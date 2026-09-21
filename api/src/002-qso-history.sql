-- 通联改过删过要留痕。qso 是人判断出来的结果，重建不出来，
-- 而原来的 UPDATE 直接覆盖、DELETE 直接抹掉，事后看不出发生过什么。
CREATE TABLE IF NOT EXISTS qso_history (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  qso_id  TEXT NOT NULL,
  at      INTEGER NOT NULL,   -- Unix 秒 UTC
  action  TEXT NOT NULL,      -- edit 或 delete
  before  TEXT NOT NULL       -- 改之前那一行的 JSON
);
CREATE INDEX IF NOT EXISTS qso_history_qso ON qso_history (qso_id, at DESC);
