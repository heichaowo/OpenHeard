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
| `clusterGapS` | 是 | 聚类间隔阈值，秒。**没有缺省值**，这个数要来自对真实流量的实测。46001 组实测 p90 是 102 秒，取 120 秒 |
| `pendingWindowDays` | 是 | 收听页「待确认」一档只放这么多天内有本台发射的对话。更早的还没结算的列在「未入库」 |
| `activityRetentionDays` | 是 | `activity` 的保留期。`qso` 不裁。比 `pendingWindowDays` 短时按 `pendingWindowDays` 算，队列里还没处理的段不裁 |
| `station` | 是 | 本台信息，见下 |
| `channels` | 是 | 频谱表，可以是空数组 |
| `queries` | 视情况 | BrandMeister 查询。`brandmeisterEnabled` 是 `false` 时可以缺失或者是空数组，否则至少一条 |
| `brandmeisterEnabled` | 否 | BrandMeister 查询的开关，缺省开。关掉时 `queries` 原样留在文件里，只是不轮询 |
| `ai` | 否 | 语音识别，见下。api 读它来显示识别状态，守护进程读它来做识别 |
| `map` | 否 | 地图，见下 |

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
| `analog` | 否 | 模拟守听，缺这一段或者 `enabled` 是 `false` 就只跑数字侧 |
| `ai` | 否 | 语音识别，缺这一段或者 `enabled` 不是 `true` 就不识别 |

### analog

| 字段 | 必填 | 说明 |
|---|---|---|
| `channels` | 视情况 | 要守的信道，每个是 `{freqMhz, channel}`：频率，以及进 `Activity` 的信道名。旧写法只写一个 `freqMhz` 和一个 `channel`，仍然认。`enabled` 是 `false` 时不读也不验这张表 |
| `enabled` | 否 | 模拟守听的开关，缺省开。关掉时这张信道表原样留在文件里，只是不起接收机 |
| `gainDb` | 否 | 调谐器增益，缺省 32.8。收不到时先调到 49.6，见下文 |
| `myUnitId` | 否 | 本台的 MDC-1200 unit ID，**十六进制字符串**。缺了就判不出哪次发射是本台，队列会一直是空的。旧名 `unitId` 仍然认 |
| `openMarginDb` | 否 | 静噪打开的余量，dB，缺省 12。噪声比静默基准低这么多就算有载波 |
| `closeMarginDb` | 否 | 静噪关闭的余量，dB，缺省 7。要比打开那个至少小 2，中间那段是回差 |
| `recordingsDir` | 否 | 每次发射的音频往这里写，缺省 `./recordings` |

一支接收机同时守 `channels` 里的全部信道，最多 8 个，最高和最低相差不超过 1.8 MHz。接收机调到哪、采样率多少由程序算，设置页上填的时候就看得到。两个隔得更远的波段要再加一支接收机，这一版不支持。

`brandmeisterEnabled` 和 `analog.enabled` 改了，守护进程盯着配置文件跟上，不用重启。关掉模拟守听的那一刻，正在收的那次发射照常收尾：写录音、推事件，不会因为接收机停了就丢掉。

两个余量按部署调。噪声本底和天线各地不一样，调大了弱信号永远打不开静噪，调小了噪声起伏就会伪造出发射，把队列和磁盘塞满。运维页上写着此刻的噪声离门限还差多少，以及这次守听里最接近的一刻差了多少，照着那两个数调。设置页上能直接改，清空一格就回到缺省值。

增益低了，弱信号压不下噪声。2026-09-27 在 mini 上用 438.500 中继实测：同一串按键，落在 49.6 下的每次把噪声压低 23 到 24 dB，落在 32.8 下的每次只压低 5 dB 左右，到不了 12 dB 的开启门限。所以 32.8 守了两天，一次也没记下。收不到东西时，先看运维页上离门限最近差多少，再把增益调到 49.6。

静默基准开机先听 5 秒定下。之后静噪关着时，每 60 秒按这 60 秒的噪声重定一次，所以门限跟着本底涨落。静噪开着超过 5 分钟就强制关掉。一次长过 5 分钟的发射记成几段，连着两段还没停就按它重定基准。守护进程每小时往 `daemon.log` 写一行小结：静噪开过几次、记下几次、噪声离开启门限最近差多少。

### ai

语音识别，缺省关。分三步：人声判断（`vad`）、识别（`asr`）、提取（`text`）。守护进程向 api 要还没识别的录音，一条条做，结果推给 api。设置页上能改。

下面的缺省值在键不存在时生效。密钥没有缺省值。

| 字段 | 缺省 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。三步都关着时也当成没开 |
| `vad.provider` | `local` | `local` 或 `off`。人声判断没有云端可选 |
| `vad.binPath` | `/opt/homebrew/bin/whisper-vad-speech-segments` | |
| `vad.modelPath` | `./models/ggml-silero-v5.1.2.bin` | Silero VAD 模型 |
| `vad.threshold` | `0.5` | 大于 0 小于 1。调大会更严，轻声的话可能被判成没人声 |
| `asr.provider` | `local` | `local`（whisper-cli）、`openai-transcriptions`、`chat-audio` 或 `off` |
| `asr.binPath` | `/opt/homebrew/bin/whisper-cli` | 只对 `local` 有用 |
| `asr.modelPath` | `./models/ggml-large-v3-turbo-q5_0.bin` | 只对 `local` 有用 |
| `asr.language` | `zh` | 识别开着时不能是空的 |
| `asr.prompt` | 空 | 提示词，见下 |
| `asr.baseUrl`、`asr.model`、`asr.apiKey` | 空 | 云端必填 |
| `asr.extraBody` | `{}` | 云端请求体，见下 |
| `text.provider` | `local` | `local`（llama-server）、`openai-chat` 或 `off`。`asr.provider` 是 `off` 时这里也必须是 `off` |
| `text.binPath` | `/opt/homebrew/bin/llama-server` | 只对 `local` 有用 |
| `text.modelPath` | `./models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | 只对 `local` 有用 |
| `text.port` | `8091` | llama-server 监听的本机端口 |
| `text.idleUnloadS` | `120` | llama-server 闲这么多秒就卸掉模型，下一个请求再装回来 |
| `text.baseUrl`、`text.model`、`text.apiKey` | 空 | 云端必填 |
| `text.extraBody` | `{}` | 云端请求体，见下 |

**路径怎么算。** `modelPath` 一律相对配置文件所在目录。`binPath` 不带 `/` 时去 `PATH` 里找，带 `/` 时相对配置文件所在目录，和 `rtl_sdr` 一个做法。

**两种云端识别接口。** `openai-transcriptions` 发 multipart 到 `<baseUrl>/audio/transcriptions`，字段是 `file`、`model`、`language`，有提示词时加 `prompt`，`response_format` 是 `json`。SiliconFlow 是这一种。`chat-audio` 发 chat completions 到 `<baseUrl>/chat/completions`，音频放在 `input_audio` 里，语言放在 `asr_options.language`。MiMo 和通义千问是这一种，它们没有提示词字段，`asr.prompt` 对它们无效。

**智谱 GLM-ASR 每个文件最长 30 秒。** 本台最长的录音有 38.85 秒，第 99 百分位是 21.55 秒。超过 30 秒的那几条用智谱会失败，记成识别失败。录音长的话选别家。

**`extraBody` 最后合并进云端请求体。** 同名的键以它为准。代码里不认厂商，各家的开关都写在这里。`openai-transcriptions` 是 multipart，标量写成文本字段，对象写成 JSON 文本。

已知要写的值：

| 服务 | 步骤 | `extraBody` |
|---|---|---|
| MiMo `mimo-v2.6-flash`、`mimo-v2.6-pro` | 提取 | `{"thinking":{"type":"disabled"},"max_completion_tokens":512}` |
| DeepSeek `deepseek-flash` | 提取 | `{"thinking":{"type":"disabled"}}` |
| SiliconFlow | 提取 | `{"enable_thinking":false}` |

这几家的思考缺省是开的。不关的话，思考会用光 512 个 token，回来的内容是空的，每一条都记成识别失败。提取请求固定带 `temperature` 0、`max_tokens` 512 和 `response_format` 为 `json_object`。MiMo 的文档只认 `max_completion_tokens`，所以它多写一项。

云端写法的例子：

```json
"ai": {
  "enabled": true,
  "asr": {
    "provider": "chat-audio",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "model": "mimo-v2.5-asr",
    "apiKey": "sk-..."
  },
  "text": {
    "provider": "openai-chat",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "model": "mimo-v2.6-flash",
    "apiKey": "sk-...",
    "extraBody": { "thinking": { "type": "disabled" }, "max_completion_tokens": 512 }
  }
}
```

SiliconFlow 的识别是 `openai-transcriptions`，`baseUrl` 为 `https://api.siliconflow.cn/v1`，`model` 为 `FunAudioLLM/SenseVoiceSmall`。

**提示词有代价。** 不加提示词时，5 段里有 2 段出繁体，而且都没有标点。加了 `以下是普通话的句子。` 之后全是简体，也有标点。但英文会被带偏：`CQTEST` 被转成 `QQ赛`，而呼号正是英文字母。所以缺省是空的，由你按自己的话务选。提示词也会被回声，所以守护进程会把和提示词只差几个字的转写当成没有人声。

**密钥只写不读。** 设置页上只显示设了没有，不会把值发回页面。它们写在配置文件里，`install.sh` 会把文件改成 `600`。

**写坏了不会拦住采集。** `ai` 里有不合法的值时，守护进程不起识别，把原因写进 `daemon.log`，运维页上也看得到。api 照常服务，采集照常跑。只有设置页存设置时才会直接拒绝。

**缺文件时先等。** 开着的本机步骤缺程序或模型时，守护进程不去要活，运维页上写缺哪个，每 60 秒再查一次。模型后下好也不用重启。模型怎么下见 [deployment.md](deployment.md)。

### map

对方网格在地图上点出来用。缺省不用地图。

| 字段 | 缺省 | 说明 |
|---|---|---|
| `provider` | `none` | `amap`（高德）、`osm`（OpenStreetMap）或 `none` |
| `amapKey` | 空 | 高德 Web 端（JS API）的 key。页面要用它，所以会发到页面上 |
| `amapSecurityCode` | 空 | 高德的安全密钥。只留在 api 里，不进页面 |

`provider` 是 `amap` 时两项都必填。key 和安全密钥在高德开放平台的控制台上申请：应用管理，创建应用，添加 Key，服务平台选「Web 端（JS API）」。2021 年 12 月 2 日以后建的 key 必须配安全密钥。

安全密钥不进页面。api 在 `/_AMapService/` 下代理高德的 Web 服务请求，加上 `jscode` 再转出去。这是高德推荐的做法。只代理 `GET`，要登录。

`osm` 不要 key，但在国内可能打不开。它的地名搜索每秒最多一次，也不能边输边搜。

高德的坐标是 GCJ-02，网格按 WGS-84 算，所以程序先换回来再算。

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
| `clusterGapS` | yes | Clustering gap threshold in seconds. **No default**, because the number has to come from measuring real traffic. Measured on talkgroup 46001, p90 is 102 seconds, so 120 |
| `pendingWindowDays` | yes | How many days a conversation with our own transmission stays under 待确认 on the listening page. Older unsettled ones are listed under 未入库 |
| `activityRetentionDays` | yes | How long `activity` is kept. `qso` is never pruned. When shorter than `pendingWindowDays`, `pendingWindowDays` applies, so nothing still waiting in the queue is pruned |
| `station` | yes | Our own station, below |
| `channels` | yes | The spectrum table, may be empty |
| `queries` | conditional | BrandMeister queries. May be missing or empty when `brandmeisterEnabled` is `false`, otherwise at least one |
| `brandmeisterEnabled` | no | Switch for BrandMeister queries, on by default. Off leaves `queries` in the file unchanged; it just stops polling |
| `ai` | no | Speech recognition, below. The api reads it to show recognition status, the daemon reads it to do the work |
| `map` | no | The map, below |

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
| `analog` | no | Analog watch. Without it, or with `enabled: false`, only the digital side runs |
| `ai` | no | Speech recognition. Without it, or unless `enabled` is `true`, nothing is recognised |

### analog

| Field | Required | Meaning |
|---|---|---|
| `channels` | conditional | The channels to watch, each `{freqMhz, channel}`: the frequency and the channel name that goes into `Activity`. The old form with a single `freqMhz` and `channel` is still accepted. Not read or validated while `enabled` is `false` |
| `enabled` | no | Switch for analog watch, on by default. Off leaves this channel table in the file unchanged; it just stops the receiver |
| `gainDb` | no | Tuner gain, default 32.8. If nothing is heard, try 49.6 first; see below |
| `myUnitId` | no | Our MDC-1200 unit ID, **as a hex string**. Without it nothing is ever marked as ours and the queue stays empty. The old name `unitId` is still accepted |
| `openMarginDb` | no | dB below the calibrated idle floor that counts as a carrier, default 12 |
| `closeMarginDb` | no | dB for closing again, default 7. At least 2 below the open margin; the gap between them is the hysteresis |
| `recordingsDir` | no | Where each transmission's audio is written, default `./recordings` |

One receiver watches every channel in `channels` at once: at most 8, with no
more than 1.8 MHz between the highest and the lowest. Where the receiver is
tuned and at what sample rate is worked out by the program, and the settings
page shows it while the channels are being entered. Bands further apart need a
second receiver, which this version does not support.

The daemon watches the config file and picks up `brandmeisterEnabled` and
`analog.enabled` changes without a restart. The moment analog is switched off,
a transmission still in progress is still closed out normally: the wav gets
written and the event still gets pushed, instead of being lost because the
receiver stopped.

Both margins are tuned per deployment. Noise floors and antennas differ by
site: too large and a weak signal never opens the squelch, too small and
ordinary noise invents transmissions that fill the queue and the disk. The ops
page shows how far the current noise is from the threshold and how close it has
come during this watch; tune against those two numbers. Both can be changed on
the settings page, and clearing one returns it to its default.

Too little gain leaves a weak signal unable to push the noise down. Measured on
the mini on 2026-09-27 with the 438.500 repeater: in one series of key-ups,
each one landing at gain 49.6 lowered the noise by 23 to 24 dB, and each one
landing at 32.8 by about 5 dB, short of the 12 dB open margin. That is why two
days at 32.8 recorded nothing. When nothing is heard, check how close the ops
page says the noise has come to the threshold, then raise the gain to 49.6.

The idle floor is set from the first 5 seconds after start. After that, while
the squelch is closed, it is reset every 60 seconds from those 60 seconds, so
the thresholds follow the floor as it drifts. A squelch open for more than 5
minutes is forced closed. A transmission longer than that is recorded in
5-minute pieces; after two pieces in a row the floor is reset from it. Once an
hour the daemon writes a summary line to `daemon.log`: how often the squelch
opened, how many transmissions were recorded, and how close the noise came to
the open threshold.

### ai

Speech recognition, off by default. Three steps: speech detection (`vad`), recognition (`asr`) and extraction (`text`). The daemon asks the api for recordings not yet processed, does them one at a time, and pushes the results back to the api. The settings page edits it.

The defaults below apply when a key is absent. Secrets have no default.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. With all three steps off it also counts as off |
| `vad.provider` | `local` | `local` or `off`. There is no cloud option for speech detection |
| `vad.binPath` | `/opt/homebrew/bin/whisper-vad-speech-segments` | |
| `vad.modelPath` | `./models/ggml-silero-v5.1.2.bin` | The Silero VAD model |
| `vad.threshold` | `0.5` | Above 0 and below 1. Higher is stricter, and quiet speech may be judged as no speech |
| `asr.provider` | `local` | `local` (whisper-cli), `openai-transcriptions`, `chat-audio` or `off` |
| `asr.binPath` | `/opt/homebrew/bin/whisper-cli` | Used by `local` only |
| `asr.modelPath` | `./models/ggml-large-v3-turbo-q5_0.bin` | Used by `local` only |
| `asr.language` | `zh` | Cannot be empty while recognition is on |
| `asr.prompt` | empty | The initial prompt, below |
| `asr.baseUrl`, `asr.model`, `asr.apiKey` | empty | Required for the cloud providers |
| `asr.extraBody` | `{}` | Cloud request body, below |
| `text.provider` | `local` | `local` (llama-server), `openai-chat` or `off`. Must be `off` when `asr.provider` is `off` |
| `text.binPath` | `/opt/homebrew/bin/llama-server` | Used by `local` only |
| `text.modelPath` | `./models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | Used by `local` only |
| `text.port` | `8091` | The loopback port llama-server listens on |
| `text.idleUnloadS` | `120` | After this many idle seconds llama-server unloads the model and loads it again on the next request |
| `text.baseUrl`, `text.model`, `text.apiKey` | empty | Required for the cloud provider |
| `text.extraBody` | `{}` | Cloud request body, below |

**How paths resolve.** `modelPath` is always relative to the config file's directory. A `binPath` without `/` is looked up on `PATH`, and one with `/` is relative to the config file's directory, the same as `rtl_sdr`.

**Two cloud recognition APIs.** `openai-transcriptions` posts multipart to `<baseUrl>/audio/transcriptions` with `file`, `model` and `language`, plus `prompt` when set, and `response_format` `json`. SiliconFlow is this kind. `chat-audio` posts chat completions to `<baseUrl>/chat/completions` with the audio in `input_audio` and the language in `asr_options.language`. MiMo and Qwen are this kind. They have no prompt field, so `asr.prompt` has no effect on them.

**Zhipu GLM-ASR takes at most 30 seconds per file.** The longest recording here is 38.85 seconds and the 99th percentile is 21.55 seconds. Anything over 30 seconds fails on Zhipu and is recorded as a recognition failure. Pick another provider if your recordings run long.

**`extraBody` is merged last into the cloud request body.** On a clash it wins. The code knows no vendor, so each vendor's switches go here. `openai-transcriptions` is multipart, so scalars become text fields and objects become JSON text.

Known values:

| Service | Step | `extraBody` |
|---|---|---|
| MiMo `mimo-v2.6-flash`, `mimo-v2.6-pro` | extraction | `{"thinking":{"type":"disabled"},"max_completion_tokens":512}` |
| DeepSeek `deepseek-flash` | extraction | `{"thinking":{"type":"disabled"}}` |
| SiliconFlow | extraction | `{"enable_thinking":false}` |

These services think by default. Left on, thinking uses up the 512 tokens, the reply comes back empty, and every item is recorded as a recognition failure. The extraction request always carries `temperature` 0, `max_tokens` 512 and `response_format` `json_object`. MiMo's documentation only knows `max_completion_tokens`, which is why it gets the extra entry.

A cloud example:

```json
"ai": {
  "enabled": true,
  "asr": {
    "provider": "chat-audio",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "model": "mimo-v2.5-asr",
    "apiKey": "sk-..."
  },
  "text": {
    "provider": "openai-chat",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "model": "mimo-v2.6-flash",
    "apiKey": "sk-...",
    "extraBody": { "thinking": { "type": "disabled" }, "max_completion_tokens": 512 }
  }
}
```

SiliconFlow recognition is `openai-transcriptions` with `baseUrl` `https://api.siliconflow.cn/v1` and `model` `FunAudioLLM/SenseVoiceSmall`.

**The prompt has a cost.** Without a prompt, 2 of 5 clips came out in traditional characters, and none had punctuation. With `以下是普通话的句子。` every clip came out simplified, with punctuation. But English gets pulled off course: `CQTEST` became `QQ赛`, and callsigns are English letters. So the default is empty and you choose by your own traffic. The prompt also gets echoed back, so the daemon treats a transcript within a few characters of the prompt as no speech.

**Keys are write-only.** The settings page only shows whether one is set and never sends the value back to the page. They live in the config file, which `install.sh` sets to `600`.

**A bad `ai` section does not stop capture.** With an invalid value in `ai` the daemon does not start recognition, writes the reason to `daemon.log`, and the ops page shows it. The api keeps serving and capture keeps running. Only saving from the settings page rejects it outright.

**Missing files make it wait.** When an enabled local step lacks its program or model, the daemon does not ask for work, the ops page names what is missing, and it checks again every 60 seconds. A model downloaded later needs no restart. See [deployment.md](deployment.md) for the model files.

### map

For picking the other side's grid on a map. No map by default.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `none` | `amap` (AMap), `osm` (OpenStreetMap) or `none` |
| `amapKey` | empty | The AMap Web (JS API) key. The page needs it, so it is sent to the page |
| `amapSecurityCode` | empty | The AMap security key. It stays in the api and never reaches the page |

With `provider` `amap`, both are required. Get the key and the security key from the AMap Open Platform console: Application Management, create an application, add a Key, and choose the service platform "Web (JS API)". A key created after 2 December 2021 must be used with a security key.

The security key stays out of the page. The api proxies AMap web-service requests under `/_AMapService/` and adds `jscode` before forwarding. This is the setup AMap recommends. Only `GET` is proxied, and it needs a session.

`osm` needs no key but may not open in China. Its place search is limited to one request per second and must not run as you type.

AMap coordinates are GCJ-02 and the grid is computed from WGS-84, so the program converts back first.
