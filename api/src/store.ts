import { randomUUID } from 'node:crypto';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { checkHealth } from './health.ts';
import type { Health } from './health.ts';
import {
  clusterActivities,
  draftFromCluster,
  knownCalls,
  parseAdif,
  missingFields,
  normalizeCallsign,
} from './core.ts';
import type { Channel, Cluster, PendingItem, Qso, QsoDraft, StationDefaults } from './core.ts';
import {
  activityCounts,
  deleteQso,
  insertActivities,
  insertPollLog,
  insertQso,
  pruneActivities,
  prunePollLog,
  resolveActivities,
  selectPollLog,
  selectQso,
  selectQsoHistory,
  selectQsos,
  selectUnresolvedActivities,
  updateQso,
  withTx,
} from './db.ts';
import type { IngestRow, PollLog, QsoChange } from './db.ts';
import { recordingsSize, removeRecordings } from './recordings.ts';
import { checkSettings, settingsOf, writeSettings } from './settings.ts';
import type { Settings } from './settings.ts';

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

/** 调用方能区分的三种失败。 */
export class StoreError extends Error {
  status: 404 | 409 | 422;
  missing?: string[];

  constructor(status: 404 | 409 | 422, message: string, missing?: string[]) {
    super(message);
    this.status = status;
    this.missing = missing;
  }
}

export interface PublicSource {
  station: () => StationDefaults;
  qsos: () => Qso[];
}

export function createStore(db: DatabaseSync, config: Config) {
  // 进程起来的时刻。健康检查靠它区分「刚装好还没轮询」和「轮询挂了」。
  const startedAt = nowS();
  /** 重新聚一次，拿到当前的待确认队列。 */
  const clusters = (): Cluster[] => {
    const since = nowS() - config.pendingWindowDays * 86400;
    const acts = selectUnresolvedActivities(db, since, config.dmrId);
    return clusterActivities(acts, config.clusterGapS).filter((c) =>
      c.activities.some((a) => a.mine),
    );
  };

  const find = (clusterId: string): Cluster => {
    const c = clusters().find((x) => x.id === clusterId);
    // 两次请求之间可能又入库了更早的行，段的边界就变了。
    if (!c) throw new StoreError(409, '这一段已经变了或已经处理过，刷新后重试');
    return c;
  };

  /** 挑出这一段里的这几次发射。不给就是整段，给了就得真的属于这一段。 */
  const subsetOf = (cluster: Cluster, ids?: string[]): string[] => {
    const all = cluster.activities.map((a) => a.id);
    if (ids === undefined || ids.length === 0) return all;
    const outside = ids.filter((id) => !all.includes(id));
    if (outside.length > 0) throw new StoreError(422, `这几次发射不在这一段里：${outside.join('、')}`);
    return ids;
  };

  const build = (draft: QsoDraft, clusterId?: string): Qso => {
    const call = draft.call === undefined ? undefined : normalizeCallsign(draft.call);
    const full = { ...draft, call, clusterId };
    const missing = missingFields(full);
    if (missing.length > 0) throw new StoreError(422, '还有字段没填', missing);
    return { ...full, id: randomUUID(), createdAt: nowS() } as Qso;
  };

  return {
    station: (): { station: StationDefaults; channels: Channel[] } => ({
      station: config.station,
      channels: config.channels,
    }),

    settings: (): Settings => settingsOf(config, config.analog),

    /** 写回配置文件并就地更新内存里那份。守护进程自己盯着文件，会跟着改。 */
    saveSettings: (next: unknown): Settings => {
      const problems = checkSettings(next, config.analog);
      if (problems.length > 0) throw new StoreError(422, problems.join('，'));
      writeSettings(config, next as Settings);
      // 用写完之后的 config，不要用请求体拼。拼出来的会掩盖没落盘的字段。
      return settingsOf(config, config.analog);
    },

    pending: (): PendingItem[] => {
      // 对照表用整个保留期内的行来建，不只是队列里这几段。以前见过的呼号
      // 才补得上，而队列里那几段本来就是缺呼号的那些。
      const known = knownCalls(selectUnresolvedActivities(db, 0, config.dmrId));
      return clusters().map((cluster) => ({
        cluster,
        draft: draftFromCluster(cluster, config.station, known),
      }));
    },

    qsos: () => selectQsos(db),

    qsoHistory: (id: string): QsoChange[] => selectQsoHistory(db, id),

    /**
     * @param activityIds 只处理这一段里的这几次发射。不给就是整段。
     *
     * 聚类是按一个间隔阈值猜的，会猜错。两段对话被并成一段时，整段提升会把
     * 两边的呼号和时长记成一条，整段忽略又把两边都丢掉。挑出属于这次通联的
     * 那几次，剩下的下一轮重新聚类，自己会分出去。
     */
    promote: (clusterId: string, draft: QsoDraft, activityIds?: string[]): Qso => {
      const cluster = find(clusterId);
      const ids = subsetOf(cluster, activityIds);
      const qso = build(draft, clusterId);
      return withTx(db, () => {
        insertQso(db, qso);
        resolveActivities(db, ids, qso.id, nowS());
        return qso;
      });
    },

    ignore: (clusterId: string, activityIds?: string[]): void => {
      const cluster = find(clusterId);
      const ids = subsetOf(cluster, activityIds);
      withTx(db, () => {
        resolveActivities(db, ids, null, nowS());
      });
    },

    /**
     * 一次忽略好几段。
     *
     * 一条一条调的话，每忽略一段就要重新聚类一次，剩下那些段的边界和 id 都会变，
     * 后面几条于是全部 409。这里在同一次聚类结果上一起解决，一个事务写完。
     */
    ignoreMany: (clusterIds: string[]): { ignored: number; missing: string[] } => {
      const all = clusters();
      const found = clusterIds
        .map((id) => all.find((c) => c.id === id))
        .filter((c): c is Cluster => c !== undefined);
      const missing = clusterIds.filter((id) => !all.some((c) => c.id === id));

      if (found.length > 0) {
        const at = nowS();
        withTx(db, () => {
          for (const c of found) {
            resolveActivities(db, c.activities.map((a) => a.id), null, at);
          }
        });
      }
      return { ignored: found.length, missing };
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
      const qso = {
        ...build(draft, existing.clusterId),
        id: existing.id,
        createdAt: existing.createdAt,
      };
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
          const key = call === undefined || draft.startAt === undefined
            ? undefined
            : dupKey(call, draft.startAt);
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
      prunePollLog(db, nowS() - 30 * 86400);
      // 发射行裁掉了，对应的录音就没有任何东西指向它了。不一起删的话
      // 那个目录只涨不减，而且涨得比库里任何一张表都快。
      const gone = pruneActivities(db, nowS() - config.activityRetentionDays * 86400);
      if (gone.length > 0) removeRecordings(config.recordingsDir, gone);
    },

    health: (): Health => checkHealth(db, config, nowS(), startedAt),

    // 运维页一次拿齐，免得开三个请求各自过期。
    ops: () => ({
      health: checkHealth(db, config, nowS(), startedAt),
      machine: machine(),
      recordings: recordingsSize(config.recordingsDir),
      polls: selectPollLog(db, 40),
      activities: activityCounts(db),
      queries: config.queries.map((q) => ({ key: q.key, intervalS: q.intervalS, amount: q.amount })),
      clusterGapS: config.clusterGapS,
      activityRetentionDays: config.activityRetentionDays,
      pendingWindowDays: config.pendingWindowDays,
      now: nowS(),
    }),
  };
}

export type Store = ReturnType<typeof createStore>;
