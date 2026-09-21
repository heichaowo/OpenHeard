# 部署

跑在一台 Mac mini 上，两个 LaunchAgent：`openheard-api` 和 `openheard-daemon`。

## 为什么是 LaunchAgent

守护进程要读 USB 上的接收机，要用 Homebrew 装的 `rtl_fm`，还要读家目录里的配置。以本人身份跑，这三件事都不用额外授权，安装也不用 sudo。

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

日志四个文件，`api.log`、`api.err.log`、`daemon.log`、`daemon.err.log`，都在 `~/Library/Logs/openheard`。`rtl_fm` 的输出走 `daemon.err.log`，它把采样率和缓冲区大小也写在那里，不是报错。

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

## 卸

```bash
infra/uninstall.sh
```

停掉两个 agent，删掉两个 plist。日志和数据库不动。

## 接收机被占住

一支接收机同一时刻只能被一个进程认领。之前手工跑的 `rtl_fm` 没退干净，守护进程就起不来，`daemon.err.log` 里是 `usb_claim_interface error -3`。

```bash
pkill -f rtl_fm
launchctl kickstart -k gui/$UID/uk.co.protocol7.openheard-daemon
```

---

# Deployment (English)

Runs on one Mac mini as two LaunchAgents, `openheard-api` and
`openheard-daemon`.

## Why LaunchAgent

The daemon reads a USB receiver, runs `rtl_fm` from Homebrew, and reads a
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
all under `~/Library/Logs/openheard`. `rtl_fm` writes to `daemon.err.log`,
including its sample rate and buffer size, which are not errors.

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

## Uninstalling

```bash
infra/uninstall.sh
```

Stops both agents and removes both plists. Logs and the database are left
alone.

## Receiver already claimed

One receiver can be claimed by one process at a time. An `rtl_fm` left over
from a manual run keeps the daemon from starting, with
`usb_claim_interface error -3` in `daemon.err.log`.

```bash
pkill -f rtl_fm
launchctl kickstart -k gui/$UID/uk.co.protocol7.openheard-daemon
```
