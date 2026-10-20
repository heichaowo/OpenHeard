# 采集 API v1

守护进程往这里推。它是两个可执行体之间唯一的接口。

## 为什么是 HTTP 而不是直接写库

守护进程不开数据库，API 是 SQLite 的唯一写入者。这样守护进程在一台没有数据库的机器上也能单独验证，并发写的问题也一并没有了。

## 认证

`Authorization: Bearer <ingestToken>`，token 在配置里。不看会话，因为推送方是进程不是人，而且将来 SDR 那侧可能从另一个进程推过来。

token 不对回 `401`。

## 幂等

判重在写入端做，键是 `Activity.id`，数字侧取 BrandMeister 的 `SessionID`，模拟侧取信道和起始时刻算出来的散列。重复推送没有副作用，返回的 `written` 会是 0。

守护进程因此可以放心重发。取回的行推不上去时先落盘，下一轮开始前补发，成功才删文件。

有一种例外：删掉的发射。人在收听页删掉一段对话时，api 给每个 id 记一条墓碑，之后再推来的同一个 id 不写回，也不算进 `written`。BrandMeister 每次轮询都重新取回最近的一批，守护进程也会把落盘的批次补发，没有墓碑的话，删掉的对话下一轮就回来了。墓碑和发射用同一个保留期。

## 接口

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/ingest/activity` | `IngestRow[]` | `{"received": number, "written": number}` |
| `POST /api/ingest/poll-log` | `PollLog` | `204` |
| `POST /api/ingest/radio` | `RadioStatus[]` | `204` |
| `GET /api/ingest/ai/todo` | `?limit=N&steps=vad,asr,text` | `{"items": TodoItem[]}` |
| `POST /api/ingest/ai` | `AiResult[]` | `{"written": number}` |
| `POST /api/ingest/ai/status` | `{"ok": boolean, "message": string}` | `204` |

### IngestRow

| 字段 | 说明 |
|---|---|
| `activity` | 归一化之后的 `Activity` |
| `raw` | 原始行的 JSON 字符串 |

`raw` 要留着。schema 改了不用重新轮询，而热闹话务组只回溯几十分钟，错过就真的取不回来。

写入时数字侧的 `mine` 不入库，读取时按 `dmr_id` 和配置里的 DMR ID 推。这样改了配置或者补上 ID，历史行跟着一起对，不用手工 UPDATE 一张只追加的表。模拟侧的 `mine` 来自 MDC-1200，没法重算，要存。

### PollLog

| 字段 | 说明 |
|---|---|
| `queryKey` | 哪条查询，例如 `dst:46001` 或 `analog:438.700 直频` |
| `at` | Unix 秒 UTC |
| `fetched` | 来源返回多少行 |
| `parsed` | 归一化成功多少行 |
| `written` | 真正新增多少行。推送方先填 0，拿到 `/api/ingest/activity` 的回应之后填上真数，再发这一条 |
| `ok`、`ms`、`errorMsg` | 这次成没成、处理这一批花了多久、失败原因 |

`ms` 一律是处理耗时，模拟侧也一样。那次发射本身多长在 `Activity.durationS` 里，塞进 `ms` 会让运维页同一列有两种含义。

### RadioStatus

模拟守听每秒报一次此刻的样子，一个信道一条：频率、信道、增益、此刻的静默基准、开关门限、此刻 5–9 kHz 的能量、静噪开没开、最近一次打开的时刻。只守一个信道时报的是单个对象，也照样认。

只留最新一批在内存里，不入库。新的一批就是全部信道，不在里面的信道从运维页上去掉。它描述的是「现在」，重启之后本来就该重新问一次电台，而每秒一行会把库撑满。

形状不对就当没收到，照样回 `204`。这条路上的东西不值得让请求失败，下一秒还有一条。推不上去守护进程也不补发，过期的状态没有价值。

没有它的话，「天线听不见」和「没人在发」在界面上长得一模一样，要分开只能登录到机器上翻日志。`/api/ops` 里 `radios[].fresh` 为假就说明守护进程或者接收机出事了。

`fetched` 和 `parsed` 必须分开。来源改字段名时 `parsed` 掉到 0 而 `fetched` 不变，那和稳态下全是重复行的计数长得一样。

写入 `poll_log` 时顺带裁剪。`poll_log` 保留 30 天，`activity` 按配置的 `activityRetentionDays`。提升或忽略引用过的行不裁。发射被裁掉时，它的识别结果、人工判定和过期的墓碑一起裁。

## 识别队列

守护进程向 api 要还没识别的录音，做完把结果推回来。队列只管模拟 FM 的发射，数字侧没有录音。

### 待识别

`GET /api/ingest/ai/todo?limit=N&steps=vad,asr,text` 返回 `{"items": TodoItem[]}`。

- `limit` 是 1 到 50，缺省 10
- `steps` 是守护进程开着的步骤，逗号隔开，只认 `vad`、`asr`、`text`。不给就等于一步都没开
- `limit` 或 `steps` 不对，回 `422`

`TodoItem` 是 `{id, startAt, durationS, mine, channel?, hasSpeech?, transcript?}`。新的在前。一次发射要同时满足这些，才会返回：

- 它是模拟 FM 的发射，开始时刻在保留期内
- `<recordingsDir>/<id>.wav` 存在
- 下面四条至少满足一条

1. 没有识别记录
2. 记录里有错误，`attempts` 小于 3，距上次写入超过一小时
3. 没有错误，有人声（`has_speech` 不是 0），`steps` 含 `asr`，还没有识别模型
4. 没有错误，有人声，`steps` 含 `text`，转写不是空的，还没有提取模型

只有第 4 条的行带 `hasSpeech` 和 `transcript`，守护进程据此只做提取，不再识别一遍。别的行都不带。

录音文件只对候选行检查，一页一页读，凑够 `limit` 条就停。录音不在的行不返回。查询走 `activity_origin` 索引，从新往旧读，不扫整张 `activity`。

出错的行最多做 3 次，每次隔一小时。用满了就不再返回。换了 key 或者下好了模型之后，不用等：设置页改了 `ai` 的值，或者 api 重启，就清掉所有出错的记录，队列重新做。

### 推结果

`POST /api/ingest/ai` 的请求体是 `AiResult[]`，返回 `{"written": number}`。

| 字段 | 说明 |
|---|---|
| `activityId` | 发射 id，必填 |
| `hasSpeech` | 有没有人声。布尔值，不是就当没给 |
| `transcript` | 识别出的原文，最多 4000 个字符。空串要留着，它表示识别跑过了但什么都没听出来 |
| `category` | `qso`、`test` 或 `noise`，别的值丢掉 |
| `fields` | 提取出的字段 `{call, calledCall, qth, rst, device, antenna, power, height}` |
| `asrModel`、`textModel` | 模型名。没跑那一步就不给 |
| `error` | 这次出错的原因，最多 300 个字符 |

写入规则：

- 同一个 `activityId` 合并进已有的记录。后一步只填自己的列，不擦掉前面的。`fields` 整个替换
- 已有记录带错误时，这次写入算重试，`attempts` 加 1。这次没带 `error`，错误就清掉
- `at` 由 api 定。请求里带的 `at` 不作数，重试间隔靠它算
- 不存在的发射 id 丢掉，被裁、被删（有墓碑）的也一样，不算在 `written` 里
- 字符串去掉首尾空白再截断：`transcript` 4000，每个 `fields` 值 100
- `fields.rst` 要匹配 `^[1-5][1-9][1-9]?$`，`fields.power` 要匹配 `^\d+(\.\d+)?W$`，不匹配就丢
- `fields.call` 和 `fields.calledCall` 规整成大写，不像呼号就丢
- 不认识的键丢掉。每个不合格的值只丢它自己，别的照存。`activityId` 不是字符串的整条丢掉
- 请求体不是数组回 `422`
- `meaningless` 由 api 算，规则见 [管理端 API](admin-api-v1.md) 的「无意义」

### 工作线程状态

`POST /api/ingest/ai/status` 的请求体是 `{"ok": boolean, "message": string}`，返回 `204`。它描述识别线程自己的状态，例如缺模型文件、云端 key 不对。这类错误不记在发射行上，不然一次配错就把整个积压的重试次数用光。

和 `/api/ingest/radio` 一样，只留最新一条在内存里，不入库，不补发。`/api/ops` 的 `ai.worker` 读它，`at` 是 api 收到的时刻。形状不对回 `422`。

---

# Ingest API v1 (English)

Where the daemon pushes. It is the only interface between the two
executables.

## Why HTTP instead of writing the database

The daemon does not open the database; the API is SQLite's only writer. That
lets the daemon be verified on a machine with no database at all, and it
removes concurrent writes as a question.

## Authentication

`Authorization: Bearer <ingestToken>`, from the config. It ignores the
session, because the caller is a process rather than a person, and because the
SDR side may one day push from a second process.

A wrong token gives `401`.

## Idempotence

Duplicates are dropped at the writer, keyed on `Activity.id`: BrandMeister's
`SessionID` on the digital side, a hash of channel and start time on the
analog side. Re-pushing has no effect and comes back with `written` at zero.

The daemon relies on this. Rows it cannot push go to disk and are replayed at
the start of the next round, with the file deleted only on success.

One exception: deleted transmissions. When a person deletes a conversation on
the listening page, the api records a tombstone for each id, and the same id
pushed again is neither written nor counted in `written`. BrandMeister returns
the latest batch again on every poll and the daemon replays spooled batches;
without a tombstone the deleted conversation would be back on the next round.
A tombstone has the same retention as an activity.

## Endpoints

| Method and path | Request | Response |
|---|---|---|
| `POST /api/ingest/activity` | `IngestRow[]` | `{"received": number, "written": number}` |
| `POST /api/ingest/poll-log` | `PollLog` | `204` |
| `POST /api/ingest/radio` | `RadioStatus[]` | `204` |
| `GET /api/ingest/ai/todo` | `?limit=N&steps=vad,asr,text` | `{"items": TodoItem[]}` |
| `POST /api/ingest/ai` | `AiResult[]` | `{"written": number}` |
| `POST /api/ingest/ai/status` | `{"ok": boolean, "message": string}` | `204` |

### IngestRow

| Field | Meaning |
|---|---|
| `activity` | The normalised `Activity` |
| `raw` | The original row as a JSON string |

Keep `raw`. A schema change then costs no re-polling, and a busy talkgroup
only reaches back tens of minutes, so what is missed is gone.

`mine` is not stored for digital rows; it is derived on read from `dmr_id`
against the configured DMR ID. Correcting or supplying that id then fixes the
history too, with no hand-written UPDATE against an append-only table. On the
analog side `mine` comes from MDC-1200, cannot be recomputed, and is stored.

### PollLog

| Field | Meaning |
|---|---|
| `queryKey` | Which query, e.g. `dst:46001` or `analog:438.700 直频` |
| `at` | Unix seconds UTC |
| `fetched` | How many rows the source returned |
| `parsed` | How many normalised successfully |
| `written` | How many rows were actually new. The caller sends zero, then fills in the real count from the `/api/ingest/activity` response before sending this |
| `ok`, `ms`, `errorMsg` | Whether it worked, how long the batch took to handle, and why not |

`ms` is always handling time, on the analog side too. How long the transmission itself lasted is `Activity.durationS`; putting it in `ms` would give one column on the ops page two meanings.

### RadioStatus

The analog watch reports itself once a second, one entry per channel:
frequency, channel, gain, the current idle noise floor, the open and close
thresholds, the current 5–9 kHz energy, whether the squelch is open, and when
it last opened. A single object, as sent when only one channel was watched, is
still accepted.

Only the latest batch is kept, in memory. A new batch is the whole set of
channels, and a channel missing from it drops off the ops page. It describes *now*; after a restart the
radio should be asked again, and a row per second would fill the database.

A malformed body is ignored and still answers `204`. Nothing on this path is
worth failing a request over, and another one arrives a second later. The daemon
does not spool these either — a stale status has no value.

Without it, "the antenna hears nothing" and "nobody is transmitting" look
identical in the UI and telling them apart means reading a log file over ssh.
`radios[].fresh` being false in `/api/ops` means the daemon or the receiver is
in trouble.

`fetched` and `parsed` have to stay apart. When a source renames a field,
`parsed` falls to zero while `fetched` does not, and that reads exactly like a
steady state of rows already seen.

Writing a poll log also prunes: `poll_log` keeps 30 days, `activity` keeps
`activityRetentionDays`, and rows referenced by a promotion or an ignore are
never pruned. When an activity is pruned, its recognition result, human verdict
and any expired tombstones go with it.

## The recognition queue

The daemon asks the api for recordings not yet recognised, and pushes results
back. The queue covers analog FM transmissions only; digital ones have no
recording.

### To do

`GET /api/ingest/ai/todo?limit=N&steps=vad,asr,text` returns
`{"items": TodoItem[]}`.

- `limit` is 1 to 50, default 10
- `steps` lists the steps the daemon has on, comma separated, and only `vad`,
  `asr` and `text` are accepted. Leaving it out means no step is on
- A bad `limit` or `steps` is `422`

A `TodoItem` is `{id, startAt, durationS, mine, channel?, hasSpeech?,
transcript?}`, newest first. A transmission is returned only when all of these
hold:

- It is an analog FM transmission, started within the retention period
- `<recordingsDir>/<id>.wav` exists
- At least one of the four conditions below holds

1. There is no recognition row
2. The row holds an error, `attempts` is below 3, and the last write was over
   an hour ago
3. No error, speech present (`has_speech` is not 0), `steps` has `asr`, and
   there is no recognition model yet
4. No error, speech present, `steps` has `text`, the transcript is not empty,
   and there is no extraction model yet

Only condition-4 rows carry `hasSpeech` and `transcript`, so the daemon runs
extraction alone and does not recognise again. Other rows carry neither.

File existence is checked only for candidate rows, read a page at a time and
stopping once `limit` is reached. A row whose recording is gone is not
returned. The query uses the `activity_origin` index, reading newest first, and
never scans the whole `activity` table.

A row with an error is tried at most 3 times, an hour apart, then it stops
being returned. After fixing a key or finishing a model download there is no
need to wait: changing the `ai` values in the settings, or restarting the api,
deletes every row that holds an error, and the queue does them again.

### Pushing results

`POST /api/ingest/ai` takes `AiResult[]` and returns `{"written": number}`.

| Field | Meaning |
|---|---|
| `activityId` | The transmission id, required |
| `hasSpeech` | Whether there is speech. A boolean; anything else counts as absent |
| `transcript` | The recognised text, at most 4000 characters. Keep an empty string: it means recognition ran and heard nothing |
| `category` | `qso`, `test` or `noise`; any other value is dropped |
| `fields` | The extracted fields `{call, calledCall, qth, rst, device, antenna, power, height}` |
| `asrModel`, `textModel` | Model names. Leave out a step that did not run |
| `error` | Why this attempt failed, at most 300 characters |

Write rules:

- A result merges into the existing row for the same `activityId`. A later
  step fills only its own columns and does not erase earlier ones. `fields` is
  replaced as a whole
- When the existing row holds an error, this write counts as a retry and
  `attempts` goes up by one. If this write has no `error`, the error is cleared
- The api sets `at` itself. A client `at` is ignored, and the retry gap
  depends on it
- An unknown activity id is dropped, and so is one that was pruned or deleted
  (it has a tombstone). It is not counted in `written`
- Strings are trimmed and capped: `transcript` at 4000, each `fields` value at
  100
- `fields.rst` must match `^[1-5][1-9][1-9]?$` and `fields.power` must match
  `^\d+(\.\d+)?W$`, or it is dropped
- `fields.call` and `fields.calledCall` are normalised to upper case and
  dropped unless they look like a callsign
- Unknown keys are dropped. An invalid value drops only itself and the rest is
  stored. A result whose `activityId` is not a string is dropped whole
- A body that is not an array is `422`
- The api computes `meaningless`; the rule is under "Meaningless" in the
  [admin API](admin-api-v1.md)

### Worker status

`POST /api/ingest/ai/status` takes `{"ok": boolean, "message": string}` and
returns `204`. It describes the recognition worker itself, for example a
missing model file or a wrong cloud key. Such errors are not recorded on the
transmission rows, or one misconfiguration would use up the retries of the
whole backlog.

Like `/api/ingest/radio`, only the latest one is kept, in memory, not stored,
not replayed. `ai.worker` in `/api/ops` reads it, and `at` is when the api
received it. A bad shape is `422`.
