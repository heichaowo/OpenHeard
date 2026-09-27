import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import {
  channelKey,
  clusterOfGroup,
  dmrIdsNeedingLookup,
  EXTEND_STEP_S,
  extendChannel,
  finalConversations,
  mergeWindows,
  normalizeCallsign,
  prefixRange,
  toConversation,
  unresolvedStatus,
} from './core.ts';
import type { Activity, Cluster, Conversation, ConversationStatus } from './core.ts';
import {
  resolveKnownCall,
  selectActivitiesInRange,
  selectCallsignSeeds,
  selectChannelRange,
  selectQsoBriefs,
  selectQsoCallSeeds,
  selectQsoMembers,
  selectUnloggedSeeds,
} from './db.ts';
import type { RangeRow } from './db.ts';
import { StoreError } from './store-error.ts';

export const ORIGINS: string[] = ['brandmeister', 'sdr-fm', 'sdr-dmr'];
export const STATUSES: ConversationStatus[] = ['pending', 'unlogged', 'logged', 'ignored', 'overheard'];

export interface ConversationFilters {
  origin?: string;
  status?: ConversationStatus;
  channel?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversationPage {
  items: Conversation[];
  next?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 请求里这几样通用参数，三个视图都要验、都要用同一套规则。 */
function checkFilters(q: {
  origin?: string;
  status?: string;
  channel?: string;
  limit?: string;
  cursor?: string;
}): ConversationFilters {
  if (q.origin !== undefined && !ORIGINS.includes(q.origin)) {
    throw new StoreError(422, `origin 只能是 ${ORIGINS.join('、')}`);
  }
  if (q.status !== undefined && !STATUSES.includes(q.status as ConversationStatus)) {
    throw new StoreError(422, `status 只能是 ${STATUSES.join('、')}`);
  }
  const limit = q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new StoreError(422, `limit 要是 1 到 ${MAX_LIMIT} 的整数`);
  }
  if (q.cursor !== undefined && !/^\d+:.+$/.test(q.cursor)) {
    throw new StoreError(422, 'cursor 要是上一页给的 next');
  }
  return {
    origin: q.origin,
    status: q.status as ConversationStatus | undefined,
    channel: q.channel,
    limit,
    cursor: q.cursor,
  };
}

function applyFilters(items: Conversation[], f: ConversationFilters): Conversation[] {
  let out = items;
  if (f.origin !== undefined) out = out.filter((c) => c.origin === f.origin);
  if (f.status !== undefined) out = out.filter((c) => c.status === f.status);
  if (f.channel !== undefined) out = out.filter((c) => c.channel === f.channel);
  return out;
}

/** (startAt DESC, id DESC)，和 /api/activities 同一个排序，keyset 游标才立得住。 */
function byRecency(a: Conversation, b: Conversation): number {
  return b.startAt - a.startAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function afterCursor(items: Conversation[], cursor: string | undefined): Conversation[] {
  if (cursor === undefined) return items;
  const m = /^(\d+):(.+)$/.exec(cursor)!;
  const cStart = Number(m[1]);
  const cId = m[2]!;
  return items.filter((c) => c.startAt < cStart || (c.startAt === cStart && c.id < cId));
}

/** 按 limit 切页，正好切满一页时多给一个 next，和 /api/activities 同一个代价换法。 */
function paginate(items: Conversation[], limit: number): ConversationPage {
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return page.length === limit && last ? { items: page, next: `${last.startAt}:${last.id}` } : { items: page };
}

function channelLabel(key: string): string {
  if (key.startsWith('tg:')) return `TG ${key.slice(3)}`;
  if (key.startsWith('ch:')) return key.slice(3);
  if (key.startsWith('fq:')) return `${key.slice(3)} MHz`;
  return key;
}

function distinctChannels(items: Conversation[]): { key: string; label: string }[] {
  const keys = [...new Set(items.map((c) => c.channel))].sort();
  return keys.map((key) => ({ key, label: channelLabel(key) }));
}

/**
 * 只把 draftFromCluster 真的会去查的那几个 dmr id 挑出来，一个个用索引查，
 * 不建整个保留期的对照表。见 core 的 dmrIdsNeedingLookup 和 db 的 resolveKnownCall。
 */
export function buildKnownMap(db: DatabaseSync, clusters: Cluster[]): Map<number, string> {
  const ids = new Set<number>();
  for (const c of clusters) for (const id of dmrIdsNeedingLookup(c.activities)) ids.add(id);
  const known = new Map<number, string>();
  for (const id of ids) {
    const call = resolveKnownCall(db, id);
    if (call !== undefined) known.set(id, call);
  }
  return known;
}

type Built = { cluster: Cluster; status: ConversationStatus; qsoId?: string };

/** 一条信道一批行：拆成未结算、已忽略、已入库（记下涉及哪几个 qso）。 */
function splitRange(rows: RangeRow[]): { unresolved: Activity[]; ignored: Activity[]; qsoIds: Set<string> } {
  const unresolved: Activity[] = [];
  const ignored: Activity[] = [];
  const qsoIds = new Set<string>();
  for (const r of rows) {
    if (!r.resolved) unresolved.push(r.activity);
    else if (r.qsoId === undefined) ignored.push(r.activity);
    else qsoIds.add(r.qsoId);
  }
  return { unresolved, ignored, qsoIds };
}

/**
 * 一条信道在一个读取窗口里建出来的对话：未结算和已忽略按间隔聚类，碰到窗口
 * 边界就往外扩（见 core 的 extendChannel）；已入库按 qso_id 整条补全，
 * 不受窗口边界影响——它的成员是 resolved_activity 定死的，不是猜出来的。
 */
function buildChannelWindow(
  db: DatabaseSync,
  config: Config,
  key: string,
  windowStart: number,
  windowEnd: number,
  dmrId: number,
): Built[] {
  const rows = selectChannelRange(db, key, windowStart, windowEnd, dmrId);
  const { unresolved, ignored, qsoIds } = splitRange(rows);
  const out: Built[] = [];

  if (unresolved.length > 0) {
    const readMore = (lo: number, hi: number) =>
      splitRange(selectChannelRange(db, key, lo, hi, dmrId)).unresolved;
    for (const cluster of extendChannel(unresolved, windowStart, windowEnd, config.clusterGapS, readMore)) {
      out.push({ cluster, status: unresolvedStatus(cluster.activities, nowS(), config.pendingWindowDays * 86400) });
    }
  }
  if (ignored.length > 0) {
    const readMore = (lo: number, hi: number) => splitRange(selectChannelRange(db, key, lo, hi, dmrId)).ignored;
    for (const cluster of extendChannel(ignored, windowStart, windowEnd, config.clusterGapS, readMore)) {
      out.push({ cluster, status: 'ignored' });
    }
  }
  for (const qsoId of qsoIds) {
    const members = selectQsoMembers(db, qsoId, dmrId);
    if (members.length > 0) out.push({ cluster: clusterOfGroup(members), status: 'logged', qsoId });
  }
  return out;
}

/**
 * 一条信道的种子按窗口分了组，两个窗口本该不相交，但窗口之间那段死区里
 * 可能藏着一条把两边连起来的发射——它自己不是种子，两边窗口各自的扩窗
 * 检查也都摸不到它（各自离自己窗口的边界都够远）。结果同一条真实对话
 * 被两个窗口各建出一份，id 不一样，膜起来看却有共同成员。按成员是否
 * 重叠合并：真正不相干的对话永远不共享一个 activity id，共享了就是同一条。
 */
function mergeOverlapping(built: Built[], config: Config): Built[] {
  const groups: Built[][] = [];
  for (const b of built) {
    if (b.qsoId !== undefined) {
      groups.push([b]); // 已入库的成员由 resolved_activity 定死，不会和别的对话重叠
      continue;
    }
    const ids = new Set(b.cluster.activities.map((a) => a.id));
    const hit = groups.find((g) => g.some((x) => x.qsoId === undefined && x.cluster.activities.some((a) => ids.has(a.id))));
    if (hit) hit.push(b);
    else groups.push([b]);
  }
  return groups.map((g) => {
    if (g.length === 1) return g[0]!;
    const union = new Map<string, Activity>();
    for (const b of g) for (const a of b.cluster.activities) union.set(a.id, a);
    const cluster = clusterOfGroup([...union.values()]);
    const status: ConversationStatus =
      g[0]!.status === 'ignored' ? 'ignored' : unresolvedStatus(cluster.activities, nowS(), config.pendingWindowDays * 86400);
    return { cluster, status };
  });
}

function toConversations(db: DatabaseSync, config: Config, built: Built[]): Conversation[] {
  const loggedIds = [...new Set(built.filter((b) => b.qsoId !== undefined).map((b) => b.qsoId!))];
  const briefs = selectQsoBriefs(db, loggedIds);
  const needDraft = built
    .filter((b) => b.status === 'pending' || b.status === 'unlogged' || b.status === 'overheard')
    .map((b) => b.cluster);
  const known = buildKnownMap(db, needDraft);
  return built.map(({ cluster, status, qsoId }) =>
    toConversation(cluster, status, {
      defaults: config.station,
      known,
      qso: qsoId === undefined ? undefined : briefs.get(qsoId),
    }),
  );
}

const nowS = () => Math.floor(Date.now() / 1000);

const MAX_DAY_SPAN_S = 172_800;

/**
 * 按天看：这一天再前后各两小时的窗口里，不管状态先整批取出来，按信道分组，
 * 未结算/已忽略各自聚类并按需扩窗，已入库整条补全。
 */
export function dayConversations(
  db: DatabaseSync,
  config: Config,
  from: number,
  to: number,
  q: { origin?: string; status?: string; channel?: string; cursor?: string; limit?: string },
): ConversationPage & { channels: { key: string; label: string }[] } {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) {
    throw new StoreError(422, 'from 和 to 要是整数 Unix 秒，且 from 小于 to');
  }
  if (to - from > MAX_DAY_SPAN_S) throw new StoreError(422, `from 到 to 最多 ${MAX_DAY_SPAN_S} 秒`);
  const filters = checkFilters(q);

  const windowStart = from - EXTEND_STEP_S;
  const windowEnd = to + EXTEND_STEP_S;
  const rows = selectActivitiesInRange(db, windowStart, windowEnd, config.dmrId);

  const byChannel = new Map<string, RangeRow[]>();
  for (const r of rows) {
    const key = channelKey(r.activity);
    const list = byChannel.get(key);
    if (list) list.push(r);
    else byChannel.set(key, [r]);
  }

  const built: Built[] = [];
  for (const [key] of byChannel) built.push(...buildChannelWindow(db, config, key, windowStart, windowEnd, config.dmrId));

  let items = toConversations(db, config, built).filter((c) => c.startAt >= from && c.startAt < to);

  const channels = distinctChannels(filters.origin === undefined ? items : items.filter((c) => c.origin === filters.origin));

  items = applyFilters(items, filters);
  items.sort(byRecency);
  items = afterCursor(items, filters.cursor);

  return { ...paginate(items, filters.limit!), channels };
}

/**
 * 未入库：种子是出了待确认窗口但还没结算的本台对话，按信道分组、窗口合并，
 * 只读要读的那几段，不是整个保留期。
 */
export function unloggedConversations(
  db: DatabaseSync,
  config: Config,
  q: { origin?: string; status?: string; channel?: string; cursor?: string; limit?: string },
): ConversationPage & { total: number } {
  const filters = checkFilters(q);
  const now = nowS();
  const pendingCutoff = now - config.pendingWindowDays * 86400;
  const keepDays = Math.max(config.activityRetentionDays, config.pendingWindowDays);
  const retentionCutoff = now - keepDays * 86400;

  const seeds = selectUnloggedSeeds(db, config.dmrId, pendingCutoff, retentionCutoff);
  const byChannel = new Map<string, number[]>();
  for (const s of seeds) {
    const key = channelKey(s);
    const list = byChannel.get(key);
    if (list) list.push(s.startAt);
    else byChannel.set(key, [s.startAt]);
  }

  let built: Built[] = [];
  for (const [key, times] of byChannel) {
    for (const w of mergeWindows(times, EXTEND_STEP_S)) {
      built.push(...buildChannelWindow(db, config, key, w.start, w.end, config.dmrId));
    }
  }
  // 两个窗口之间可能藏着一条两边都摸不到的发射，把同一条对话各建了一份。
  built = mergeOverlapping(built, config).filter((b) => b.status === 'unlogged');

  let items = toConversations(db, config, built);
  items = applyFilters(items, filters);
  const total = items.length;
  items.sort(byRecency);
  items = afterCursor(items, filters.cursor);

  return { ...paginate(items, filters.limit!), total };
}

const SEARCH_BATCH = 200;

/**
 * 搜呼号：种子按 start_at 从新到旧分批取，一批建一批的对话，只有确定不会再
 * 被更旧的种子拉长的那些才下发。见 core 的 finalConversations。
 */
export function searchConversations(
  db: DatabaseSync,
  config: Config,
  qRaw: string,
  q: { origin?: string; status?: string; channel?: string; cursor?: string; limit?: string },
): ConversationPage {
  const prefix = normalizeCallsign(qRaw);
  if (prefix.length < 2) throw new StoreError(422, 'q 至少要 2 个字符');
  const filters = checkFilters(q);
  const limit = filters.limit!;
  const [lo, hi] = prefixRange(prefix);
  const now = nowS();
  const retentionCutoff = now - config.activityRetentionDays * 86400;

  const cursorStart = filters.cursor === undefined ? undefined : Number(/^(\d+):/.exec(filters.cursor)![1]);
  let upperBound = cursorStart === undefined ? now + 1 : cursorStart + EXTEND_STEP_S;

  const seen = new Map<string, Built>();

  for (;;) {
    const aSeeds = selectCallsignSeeds(db, lo, hi, retentionCutoff, upperBound, SEARCH_BATCH, config.dmrId);
    const qSeeds = selectQsoCallSeeds(db, lo, hi, upperBound, SEARCH_BATCH, config.dmrId);
    const batch = new Map<string, Activity>();
    for (const a of aSeeds) batch.set(a.id, a);
    for (const a of qSeeds) batch.set(a.id, a);

    const exhausted = aSeeds.length < SEARCH_BATCH && qSeeds.length < SEARCH_BATCH;
    if (batch.size === 0) break;

    const byChannel = new Map<string, number[]>();
    for (const a of batch.values()) {
      const key = channelKey(a);
      const list = byChannel.get(key);
      if (list) list.push(a.startAt);
      else byChannel.set(key, [a.startAt]);
    }

    let built: Built[] = [];
    for (const [key, times] of byChannel) {
      for (const w of mergeWindows(times, EXTEND_STEP_S)) {
        built.push(...buildChannelWindow(db, config, key, w.start, w.end, config.dmrId));
      }
    }
    // 两颗种子隔得太远、窗口不重叠，但中间藏着一条两边都摸不到的发射，把
    // 同一条真实对话各建了一份：按成员重叠合并回一份。
    built = mergeOverlapping(built, config);
    // 只留下真的含种子的对话：窗口合并会把邻近但不相干的对话也读进来。
    const withSeed = built.filter((b) => b.cluster.activities.some((a) => batch.has(a.id)));

    const boundaries: number[] = [];
    if (aSeeds.length === SEARCH_BATCH) boundaries.push(Math.min(...aSeeds.map((a) => a.startAt)));
    if (qSeeds.length === SEARCH_BATCH) boundaries.push(Math.min(...qSeeds.map((a) => a.startAt)));
    const nextUnreadSeedStartAt = boundaries.length === 0 ? undefined : Math.min(...boundaries);

    const finalIds = new Set(finalConversations(withSeed.map((b) => b.cluster), nextUnreadSeedStartAt).map((c) => c.id));
    for (const b of withSeed) if (finalIds.has(b.cluster.id) && !seen.has(b.cluster.id)) seen.set(b.cluster.id, b);

    let pool = toConversations(db, config, [...seen.values()]);
    pool = applyFilters(pool, filters);
    pool = afterCursor(pool, filters.cursor);
    pool.sort(byRecency);

    if (pool.length >= limit || exhausted) return paginate(pool, limit);

    upperBound = Math.min(...[...batch.values()].map((a) => a.startAt));
  }

  const pool = afterCursor(applyFilters(toConversations(db, config, [...seen.values()]), filters), filters.cursor).sort(
    byRecency,
  );
  return paginate(pool, limit);
}
