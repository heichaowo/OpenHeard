import { useEffect, useState } from 'react'
import { fetchSummary } from './api.ts'
import type { Summary } from './api.ts'
import { utc } from './time.ts'

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

export function App() {
  const [data, setData] = useState<Summary | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    fetchSummary().then(setData, (e: Error) => setError(e.message))
  }, [])

  if (error) {
    return (
      <main className="page">
        <p className="notice">{error}</p>
      </main>
    )
  }
  if (!data) {
    return (
      <main className="page">
        <p className="notice">正在读取…</p>
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
      <header className="head">
        <h1>{call}</h1>
        {where && <p className="where">{where}</p>}
        {rig.length > 0 && <p className="rig">{rig.join(' · ')}</p>}
      </header>

      <section className="stats" aria-label="统计">
        <Stat label="通联总数" value={data.total} />
        <Stat label="不同呼号" value={data.distinctCalls} />
        <Stat small label="最早一次" value={data.firstAt ? utc(data.firstAt, false) : '—'} />
        <Stat small label="最近一次" value={data.lastAt ? utc(data.lastAt) : '—'} />
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
                  <th scope="col">时间 UTC</th>
                  <th scope="col">呼号</th>
                  <th scope="col">波段</th>
                  <th scope="col">模式</th>
                  <th scope="col">对方 QTH</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((q) => (
                  <tr key={q.id}>
                    <td className="mono">{utc(q.startAt)}</td>
                    <td className="call">{q.call}</td>
                    <td>{q.band}</td>
                    <td>
                      <span className="chip">{q.mode}</span>
                    </td>
                    <td>{[q.qth, q.gridsquare].filter(Boolean).join(' ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer>
        本页由 OpenHeard 自动记录并生成，{utc(data.generatedAt)} UTC。
      </footer>
    </main>
  )
}
