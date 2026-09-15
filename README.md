# OpenHeard

自动记录每一次通联的业余无线电日志。

## 这是什么

通联记录不用人打字，来源有两个。BrandMeister 发布逐次会话的 feed，我们轮询它的历史查询，不订阅。模拟中继不发布任何数据，所以用一台只收不发的 SDR 听中继下行，把每一次静噪开启变成事件。机器不知道的那部分由人填，模拟侧要填的只有对方呼号。

名字取自 Last Heard。BrandMeister 这样称呼它的 feed，中继的「听到列表」也是这个意思。

## 现状

五个目录都在跑。`web/` 是管理端，四个页面：待确认队列、带 ADIF 导出的日志、快速补录和运维。`public/` 是公开展示页，独立应用，除 react 外零依赖，一个请求拿齐整页。`api/` 用 Hono 加内置的 `node:sqlite`，只监听回环地址。`daemon/` 同时轮询 BrandMeister 和守听一个模拟信道。`core/` 放它们共用的纯逻辑，不依赖框架、数据库和 HTTP。

两条采集线都在真信号上验过。BrandMeister 那条一次取回 200 行入库并聚成对话。模拟那条在 438.700 上把每次按下 PTT 切成事件，并靠 MDC-1200 认出本台。

还差两样。聚类的间隔阈值要用真实流量实测，现在是占位数。公开展示页对外怎么落地没有方案，主机在国内而 `bg0cg.ampr.org` 无法备案。

设计规范在 `specs/openheard.md`，只写约束代码的内容。场地数据、验证步骤和调研过程不放在仓库里。

## 已定的设计决定

这几条在写代码前定死，因为事后改代价最高。

- 数据模型从第一天就带齐 LoTW 要的字段，包括频率、模式、波段、双向 RST 和网格
- 在此之上还存 QTH、设备、天线、功率和高度
- Web 界面用 React 19 加 Ant Design 6
- 现在不做原生客户端，浏览器够用
- 不重复造轮子，TQSL 签名调命令行，DXCC 判定用现成库

## 能自动到什么程度

| 通联怎么走 | 机器能知道什么 |
|---|---|
| 模拟 FM 过中继 | 时间、时长、哪个信道，以及这次有没有你 |
| 模拟 FM 的对方呼号 | 无，由人填 |
| DMR 过 BrandMeister | 本台发射的全部字段，对方呼号要另查话务组 |
| HF，以后 | FT8 走 WSJT-X 的 UDP，SSB 无 |

模拟侧那个缺口是永久的。模拟 FM 空中不带身份信息，任何接收机和任何软件都叫不出对方呼号。语音识别能缩小缺口，不能消除，所以它是可选项。

## 怎么跑

后端和采集守护进程各跑一个进程，配置抄 `api/openheard.config.example.json`。

```
cd api && npm install && OPENHEARD_CONFIG=../openheard.config.json npm start
cd daemon && npm install && npm start -- --config ../openheard.config.json
cd web && npm install && npm run dev
cd public && npm install && npm run dev
```

`npm test` 在 `api/`、`daemon/` 和 `web/` 下各自可跑，`web/` 那个跑的是 `core/` 的测试。

## 许可证

**AGPL-3.0**，见 `LICENSE`。把修改过的副本跑成网络服务，就必须向使用者提供它的源码。

---

# OpenHeard (English)

An amateur radio logbook that fills itself in.

## What this is

Contacts arrive without anyone typing them, from two sources. BrandMeister
publishes a per-session feed, which we poll rather than subscribe to. Analog
repeaters publish nothing, so a receive-only SDR listens to the downlink and
turns each squelch opening into an event. A human fills in what the machine
cannot know, which on the analog side is the other station's callsign and
nothing else.

The name is taken from Last Heard. That is what BrandMeister calls its feed,
and a repeater's heard list means the same thing.

## Status

All five directories run. `web/` is the admin side: the pending-confirmation
queue, a log with ADIF export, a quick-entry form and an operations page.
`public/` is the public station page, a separate app with no dependencies
beyond react, fetching the whole page in one request. `api/` is Hono over the
built-in `node:sqlite`, bound to loopback only. `daemon/` polls BrandMeister
and watches one analog channel at the same time. `core/` holds the
framework-free logic they share.

Both capture paths have been verified on live signals. The BrandMeister one
pulls 200 rows into the database and clusters them into conversations; the
analog one turns each key-up on 438.700 into an event and recognises our own
station from its MDC-1200 burst.

Two things are still open. The clustering gap threshold needs measuring
against real traffic and is a placeholder today. And there is no plan yet for
where the public page is served from, since the host is in China and
`bg0cg.ampr.org` cannot get an ICP filing.

The spec is in `specs/openheard.md` and covers only what constrains the code.
Site data, procedures and research are kept outside this repository.

## Settled design decisions

These were fixed before any code, because changing them later costs the most.

- The data model carries every field LoTW requires from day one, including
  frequency, mode, band, both RST directions and the grid square
- On top of that it stores QTH, device, antenna, power and height
- The web UI is React 19 with Ant Design 6
- No native client for now. A browser is enough
- Nothing gets reinvented. TQSL signs through its command line, and DXCC
  resolution uses an existing library

## How far automation reaches

| How the contact was carried | What the machine can know |
|---|---|
| Analog FM through a repeater | when, how long, which channel, and whether we were in it |
| Analog FM, the far station's callsign | nothing, a human types it |
| DMR through BrandMeister | every field of our own transmissions; the far station's callsign needs a second query against the talkgroup |
| HF, later | FT8 through the WSJT-X UDP feed, nothing for SSB |

The analog gap is permanent. Analog FM carries no identity, so no receiver and
no software can name the far station. Speech recognition narrows the gap
without closing it, which is why it stays optional.

## Running it

The backend and the capture daemon are separate processes. Copy
`api/openheard.config.example.json` for the config.

```
cd api && npm install && OPENHEARD_CONFIG=../openheard.config.json npm start
cd daemon && npm install && npm start -- --config ../openheard.config.json
cd web && npm install && npm run dev
cd public && npm install && npm run dev
```

`npm test` works in `api/`, `daemon/` and `web/`; the one in `web/` runs the
`core/` tests.

## Licence

**AGPL-3.0**. See `LICENSE`. Running a modified copy as a network service
obliges you to offer its source to the people using it.
