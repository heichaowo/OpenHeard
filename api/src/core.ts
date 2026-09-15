// 唯一引用 core/ 的地方。core/ 将来换成 Rust 时只改这一个文件。
//
// 用相对路径而不是包名：core/ 没有 package.json，而 Node 的 imports 字段
// 不允许映射到包目录之外（ERR_INVALID_PACKAGE_TARGET）。

export {
  adifFile,
  checkQueries,
  bandOf,
  clusterActivities,
  draftFromCluster,
  isValidCallsign,
  missingFields,
  modeOf,
  normalizeCallsign,
} from '../../core/src/index.ts';

export type {
  Activity,
  Channel,
  Cluster,
  Mode,
  Origin,
  PendingItem,
  Qso,
  QsoDraft,
  QsoField,
  StationDefaults,
} from '../../core/src/index.ts';
