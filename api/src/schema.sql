-- 时间一律 Unix 秒 UTC。

CREATE TABLE IF NOT EXISTS activity (
  id            TEXT PRIMARY KEY,   -- 幂等键。数字侧取 BrandMeister 的 SessionID
  origin        TEXT NOT NULL,
  start_at      INTEGER NOT NULL,
  duration_s    REAL NOT NULL,      -- 模拟侧是小数秒
  mine          INTEGER,            -- 模拟侧存 MDC 的判断，数字侧留空，读时按 dmr_id 推
  freq_mhz      REAL,
  channel       TEXT,
  callsign      TEXT,
  dmr_id        INTEGER,
  talkgroup     INTEGER,
  rssi          REAL,
  ber           REAL,
  audio_snr_db  REAL,
  raw           TEXT NOT NULL,      -- 原始行。schema 改了不用重新轮询
  fetched_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_start_at ON activity (start_at);

-- 提升和忽略记在成员行上，不记在 cluster id 上。qso_id 为空表示忽略。
CREATE TABLE IF NOT EXISTS resolved_activity (
  activity_id TEXT PRIMARY KEY,
  qso_id      TEXT,
  resolved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS qso (
  id            TEXT PRIMARY KEY,
  call          TEXT NOT NULL,
  start_at      INTEGER NOT NULL,
  freq_mhz      REAL NOT NULL,
  band          TEXT NOT NULL,
  mode          TEXT NOT NULL,
  rst_sent      TEXT NOT NULL,
  rst_rcvd      TEXT NOT NULL,
  gridsquare    TEXT,
  qth           TEXT,
  my_gridsquare TEXT,
  my_qth        TEXT,
  my_device     TEXT,
  my_antenna    TEXT,
  my_power      TEXT,
  my_height_m   REAL,
  note          TEXT,
  cluster_id    TEXT,               -- 只作溯源，没有外键
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS qso_start_at ON qso (start_at DESC);

-- 每次轮询一行。parsed 和 fetched 分开记，否则 feed 改字段导致全丢时
-- 看起来和「这批全是重复行」一模一样。
CREATE TABLE IF NOT EXISTS poll_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  query_key TEXT NOT NULL,
  at        INTEGER NOT NULL,
  fetched   INTEGER NOT NULL,
  parsed    INTEGER NOT NULL,
  written   INTEGER NOT NULL,
  ok        INTEGER NOT NULL,
  ms        INTEGER NOT NULL,
  error_msg TEXT
);
CREATE INDEX IF NOT EXISTS poll_log_at ON poll_log (at DESC);
