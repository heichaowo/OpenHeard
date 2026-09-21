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

## 接口

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/ingest/activity` | `IngestRow[]` | `{"received": number, "written": number}` |
| `POST /api/ingest/poll-log` | `PollLog` | `204` |
| `POST /api/ingest/radio` | `RadioStatus` | `204` |

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

模拟守听每秒报一次此刻的样子：频率、信道、增益、校准出来的静默基准、开关门限、此刻 5–9 kHz 的能量、静噪开没开、最近一次打开的时刻。

只留最新一条在内存里，不入库。它描述的是「现在」，重启之后本来就该重新问一次电台，而每秒一行会把库撑满。

形状不对就当没收到，照样回 `204`。这条路上的东西不值得让请求失败，下一秒还有一条。推不上去守护进程也不补发，过期的状态没有价值。

没有它的话，「天线听不见」和「没人在发」在界面上长得一模一样，要分开只能登录到机器上翻日志。`/api/ops` 里 `radio.fresh` 为假就说明守护进程或者接收机出事了。

`fetched` 和 `parsed` 必须分开。来源改字段名时 `parsed` 掉到 0 而 `fetched` 不变，那和稳态下全是重复行的计数长得一样。

写入 `poll_log` 时顺带裁剪。`poll_log` 保留 30 天，`activity` 按配置的 `activityRetentionDays`。提升或忽略引用过的行不裁。

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

## Endpoints

| Method and path | Request | Response |
|---|---|---|
| `POST /api/ingest/activity` | `IngestRow[]` | `{"received": number, "written": number}` |
| `POST /api/ingest/poll-log` | `PollLog` | `204` |
| `POST /api/ingest/radio` | `RadioStatus` | `204` |

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

The analog watch reports itself once a second: frequency, channel, gain, the
idle noise floor it calibrated, the open and close thresholds, the current
5–9 kHz energy, whether the squelch is open, and when it last opened.

Only the latest one is kept, in memory. It describes *now*; after a restart the
radio should be asked again, and a row per second would fill the database.

A malformed body is ignored and still answers `204`. Nothing on this path is
worth failing a request over, and another one arrives a second later. The daemon
does not spool these either — a stale status has no value.

Without it, "the antenna hears nothing" and "nobody is transmitting" look
identical in the UI and telling them apart means reading a log file over ssh.
`radio.fresh` being false in `/api/ops` means the daemon or the receiver is in
trouble.

`fetched` and `parsed` have to stay apart. When a source renames a field,
`parsed` falls to zero while `fetched` does not, and that reads exactly like a
steady state of rows already seen.

Writing a poll log also prunes: `poll_log` keeps 30 days, `activity` keeps
`activityRetentionDays`, and rows referenced by a promotion or an ignore are
never pruned.
