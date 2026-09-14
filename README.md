# OpenHeard

会自己填写的业余无线电通联日志。

## 这是什么

通联记录从两个来源自动进来，不用人打字。BrandMeister 有逐次会话的 feed，轮询它的历史查询就能取全。模拟中继什么都不发，所以用只收不发的 SDR 守住它的下行，把静噪开启变成事件。机器拿不到的部分由人补，模拟侧要补的只有对方呼号。

名字来自圈里现成的说法。BrandMeister 把它的 feed 叫 Last Heard，中继的「听到列表」是同一个意思。这套系统就是一本由「听到什么」驱动的日志。

## 现状

Web 界面跑在假数据上，四个页面都在：待确认队列、带 ADIF 导出的日志列表、快速补录表单和公开展示页。`core/` 放它们共用的纯逻辑，不依赖框架、数据库和 HTTP。后端和采集守护进程都还没有。

设计文档在 `specs/openheard.md`，只写约束代码的部分。站点数据、验证步骤和调研过程不在仓库里。

采集侧要先通过三步验证才动手写守护进程。三步分别检查驱动、USB 和天线，每一步失败指向不同的层。

## 已定的设计决定

这几条在写代码前定死，因为事后改代价最高。

- 数据模型从第一天就带齐 LoTW 需要的字段，包括频率、模式、波段、双向 RST 和网格
- 在此之上还存 QTH、设备、天线、功率和高度
- Web 界面用 React 19 加 Ant Design 6
- 不做原生客户端，浏览器够用
- 不重复造轮子，TQSL 签名调命令行，DXCC 判定用现成库

## 能自动到什么程度

| 通联怎么走 | 机器能知道什么 |
|---|---|
| 模拟 FM 过中继 | 时间、时长、哪个信道，以及这次有没有你 |
| 模拟 FM 的对方呼号 | 无，由人补 |
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

## 许可证

**AGPL-3.0**，见 `LICENSE`。

选它是因为这个项目最可能的形态是俱乐部拿去跑成公开网站。在这个形态下，MIT、MPL 和 GPL 的义务都不触发，因为它们由分发触发而自己部署不算分发。AGPL 第 13 条专门覆盖这一点，所以把它部署成公开服务的人必须向使用者提供源码。

---

# OpenHeard (English)

An amateur radio logbook that fills itself in.

## What this is

Contacts arrive from two places without anyone typing them. BrandMeister
publishes a per-session feed, which we poll rather than subscribe to. Analog repeaters publish nothing,
so a receive-only SDR listens to their downlinks and turns squelch openings
into events. A human supplies what the machine cannot know, which for analog is
the other station's callsign and nothing else.

The name comes from the term the hobby already uses. BrandMeister calls its
feed Last Heard, and a repeater's heard list is the same idea. This is a
logbook driven by what was heard.

## Status

The web UI runs against mock data, with all four pages in place: the
pending-confirmation queue, a log list with ADIF export, a quick-entry form
and a public station page. `core/` holds the framework-free logic they share.
There is no backend and no capture daemon yet.

The spec is in `specs/openheard.md` and covers only what constrains the code.
Site data, procedures and research are kept outside this repository.

The capture side must pass three verification steps before the daemon gets
written. Each step checks a different layer, so each failure means something
different.

## Settled design decisions

These were fixed before any code, because changing them later costs the most.

- The data model carries every field LoTW requires from day one, including
  frequency, mode, band, both RST directions and the grid square
- On top of that it stores QTH, device, antenna, power and height
- The web UI is React 19 with Ant Design 6
- There is no native client. A browser is enough
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

## Licence

**AGPL-3.0**. See `LICENSE`.

The likely deployment is a club running this as a public website. Under MIT,
MPL or GPL that triggers nothing, because their obligations follow
distribution and self-hosting is not distribution. Section 13 of the AGPL
covers exactly this case, so anyone who runs a modified copy as a public
service must offer the source to its users.
