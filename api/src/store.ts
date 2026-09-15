import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import {
  clusterActivities,
  draftFromCluster,
  missingFields,
  normalizeCallsign,
} from './core.ts';
import type { Channel, Cluster, PendingItem, Qso, QsoDraft, StationDefaults } from './core.ts';
import {
  deleteQso,
  insertQso,
  resolveActivities,
  selectQsos,
  selectUnresolvedActivities,
  withTx,
} from './db.ts';

const nowS = () => Math.floor(Date.now() / 1000);

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

    pending: (): PendingItem[] =>
      clusters().map((cluster) => ({
        cluster,
        draft: draftFromCluster(cluster, config.station),
      })),

    qsos: () => selectQsos(db),

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

    removeQso: (id: string): void => {
      if (!deleteQso(db, id)) throw new StoreError(404, '没有这条通联');
    },
  };
}

export type Store = ReturnType<typeof createStore>;
