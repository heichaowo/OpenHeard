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
infra/install.sh ~/OpenHeard/openheard.config.json
```

`install.sh` 每次都先验配置、再备份、最后才装，所以升级不用额外动作。备份失败就停下来，不往下走。

## 数据库

schema 版本记在 `PRAGMA user_version` 里。api 开库时把落后的迁移补上，跑完把版本号写进 `api.log`。库的版本比程序新就不开库，因为旧代码会按旧的理解读新表。

备份用 `VACUUM INTO`，不要用 `cp`。WAL 模式下主库和 `-wal` 是两个文件，`cp` 分两次读，中间写进来的改动只落在一边。

配置里 `dbPath` 的相对路径按配置文件所在目录算，和你在哪个目录敲命令无关。

```bash
node api/src/backup.ts ~/OpenHeard/openheard.config.json
```

缺省写到数据库同级的 `backups/`，文件名带 UTC 时刻。第二个参数换目标目录。旧备份不自动删，自己清。

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
infra/install.sh ~/OpenHeard/openheard.config.json
```

`install.sh` validates the config, then backs up, then installs, so an upgrade
needs nothing extra. A failed backup stops it before anything is installed.

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
