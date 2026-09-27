import { randomUUID } from 'node:crypto';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { buildKnownMap, dayConversations, ORIGINS, searchConversations, unloggedConversations } from './conversations.ts';
import type { ConversationPage } from './conversations.ts';
import { checkHealth } from './health.ts';
import type { Health } from './health.ts';
import { channelKey, clusterActivities, draftFromCluster, parseAdif, missingFields, normalizeCallsign } from './core.ts';
import type { Activity, Channel, Cluster, PendingItem, Qso, QsoDraft, StationDefaults } from './core.ts';
import {
  activityCounts,
  deleteQso,
  insertActivities,
  insertPollLog,
  insertQso,
  pruneActivities,
  prunePollLog,
  resolveActivities,
  selectActivitiesByIds,
  selectHeard,
  selectPollLog,
  selectQso,
  selectQsoActivitiesMap,
  selectQsoHistory,
  selectQsos,
  selectUnresolvedActivities,
  updateQso,
  withTx,
} from './db.ts';
import type { HeardItem, IngestRow, PollLog, QsoChange } from './db.ts';
import { recordingsSize, removeRecordings } from './recordings.ts';
import { analogEffectivelyOn } from './radio.ts';
import { checkSettings, settingsOf, writeSettings } from './settings.ts';
import type { Settings } from './settings.ts';

export { StoreError } from './store-error.ts';
import { StoreError } from './store-error.ts';

const nowS = () => Math.floor(Date.now() / 1000);

/**
 * 判重用的键：呼号加上取整到分钟的时刻。
 *
 * ADIF 里的时刻常常只到分钟，而这台机器记到秒。比死时刻的话，同一条通联
 * 每导一次就多一条。
 */
const dupKey = (call: string, startAt: number) => `${call}|${Math.floor(startAt / 60)}`;

/**
 * 机器本身的几个数。
 *
 * 这台机器无人值守，跑飞的轮询和内存泄漏只看磁盘看不出来，要等到磁盘满了
 * 才发现就太晚了。放在运维接口后面，不进 /health：健康检查是给一行 curl 用的。
 *
 * load 除以核数，这样它和 1.0 比较才有意义，不用记这台机器有几个核。
 */
function machine() {
  const cores = cpus().length || 1;
  return {
    rssBytes: process.memoryUsage().rss,
    uptimeS: Math.floor(process.uptime()),
    cores,
    // macOS 的 freemem 不算可回收的那部分，偏小，只当趋势看。
    memFreeBytes: freemem(),
    memTotalBytes: totalmem(),
    load1: Number((loadavg()[0] / cores).toFixed(2)),
  };
}

export interface PublicSource {
  station: () => StationDefaults;
  qsos: () => Qso[];
}

const HEARD_PAGE = 100;
const HEARD_MAX = 200;

type ActivityLookup = Map<string, { activity: Activity; resolved: boolean }>;

/**
 * 结算按发射 id 走的那五条检查，/promote 和 /ignore 共用。按顺序：非空、
 * 不重复、都还在、都没结算过、都在同一条信道上。哪一条不过就抛对应的
 * StoreError，调用方按需要接住或者让它一路抛出去变成 HTTP 状态。
 */
function checkIdSet(ids: string[], lookup: ActivityLookup): Activity[] {
  if (ids.length === 0) throw new StoreError(422, '一次发射都没挑');
  if (new Set(ids).size !== ids.length) throw new StoreError(422, '同一次发射不能挑两遍');
  if (ids.some((id) => !lookup.has(id))) throw new StoreError(409, '这几次发射已经不在了，刷新后重试');
  if (ids.some((id) => lookup.get(id)!.resolved)) throw new StoreError(409, '这几次发射已经结算过了，刷新后重试');
  const activities = ids.map((id) => lookup.get(id)!.activity);
  if (new Set(activities.map((a) => channelKey(a))).size > 1) {
    throw new StoreError(422, '这几次发射不在同一条信道上');
  }
  return activities;
}

/** (start_at, id) 最小的那个，和 clusterActivities 排序一致。 */
const smallestId = (activities: Activity[]): string =>
  [...activities].sort((a, b) => a.startAt - b.startAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]!.id;

export function createStore(db: DatabaseSync, config: Config) {
  // 进程起来的时刻。健康检查靠它区分「刚装好还没轮询」和「轮询挂了」。
  const startedAt = nowS();
  // BrandMeister 从关到开的那一刻。刚打开时还没来得及轮询，健康检查要按
  // 这一刻给一段宽限，不是一直拿进程起来的时刻当基准。
  let brandmeisterEnabledSince = config.brandmeisterEnabled ? startedAt : undefined;
  const graceStart = () => brandmeisterEnabledSince ?? startedAt;

  /** 重新聚一次，拿到当前的待确认队列。 */
  const clusters = (): Cluster[] => {
    const since = nowS() - config.pendingWindowDays * 86400;
    const acts = selectUnresolvedActivities(db, since, config.dmrId);
    return clusterActivities(acts, config.clusterGapS).filter((c) => c.activities.some((a) => a.mine));
  };

  const build = (draft: QsoDraft, clusterId?: string): Qso => {
    const call = draft.call === undefined ? undefined : normalizeCallsign(draft.call);
    const full = { ...draft, call, clusterId };
    const missing = missingFields(full);
    if (missing.length > 0) throw new StoreError(422, '还有字段没填', missing);
    return { ...full, id: randomUUID(), createdAt: nowS() } as Qso;
  };

  /**
   * activity 的保留期、poll_log 的保留期、连带录音一起裁。logPoll 每次轮询
   * 都跑一遍，api 自己还按小时跑一遍——两路都关着的时候没有轮询上门，
   * 不能靠它触发，不然什么都不裁。
   */
  const prune = (): void => {
    prunePollLog(db, nowS() - 30 * 86400);
    const keepDays = Math.max(config.activityRetentionDays, config.pendingWindowDays);
    const gone = pruneActivities(db, nowS() - keepDays * 86400);
    if (gone.length > 0) removeRecordings(config.recordingsDir, gone);
  };

  const switches = (): { analogEnabled: boolean; brandmeisterEnabled: boolean } => ({
    analogEnabled: analogEffectivelyOn(config.analog),
    brandmeisterEnabled: config.brandmeisterEnabled,
  });

  return {
    station: (): {
      station: StationDefaults;
      channels: Channel[];
      analogEnabled: boolean;
      brandmeisterEnabled: boolean;
    } => ({
      station: config.station,
      channels: config.channels,
      ...switches(),
    }),

    switches,

    settings: (): Settings => settingsOf(config, config.analog),

    /** 写回配置文件并就地更新内存里那份。守护进程自己盯着文件，会跟着改。 */
    saveSettings: (next: unknown): Settings => {
      const problems = checkSettings(next, config);
      if (problems.length > 0) throw new StoreError(422, problems.join('，'));
      const wasEnabled = config.brandmeisterEnabled;
      writeSettings(config, next as Settings);
      if (!wasEnabled && config.brandmeisterEnabled) brandmeisterEnabledSince = nowS();
      if (!config.brandmeisterEnabled) brandmeisterEnabledSince = undefined;
      // 用写完之后的 config，不要用请求体拼。拼出来的会掩盖没落盘的字段。
      return settingsOf(config, config.analog);
    },

    pending: (): PendingItem[] => {
      const segs = clusters();
      // 只查 draftFromCluster 真的会用到的那几个 dmr id，不是整个保留期扫一遍。
      const known = buildKnownMap(db, segs);
      return segs.map((cluster) => ({ cluster, draft: draftFromCluster(cluster, config.station, known) }));
    },

    qsos: () => selectQsos(db),

    /** 挂了每条通联用到的发射（id、开始时刻、时长），只给管理端用。 */
    qsosWithActivities: (): (Qso & { activities: { id: string; startAt: number; durationS: number }[] })[] => {
      const map = selectQsoActivitiesMap(db);
      return selectQsos(db).map((q) => ({ ...q, activities: map.get(q.id) ?? [] }));
    },

    qsoHistory: (id: string): QsoChange[] => selectQsoHistory(db, id),

    /**
     * 收听记录。参数原样来自查询串，在这里验。
     *
     * @param cursor 上一页的 next，形如 `<时刻>:<id>`。
     */
    heard: (q: { origin?: string; cursor?: string; limit?: string }): { items: HeardItem[]; next?: string } => {
      if (q.origin !== undefined && !ORIGINS.includes(q.origin)) {
        throw new StoreError(422, `origin 只能是 ${ORIGINS.join('、')}`);
      }
      const m = q.cursor === undefined ? undefined : /^(\d+):(.+)$/.exec(q.cursor);
      if (q.cursor !== undefined && m === null) {
        throw new StoreError(422, 'cursor 要是上一页给的 next');
      }
      const limit = q.limit === undefined ? HEARD_PAGE : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > HEARD_MAX) {
        throw new StoreError(422, `limit 要是 1 到 ${HEARD_MAX} 的整数`);
      }
      const items = selectHeard(
        db,
        { origin: q.origin, before: m ? { startAt: Number(m[1]), id: m[2]! } : undefined, limit },
        config.dmrId,
      );
      const last = items.at(-1);
      // 不满一页就是翻到头了。正好满一页时多给一个 next，下一页是空的，代价是多一次请求。
      return items.length === limit && last ? { items, next: `${last.startAt}:${last.id}` } : { items };
    },

    /**
     * 收听页：按天看、未入库、按呼号搜，三选一。exactly one of from+to /
     * view=unlogged / q，否则 422。
     */
    conversations: (q: {
      from?: string;
      to?: string;
      view?: string;
      q?: string;
      origin?: string;
      status?: string;
      channel?: string;
      cursor?: string;
      limit?: string;
    }): (ConversationPage & { channels?: { key: string; label: string }[]; total?: number }) => {
      const wantsDay = q.from !== undefined || q.to !== undefined;
      const wantsUnlogged = q.view !== undefined;
      const wantsSearch = q.q !== undefined;
      const count = Number(wantsDay) + Number(wantsUnlogged) + Number(wantsSearch);
      if (count !== 1) {
        throw new StoreError(422, '要在按天看（from、to）、view=unlogged、按呼号搜（q）三者里选一个');
      }
      const filters: { origin?: string; status?: string; channel?: string; cursor?: string; limit?: string } = {
        origin: q.origin,
        status: q.status,
        channel: q.channel,
        cursor: q.cursor,
        limit: q.limit,
      };

      if (wantsDay) {
        if (q.from === undefined || q.to === undefined) {
          throw new StoreError(422, '按天看要同时给 from 和 to');
        }
        const from = Number(q.from);
        const to = Number(q.to);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          throw new StoreError(422, 'from 和 to 要是整数 Unix 秒');
        }
        return dayConversations(db, config, from, to, filters);
      }
      if (wantsUnlogged) {
        if (q.view !== 'unlogged') throw new StoreError(422, 'view 只能是 unlogged');
        return unloggedConversations(db, config, filters);
      }
      return searchConversations(db, config, q.q!, filters);
    },

    /**
     * 按发射 id 结算成通联。检查顺序见 checkIdSet。服务端存下收到的草稿，
     * 不重算开始时间和呼号——界面已经按挑中的那几次算过了。
     */
    promoteActivities: (activityIds: string[], draft: QsoDraft): Qso => {
      const lookup = selectActivitiesByIds(db, activityIds, config.dmrId);
      const activities = checkIdSet(activityIds, lookup);
      const qso = build(draft, smallestId(activities));
      return withTx(db, () => {
        insertQso(db, qso);
        resolveActivities(db, activityIds, qso.id, nowS());
        return qso;
      });
    },

    /**
     * 一次忽略好几个对话，按发射 id。一条不过就把它记到 missing 里，不影响
     * 别的；同一个请求里，后一条挑的 id 若已经被前一条有效的 pick 用过，
     * 也算「已经结算过」。合法的那些一个事务写完。
     */
    ignoreActivities: (picks: { id: string; activityIds: string[] }[]): { ignored: number; missing: string[] } => {
      const allIds = [...new Set(picks.flatMap((p) => p.activityIds))];
      const base = selectActivitiesByIds(db, allIds, config.dmrId);
      const usedByEarlier = new Set<string>();
      const settle: string[] = [];
      const missing: string[] = [];

      for (const pick of picks) {
        const lookup: ActivityLookup = new Map(
          [...base].map(([id, v]) => [id, usedByEarlier.has(id) ? { ...v, resolved: true } : v]),
        );
        try {
          checkIdSet(pick.activityIds, lookup);
          for (const id of pick.activityIds) usedByEarlier.add(id);
          settle.push(...pick.activityIds);
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
          missing.push(pick.id);
        }
      }

      if (settle.length > 0) withTx(db, () => resolveActivities(db, settle, null, nowS()));
      return { ignored: picks.length - missing.length, missing };
    },

    // 手工录入没有任何观测，所以不带 clusterId，也不动 activity。
    addQso: (draft: QsoDraft): Qso => {
      const qso = build(draft);
      insertQso(db, qso);
      return qso;
    },

    // 改一条已经入库的。id、createdAt 和 clusterId 保持原样，因为 clusterId 是
    // 这条记录和当初那几次发射的唯一联系，删了重录就断了。
    editQso: (id: string, draft: QsoDraft): Qso => {
      const existing = selectQso(db, id);
      if (!existing) throw new StoreError(404, '没有这条通联');
      const qso = { ...build(draft, existing.clusterId), id: existing.id, createdAt: existing.createdAt };
      updateQso(db, qso, nowS());
      return qso;
    },

    /**
     * 从 ADIF 里导入。
     *
     * 判重靠呼号加时刻：同一个呼号、开始时间相差不到一分钟，就当是同一次通联。
     * ADIF 里的时刻常常只精确到分钟，而这台机器记到秒，比死时刻会把同一条
     * 反复导进来。导进来的记录不带 clusterId，它们没有任何观测支撑。
     */
    importAdif: (text: string): { parsed: number; imported: number; skipped: number; problems: string[] } => {
      const { drafts, problems } = parseAdif(text);
      const existing = selectQsos(db);
      const seen = new Set<string>(existing.map((q) => dupKey(q.call, q.startAt)));

      let imported = 0;
      let skipped = 0;
      const rejected = [...problems];

      withTx(db, () => {
        drafts.forEach((draft, i) => {
          const call = draft.call === undefined ? undefined : normalizeCallsign(draft.call);
          const key = call === undefined || draft.startAt === undefined ? undefined : dupKey(call, draft.startAt);
          if (key !== undefined && seen.has(key)) {
            skipped += 1;
            return;
          }
          const missing = missingFields({ ...draft, call });
          if (missing.length > 0) {
            rejected.push(`第 ${i + 1} 条还缺 ${missing.join('、')}，跳过`);
            return;
          }
          const qso = { ...draft, call, id: randomUUID(), createdAt: nowS() } as Qso;
          insertQso(db, qso);
          if (key !== undefined) seen.add(key);
          imported += 1;
        });
      });

      return { parsed: drafts.length, imported, skipped, problems: rejected };
    },

    removeQso: (id: string): void => {
      if (!deleteQso(db, id, nowS())) throw new StoreError(404, '没有这条通联');
    },

    // 采集端推过来的。判重在这里做，所以重复推送没有副作用。
    ingest: (rows: IngestRow[]): { received: number; written: number } => {
      const written = insertActivities(db, rows, nowS());
      return { received: rows.length, written };
    },

    logPoll: (p: PollLog): void => {
      insertPollLog(db, p);
      prune();
    },

    /** api 自己按小时跑一遍裁剪，独立于轮询：两路都关着时没有轮询上门。 */
    prune,

    health: (): Health => checkHealth(db, config, nowS(), graceStart()),

    // 运维页一次拿齐，免得开三个请求各自过期。
    ops: () => ({
      health: checkHealth(db, config, nowS(), graceStart()),
      machine: machine(),
      recordings: recordingsSize(config.recordingsDir),
      polls: selectPollLog(db, 40),
      activities: activityCounts(db),
      queries: config.queries.map((q) => ({ key: q.key, intervalS: q.intervalS, amount: q.amount })),
      clusterGapS: config.clusterGapS,
      activityRetentionDays: config.activityRetentionDays,
      pendingWindowDays: config.pendingWindowDays,
      now: nowS(),
      ...switches(),
    }),
  };
}

export type Store = ReturnType<typeof createStore>;
