# 部署

跑在一台 Mac mini 上，两个 LaunchAgent：`openheard-api` 和 `openheard-daemon`。

## 为什么是 LaunchAgent

守护进程要读 USB 上的接收机，要用 Homebrew 装的 `rtl_sdr`，还要读家目录里的配置。以本人身份跑，这三件事都不用额外授权，安装也不用 sudo。

代价是要保持登录。Mac mini 开自动登录，重启后两个服务跟着起来。

## 装之前

Node 24 或更高。低于 24 没有类型擦除，`api/` 和 `daemon/` 直接跑 `.ts` 这条路就断了。

```bash
brew install node rtl-sdr
git clone https://github.com/heichaowo/OpenHeard.git ~/OpenHeard
cd ~/OpenHeard && npm ci --prefix api && npm ci --prefix daemon
npm ci --prefix web && npm run build --prefix web
cp api/openheard.config.example.json openheard.config.json
```

改配置，字段见 [configuration.md](configuration.md)。口令哈希和两个密钥这样生成：

```bash
node api/src/hash-password.ts '你的口令'
openssl rand -hex 32
```

## 装

```bash
infra/install.sh ~/OpenHeard/openheard.config.json
```

它先验配置，不过就停下。配置错了照装，结果是一个每 30 秒重启一次、谁也看不见的循环。

它还会把配置文件改成 `600`，因为里面有 `ingestToken` 和 `sessionSecret`。

换端口在安装时给：

```bash
OPENHEARD_PORT=8080 infra/install.sh ~/OpenHeard/openheard.config.json
```

端口写进 plist，改端口要重装。

## 看状态

```bash
launchctl print gui/$UID/uk.co.protocol7.openheard-api
tail -f ~/Library/Logs/openheard/daemon.log
curl -s http://127.0.0.1:3000/health
```

日志四个文件，`api.log`、`api.err.log`、`daemon.log`、`daemon.err.log`，都在 `~/Library/Logs/openheard`。`rtl_sdr` 的输出走 `daemon.err.log`，它把找到的设备和调谐器也写在那里，不是报错。

launchd 不轮转日志。日志长到碍事时自己截断。

## 睡眠

Mac 睡着，两个服务跟着停，那段时间的发射听不到，也补不回来。要它一直醒着：

```bash
sudo pmset -a sleep 0
```

安装脚本只提示这一条，不替你改电源设置。

## 升级

```bash
cd ~/OpenHeard && git pull
npm ci --prefix api && npm ci --prefix daemon
npm ci --prefix web && npm run build --prefix web
infra/install.sh ~/OpenHeard/openheard.config.json
```

`install.sh` 每次都先验配置、再备份、最后才装，所以升级不用额外动作。备份失败就停下来，不往下走。

头一次装的时候健康检查是通过的，那时还一次都没轮询过，这不算问题。等过了最慢那条查询间隔的三倍还没轮询成功，`/health` 才开始回 503。

## 从手机上用

监听地址缺省是 `127.0.0.1`，所以本机之外谁都够不着。站在楼下拿手台要用手机确认通联，有两条路。

**走 Tailscale。** 服务照旧只绑回环，由 Tailscale 从 tailnet 转进来，只有自己的设备连得上，而且它自己终结 TLS，会话 cookie 走的是加密链路。

```bash
tailscale serve --bg --https=8443 3000
```

之后手机上开 `https://<主机名>.<tailnet>.ts.net:8443`。`--https=443` 也行，但那个端口可能已经被这台机器上别的服务占了，`tailscale serve status` 看得到。撤掉是 `tailscale serve --https=8443 off`。

**改成 `0.0.0.0`。** 这样同一个局域网上任何设备都够得着，包括登录口。登录口有限速，但那是最后一道，不是第一道。没有 Tailscale 才走这条。

会话 cookie 在请求从 https 过来时带 `Secure`。Tailscale 转进来的是明文回环，所以看的是 `X-Forwarded-Proto`。

## 管理端界面

`api` 在根路径上发 `web/dist`，所以装之前要先构建，否则浏览器打开只有接口、一片 404。前端路由（`/log`、`/ops` 这些）由服务端一律回首页。

## 数据库

schema 版本记在 `PRAGMA user_version` 里。api 开库时把落后的迁移补上，跑完把版本号写进 `api.log`。库的版本比程序新就不开库，因为旧代码会按旧的理解读新表。

备份用 `VACUUM INTO`，不要用 `cp`。WAL 模式下主库和 `-wal` 是两个文件，`cp` 分两次读，中间写进来的改动只落在一边。

配置里 `dbPath` 的相对路径按配置文件所在目录算，和你在哪个目录敲命令无关。

```bash
node api/src/backup.ts ~/OpenHeard/openheard.config.json
```

缺省写到数据库同级的 `backups/`，文件名带 UTC 时刻。第二个参数换目标目录。旧备份不自动删，自己清。

写完当场验一遍：能打开、`integrity_check` 通过、四张表的行数和 schema 版本都和源库对得上。验不过就退出 1 并说明哪一项不对，`install.sh` 会停在这里不往下装。`VACUUM INTO` 没报错不等于那个文件能用，而备份坏没坏，等到要恢复那天才发现就太晚了。

恢复要在服务停着的时候做：

```bash
infra/uninstall.sh
cd ~/OpenHeard
cp backups/openheard-20260915T113840Z.db openheard.db
rm -f openheard.db-wal openheard.db-shm
infra/install.sh ~/OpenHeard/openheard.config.json
```

`-wal` 和 `-shm` 是旧库的，留着会和恢复回来的库对不上。

## 语音识别（可选）

识别在守护进程里跑，不另起服务。缺省关。想用本机识别，先装程序，再下模型，最后打开。想用云端识别，直接看「本机和云端之间切换」。

### 装程序

```bash
brew install whisper-cpp llama.cpp
```

装完 `/opt/homebrew/bin` 里有 `whisper-cli`、`whisper-vad-speech-segments` 和 `llama-server`。核对过的版本是 whisper.cpp 1.9.4 和 llama.cpp 0.5.0（build 11146）。

### 下模型

**下载是你的一步，程序不会自己下。** 模型放在配置文件旁的 `models/`，路径缺省就指向那里。

| 文件 | 大小 | sha256 |
|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin`（识别） | 574,041,195 字节 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| `ggml-silero-v5.1.2.bin`（人声判断） | 885,098 字节 | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` |
| `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`（提取） | 2,497,281,120 字节 | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |

从 ModelScope 下，国内连得上：

```bash
mkdir -p ~/OpenHeard/models && cd ~/OpenHeard/models
curl -L -O https://www.modelscope.cn/models/viggocx/whisper.cpp/resolve/master/ggml-large-v3-turbo-q5_0.bin
curl -L -O https://www.modelscope.cn/models/ggml-org/whisper-vad/resolve/master/ggml-silero-v5.1.2.bin
curl -L -O https://www.modelscope.cn/models/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/master/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
shasum -a 256 ggml-large-v3-turbo-q5_0.bin ggml-silero-v5.1.2.bin Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

`shasum` 打出的值要和上表一致。不一致就删掉重下。

三个文件一共约 3.1 GB。mini 上实测磁盘只剩 13 GiB，下之前先看一眼。

`viggocx/whisper.cpp` 是 `ggerganov/whisper.cpp` 的第三方镜像，sha256 和上游一致，ModelScope 上没有官方那份。Qwen3-4B-Instruct-2507 是 Apache-2.0。同名的 lmstudio-community 那份 sha256 不同，换用时以自己下的那份为准。

### 打开之前，先核对一次真实的人声判断输出

程序读 `whisper-vad-speech-segments` 的输出，格式来自上游源码，**还没有在 mini 上用真模型验过**。下好模型之后、打开识别之前，手工跑一次，和下面的格式对一遍：

```bash
cd ~/OpenHeard
whisper-vad-speech-segments -vm models/ggml-silero-v5.1.2.bin -f recordings/<一条有话的>.wav -vt 0.5 -np
```

期望的输出：

```
Detected 2 speech segments:
Speech segment 0: start = 10.00, end = 150.00
Speech segment 1: start = 180.00, end = 250.00
```

核对三处：

1. 第一行是 `Detected N speech segments:`，N 是段数。
2. 接下来恰好 N 行，每行是 `Speech segment i: start = T0, end = T1`。
3. 时间单位是百分之一秒。一条 3 秒、一直有话的录音，数值在 300 上下，不是 3。

再挑一条 1 秒左右的空按跑一次，期望第一行是 `Detected 0 speech segments:`。

任何一处对不上，就不要打开识别。程序遇到对不上的输出会报识别失败，不会当成没有人声，但那样白白耗掉重试次数。先弄清格式，再改程序。

### 打开

设置页「识别」卡里打开，或者在配置里写 `"ai": {"enabled": true}`。守护进程盯着配置文件，不用重启。

打开前，守护进程先查开着的本机步骤要用的程序和模型在不在。缺哪个，运维页上写哪个，守护进程不去要活，每 60 秒再查一次。所以模型可以先打开、后下载，下好就接着做。

### 出错怎么办

出错分两类，处理不同。

**这一条录音的问题**，记成「识别失败」：读不了录音，提供方说这份输入不行（400、413、422），子进程在这个文件上失败，模型回的不是 JSON。每条最多试 3 次，两次之间至少隔 1 小时。做的时候录音被人删了，不记，直接跳过。同一步连着两条都失败时（中间没有成功过，跨批次也算），先当成下一类，第二条不记，状态和日志里写出两条的 id。等一会儿再做，先做别的录音来对照。别的录音在这一步通过了，环境没问题，这两条记成「识别失败」，队列接着往前走。别的录音也在这一步失败了，是环境的问题，什么都不记。

**环境的问题**，不记在录音上：程序或模型没了，llama-server 90 秒内没就绪或者起来就退出，网络断了，超时，HTTP 401、403、404、429、5xx。这一条留着，等 60 秒再试，之后每次翻倍，最多 10 分钟。服务端给了 `Retry-After` 就按它等。运维页上写着原因。

这样一次配置失误（key 填错、模型没下好）不会把整批积压的重试次数用光。

`daemon.log` 里每小时有一行小结，写处理了几条、几条没有人声、几条无意义、几条出错，以及平均每条几秒。

### 本机和云端之间切换

识别和提取各选各的，改设置页「识别」卡里的下拉，或者改配置里的 `asr.provider` 和 `text.provider`。守护进程盯着文件，不用重启。

- 换到云端要填 `baseUrl`、`model` 和 `apiKey`，各家要加的 `extraBody` 见 [configuration.md](configuration.md)。
- 云端识别和提取会把每段录音或转写发给第三方。本机的不出这台机器。
- 只改识别时，llama-server 留着不动。把提取从本机换到云端时，llama-server 退出，内存还回来。
- 已经识别好的录音不重做。还没做的，按新设置从新到旧接着做。
- 在设置页改 `ai` 时，api 会清掉识别失败的记录，让它们按新设置重做。手改配置文件的话，要重启 api 才清。

## 卸

```bash
infra/uninstall.sh
```

停掉两个 agent，删掉两个 plist。日志和数据库不动。

## 接收机被占住

一支接收机同一时刻只能被一个进程认领。之前手工跑的 `rtl_sdr` 或 `rtl_fm` 没退干净，守护进程就起不来，`daemon.err.log` 里是 `usb_claim_interface error -3`。

```bash
pkill -f "rtl_sdr|rtl_fm"
launchctl kickstart -k gui/$UID/uk.co.protocol7.openheard-daemon
```

---

# Deployment (English)

Runs on one Mac mini as two LaunchAgents, `openheard-api` and
`openheard-daemon`.

## Why LaunchAgent

The daemon reads a USB receiver, runs `rtl_sdr` from Homebrew, and reads a
config in the home directory. Running as the logged-in user makes all three
work without extra authorisation, and installing needs no sudo.

The cost is that a login session has to exist. Turn on automatic login and
both services come back after a reboot.

## Before installing

Node 24 or newer. Below 24 there is no type stripping, and running `.ts`
directly in `api/` and `daemon/` stops working.

```bash
brew install node rtl-sdr
git clone https://github.com/heichaowo/OpenHeard.git ~/OpenHeard
cd ~/OpenHeard && npm ci --prefix api && npm ci --prefix daemon
npm ci --prefix web && npm run build --prefix web
cp api/openheard.config.example.json openheard.config.json
```

Edit the config; the fields are in [configuration.md](configuration.md).
Generate the password hash and the two secrets:

```bash
node api/src/hash-password.ts 'your password'
openssl rand -hex 32
```

## Install

```bash
infra/install.sh ~/OpenHeard/openheard.config.json
```

It validates the config first and stops if that fails. Installing a broken
config gives a restart loop every 30 seconds that nobody can see.

It also chmods the config to `600`, since it holds `ingestToken` and
`sessionSecret`.

Choose the port at install time:

```bash
OPENHEARD_PORT=8080 infra/install.sh ~/OpenHeard/openheard.config.json
```

The port is written into the plist, so changing it means reinstalling.

## Checking on it

```bash
launchctl print gui/$UID/uk.co.protocol7.openheard-api
tail -f ~/Library/Logs/openheard/daemon.log
curl -s http://127.0.0.1:3000/health
```

Four log files, `api.log`, `api.err.log`, `daemon.log` and `daemon.err.log`,
all under `~/Library/Logs/openheard`. `rtl_sdr` writes to `daemon.err.log`,
including the device and tuner it found, which are not errors.

launchd does not rotate these. Truncate them when they get in the way.

## Sleep

When the Mac sleeps both services stop, and transmissions during that time are
missed and cannot be recovered. To keep it awake:

```bash
sudo pmset -a sleep 0
```

The install script only prints this; it does not change power settings for
you.

## Upgrading

```bash
cd ~/OpenHeard && git pull
npm ci --prefix api && npm ci --prefix daemon
npm ci --prefix web && npm run build --prefix web
infra/install.sh ~/OpenHeard/openheard.config.json
```

`install.sh` validates the config, then backs up, then installs, so an upgrade
needs nothing extra. A failed backup stops it before anything is installed.

On a first install the health check passes even though nothing has been polled
yet, which is not a problem. `/health` only starts answering 503 once three
times the slowest query interval has gone by with no successful poll.

## Using it from a phone

The listen address defaults to `127.0.0.1`, so nothing off the machine can
reach it. Confirming a contact from a phone while standing outside with a
handheld has two routes.

**Tailscale.** The service stays bound to loopback and Tailscale proxies in
from the tailnet, so only your own devices reach it, and it terminates TLS
itself, so the session cookie travels encrypted.

```bash
tailscale serve --bg --https=8443 3000
```

Then open `https://<host>.<tailnet>.ts.net:8443` on the phone. `--https=443`
works too, but that port may already be taken by something else on the machine;
`tailscale serve status` shows what is there. Remove it with
`tailscale serve --https=8443 off`.

**Set `0.0.0.0`.** Anything on the same LAN can then reach it, login included.
The login is rate limited, but that is the last line, not the first. Take this
route only without Tailscale.

The session cookie is marked `Secure` when the request arrived over https.
Tailscale proxies in as plain loopback, so what is read is `X-Forwarded-Proto`.

## The admin UI

`api` serves `web/dist` at the root, so it has to be built before installing;
otherwise a browser finds only the API and a page of 404s. Client-side routes
(`/log`, `/ops` and the rest) are answered with the index page.

## The database

The schema version lives in `PRAGMA user_version`. The API applies whatever
migrations the database is behind on when it opens it, and writes the
resulting version to `api.log`. A database newer than the binary is refused,
since old code would read new tables with old assumptions.

Back up with `VACUUM INTO`, not `cp`. Under WAL the main file and `-wal` are
two files, and `cp` reads them one after the other, so a write landing in
between ends up in only one of them.

A relative `dbPath` in the config resolves against the config file's own
directory, not against wherever you ran the command from.

```bash
node api/src/backup.ts ~/OpenHeard/openheard.config.json
```

It writes to `backups/` next to the database by default, named with a UTC
timestamp. A second argument changes the directory. Old backups are never
deleted for you.

Each backup is verified as soon as it is written: it opens, `integrity_check`
passes, and the four table counts and the schema version match the source. A
failure exits 1 naming what did not match, and `install.sh` stops there without
installing anything. `VACUUM INTO` returning without an error is not the same
as the file being usable, and finding out on the day you need to restore is too
late.

Restoring is done with the services stopped:

```bash
infra/uninstall.sh
cd ~/OpenHeard
cp backups/openheard-20260915T113840Z.db openheard.db
rm -f openheard.db-wal openheard.db-shm
infra/install.sh ~/OpenHeard/openheard.config.json
```

The `-wal` and `-shm` files belong to the old database and do not match the
one restored.

## Speech recognition (optional)

Recognition runs inside the daemon, not as another service. Off by default. For local recognition, install the programs, download the models, then turn it on. For cloud recognition, go straight to "Switching between local and cloud".

### Install the programs

```bash
brew install whisper-cpp llama.cpp
```

`/opt/homebrew/bin` then holds `whisper-cli`, `whisper-vad-speech-segments` and `llama-server`. The versions checked are whisper.cpp 1.9.4 and llama.cpp 0.5.0 (build 11146).

### Download the models

**Downloading is your step. The program never downloads anything.** Put the models in `models/` next to the config file, which is where the default paths point.

| File | Size | sha256 |
|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin` (recognition) | 574,041,195 bytes | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |
| `ggml-silero-v5.1.2.bin` (speech detection) | 885,098 bytes | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` |
| `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (extraction) | 2,497,281,120 bytes | `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597` |

Download from ModelScope, which is reachable from China:

```bash
mkdir -p ~/OpenHeard/models && cd ~/OpenHeard/models
curl -L -O https://www.modelscope.cn/models/viggocx/whisper.cpp/resolve/master/ggml-large-v3-turbo-q5_0.bin
curl -L -O https://www.modelscope.cn/models/ggml-org/whisper-vad/resolve/master/ggml-silero-v5.1.2.bin
curl -L -O https://www.modelscope.cn/models/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/master/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
shasum -a 256 ggml-large-v3-turbo-q5_0.bin ggml-silero-v5.1.2.bin Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

The values `shasum` prints must match the table. If they do not, delete the file and download it again.

The three files add up to about 3.1 GB. The mini had only 13 GiB free when measured, so check before downloading.

`viggocx/whisper.cpp` is a third-party mirror of `ggerganov/whisper.cpp` with the same sha256 as upstream; the official repository is not on ModelScope. Qwen3-4B-Instruct-2507 is Apache-2.0. The lmstudio-community copy of the same name has a different sha256, so if you use it, go by the hash of the file you downloaded.

### Before turning it on, compare one real speech-detection run

The program reads the output of `whisper-vad-speech-segments`. The format comes from the upstream source and **has not been checked on the mini with the real model**. After downloading the models and before turning recognition on, run it once by hand and compare it with the format below:

```bash
cd ~/OpenHeard
whisper-vad-speech-segments -vm models/ggml-silero-v5.1.2.bin -f recordings/<a clip with speech>.wav -vt 0.5 -np
```

Expected output:

```
Detected 2 speech segments:
Speech segment 0: start = 10.00, end = 150.00
Speech segment 1: start = 180.00, end = 250.00
```

Check three things:

1. The first line is `Detected N speech segments:`, where N is the segment count.
2. Exactly N lines follow, each `Speech segment i: start = T0, end = T1`.
3. The time unit is hundredths of a second. For a 3 second clip with speech all the way through, the values are around 300, not 3.

Then run a roughly 1 second empty key-up and expect `Detected 0 speech segments:` on the first line.

If anything differs, do not turn recognition on. On output that does not match, the program reports a recognition failure and never treats it as no speech, but that burns retries for nothing. Settle the format first, then fix the program.

### Turning it on

Switch it on in the 识别 card on the settings page, or write `"ai": {"enabled": true}` in the config. The daemon watches the config file, so no restart is needed.

Before it starts, the daemon checks that the programs and models of the enabled local steps exist. For anything missing, the ops page names it, the daemon does not ask for work, and it checks again every 60 seconds. So you may turn it on first and download later; it carries on once the files are there.

### When something goes wrong

Failures come in two kinds and are handled differently.

**A problem with this recording** is recorded as "识别失败" (recognition failed): the recording cannot be read, the provider says this input is bad (400, 413, 422), a child process fails on this file, or the model's reply is not JSON. Each recording is tried at most 3 times, at least 1 hour apart. A recording deleted while it is being processed is skipped and not recorded. When two recordings in a row fail at the same step (with no success between them, across batches too), it is first treated as the second kind: the second one is not recorded, and the status and the log name both ids. After a wait, other recordings go first as a check. If one of them passes that step, the environment is fine, both are recorded as "识别失败" and the queue moves on. If one of them fails at that step too, it is an environment problem and nothing is recorded.

**A problem with the environment** is never recorded on the recording: a program or model is gone, llama-server is not ready within 90 seconds or exits on start, the network is down, a timeout, or HTTP 401, 403, 404, 429 or 5xx. The recording is kept and retried after 60 seconds, doubling each time up to 10 minutes. A `Retry-After` from the server is honoured. The ops page shows the reason.

So one configuration mistake, a wrong key or a model not yet downloaded, cannot use up the retries of the whole backlog.

`daemon.log` gets a summary line every hour: how many were processed, how many had no speech, how many were meaningless, how many failed, and the mean seconds per item.

### Switching between local and cloud

Recognition and extraction are chosen separately. Change the dropdowns in the 识别 card on the settings page, or `asr.provider` and `text.provider` in the config. The daemon watches the file, so no restart is needed.

- Switching to cloud needs `baseUrl`, `model` and `apiKey`. The `extraBody` each vendor needs is in [configuration.md](configuration.md).
- Cloud recognition and extraction send each recording or transcript to a third party. The local ones never leave the machine.
- Changing only recognition leaves llama-server alone. Switching extraction from local to cloud stops llama-server and returns its memory.
- Recordings already recognised are not redone. Those not yet done carry on with the new setting, newest first.
- When `ai` is changed on the settings page, the api clears the recognition-failed records so they are redone with the new setting. After a hand edit of the config file, the api has to restart before it clears them.

## Uninstalling

```bash
infra/uninstall.sh
```

Stops both agents and removes both plists. Logs and the database are left
alone.

## Receiver already claimed

One receiver can be claimed by one process at a time. An `rtl_sdr` or `rtl_fm`
left over from a manual run keeps the daemon from starting, with
`usb_claim_interface error -3` in `daemon.err.log`.

```bash
pkill -f "rtl_sdr|rtl_fm"
launchctl kickstart -k gui/$UID/uk.co.protocol7.openheard-daemon
```
