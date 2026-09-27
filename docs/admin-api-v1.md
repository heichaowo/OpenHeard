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
| `409` | 结算按发射 id：挑的 id 里有不存在的，或者有已经结算过的。刷新后重试，见「按发射 id 结算」 |
| `413` | 请求体超过 16 MB |
| `422` | 草稿还缺必填字段，`missing` 里是字段名。`activityIds` 是空数组，或者不是字符串数组，都回这个。挑的发射不在同一条信道上，也回这个 |
| `503` | 配置有问题，`problems` 里是原因。此时每条路由都回这个 |

## 本台信息

| 方法和路径 | 响应 |
|---|---|
| `GET /api/station` | `{"station": StationDefaults, "channels": Channel[]}` |

两者都来自配置，不入库。`channels` 是频谱表，快速补录的信道下拉用它。

## 待确认队列

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/pending` | 无 | `PendingItem[]` |

`PendingItem` 是 `{cluster, draft}`。`cluster` 是按信道和间隔阈值算出来的一段对话，不入库，每次请求重算。`draft` 是机器能预填的部分。

队列只含有本台发射的段，窗口是配置里的 `pendingWindowDays`。这条接口只用来读。结算走下面「按发射 id 结算」那两条，不再有按 `cluster.id` 提升、忽略、删除的路由。

删掉一条通联会把它占住的发射放回队列。

## 收听页：对话

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/conversations` | 见下 | `{items, next?, channels?, total?}`，或 `422` |
| `POST /api/conversations/promote` | `QsoDraft` 加 `activityIds` | `Qso`，`201`，或 `409`、`422` |
| `POST /api/conversations/ignore` | `{picks: {id, activityIds}[]}` | `{ignored, missing}` |

收听页把待确认、未入库、已入库、已忽略、旁听这五档对话，当成同一张图来看。三个视图选一个，多给或者少给都回 `422`：

- 按天看：带 `from` 和 `to`，Unix 秒，`from` 小于 `to`。跨度最多 172800 秒。返回 `startAt` 落在 `[from, to)` 里的对话。`channels` 是这一天这个来源里出现过的信道
- 未入库：`view=unlogged`。返回出了待确认窗口、还没结算的本台对话。`total` 是这一档的总数
- 按呼号搜：`q`，前缀匹配，归一化之后至少两个字符。跨整个保留期，不带 `total`

三个视图都能再叠加 `origin`、`status`、`channel` 过滤。分页用同一套 `limit`（1 到 200，缺省 50）和 `cursor`。`cursor` 是上一页 `next` 原样传回来。翻到满一页会多给一个 `next`。

`Conversation` 形状：

```json
{
  "id": "a3",
  "startAt": 1789465773,
  "endAt": 1789465793,
  "channel": "tg:46001",
  "origin": "brandmeister",
  "status": "pending",
  "activities": [ ],
  "qso": { "id": "…", "call": "BD7KLO", "rstSent": "59", "rstRcvd": "59" },
  "draft": { }
}
```

`status` 是 `pending`、`unlogged`、`logged`、`ignored`、`overheard` 之一。`qso` 只在 `logged` 时才有。`draft` 只在没结算的三档才有，形状和 `PendingItem.draft` 一样。

### 按发射 id 结算

提升和忽略都认发射的 id，不认对话的 `id`。界面把看过的那几次发射的 id 收集起来，一起交上来。检查按这个顺序来：

1. 一个都没给：`422`
2. 同一个 id 出现了两次：`422`
3. 有 id 已经不存在：`409`
4. 有 id 已经结算过：`409`
5. 这几个 id 不在同一条信道上：`422`

`/promote` 按上面五条检查，通过之后再检查草稿字段是否齐全，缺了回 `422` 并在 `missing` 里点名。服务端存下收到的草稿，不重新算开始时间和对方呼号，界面已经按挑中的那几次算过了。`qso.clusterId` 取挑中的那几个里 `(startAt, id)` 最小的一个。

`/ignore` 里任何一个 `pick` 没通过上面的检查，就把它的 `id` 记进 `missing`。这不影响别的 `pick`。同一个请求里，更早的一个合法 `pick` 用过某个 id 之后，后面再挑到它也算「已经结算过」。合法的那些一次事务写完。响应一律 `200`。

请求体本身不对才回 `422`。`picks` 不是数组算不对。`id` 不是字符串算不对。`activityIds` 不是字符串数组也算不对。

## 收听记录

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/activities` | 可带 `?origin=sdr-fm&cursor=…&limit=100` | `{items, next?}`，或 `422` |

`items` 是 `Activity[]`，最新的在前，结算过的另带 `settled`：`logged` 是已入库，`ignored` 是已忽略。它列出听到的每一次发射，别的电台单独发的也在里面，待确认队列不放这种。

`origin` 是 `brandmeister`、`sdr-fm` 或 `sdr-dmr`，不给就是全部。`limit` 缺省 100，最多 200。

要更早的一页，把 `next` 原样作为 `cursor` 传回来。没有 `next` 就是翻到头了。游标是上一页最后一行的时刻和 id，不是偏移量，翻页时进来的新行不会让下一页错位或者重复。

## 日志

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/qsos` | 无 | `Qso[]`，按开始时间倒序，每条带 `activities` |
| `GET /api/qsos/:id/history` | 无 | `{at, action, before}[]`，最近的在前 |
| `POST /api/qsos` | `QsoDraft` | `Qso`，或 `422` |
| `PUT /api/qsos/:id` | `QsoDraft` | `Qso`，或 `404`、`422` |
| `POST /api/qsos/import` | ADIF 文本 | `{parsed, imported, skipped, problems}` |
| `DELETE /api/qsos/:id` | 无 | `204`，或 `404` |

`activities` 是 `{id, startAt, durationS}[]`，按时间升序，是这条通联结算时用到的那几次发射。手工补录和 ADIF 导入的通联没有观测，`activities` 是空数组。这个字段只在这条守会话的接口上有，`/public/qsos` 不带它。

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

导入直接把 ADIF 文本当请求体，不走 multipart。一个人从浏览器传一个文件，为它引一套表单解析不划算。

判重看呼号加上取整到分钟的时刻。ADIF 里的时刻常常只精确到分钟，而这台机器记到秒，比死时刻的话同一条每导一次就多一条。同一次导入里的重复也只进一条。

读不了的记录跳过，好的照样进，`problems` 里每条一句话并指出是第几条。只认这套系统用得上的字段，`MODE` 不是 FM 或 DMR、频率不在 2m 或 70cm 段内的都跳过。导进来的记录不带 `clusterId`，它们没有任何观测支撑。

字段长度按 UTF-8 字节数算。有些程序写的长度是错的。按长度切出来的值后面如果不是空白加下一个标记，就当长度写错了，改取到下一个标记为止。日期或时刻不存在的记录跳过，例如 25 点或 13 月，不顺延到下一天。

## 设置

| 方法和路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/settings` | 无 | `Settings` |
| `PUT /api/settings` | `Settings` | `Settings`，或 `422` |

`Settings` 是配置里人能在界面上改的那部分：`station`、`channels`、`queries`、`brandmeisterEnabled`，以及 `analog` 的 `channels`、`enabled`、`gainDb`、`myUnitId`、`openMarginDb`、`closeMarginDb`。`analog.channels` 是 `{freqMhz, channel}[]`，一支接收机收不下的一组回 `422` 并说明原因。

改不了的留在文件里：`dbPath`、`host`、三个密钥、`recordingsDir`。它们要么一改就要重启整套，要么改错了就把自己关在门外。

`brandmeisterEnabled` 和 `analog.enabled` 是两个开关，缺省都是开。关掉不清空设置，原来的 `queries` 和 `analog.channels` 留在文件里，界面收起对应的卡片，改不了里面的字段。

`brandmeisterEnabled` 是 `false` 时，`queries` 可以缺失或者是空数组。传了的条目还是照样验。`analog.enabled` 是 `false` 时，只验提交里有的那几个 `analog` 字段，不要求至少一个信道。提交的 `analog` 只有 `enabled` 一个字段，当成没交，不新建一段 `analog`，除非文件里已经有一段。

写入落盘，先写临时文件再 rename。rename 之前会先把临时文件读一遍，读不回来就不落盘，报错但文件不变。写完就地更新内存里那份。只改内存的话，launchd 下次重启就悄悄变回去。文件里有密钥，权限保持 `600`，注释键和不在 `Settings` 里的字段原样保留。

守护进程盯着配置文件，改了自己跟上，两个进程之间没有另一条接口。换频率大约有 5 秒听不见，`watchAnalog` 要拿 5 秒静音重算静噪基线。开关切换不用重启守护进程。`brandmeisterEnabled` 一变，轮询就停或者起。`analog.enabled` 一变，接收机就停或者起。

校验和配置文件那套是同一份，所以界面存不进去的东西，手改文件也起不来。

## 电台

| 方法和路径 | 响应 |
|---|---|
| `GET /api/radios` | `{analogEnabled: boolean, radios: RadioView[]}` |

电台此刻的样子，一个模拟信道一条，来自 api 内存里最新的一批状态，每秒更新，不查数据库。`analogEnabled` 是 `false` 时，`radios` 一律是空数组，即使上一次还收到过状态。这条判断读的是这一刻的配置，不是在开关变化那一刻去清状态，一个正在停下来的守护进程晚到的一两批状态不会把旧信道带回来。

`/api/ops` 的 `radios` 字段和 `analogEnabled` 字段用的是同一个函数，两边不会说法不一样。

## 备份

| 方法和路径 | 响应 |
|---|---|
| `GET /api/backup` | `application/vnd.sqlite3`，一份完整的数据库文件，或者 `500` |

服务端 `VACUUM INTO` 一个临时文件，按和 CLI 备份脚本相同的办法验过，再流式发给浏览器。文件名形如 `openheard-20260928T031234Z.db`。验不过回 `500`，把原因放进 `error`。临时文件在发完、出错、客户端断开这三种情况下都会删掉。

只含数据库，不含录音，录音另外拷贝。`VACUUM INTO` 期间会挡住这个进程上的其他请求，库越大挡得越久。

## 录音

| 方法和路径 | 响应 |
|---|---|
| `GET /api/recordings` | `string[]`，有录音的那几次发射的 id |
| `GET /api/recordings/:id` | `audio/wav`，没有回 `404` |

守护进程把模拟侧每次静噪开启存成 `<activity id>.wav`，目录是配置里 `analog.recordingsDir`，没有 `analog` 那一段时按 `./recordings` 算。这个目录跟着配置读，不是进程起来时的一份快照。设置页加上模拟守听之后，新目录立刻能读能放，不用重启 api。模拟 FM 空中不带身份信息，对方呼号只能靠人回忆，所以确认的时候要能听回去。

要会话。这是本台信道上的音频，不进公开面。列表那条存在是为了让界面知道该给哪几行放播放器，不必挨个探一次 404。

## 运维

| 方法和路径 | 响应 |
|---|---|
| `GET /api/ops` | 健康状态、机器负载和内存、最近 40 次采集、按来源分组的发射数、每个模拟信道此刻的电台状态 `radios`、`analogEnabled`、`brandmeisterEnabled`，以及决定行为的配置值 |

不论健康与否都回 `200`，因为这一页的用途是把问题显示出来。要当外部监控用 `GET /health`，它不要会话，只回 `{"ok", "problems"}`，不健康时回 `503`。

`brandmeisterEnabled` 是 `false` 时，健康检查不看查询有没有轮询，那一路关着不算健康问题。`brandmeisterEnabled` 从 `false` 变成 `true` 的那一刻起才重新给一段宽限，不是从进程启动那一刻算，否则关了很久刚打开会立刻报「一直没有轮询成功过」。

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
| `409` | Settlement is by activity id: one of the picked ids no longer exists, or one is already settled. Refresh and retry; see "Settling by activity id" |
| `413` | The request body is over 16 MB |
| `422` | The draft is missing required fields, named in `missing`. Also an empty or non-string-array `activityIds`, or picked transmissions that are not all on the same channel |
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

A `PendingItem` is `{cluster, draft}`. The cluster is a conversation derived
from the channel and the gap threshold. It is not stored and is recomputed per
request. The draft is whatever the machine could fill in.

The queue only holds clusters containing one of our own transmissions, within
`pendingWindowDays`. This endpoint is read-only now. Settlement goes through
the two activity-id routes below; there is no longer a promote, ignore or
delete route keyed by `cluster.id`.

Deleting a contact releases its transmissions back into the queue.

## The listening page: conversations

| Method and path | Request | Response |
|---|---|---|
| `GET /api/conversations` | see below | `{items, next?, channels?, total?}`, or `422` |
| `POST /api/conversations/promote` | `QsoDraft` plus `activityIds` | `Qso`, `201`, or `409`, `422` |
| `POST /api/conversations/ignore` | `{picks: {id, activityIds}[]}` | `{ignored, missing}` |

The listening page treats pending, unlogged, logged, ignored and overheard as
one picture. Pick exactly one of these three views; giving more or fewer than
one is `422`:

- Day view: `from` and `to`, Unix seconds, `from` less than `to`, span at most
  172800 seconds. Returns conversations whose `startAt` falls in `[from, to)`.
  `channels` lists the channels that day and origin actually used
- Unlogged: `view=unlogged`. Returns our own conversations that are past the
  pending window and still unsettled. `total` is this view's full count
- Search: `q`, a prefix match, at least two characters after normalizing.
  Spans the whole retention period. No `total`

All three views also take `origin`, `status` and `channel` filters, and page
with the same `limit` (1 to 200, default 50) and `cursor`. `cursor` is the
previous page's `next`, sent back unchanged. A full page gets another `next`.

A `Conversation`:

```json
{
  "id": "a3",
  "startAt": 1789465773,
  "endAt": 1789465793,
  "channel": "tg:46001",
  "origin": "brandmeister",
  "status": "pending",
  "activities": [ ],
  "qso": { "id": "…", "call": "BD7KLO", "rstSent": "59", "rstRcvd": "59" },
  "draft": { }
}
```

`status` is one of `pending`, `unlogged`, `logged`, `ignored`, `overheard`.
`qso` is only present when `logged`. `draft` is only present on the three
unsettled statuses, shaped like `PendingItem.draft`.

### Settling by activity id

Promote and ignore both key on transmission ids, not on the conversation's
`id`. The UI collects the ids of the transmissions it has actually seen and
sends those. Checks run in this order:

1. None given: `422`
2. The same id appears twice: `422`
3. An id no longer exists: `409`
4. An id is already settled: `409`
5. The ids are not all on the same channel: `422`

`/promote` runs those five checks, then checks the draft has every required
field, `422` with `missing` when it does not. The server stores the draft as
received and does not recompute the start time or the far callsign — the UI
already computed those from the picked transmissions. `qso.clusterId` is
whichever of the picked ids has the smallest `(startAt, id)`.

`/ignore` puts any pick that fails a check into `missing`, by its `id`,
without touching the other picks. Within one request, an id already used by an
earlier valid pick counts as settled if it comes up again. The valid picks
settle in one transaction. The response is always `200`. Only a malformed body
gives `422`: `picks` not an array, an `id` not a string, or `activityIds` not
an array of strings.

## Heard

| Method and path | Request | Response |
|---|---|---|
| `GET /api/activities` | optionally `?origin=sdr-fm&cursor=…&limit=100` | `{items, next?}`, or `422` |

`items` is `Activity[]`, newest first. Settled rows also carry `settled`:
`logged` or `ignored`. It lists every transmission heard, including other
stations on their own, which the pending queue does not show.

`origin` is `brandmeister`, `sdr-fm` or `sdr-dmr`; without it, all of them.
`limit` defaults to 100, at most 200.

For the previous page, pass `next` back unchanged as `cursor`. No `next` means
there is nothing older. The cursor is the time and id of the last row, not an
offset, so rows arriving between pages do not shift or repeat the next page.

## Log

| Method and path | Request | Response |
|---|---|---|
| `GET /api/qsos` | none | `Qso[]`, newest first, each with `activities` |
| `GET /api/qsos/:id/history` | none | `{at, action, before}[]`, newest first |
| `POST /api/qsos` | `QsoDraft` | `Qso`, or `422` |
| `PUT /api/qsos/:id` | `QsoDraft` | `Qso`, or `404` / `422` |
| `POST /api/qsos/import` | ADIF text | `{parsed, imported, skipped, problems}` |
| `DELETE /api/qsos/:id` | none | `204`, or `404` |

`activities` is `{id, startAt, durationS}[]`, ascending, the transmissions this
contact was settled from. Manual entries and ADIF imports were never observed,
so `activities` is empty for them. This field is only on this guarded route;
`/public/qsos` does not carry it.

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

Import takes the ADIF text as the request body rather than multipart. One
person uploading one file from a browser does not earn a form parser.

Duplicates are keyed on callsign plus the time truncated to the minute. ADIF
times are often only accurate to the minute while this machine records seconds,
so an exact comparison would add a copy on every import. Duplicates within one
file collapse too.

Unreadable records are skipped and the readable ones still go in; `problems`
carries a line each, naming the record number. Only the fields this system uses
are read, and a record is skipped when `MODE` is neither FM nor DMR or the
frequency is outside 2m and 70cm. Imported rows carry no `clusterId` — nothing
observed them.

Field lengths count UTF-8 bytes. Some programs write wrong lengths: when the
value cut by length is not followed by whitespace and the next tag, the length
is taken as wrong and the value runs to the next tag instead. A record whose
date or time does not exist, such as hour 25 or month 13, is skipped rather than
rolled over into the next day.

## Settings

| Method and path | Request | Response |
|---|---|---|
| `GET /api/settings` | none | `Settings` |
| `PUT /api/settings` | `Settings` | `Settings`, or `422` |

`Settings` is the part of the config a person edits in the UI: `station`,
`channels`, `queries`, `brandmeisterEnabled`, and `analog`'s `channels`,
`enabled`, `gainDb`, `myUnitId`, `openMarginDb` and `closeMarginDb`.
`analog.channels` is `{freqMhz, channel}[]`; a set one receiver cannot cover
gives `422` with the reason.

The rest stays in the file: `dbPath`, `host`, the three secrets, and
`recordingsDir`. Each either needs the whole thing restarted or locks you out
if you get it wrong.

`brandmeisterEnabled` and `analog.enabled` are two switches, both on by
default. Turning one off does not clear its settings: `queries` and
`analog.channels` stay in the file, and the UI collapses the matching card and
stops accepting edits to its fields.

While `brandmeisterEnabled` is `false`, `queries` may be missing or an empty
array; entries that are present are still validated. While `analog.enabled` is
`false`, only the `analog` fields that are present get validated, and at least
one channel is not required. A submitted `analog` with nothing but `enabled`
is treated as not submitted at all, and does not create a section, unless the
file already has one.

Writes go to disk through a temp file, then a rename. Before the rename, the
temp file is read back through `loadConfig`; a failed read means no write at
all, an error, and the file untouched. A successful write then updates the
in-memory config in place — memory alone would silently revert on launchd's
next restart. The file holds secrets, so it stays `600`, and comment keys and
anything outside `Settings` are preserved.

The daemon watches the config file and follows along; there is no second
interface between the two processes. Retuning costs about five seconds of
deafness while `watchAnalog` rebuilds its squelch baseline from fresh silence.
Flipping a switch needs no daemon restart either: polling starts or stops when
`brandmeisterEnabled` changes, and the receiver starts or stops when
`analog.enabled` changes.

Validation is the same code the config file goes through, so nothing the UI
refuses would have started from a hand-edited file either.

## Radios

| Method and path | Response |
|---|---|
| `GET /api/radios` | `{analogEnabled: boolean, radios: RadioView[]}` |

The current state of each analog channel, from the latest batch the api holds
in memory, refreshed every second, no database read. When `analogEnabled` is
`false`, `radios` is always an empty array, even if a batch arrived a moment
ago. This is checked against the config at read time, not by clearing state
the moment the switch flips, so a late batch from a daemon that is still
shutting down cannot bring old channels back.

`/api/ops` uses the same function for its `radios` and `analogEnabled` fields,
so the two never disagree.

## Backup

| Method and path | Response |
|---|---|
| `GET /api/backup` | `application/vnd.sqlite3`, a full database file, or `500` |

The server runs `VACUUM INTO` on a temp file, verifies it the same way the CLI
backup script does, and streams it to the browser. The filename looks like
`openheard-20260928T031234Z.db`. A failed verification gives `500` with the
reason in `error`. The temp file is deleted whether the stream ends, errors,
or the client disconnects.

This is the database only, not recordings — those are copied separately.
`VACUUM INTO` blocks this process's other requests while it runs; the bigger
the database, the longer that takes.

## Recordings

| Method and path | Response |
|---|---|
| `GET /api/recordings` | `string[]`, the ids of transmissions that have audio |
| `GET /api/recordings/:id` | `audio/wav`, or `404` |

The daemon writes each analog squelch opening to `<activity id>.wav` under
`analog.recordingsDir`, or `./recordings` when there is no `analog` section.
This directory is read from the config on every request, not captured once at
startup, so adding analog from the settings page makes it usable at once, no
api restart needed. Analog FM carries no identity, so the far station's
callsign comes from the operator's memory; being able to listen again is what
makes that accurate.

Both need a session. This is audio off our own channel and does not reach the
public face. The list exists so the UI knows which rows get a player without
probing each one for a 404.

## Operations

| Method and path | Response |
|---|---|
| `GET /api/ops` | Health, machine load and memory, the last 40 polls, activity counts by origin, the current radio status of each analog channel as `radios`, `analogEnabled`, `brandmeisterEnabled`, and the config values that decide behaviour |

It answers `200` whether healthy or not, because the page exists to display
problems. For an external monitor use `GET /health`: no session, only
`{"ok", "problems"}`, and `503` when unhealthy.

While `brandmeisterEnabled` is `false`, health does not check whether the
queries have been polling; that side being off is not a health problem. Grace
after turning it back on runs from the moment it changed to `true`, not from
process startup, or a station that was off for a while would report "never
polled successfully" the instant it came back on.

`machine` carries load, this process's memory, system memory and uptime. Load
is already divided by the core count, so it compares against 1.0. Unattended,
a runaway poll loop or a leak shows up in none of the other figures until the
disk fills. None of it is in `/health`, which answers only `ok` and
`problems`.

`poll_log` records `fetched`, `parsed` and `written` separately. When a feed
renames a field, `parsed` drops to zero while `fetched` does not, and that
reads exactly like a batch of rows already seen unless the two are apart.
