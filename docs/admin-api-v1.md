# 管理端 API v1

管理端的全部接口。`web/` 是它唯一的调用方。

## 认证

`/api/*` 下除 `/api/session` 和 `/api/ingest/*` 外，每条都要会话。没有会话回 `401 {"error":"没登录"}`。

会话是签名 cookie `openheard_session`，HttpOnly，SameSite=Lax，有效期 30 天。服务端不存会话状态，令牌本身是 `<到期秒>.<HMAC>`。换掉配置里的 `sessionSecret` 会让已发出的会话立刻失效。

采集入口走自己的 Bearer token，不看会话，见 [采集 API](ingest-api-v1.md)。

### 会话

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/session` | 无 | `{"signedIn": boolean}` |
| `POST /api/session` | `{"password": string}` | `{"signedIn": true}` 并下发 cookie，口令错回 `401` 且不下发 |
| `DELETE /api/session` | 无 | `{"signedIn": false}` 并清掉 cookie |

口令哈希用 scrypt，放在配置的 `adminPasswordHash`，生成方式见 [配置](configuration.md)。

## 错误

失败一律是 `{"error": string}`，`422` 另带 `missing`，列出还缺哪些字段。

| 状态码 | 什么时候 |
|---|---|
| `401` | 没有会话，或者口令不对 |
| `429` | 登录试得太频繁。一个来源五分钟内最多十次，`Retry-After` 是还要等的秒数。只有一个口令，猜中一次就是全部，而监听地址可以配到局域网 |
| `404` | 要删的通联不存在 |
| `409` | 段的 id 对不上。两次请求之间又入库了更早的发射，聚类边界变了，刷新后重试 |
| `422` | 草稿还缺必填字段，`missing` 里是字段名 |
| `503` | 配置有问题，`problems` 里是原因，此时每条路由都回这个 |

## 本台信息

| 方法和路径 | 响应 |
|---|---|
| `GET /api/station` | `{"station": StationDefaults, "channels": Channel[]}` |

两者都来自配置，不入库。`channels` 是频谱表，快速补录的信道下拉用它。

## 待确认队列

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/pending` | 无 | `PendingItem[]` |
| `POST /api/pending/:clusterId/promote` | `QsoDraft`，可带 `activityIds` | `Qso`，或 `409`、`422` |
| `DELETE /api/pending/:clusterId` | 无，可带 `?activityIds=a,b` | `204`，或 `409` |
| `POST /api/pending/ignore` | `{clusterIds: string[]}` | `{ignored, missing}` |

`PendingItem` 是 `{cluster, draft}`。`cluster` 是按信道和间隔阈值算出来的一段对话，不入库，每次请求重算。`draft` 是机器能预填的部分。

队列只含有本台发射的段，窗口是配置里的 `pendingWindowDays`。

提升和忽略都落在段内每一条发射上，不落在 `cluster.id` 上。`cluster.id` 只够在一次请求往返里指认这一段，后到一条更早的发射或者改了阈值，它就变了。

删掉一条通联会把它占住的发射放回队列。

`activityIds` 只结算这一段里的这几次发射，不给就是整段。聚类按一个间隔阈值猜，会猜错：两段对话挨得近会被并成一段，这时整段提升会把两边记成一条，整段忽略又把两边都丢掉。挑出属于这次通联的那几次，剩下的没有被结算，下一轮重新聚类会自己分出去。

挑的 id 必须真的属于这一段，否则回 `422`。

## 日志

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/qsos` | 无 | `Qso[]`，按开始时间倒序 |
| `GET /api/qsos/:id/history` | 无 | `{at, action, before}[]`，最近的在前 |
| `POST /api/qsos` | `QsoDraft` | `Qso`，或 `422` |
| `PUT /api/qsos/:id` | `QsoDraft` | `Qso`，或 `404`、`422` |
| `DELETE /api/qsos/:id` | 无 | `204`，或 `404` |

`POST` 是手工补录，写进去的记录没有 `clusterId`，也不动 `activity` 表，因为没有任何东西观测到它。
`Qso` 和 `QsoDraft` 只差几个必填项，草稿允许缺字段，缺了会回 `422` 并在 `missing` 里点名。一条完整的记录长这样：

```json
{
  "id": "251c7bd8-5753-4339-a155-841bb96bfccf",
  "call": "BD7KLO",
  "startAt": 1789465773,
  "freqMhz": 439.525,
  "band": "70cm",
  "mode": "FM",
  "rstSent": "59",
  "rstRcvd": "59",
  "gridsquare": "OL72",
  "qth": "深圳",
  "myGridsquare": "OM24",
  "myQth": "成都",
  "myDevice": "Quansheng UV-K6",
  "myAntenna": "Nagoya NA-771",
  "myPower": "5W",
  "myHeightM": 30,
  "note": "中继信号很好",
  "clusterId": "a3",
  "createdAt": 1789465800
}
```

`id`、`createdAt` 和 `clusterId` 由服务端定，请求体里带了也不作数。手工补录只要必填的那几项：

```bash
curl -b cookie.txt -X POST http://127.0.0.1:3000/api/qsos \
  -H 'content-type: application/json' \
  -d '{"call":"BD7KLO","startAt":1789465773,"freqMhz":439.525,
       "band":"70cm","mode":"FM","rstSent":"59","rstRcvd":"59"}'
```


`PUT` 改一条已经入库的。`id`、`createdAt` 和 `clusterId` 保持原样，其余整份替换。`clusterId` 从库里读，请求体里的那个不作数：它是这条记录和当初那几次发射的唯一联系，删了重录就断了，而改一个打错的报告不该把来源一起丢掉。

改和删都会先把改之前那一行存进 `qso_history`，和改动同一个事务。`action` 是 `edit` 或 `delete`，`before` 是那一行当时的完整 JSON。自动来的通联删掉之后那几次发射会回到待确认队列，手工补录的删掉就只剩这一条痕迹。

呼号入库前统一去空格转大写。时间一律 Unix 秒 UTC，界面显示的时区可选，接口不受影响。

## 设置

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/settings` | 无 | `Settings` |
| `PUT /api/settings` | `Settings` | `Settings`，或 `422` |

`Settings` 是配置里人能在界面上改的那部分：`station`、`channels`、`queries`，以及 `analog` 的 `freqMhz`、`channel`、`gainDb`、`myUnitId`。

改不了的留在文件里：`dbPath`、`host`、三个密钥、`recordingsDir`。它们要么一改就要重启整套，要么改错了就把自己关在门外。

写入落盘，先写临时文件再 rename，然后就地更新内存里那份。只改内存的话，launchd 下次重启就悄悄变回去。文件里有密钥，权限保持 `600`，注释键和不在 `Settings` 里的字段原样保留。

守护进程盯着配置文件，改了自己跟上，两个进程之间没有另一条接口。换频率大约有 5 秒听不见，`watchAnalog` 要拿 5 秒静音重算静噪基线。

校验和配置文件那套是同一份，所以界面存不进去的东西，手改文件也起不来。

## 录音

| 方法和路径 | 响应 |
|---|---|
| `GET /api/recordings` | `string[]`，有录音的那几次发射的 id |
| `GET /api/recordings/:id` | `audio/wav`，没有回 `404` |

守护进程把模拟侧每次静噪开启存成 `<activity id>.wav`，目录是配置里 `analog.recordingsDir`。模拟 FM 空中不带身份信息，对方呼号只能靠人回忆，所以确认的时候要能听回去。

要会话。这是本台信道上的音频，不进公开面。列表那条存在是为了让界面知道该给哪几行放播放器，不必挨个探一次 404。

## 运维

| 方法和路径 | 响应 |
|---|---|
| `GET /api/ops` | 健康状态、机器负载和内存、最近 40 次采集、按来源分组的发射数、以及决定行为的配置值 |

不论健康与否都回 `200`，因为这一页的用途是把问题显示出来。要当外部监控用 `GET /health`，它不要会话，只回 `{"ok", "problems"}`，不健康时回 `503`。

`machine` 里是负载、本进程内存、系统内存和已运行时长。负载已经除以核数，直接和 1.0 比。无人值守时跑飞的轮询和内存泄漏只看磁盘看不出来。这几项不进 `/health`，那里只回 `ok` 和 `problems`。

`poll_log` 里 `fetched`、`parsed`、`written` 分开记。来源改字段名时 `parsed` 会掉到 0 而 `fetched` 不变，那和「这批全是重复行」的计数长得一样，只有分开记才分得出来。

---

# Admin API v1 (English)

Every admin endpoint. `web/` is its only caller.

## Authentication

Everything under `/api/*` needs a session except `/api/session` and
`/api/ingest/*`. Without one the answer is `401 {"error":"没登录"}`.

The session is a signed cookie `openheard_session`, HttpOnly, SameSite=Lax,
good for 30 days. No session state is kept on the server; the token is
`<expiry seconds>.<HMAC>`. Changing `sessionSecret` in the config invalidates
every issued session at once.

Ingest carries its own bearer token and ignores the session. See the
[ingest API](ingest-api-v1.md).

### Session

| Method and path | Request | Response |
|---|---|---|
| `GET /api/session` | none | `{"signedIn": boolean}` |
| `POST /api/session` | `{"password": string}` | `{"signedIn": true}` and a cookie; a wrong password gives `401` and no cookie; too many attempts give `429` |
| `DELETE /api/session` | none | `{"signedIn": false}` and clears the cookie |

The password is stored as an scrypt hash in `adminPasswordHash`. See
[configuration](configuration.md) for how to generate it.

## Errors

Failures are `{"error": string}`, including anything uncaught — no route falls
through to a plain-text body. A `422` also carries `missing`, naming the fields
that are still absent.

| Status | When |
|---|---|
| `401` | No session, or the wrong password |
| `429` | Too many login attempts. Ten per source per five minutes; `Retry-After` gives the seconds to wait. There is one password and guessing it once is everything, and the listen address can be on the LAN |
| `404` | The contact to edit or delete does not exist |
| `409` | The cluster id no longer matches. An earlier transmission arrived between the two requests and moved the boundary; refresh and retry |
| `422` | The draft is missing required fields, named in `missing` |
| `503` | The config is broken. `problems` says why, and every route answers this |

## Station

| Method and path | Response |
|---|---|
| `GET /api/station` | `{"station": StationDefaults, "channels": Channel[]}` |

Both come from the config and are never stored. `channels` is the spectrum
table behind the quick-entry channel picker.

## Pending queue

| Method and path | Request | Response |
|---|---|---|
| `GET /api/pending` | none | `PendingItem[]` |
| `POST /api/pending/:clusterId/promote` | `QsoDraft` | `Qso`, or `409`, `422` |
| `DELETE /api/pending/:clusterId` | none, optionally `?activityIds=a,b` | `204`, or `409` |
| `POST /api/pending/ignore` | `{clusterIds: string[]}` | `{ignored, missing}` |

A `PendingItem` is `{cluster, draft}`. The cluster is a conversation derived
from the channel and the gap threshold; it is not stored and is recomputed per
request. The draft is whatever the machine could fill in.

The queue only holds clusters containing one of our own transmissions, within
`pendingWindowDays`.

Promotion and ignore both land on each member transmission, not on
`cluster.id`. That id is only good enough to name the segment across one
request round trip: a late-arriving earlier transmission, or a changed
threshold, changes it.

Deleting a contact releases its transmissions back into the queue.

`activityIds` settles only those transmissions of the segment; without it the
whole segment is settled. Clustering guesses from one gap threshold and gets it
wrong: two conversations close together merge into one segment, where promoting
the whole thing records both as a single contact and ignoring it discards both.
Pick the transmissions that belong to this contact; the rest are left unsettled
and separate on the next clustering.

An id that does not belong to the segment gives `422`.

## Log

| Method and path | Request | Response |
|---|---|---|
| `GET /api/qsos` | none | `Qso[]`, newest first |
| `GET /api/qsos/:id/history` | none | `{at, action, before}[]`, newest first |
| `POST /api/qsos` | `QsoDraft` | `Qso`, or `422` |
| `PUT /api/qsos/:id` | `QsoDraft` | `Qso`, or `404` / `422` |
| `DELETE /api/qsos/:id` | none | `204`, or `404` |

`POST` is manual entry. What it writes carries no `clusterId` and touches no
`activity` row, because nothing observed it.
`Qso` and `QsoDraft` differ only in which fields are required; a draft may be
incomplete, and what is missing comes back in `missing` with a `422`. A
complete record:

```json
{
  "id": "251c7bd8-5753-4339-a155-841bb96bfccf",
  "call": "BD7KLO",
  "startAt": 1789465773,
  "freqMhz": 439.525,
  "band": "70cm",
  "mode": "FM",
  "rstSent": "59",
  "rstRcvd": "59",
  "gridsquare": "OL72",
  "qth": "深圳",
  "myGridsquare": "OM24",
  "myQth": "成都",
  "myDevice": "Quansheng UV-K6",
  "myAntenna": "Nagoya NA-771",
  "myPower": "5W",
  "myHeightM": 30,
  "note": "中继信号很好",
  "clusterId": "a3",
  "createdAt": 1789465800
}
```

`id`, `createdAt` and `clusterId` are set by the server and ignored if sent.
Manual entry needs only the required fields:

```bash
curl -b cookie.txt -X POST http://127.0.0.1:3000/api/qsos \
  -H 'content-type: application/json' \
  -d '{"call":"BD7KLO","startAt":1789465773,"freqMhz":439.525,
       "band":"70cm","mode":"FM","rstSent":"59","rstRcvd":"59"}'
```


`PUT` edits a row already in the log. `id`, `createdAt` and `clusterId` stay
and everything else is replaced. `clusterId` is read from the stored row, not
from the request body: it is the only link back to the transmissions the
contact came from, and correcting a mistyped report should not cost that link.

An edit or a delete first writes the previous row into `qso_history`, in the
same transaction. `action` is `edit` or `delete` and `before` is that row's
full JSON at the time. Deleting an automatically captured contact returns its
transmissions to the pending queue; deleting a manual entry leaves this as the
only trace.

Callsigns are stripped of spaces and upper-cased before storage. Times are
Unix seconds UTC throughout; the display timezone is the operator's choice and
does not reach the API.

## Settings

| Method and path | Request | Response |
|---|---|---|
| `GET /api/settings` | none | `Settings` |
| `PUT /api/settings` | `Settings` | `Settings`, or `422` |

`Settings` is the part of the config a person edits in the UI: `station`,
`channels`, `queries`, and `analog`'s `freqMhz`, `channel`, `gainDb` and
`myUnitId`.

The rest stays in the file: `dbPath`, `host`, the three secrets, and
`recordingsDir`. Each either needs the whole thing restarted or locks you out
if you get it wrong.

Writes go to disk, through a temp file and a rename, and then update the
in-memory config in place. Memory alone would silently revert on launchd's next
restart. The file holds secrets, so it stays `600`, and comment keys and
anything outside `Settings` are preserved.

The daemon watches the config file and follows along; there is no second
interface between the two processes. Retuning costs about five seconds of
deafness while `watchAnalog` rebuilds its squelch baseline from fresh silence.

Validation is the same code the config file goes through, so nothing the UI
refuses would have started from a hand-edited file either.

## Recordings

| Method and path | Response |
|---|---|
| `GET /api/recordings` | `string[]`, the ids of transmissions that have audio |
| `GET /api/recordings/:id` | `audio/wav`, or `404` |

The daemon writes each analog squelch opening to `<activity id>.wav` under
`analog.recordingsDir`. Analog FM carries no identity, so the far station's
callsign comes from the operator's memory — being able to listen again is what
makes that accurate.

Both need a session. This is audio off our own channel and does not reach the
public face. The list exists so the UI knows which rows get a player without
probing each one for a 404.

## Operations

| Method and path | Response |
|---|---|
| `GET /api/ops` | Health, machine load and memory, the last 40 polls, activity counts by origin, and the config values that decide behaviour |

It answers `200` whether healthy or not, because the page exists to display
problems. For an external monitor use `GET /health`: no session, only
`{"ok", "problems"}`, and `503` when unhealthy.

`machine` carries load, this process's memory, system memory and uptime. Load
is already divided by the core count, so it compares against 1.0. Unattended,
a runaway poll loop or a leak shows up in none of the other figures until the
disk fills. None of it is in `/health`, which answers only `ok` and
`problems`.

`poll_log` records `fetched`, `parsed` and `written` separately. When a feed
renames a field, `parsed` drops to zero while `fetched` does not, and that
reads exactly like a batch of rows already seen unless the two are apart.
