import { DatabaseSync } from 'node:sqlite';
import type { Activity, Qso } from './core.ts';
import { migrate } from './migrations.ts';

/** 采集端推过来的一行：归一化结果加上原始行。 */
export interface IngestRow {
  activity: Activity;
  /** 原始 JSON。schema 改了不用重新轮询，而热闹话务组错过就取不回来。 */
  raw: string;
}

export interface PollLog {
  queryKey: string;
  at: number;
  /** 来源返回多少行。 */
  fetched: number;
  /** 归一化成功多少行。和 fetched 分开记，否则字段改名导致全丢时看起来像稳态。 */
  parsed: number;
  /** 真正新增多少行。 */
  written: number;
  ok: boolean;
  ms: number;
  errorMsg?: string;
}

export function openDb(path: string): DatabaseSync {
  // node:sqlite 开库就把外键打开了，所以要关只能在这里关。现在一条外键也没有，
  // 但重建表那种迁移要求外键是关的，而 PRAGMA foreign_keys 在事务里不生效，
  // 迁移又每一版一个事务，到那时再想关就没地方关了。
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** node:sqlite 没有 better-sqlite3 那个 transaction 包装，自己补一个。 */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const bool = (v: unknown) => (v === null || v === undefined ? undefined : v === 1);
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

/**
 * 一行 activity 转回 Activity。
 *
 * 数字侧的 mine 不入库，按 dmr_id 推。配置里的 DMR ID 改了或补上了，
 * 历史行跟着一起对，不用手工 UPDATE 一张只追加的表。
 */
export function rowToActivity(row: Record<string, unknown>, dmrId: number): Activity {
  const dbMine = bool(row.mine);
  return {
    id: String(row.id),
    origin: row.origin as Activity['origin'],
    startAt: Number(row.start_at),
    durationS: Number(row.duration_s),
    mine: dbMine ?? (row.dmr_id !== null && Number(row.dmr_id) === dmrId),
    freqMhz: num(row.freq_mhz),
    channel: str(row.channel),
    callsign: str(row.callsign),
    dmrId: num(row.dmr_id),
    talkgroup: num(row.talkgroup),
    rssi: num(row.rssi),
    ber: num(row.ber),
    audioSnrDb: num(row.audio_snr_db),
  };
}

const nul = <T>(v: T | undefined) => (v === undefined ? null : v);

/** 判重在写入端做，主键冲突就跳过。返回真正新增的行数。 */
export function insertActivities(
  db: DatabaseSync,
  rows: IngestRow[],
  fetchedAt: number,
): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO activity
      (id, origin, start_at, duration_s, mine, freq_mhz, channel, callsign,
       dmr_id, talkgroup, rssi, ber, audio_snr_db, raw, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  return withTx(db, () => {
    let written = 0;
    for (const { activity: a, raw } of rows) {
      // 数字侧的 mine 是推导出来的，不存。模拟侧靠 MDC 判断，没法重算，要存。
      const mine = a.origin === 'brandmeister' ? null : a.mine ? 1 : 0;
      const r = stmt.run(
        a.id, a.origin, a.startAt, a.durationS, mine, nul(a.freqMhz), nul(a.channel),
        nul(a.callsign), nul(a.dmrId), nul(a.talkgroup), nul(a.rssi), nul(a.ber),
        nul(a.audioSnrDb), raw, fetchedAt,
      );
      written += Number(r.changes);
    }
    return written;
  });
}

/** 取还没被提升也没被忽略的发射，只看窗口内的。 */
export function selectUnresolvedActivities(
  db: DatabaseSync,
  sinceUnix: number,
  dmrId: number,
): Activity[] {
  const rows = db
    .prepare(`
      SELECT a.* FROM activity a
      LEFT JOIN resolved_activity r ON r.activity_id = a.id
      WHERE a.start_at > ? AND r.activity_id IS NULL
      ORDER BY a.start_at
    `)
    .all(sinceUnix) as Record<string, unknown>[];
  return rows.map((r) => rowToActivity(r, dmrId));
}

/** 把一段对话的全部成员标成已处理。qsoId 为 null 表示忽略。 */
export function resolveActivities(
  db: DatabaseSync,
  activityIds: string[],
  qsoId: string | null,
  at: number,
): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO resolved_activity (activity_id, qso_id, resolved_at) VALUES (?,?,?)',
  );
  for (const id of activityIds) stmt.run(id, qsoId, at);
}

export function insertQso(db: DatabaseSync, q: Qso): void {
  db.prepare(`
    INSERT INTO qso
      (id, call, start_at, freq_mhz, band, mode, rst_sent, rst_rcvd, gridsquare, qth,
       my_gridsquare, my_qth, my_device, my_antenna, my_power, my_height_m,
       note, cluster_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    q.id, q.call, q.startAt, q.freqMhz, q.band, q.mode, q.rstSent, q.rstRcvd,
    nul(q.gridsquare), nul(q.qth), nul(q.myGridsquare), nul(q.myQth), nul(q.myDevice),
    nul(q.myAntenna), nul(q.myPower), nul(q.myHeightM), nul(q.note), nul(q.clusterId),
    q.createdAt,
  );
}

export function rowToQso(r: Record<string, unknown>): Qso {
  return {
    id: String(r.id),
    call: String(r.call),
    startAt: Number(r.start_at),
    freqMhz: Number(r.freq_mhz),
    band: String(r.band),
    mode: r.mode as Qso['mode'],
    rstSent: String(r.rst_sent),
    rstRcvd: String(r.rst_rcvd),
    gridsquare: str(r.gridsquare),
    qth: str(r.qth),
    myGridsquare: str(r.my_gridsquare),
    myQth: str(r.my_qth),
    myDevice: str(r.my_device),
    myAntenna: str(r.my_antenna),
    myPower: str(r.my_power),
    myHeightM: num(r.my_height_m),
    note: str(r.note),
    clusterId: str(r.cluster_id),
    createdAt: Number(r.created_at),
  };
}

export function selectQsos(db: DatabaseSync): Qso[] {
  const rows = db
    .prepare('SELECT * FROM qso ORDER BY start_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToQso);
}

export function selectQso(db: DatabaseSync, id: string): Qso | undefined {
  const row = db.prepare('SELECT * FROM qso WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? undefined : rowToQso(row);
}

/**
 * 改一条已经入库的通联。
 *
 * id、created_at 和 cluster_id 不动。cluster_id 是这条记录和当初那几次发射的
 * 唯一联系，删了重录就断了，而改一个打错的 RST 不该把来源也一起丢掉。
 */
export function updateQso(db: DatabaseSync, q: Qso): boolean {
  const r = db.prepare(`
    UPDATE qso SET
      call = ?, start_at = ?, freq_mhz = ?, band = ?, mode = ?,
      rst_sent = ?, rst_rcvd = ?, gridsquare = ?, qth = ?,
      my_gridsquare = ?, my_qth = ?, my_device = ?, my_antenna = ?,
      my_power = ?, my_height_m = ?, note = ?
    WHERE id = ?
  `).run(
    q.call, q.startAt, q.freqMhz, q.band, q.mode, q.rstSent, q.rstRcvd,
    nul(q.gridsquare), nul(q.qth), nul(q.myGridsquare), nul(q.myQth), nul(q.myDevice),
    nul(q.myAntenna), nul(q.myPower), nul(q.myHeightM), nul(q.note),
    q.id,
  );
  return Number(r.changes) > 0;
}

/** 删掉一条通联，并把它占住的 activity 放回待确认队列。 */
export function deleteQso(db: DatabaseSync, id: string): boolean {
  return withTx(db, () => {
    db.prepare('DELETE FROM resolved_activity WHERE qso_id = ?').run(id);
    return Number(db.prepare('DELETE FROM qso WHERE id = ?').run(id).changes) > 0;
  });
}

export function insertPollLog(db: DatabaseSync, p: PollLog): void {
  db.prepare(`
    INSERT INTO poll_log (query_key, at, fetched, parsed, written, ok, ms, error_msg)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(p.queryKey, p.at, p.fetched, p.parsed, p.written, p.ok ? 1 : 0, p.ms, nul(p.errorMsg));
}

/** 运维页要看的：最近若干次轮询。 */
export function selectPollLog(db: DatabaseSync, limit: number): PollLog[] {
  const rows = db
    .prepare('SELECT * FROM poll_log ORDER BY at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    queryKey: String(r.query_key),
    at: Number(r.at),
    fetched: Number(r.fetched),
    parsed: Number(r.parsed),
    written: Number(r.written),
    ok: r.ok === 1,
    ms: Number(r.ms),
    errorMsg: str(r.error_msg),
  }));
}

/** 采集来的发射，按来源分组数一数。 */
export function activityCounts(db: DatabaseSync): { origin: string; n: number; latest: number }[] {
  return db
    .prepare('SELECT origin, COUNT(*) AS n, MAX(start_at) AS latest FROM activity GROUP BY origin')
    .all() as { origin: string; n: number; latest: number }[];
}

/** activity 有保留期，qso 没有。已经被提升或忽略引用的行不裁。 */
export function pruneActivities(db: DatabaseSync, olderThan: number): number {
  const r = db
    .prepare(`
      DELETE FROM activity WHERE start_at < ?
        AND id NOT IN (SELECT activity_id FROM resolved_activity)
    `)
    .run(olderThan);
  return Number(r.changes);
}

export function prunePollLog(db: DatabaseSync, olderThan: number): number {
  return Number(db.prepare('DELETE FROM poll_log WHERE at < ?').run(olderThan).changes);
}
