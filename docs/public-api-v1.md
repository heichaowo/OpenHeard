# 公开 API v1

公开展示页读的那几条。只读，不要会话，也不暴露任何写接口。

调用方是 `public/`，一个独立的 Vite 应用，除 react 外零依赖。

## 边界

这些路由挂在管理端同一个进程里，但它们是公开面。两件事因此定死：

- 这里不长写接口。要改数据走管理端。
- 这里不返回未确认的内容。`activity` 和待确认队列都只在管理端可见，公开面只有已经由人判断过的 `qso`。

数据怎么送到境外还没有方案。`api/src/public.ts` 因此只接受一个注入的数据源，将来换成读导出文件或读远端 HTTP 时，改的只有注入的那一层。

## 接口

| 方法和路径 | 响应 |
|---|---|
| `GET /public/summary` | 整页所需的全部内容，见下 |
| `GET /public/station` | `StationDefaults` |
| `GET /public/qsos` | `Qso[]`，按开始时间倒序 |

`summary` 是首选。整页只发这一个请求，形状也正是将来导出成静态文件时的形状。

### summary 的形状

| 字段 | 说明 |
|---|---|
| `station` | 本台信息，呼号、QTH、网格、设备、天线、功率、高度 |
| `total` | 通联总数 |
| `distinctCalls` | 不同呼号数 |
| `firstAt`、`lastAt` | 最早和最近一次的 Unix 秒 UTC，没有记录时缺省 |
| `byBand`、`byMode` | `{key, n}[]`，按条数倒序 |
| `recent` | 最近 30 条，每条只有 `id`、`call`、`startAt`、`band`、`mode`、`rstSent`、`rstRcvd`、`qth`、`gridsquare` |
| `generatedAt` | 生成时刻的 Unix 秒 UTC |

`recent` 不带本台字段和备注。公开面需要对方是谁、什么时候、走哪个波段和模式，外加双向报告。别的电台核对这次通联时要看报告。

时间一律 Unix 秒 UTC。公开页显示成哪个时区由看的人自己选，接口不受影响。

## 健康检查

`GET /health` 也不要会话，只回 `{"ok", "problems"}`，不健康时状态码是 `503`。它不带计数、路径和磁盘，那些在管理端的 `/api/ops` 后面。

---

# Public API v1 (English)

What the public station page reads. Read-only, no session, and no write
endpoint anywhere on it.

The caller is `public/`, a separate Vite app with no dependencies beyond
react.

## Boundary

These routes live in the same process as the admin side, but they are the
public face. Two things follow:

- No write endpoint grows here. Changes go through the admin side.
- Nothing unconfirmed is returned. `activity` and the pending queue are
  admin-only; the public face sees only `qso` rows, which a human judged.

How the data reaches a host outside the country is still unanswered.
`api/src/public.ts` therefore takes an injected source, so swapping to an
exported file or a remote HTTP read changes only that one layer.

## Endpoints

| Method and path | Response |
|---|---|
| `GET /public/summary` | Everything the page needs, described below |
| `GET /public/station` | `StationDefaults` |
| `GET /public/qsos` | `Qso[]`, newest first |

Prefer `summary`. The whole page is one request, and that shape is also what
a static export would look like.

### Shape of summary

| Field | Meaning |
|---|---|
| `station` | Callsign, QTH, grid, device, antenna, power, height |
| `total` | Number of contacts |
| `distinctCalls` | Number of distinct callsigns |
| `firstAt`, `lastAt` | Unix seconds UTC of the first and last, absent with no records |
| `byBand`, `byMode` | `{key, n}[]`, most frequent first |
| `recent` | The last 30, carrying only `id`, `call`, `startAt`, `band`, `mode`, `rstSent`, `rstRcvd`, `qth`, `gridsquare` |
| `generatedAt` | Unix seconds UTC when it was built |

`recent` omits our own station fields and the notes. The public face needs who,
when, which band, which mode, and both reports — another station checks a
contact against those.

Times are Unix seconds UTC. Which timezone the page shows them in is the
visitor's choice and does not reach the API.

## Health

`GET /health` also needs no session and returns only `{"ok", "problems"}`,
with `503` when unhealthy. It carries no counts, paths or disk figures; those
sit behind `/api/ops` on the admin side.
