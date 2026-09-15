import { useCallback, useEffect, useState } from 'react'
import { fetchSummary } from './api.ts'
import type { Summary } from './api.ts'
import { zoneName } from '@core'
import { UTC, ZONE_KEY, allZones, at, localZone, zoneLabel } from './time.ts'

function Bar({ rows }: { rows: { key: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n))
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.key}>
          <span className="bar-label">{r.key}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ inlineSize: `${(r.n / max) * 100}%` }} />
          </span>
          <span className="bar-count">{r.n}</span>
        </li>
      ))}
    </ul>
  )
}

function Stat({
  label,
  value,
  small,
}: {
  label: string
  value: string | number
  /** 日期比计数长得多，用同样的字号会在窄卡片里折行。 */
  small?: boolean
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={small ? 'stat-value stat-value-small' : 'stat-value'}>{value}</div>
    </div>
  )
}

/** 采集一直在跑，页面开着就该看见新的通联。 */
const REFRESH_MS = 60000

const readZone = () => {
  try {
    const v = localStorage.getItem(ZONE_KEY)
    if (v && allZones().includes(v)) return v
  } catch {
    // 无痕窗口读不到，当没选过。
  }
  return UTC
}

/**
 * 显示时区。缺省 UTC，因为业余无线电按 UTC 记，来看这一页的多半也是同好。
 *
 * 只改显示，记录本身一律 UTC。
 */
function ZoneSelect({ zone, onChange }: { zone: string; onChange: (z: string) => void }) {
  const here = localZone()
  const quick = here === UTC ? [UTC] : [UTC, here]
  return (
    <label className="zone">
      <span className="zone-label">时区</span>
      <select
        value={zone}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`显示时区，现在是 ${zoneLabel(zone)}`}
      >
        {quick.map((z) => (
          <option key={z} value={z}>
            {zoneLabel(z)}
          </option>
        ))}
        <optgroup label="全部">
          {allZones()
            .filter((z) => !quick.includes(z))
            .map((z) => (
              <option key={z} value={z}>
                {zoneName(z)}
              </option>
            ))}
        </optgroup>
      </select>
    </label>
  )
}

export function App() {
  const [data, setData] = useState<Summary | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [zone, setZone] = useState<string>(readZone)

  const pickZone = useCallback((z: string) => {
    setZone(z)
    try {
      localStorage.setItem(ZONE_KEY, z)
    } catch {
      // 无痕窗口写不了，这一次会话里照样有效。
    }
  }, [])

  const load = useCallback(() => {
    fetchSummary().then(
      (d) => {
        setData(d)
        setError(undefined)
      },
      (e: Error) => setError(e.message),
    )
  }, [])

  useEffect(() => {
    load()
    // 标签页在后台时不拉，切回来立刻补一次。
    const tick = () => {
      if (!document.hidden) load()
    }
    const t = setInterval(tick, REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  // 拉失败但手上还有上一次的数据，就接着显示，只在上面挂一条。
  if (error && !data) {
    return (
      <main className="page">
        <p className="notice" role="alert">
          {error}
          <button type="button" className="retry" onClick={load}>
            重试
          </button>
        </p>
      </main>
    )
  }
  if (!data) {
    return (
      <main className="page">
        <p className="notice" aria-live="polite">
          正在读取…
        </p>
      </main>
    )
  }

  const s = data.station
  const call = s.myCallsign ?? '本台'
  const where = [s.myQth, s.myGridsquare].filter(Boolean).join(' · ')
  const rig = [s.myDevice, s.myAntenna, s.myPower].filter(Boolean)
  if (s.myHeightM !== undefined) rig.push(`天线 ${s.myHeightM} 米`)

  return (
    <main className="page">
      {error && (
        <p className="notice stale" role="status">
          {error}
          <button type="button" className="retry" onClick={load}>
            重试
          </button>
        </p>
      )}
      <header className="head">
        <div className="head-top">
          <h1>{call}</h1>
          <ZoneSelect zone={zone} onChange={pickZone} />
        </div>
        {where && <p className="where">{where}</p>}
        {rig.length > 0 && <p className="rig">{rig.join(' · ')}</p>}
      </header>

      <section className="stats" aria-label="统计">
        <Stat label="通联总数" value={data.total} />
        <Stat label="不同呼号" value={data.distinctCalls} />
        <Stat small label="最早一次" value={data.firstAt ? at(data.firstAt, zone, false) : '—'} />
        <Stat small label="最近一次" value={data.lastAt ? at(data.lastAt, zone) : '—'} />
      </section>

      {data.total > 0 && (
        <section className="split">
          <div>
            <h2>按波段</h2>
            <Bar rows={data.byBand} />
          </div>
          <div>
            <h2>按模式</h2>
            <Bar rows={data.byMode} />
          </div>
        </section>
      )}

      <section>
        <h2>最近通联</h2>
        {data.recent.length === 0 ? (
          <p className="notice">还没有通联</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">时间 {zoneLabel(zone)}</th>
                  <th scope="col">呼号</th>
                  <th scope="col">波段</th>
                  <th scope="col">模式</th>
                  <th scope="col">报告 发/收</th>
                  <th scope="col">对方 QTH</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((q) => (
                  <tr key={q.id}>
                    <td className="mono">{at(q.startAt, zone)}</td>
                    <td className="call">{q.call}</td>
                    <td>{q.band}</td>
                    <td>
                      <span className="chip">{q.mode}</span>
                    </td>
                    <td className="mono">{`${q.rstSent} / ${q.rstRcvd}`}</td>
                    <td>{[q.qth, q.gridsquare].filter(Boolean).join(' ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer>
        本页由 OpenHeard 自动记录并生成，{at(data.generatedAt, zone)} {zoneLabel(zone)}。
        记录本身一律 UTC，这里只是换个时区写出来。
      </footer>
    </main>
  )
}
