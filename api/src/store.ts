import { randomUUID } from 'node:crypto';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { checkHealth } from './health.ts';
import type { Health } from './health.ts';
import {
  clusterActivities,
  draftFromCluster,
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
import { checkSettings, settingsOf, writeSettings } from './settings.ts';
import type { Settings } from './settings.ts';

const nowS = () => Math.floor(Date.now() / 1000);

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
      const problems = checkSettings(next);
      if (problems.length > 0) throw new StoreError(422, problems.join('；'));
      writeSettings(config, next as Settings);
      return settingsOf(config, (next as Settings).analog ?? config.analog);
    },

    pending: (): PendingItem[] =>
      clusters().map((cluster) => ({
        cluster,
        draft: draftFromCluster(cluster, config.station),
      })),

    qsos: () => selectQsos(db),

    qsoHistory: (id: string): QsoChange[] => selectQsoHistory(db, id),

    promote: (clusterId: string, draft: QsoDraft): Qso => {
      const cluster = find(clusterId);
      const qso = build(draft, clusterId);
      return withTx(db, () => {
        insertQso(db, qso);
        resolveActivities(db, cluster.activities.map((a) => a.id), qso.id, nowS());
        return qso;
      });
    },

    ignore: (clusterId: string): void => {
      const cluster = find(clusterId);
      withTx(db, () => {
        resolveActivities(db, cluster.activities.map((a) => a.id), null, nowS());
      });
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
      pruneActivities(db, nowS() - config.activityRetentionDays * 86400);
    },

    health: (): Health => checkHealth(db, config, nowS(), startedAt),

    // 运维页一次拿齐，免得开三个请求各自过期。
    ops: () => ({
      health: checkHealth(db, config, nowS(), startedAt),
      machine: machine(),
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
