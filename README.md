# OpenHeard

自动记录每一次通联的业余无线电日志。

## 这是什么

通联记录不用人打字，来源有两个。BrandMeister 发布逐次会话的 feed，我们轮询它的历史查询，不订阅。模拟中继不发布任何数据，所以用一台只收不发的 SDR 听中继下行，把每一次静噪开启变成事件。机器不知道的那部分由人填，模拟侧要填的只有对方呼号。

名字取自 Last Heard。BrandMeister 这样称呼它的 feed，中继的「听到列表」也是这个意思。

## 现状

Web 界面跑在假数据上，四个页面都有了：待确认队列、带 ADIF 导出的日志列表、快速补录表单和公开展示页。`core/` 放它们共用的纯逻辑，不依赖框架、数据库和 HTTP。后端和采集守护进程还没写。

设计规范在 `specs/openheard.md`，只写约束代码的内容。场地数据、验证步骤和调研过程不放在仓库里。

采集侧要先跑通三步验证才动手写守护进程。三步分别检查驱动、USB 和天线，哪一步失败就指向哪一层。

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

```
cd web
npm install
npm run dev
```

`npm test` 跑 `core/` 的测试，`npm run build` 做类型检查并构建。

## 用到的别人的代码

Web 界面的布局、主题取值和两个组件改写自 OpenLogTool Server。

- 版权 © 2026 Mazha0309 与贡献者，AGPL-3.0-only
- 来源 <https://github.com/Mazha0309/OpenLogToolServer>
- 涉及 `web/src/styles.css`、`web/src/App.tsx` 的主题段、`web/src/components/AppShell.tsx`、`PageHeader.tsx`、`AsyncContent.tsx`
- 都做了删减和改写，各文件头部注明了改动

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

The web UI runs against mock data, with all four pages in place: the
pending-confirmation queue, a log list with ADIF export, a quick-entry form
and a public station page. `core/` holds the framework-free logic they share.
The backend and the capture daemon are not written yet.

The spec is in `specs/openheard.md` and covers only what constrains the code.
Site data, procedures and research are kept outside this repository.

The capture side must pass three verification steps before the daemon gets
written. They check the driver, the USB path and the antenna, so each failure
points at a different layer.

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

```
cd web
npm install
npm run dev
```

`npm test` runs the `core/` tests. `npm run build` type-checks and builds.

## Borrowed code

The web UI's layout, theme tokens and two components are adapted from
OpenLogTool Server.

- Copyright © 2026 Mazha0309 and contributors, AGPL-3.0-only
- Source <https://github.com/Mazha0309/OpenLogToolServer>
- Covers `web/src/styles.css`, the theme block in `web/src/App.tsx`, and
  `web/src/components/AppShell.tsx`, `PageHeader.tsx`, `AsyncContent.tsx`
- All were trimmed and rewritten; each file's header says what changed

## Licence

**AGPL-3.0**. See `LICENSE`. Running a modified copy as a network service
obliges you to offer its source to the people using it.
