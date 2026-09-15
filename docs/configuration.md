# 配置

一个 JSON 文件，`api/` 和 `daemon/` 都读它，各取自己要的那几项。两边各自解析，不共用模块，这样两个可执行体互不依赖。

抄 `api/openheard.config.example.json` 起手。路径用 `OPENHEARD_CONFIG` 指定，缺省是 `./openheard.config.json`。

配置里的相对路径（`dbPath`、`spoolDir`、`recordingsDir`）按配置文件所在目录算，不按 cwd。服务由 launchd 从各自的目录起，而备份是你在别处敲的，按 cwd 算两边会指向不同的文件。

配置有问题时 API 照常监听，每条路由回 `503` 并列出原因。退出会让 launchd 的 KeepAlive 变成一个谁也看不见的重启循环。

## api 读的

| 字段 | 必填 | 说明 |
|---|---|---|
| `dbPath` | 是 | SQLite 文件路径 |
| `host` | 否 | 监听地址，缺省 `127.0.0.1`。要从手机用就改成 `0.0.0.0`，那时管理端靠口令挡着 |
| `adminPasswordHash` | 是 | 管理端口令的 scrypt 哈希，生成方式见下 |
| `sessionSecret` | 是 | 会话签名密钥，至少 32 字符。换掉它，已发出的会话立刻失效 |
| `ingestToken` | 是 | 采集入口的 Bearer token，至少 16 字符 |
| `dmrId` | 是 | 本台在 radioid.net 的 7 位 ID。数字侧靠它判断一次发射是不是本台 |
| `clusterGapS` | 是 | 聚类间隔阈值，秒。**没有缺省值**，这个数要来自对真实流量的实测 |
| `pendingWindowDays` | 是 | 待确认队列只看这么多天内的发射 |
| `activityRetentionDays` | 是 | `activity` 的保留期。`qso` 不裁 |
| `station` | 是 | 本台信息，见下 |
| `channels` | 是 | 频谱表，可以是空数组 |
| `queries` | 是 | BrandMeister 查询，至少一条 |

端口走环境变量 `OPENHEARD_PORT`，缺省 3000。

### 生成口令哈希和密钥

```bash
cd api && node src/hash-password.ts '你的口令'   # adminPasswordHash
openssl rand -hex 32                            # sessionSecret 和 ingestToken
```

### station

呼号、网格、QTH、设备、天线、功率、天线高度，外加 `networkFreqMhz`。前几项会预填进每一条新通联，因为通联结束后再也拿不回来。`networkFreqMhz` 是网络会话的记账频率，BrandMeister 的会话没有射频频率。

### channels

每条是 `{name, freqMhz, mode}`。快速补录的信道下拉用它，选中会带出频率和模式。

### queries

每条是 `{key, rule, amount, intervalS}`。

**每条规则单独一次查询，不要用 `condition: OR` 合并。** `amount` 是合并去重后的全局上限，热闹的话务组会把安静的饿死。实测把 91 组和 460 组 OR 在一起、`amount` 取 200，返回的 200 行全部来自 91 组。

**间隔和 amount 按话务组各给各的。** 同为 `amount` 200，本台查询跨 53 天，460 组跨 3.6 天，91 组只跨 51 分钟。

**数值字段的 value 必须是 JSON number。** 传 `"91"` 静默返回 0 行，传 `91` 返回 200 行。配置校验会拦住这一条。

## daemon 读的

| 字段 | 必填 | 说明 |
|---|---|---|
| `dmrId`、`queries`、`ingestToken` | 是 | 和上面同一份 |
| `apiUrl` | 否 | 推给谁，缺省 `http://127.0.0.1:3000` |
| `spoolDir` | 否 | 推不上去时落盘的目录，缺省 `./spool` |
| `analog` | 否 | 模拟守听，缺这一段就只跑数字侧 |

### analog

| 字段 | 必填 | 说明 |
|---|---|---|
| `freqMhz`、`channel` | 是 | 守哪个频率，以及进 `Activity` 的信道名 |
| `gainDb` | 否 | 调谐器增益，缺省 32.8 |
| `myUnitId` | 否 | 本台的 MDC-1200 unit ID，**十六进制字符串**。缺了就判不出哪次发射是本台，队列会一直是空的。旧名 `unitId` 仍然认 |
| `recordingsDir` | 否 | 每次发射的音频往这里写，缺省 `./recordings` |

一次只守一个频率。一支接收机同时只能调谐一处，跳频期间漏掉的发射无法补回。

---

# Configuration (English)

One JSON file. `api/` and `daemon/` both read it and each takes the fields it
needs. They parse it separately rather than sharing a module, so neither
executable depends on the other.

Start from `api/openheard.config.example.json`. Point at it with
`OPENHEARD_CONFIG`; the default is `./openheard.config.json`.

Relative paths inside the config (`dbPath`, `spoolDir`, `recordingsDir`)
resolve against the config file's own directory, not the working directory.
launchd starts each service from its own directory while you run the backup
from somewhere else, and resolving against the working directory would make
those two point at different files.

When the config is broken the API still listens and answers `503` on every
route with the reasons. Exiting would turn launchd's KeepAlive into a restart
loop nobody can see.

## What api reads

| Field | Required | Meaning |
|---|---|---|
| `dbPath` | yes | Path to the SQLite file |
| `host` | no | Listen address, default `127.0.0.1`. Set `0.0.0.0` to use it from a phone; the password is what guards the admin side then |
| `adminPasswordHash` | yes | scrypt hash of the admin password, generated below |
| `sessionSecret` | yes | Session signing key, at least 32 characters. Changing it invalidates every issued session |
| `ingestToken` | yes | Bearer token for ingest, at least 16 characters |
| `dmrId` | yes | Our 7-digit radioid.net ID. The digital side decides `mine` from it |
| `clusterGapS` | yes | Clustering gap threshold in seconds. **No default**, because the number has to come from measuring real traffic |
| `pendingWindowDays` | yes | How far back the pending queue looks |
| `activityRetentionDays` | yes | How long `activity` is kept. `qso` is never pruned |
| `station` | yes | Our own station, below |
| `channels` | yes | The spectrum table, may be empty |
| `queries` | yes | BrandMeister queries, at least one |

The port comes from `OPENHEARD_PORT`, default 3000.

### Generating the hash and the keys

```bash
cd api && node src/hash-password.ts 'your password'   # adminPasswordHash
openssl rand -hex 32                                  # sessionSecret and ingestToken
```

### station

Callsign, grid, QTH, device, antenna, power, antenna height, plus
`networkFreqMhz`. The first few are prefilled into every new contact, because
they cannot be recovered once the contact is over. `networkFreqMhz` is the
frequency to book network sessions against, since a BrandMeister session has
no RF frequency of its own.

### channels

Each is `{name, freqMhz, mode}`. It backs the quick-entry channel picker, and
picking one fills in the frequency and mode.

### queries

Each is `{key, rule, amount, intervalS}`.

**One query per rule. Do not merge them with `condition: OR`.** `amount` is a
global cap applied after the OR dedup, so a busy talkgroup starves a quiet
one. Measured: 91 and 460 merged at `amount` 200 returned 200 rows, all from
91.

**Interval and amount are per talkgroup.** At the same `amount` of 200, the
src query reaches back 53 days, talkgroup 460 reaches 3.6 days, and 91 reaches
51 minutes.

**A numeric field needs a JSON number.** `"91"` silently returns nothing where
`91` returns 200 rows. Config validation rejects the string form.

## What daemon reads

| Field | Required | Meaning |
|---|---|---|
| `dmrId`, `queries`, `ingestToken` | yes | The same ones as above |
| `apiUrl` | no | Where to push, default `http://127.0.0.1:3000` |
| `spoolDir` | no | Where rows land when a push fails, default `./spool` |
| `analog` | no | Analog watch. Without it only the digital side runs |

### analog

| Field | Required | Meaning |
|---|---|---|
| `freqMhz`, `channel` | yes | Which frequency to watch, and the channel name that goes into `Activity` |
| `gainDb` | no | Tuner gain, default 32.8 |
| `myUnitId` | no | Our MDC-1200 unit ID, **as a hex string**. Without it nothing is ever marked as ours and the queue stays empty. The old name `unitId` is still accepted |
| `recordingsDir` | no | Where each transmission's audio is written, default `./recordings` |

One frequency at a time. A single receiver tunes one place, and transmissions
missed while hopping cannot be recovered.
