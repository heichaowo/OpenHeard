-- 第 4 版：AI 识别结果、人工判定、删除留下的墓碑，以及按来源找发射的索引。
-- 全是新增，已经在跑的库跑完这一版不丢任何东西。

-- 识别队列只要 sdr-fm 的行。没有这个索引，每次要待识别的录音都扫整张 activity。
CREATE INDEX IF NOT EXISTS activity_origin ON activity(origin, start_at);

-- 删掉的发射。BrandMeister 每次轮询都重新取回最近的行，守护进程的落盘批次也会补发，
-- 没有它，删掉的对话下一轮就回来了。过了保留期的墓碑一起裁。
CREATE TABLE IF NOT EXISTS deleted_activity (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deleted_activity_at ON deleted_activity(deleted_at);

-- 每次发射的识别结果。按发射 id 存，发射被裁或被删时跟着删。
CREATE TABLE IF NOT EXISTS activity_ai (
  activity_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,          -- 最后一次写入的服务端时刻
  attempts INTEGER NOT NULL DEFAULT 1,
  has_speech INTEGER,           -- 1 / 0；没开 VAD 时是 NULL
  transcript TEXT,              -- 识别出的原文。过滤判成没人声时也留着
  category TEXT,                -- 'qso' | 'test' | 'noise' | NULL
  fields TEXT,                  -- AiFields 的 JSON；没跑文字提取时是 NULL
  meaningless INTEGER NOT NULL, -- AI 的判定，由 api 算
  asr_model TEXT,               -- 没跑识别时是 NULL
  text_model TEXT,              -- 没跑文字提取时是 NULL
  error TEXT
);

-- 人工判定，压过 activity_ai。
CREATE TABLE IF NOT EXISTS activity_verdict (
  activity_id TEXT PRIMARY KEY,
  meaningless INTEGER NOT NULL,
  at INTEGER NOT NULL
);
