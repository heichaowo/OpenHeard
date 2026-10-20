import { randomUUID } from 'node:crypto';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { AI_STEPS, aiStats, countTodo, resetAiErrors, selectTodo, setVerdicts, writeAiResults } from './ai.ts';
import type { AiStep, TodoItem } from './ai.ts';
import {
  dayConversations,
  meaninglessConversations,
  ORIGINS,
  pendingConversations,
  searchConversations,
  unloggedConversations,
} from './conversations.ts';
import type { ConversationPage } from './conversations.ts';
import { checkHealth } from './health.ts';
import type { Health } from './health.ts';
import { channelKey, parseAdif, missingFields, normalizeCallsign } from './core.ts';
import type { Activity, Channel, PendingItem, Qso, QsoDraft, StationDefaults } from './core.ts';
import {
  activityCounts,
  deleteActivities,
  deleteQso,
  insertActivities,
  insertPollLog,
  insertQso,
  pruneActivities,
  pruneAiRows,
  prunePollLog,
  pruneTombstones,
  resolveActivities,
  selectActivitiesByIds,
  selectHeard,
  selectPollLog,
  selectQso,
  selectQsoActivitiesMap,
  selectQsoHistory,
  selectQsos,
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

type ActivityLookup = Map<string, { activity: Activity; resolved: boolean; logged: boolean }>;

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

/**
 * 删除按发射 id 走的检查，和 checkIdSet 差在两处：已忽略的可以删（连它的忽略记录），
 * 已入库的不行；同一次请求里更早的 pick 删过的 id 算已经不在了。
 * 顺序：非空、不重复、都在、都没入库、同一条信道。
 */
function checkDeleteSet(ids: string[], lookup: ActivityLookup, gone: Set<string>): void {
  if (ids.length === 0) throw new StoreError(422, '一次发射都没挑');
  if (new Set(ids).size !== ids.length) throw new StoreError(422, '同一次发射不能挑两遍');
  if (ids.some((id) => gone.has(id) || !lookup.has(id))) throw new StoreError(409, '这几次发射已经不在了，刷新后重试');
  if (ids.some((id) => lookup.get(id)!.logged)) throw new StoreError(409, '已经入库的发射不能删，先到日志里删掉那条通联');
  if (new Set(ids.map((id) => channelKey(lookup.get(id)!.activity))).size > 1) {
    throw new StoreError(422, '这几次发射不在同一条信道上');
  }
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
    const cutoff = nowS() - keepDays * 86400;
    const gone = pruneActivities(db, cutoff);
    if (gone.length > 0) removeRecordings(config.recordingsDir, gone);
    // 发射没了，它的识别结果和人工判定也没用了。墓碑过了保留期，采集也不会再推那一行。
    pruneAiRows(db);
    pruneTombstones(db, cutoff);
  };

  /** 识别队列要看的步骤，来自配置：和守护进程那边开着的是同一批。 */
  const aiSteps = (): Set<AiStep> => {
    const ai = config.ai;
    const steps = new Set<AiStep>();
    if (ai === undefined || !ai.enabled) return steps;
    if (ai.vad.provider === 'local') steps.add('vad');
    if (ai.asr.provider !== 'off') steps.add('asr');
    if (ai.text.provider !== 'off') steps.add('text');
    return steps;
  };
  const retentionCutoff = () => nowS() - Math.max(config.activityRetentionDays, config.pendingWindowDays) * 86400;

  /** 守护进程报上来的识别状态。只在内存里，和 /api/ingest/radio 一样。 */
  let aiWorker: { at: number; ok: boolean; message: string } | undefined;

  const switches = (): { analogEnabled: boolean; brandmeisterEnabled: boolean } => ({
    analogEnabled: analogEffectivelyOn(config.analog),
    brandmeisterEnabled: config.brandmeisterEnabled,
  });

  const opsAi = () => {
    const ai = config.ai;
    const on = ai !== undefined && ai.enabled;
    const stats = aiStats(db, nowS());
    return {
      enabled: on,
      vad: ai?.vad.provider ?? 'off',
      asrProvider: ai?.asr.provider ?? 'off',
      textProvider: ai?.text.provider ?? 'off',
      // 关着时不数：没有守护进程在做，数出来只会让人以为它卡住了。
      todo: on
        ? countTodo(db, { steps: aiSteps(), sinceStartAt: retentionCutoff(), now: nowS(), recordingsDir: config.recordingsDir })
        : 0,
      doneLast24h: stats.doneLast24h,
      // 和收听页「无意义」那一档的 total 是同一个函数算的，两边不会差。
      meaningless: meaninglessConversations(db, config, { limit: '1' }).total,
      ...(aiWorker === undefined ? {} : { worker: aiWorker }),
      ...(stats.lastError === undefined ? {} : { lastError: stats.lastError }),
      ...(config.aiProblem === undefined ? {} : { problem: config.aiProblem }),
    };
  };

  return {
    station: (): {
      station: StationDefaults;
      channels: Channel[];
      analogEnabled: boolean;
      brandmeisterEnabled: boolean;
      aiEnabled: boolean;
      map: { provider: 'amap' | 'osm' | 'none'; amapKey?: string };
    } => {
      const map = config.map;
      return {
        station: config.station,
        channels: config.channels,
        ...switches(),
        aiEnabled: config.ai?.enabled === true,
        // 高德的 key 是公开的，页面要拿它加载地图。安全密钥不在这里。
        map:
          map?.provider === 'amap'
            ? { provider: 'amap', amapKey: map.amapKey }
            : { provider: map?.provider ?? 'none' },
      };
    },

    switches,

    /** 高德代理用。没选高德或者没填安全密钥就是 undefined。 */
    amapSecurityCode: (): string | undefined =>
      config.map?.provider === 'amap' && config.map.amapSecurityCode !== '' ? config.map.amapSecurityCode : undefined,

    settings: (): Settings => settingsOf(config, config.analog),

    /** 写回配置文件并就地更新内存里那份。守护进程自己盯着文件，会跟着改。 */
    saveSettings: (next: unknown): Settings => {
      const problems = checkSettings(next, config);
      if (problems.length > 0) throw new StoreError(422, problems.join('，'));
      const wasEnabled = config.brandmeisterEnabled;
      const aiBefore = JSON.stringify(config.ai);
      writeSettings(config, next as Settings);
      // 改了 ai 多半是在修配置，上次的错误不再算数，让队列重新做。
      if (JSON.stringify(config.ai) !== aiBefore) resetAiErrors(db);
      if (!wasEnabled && config.brandmeisterEnabled) brandmeisterEnabledSince = nowS();
      if (!config.brandmeisterEnabled) brandmeisterEnabledSince = undefined;
      // 用写完之后的 config，不要用请求体拼。拼出来的会掩盖没落盘的字段。
      return settingsOf(config, config.analog);
    },

    pending: (): PendingItem[] =>
      // 和收听页其他几档同一套建法，跨过窗口起点的对话整段都在，段 id 也对得上。
      pendingConversations(db, config).map((c) => ({
        cluster: { id: c.id, startAt: c.startAt, endAt: c.endAt, activities: c.activities },
        draft: c.draft!,
        ...(c.aiFilled === undefined ? {} : { aiFilled: c.aiFilled }),
      })),

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
      meaningless?: string;
    }): (ConversationPage & { channels?: { key: string; label: string }[]; total?: number }) => {
      const wantsDay = q.from !== undefined || q.to !== undefined;
      const wantsUnlogged = q.view !== undefined;
      const wantsSearch = q.q !== undefined;
      const count = Number(wantsDay) + Number(wantsUnlogged) + Number(wantsSearch);
      if (count !== 1) {
        throw new StoreError(422, '要在按天看（from、to）、view=unlogged 或 meaningless、按呼号搜（q）三者里选一个');
      }
      const filters = {
        origin: q.origin,
        status: q.status,
        channel: q.channel,
        cursor: q.cursor,
        limit: q.limit,
        meaningless: q.meaningless,
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
        if (q.view === 'meaningless') return meaninglessConversations(db, config, filters);
        if (q.view !== 'unlogged') throw new StoreError(422, 'view 只能是 unlogged 或 meaningless');
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

    /**
     * 整段删掉没入库的对话：发射行、忽略记录、识别结果、人工判定，再记墓碑，
     * 最后删录音。逐条 pick 检查，一条不过记到 missing，不影响别的；同一个请求里
     * 更早的合法 pick 用过的 id，后面再挑到算已经不在了。合法的那些一个事务写完，
     * 录音等提交了再删，事务回滚不会留下没有录音的行。
     */
    deleteConversations: (picks: { id: string; activityIds: string[] }[]): { deleted: number; missing: string[] } => {
      const allIds = [...new Set(picks.flatMap((p) => p.activityIds))];
      const base = selectActivitiesByIds(db, allIds, config.dmrId);
      const gone = new Set<string>();
      const doomed: string[] = [];
      const missing: string[] = [];

      for (const pick of picks) {
        try {
          checkDeleteSet(pick.activityIds, base, gone);
          for (const id of pick.activityIds) gone.add(id);
          doomed.push(...pick.activityIds);
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
          missing.push(pick.id);
        }
      }

      if (doomed.length > 0) {
        withTx(db, () => deleteActivities(db, doomed, nowS()));
        removeRecordings(config.recordingsDir, doomed);
      }
      return { deleted: picks.length - missing.length, missing };
    },

    /** 人工判定这几次发射是不是无意义，压过 AI 的。有一个不存在就一个都不写。 */
    setVerdict: (activityIds: string[], meaningless: boolean): void => {
      const ids = [...new Set(activityIds)];
      if (ids.length === 0) throw new StoreError(422, '一次发射都没挑');
      const found = selectActivitiesByIds(db, ids, config.dmrId);
      if (ids.some((id) => !found.has(id))) throw new StoreError(409, '这几次发射已经不在了，刷新后重试');
      withTx(db, () => setVerdicts(db, ids, meaningless, nowS()));
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

    /**
     * 识别队列：还没做完的 sdr-fm 录音，新的在前。steps 是守护进程开着的那几步，
     * 决定「已经识别但还没提取」这类行算不算待办。
     */
    aiTodo: (q: { limit?: string; steps?: string }): { items: TodoItem[] } => {
      const limit = q.limit === undefined ? 10 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new StoreError(422, 'limit 要是 1 到 50 的整数');
      const names = q.steps === undefined || q.steps === '' ? [] : q.steps.split(',');
      if (names.some((n) => !AI_STEPS.includes(n as AiStep))) {
        throw new StoreError(422, `steps 只能是 ${AI_STEPS.join('、')}，用逗号隔开`);
      }
      return {
        items: selectTodo(db, {
          steps: new Set(names as AiStep[]),
          sinceStartAt: retentionCutoff(),
          now: nowS(),
          recordingsDir: config.recordingsDir,
          limit,
        }),
      };
    },

    /** 守护进程推上来的识别结果。验、合并都在 writeAiResults。 */
    ingestAi: (results: unknown[]): { written: number } => ({ written: writeAiResults(db, results, nowS()) }),

    setAiWorker: (ok: boolean, message: string): void => {
      aiWorker = { at: nowS(), ok, message: message.slice(0, 500) };
    },

    /** api 起来时调一次：上次的错误多半是配置问题，清掉重做。 */
    resetAiErrors: (): number => resetAiErrors(db),

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
      ai: opsAi(),
      ...(config.mapProblem === undefined ? {} : { mapProblem: config.mapProblem }),
    }),
  };
}

export type Store = ReturnType<typeof createStore>;
