-- 收听页要按呼号前缀、DMR ID、mine 和信道做范围查询，这些列原来都没有索引，
-- 会退化成整表扫描。索引配的都是各自查询实际会用到的那一列，不是每一列都配。
CREATE INDEX IF NOT EXISTS activity_callsign ON activity (callsign, start_at);
CREATE INDEX IF NOT EXISTS activity_dmr_id ON activity (dmr_id, start_at);
CREATE INDEX IF NOT EXISTS activity_mine ON activity (mine, start_at);
CREATE INDEX IF NOT EXISTS activity_talkgroup ON activity (talkgroup, start_at);
CREATE INDEX IF NOT EXISTS activity_channel ON activity (channel, start_at);
-- 搜呼号也要从日志里找：呼号来自发射行，也来自已经入库的通联。
CREATE INDEX IF NOT EXISTS qso_call ON qso (call, start_at);
