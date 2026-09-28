# OpenHeard

**An amateur radio logbook that automatically records every contact.**

OpenHeard captures radio contacts from multiple sources—BrandMeister DMR network and analog repeaters—and assembles them into a structured log. Contacts populate automatically; operators only fill in what the machine cannot know.

## Quick Start

**Backend + daemon:**
```bash
cd api && npm install && OPENHEARD_CONFIG=../openheard.config.json npm start
cd daemon && npm install && npm start -- --config ../openheard.config.json
```

**Web UI + public page:**
```bash
cd web && npm install && npm run dev
cd public && npm install && npm run dev
```

Copy `api/openheard.config.example.json` to `openheard.config.json` and configure it first.

## What it Does

| Source | What OpenHeard Captures | What Needs Human Input |
|--------|------------------------|----------------------|
| **Analog FM (repeater)** | Time, duration, channel, whether you transmitted | Far station's callsign |
| **DMR (BrandMeister)** | Your transmission details (all fields), timestamp | Far station's callsign (from talkgroup query) |
| **HF (future)** | FT8 via WSJT-X UDP feed | SSB contacts (no automation) |

Contacts are clustered into conversations using measured silence thresholds (120 seconds for analog).

## Architecture

- **`api/`** — Hono backend over SQLite, REST endpoints for web and daemon
- **`daemon/`** — Polling service for BrandMeister; SDR listener for analog 438.700
- **`web/`** — React 19 + Ant Design 6 admin interface
  - Listening: confirm and review captured contacts
  - Log: search, ADIF import/export, QSL management
  - Entry: quick manual logging
  - Operations & Settings
- **`public/`** — Lightweight public station page (no external dependencies)
- **`core/`** — Shared framework-free business logic and data models

## Data Model

The log stores every field required for LoTW (Logbook of The World):
- Frequency, mode, band, RST (both directions), grid square
- Plus: QTH, equipment, antenna, power, elevation

## Design Decisions

Fixed before code started (highest cost to change):

- Full LoTW compliance from day one
- React 19 + Ant Design 6 for the UI
- No native client—browser-based only
- Reuse existing tools (TQSL via CLI, DXCC libraries)

## Testing & Deployment

Run locally:
```bash
npm test           # in api/, daemon/, web/
npm run verify     # root: typecheck, tests, lint, builds, smoke test
```

Deploy to production:
```bash
infra/install.sh   # macOS LaunchAgent setup
```

See [docs/deployment.md](docs/deployment.md) for details.

## Documentation

- **`specs/openheard.md`** — Technical specification
- **`docs/api-admin.md`** — Admin interface API
- **`docs/api-public.md`** — Public page API
- **`docs/api-ingest.md`** — Data capture API
- **`docs/config.md`** — Configuration reference
- **`docs/deployment.md`** — Setup and deployment

## License

**AGPL-3.0** — See [LICENSE](LICENSE)

Modified copies run as a network service must offer source to users.

---

## 中文说明

自动记录业余无线电通联的日志系统。支持 BrandMeister DMR 网络和模拟中继两个数据源。

- **`api/`** — Hono 后端，使用 SQLite
- **`daemon/`** — 轮询 BrandMeister，同时监听本地模拟信道 438.700
- **`web/`** — React 19 + Ant Design 6 管理界面
- **`public/`** — 轻量级公开展示页
- **`core/`** — 共享的业务逻辑

快速启动见上面的 Quick Start。完整文档在 `docs/` 目录。

协议：**AGPL-3.0**
