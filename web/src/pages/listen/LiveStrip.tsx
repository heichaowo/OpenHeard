import { useEffect, useState } from 'react'
import { Typography } from 'antd'
import { api } from '../../api'
import type { Radio } from '../../api'
import { useStore } from '../../store'

const POLL_MS = 3000

/** 状态标签的宽度按「没有回报」四个字算，来回切换时不跳字。 */
function stateOf(r: Radio): { label: string; cls: string } {
  if (!r.fresh) return { label: '没有回报', cls: 'live-state amber' }
  if (r.open) return { label: '正在收', cls: 'live-state green pulsing' }
  return { label: '安静', cls: 'live-state' }
}

/**
 * 收听页顶上的实时条：每个模拟信道此刻开没开。
 *
 * 单开这个只读内存的接口，3 秒拉一次，不碰运维接口背后的数据库（spec
 * 「收听页顶上显示每个信道此刻开没开」）。analogEnabled 读 store 的效果值，
 * 不是靠这个接口空着的数组去猜——关掉之后守护进程可能还有一两条在飞的旧
 * 状态，那不该被当成「还开着」。
 */
export function LiveStrip() {
  const { analogEnabled } = useStore()
  const [radios, setRadios] = useState<Radio[]>([])

  useEffect(() => {
    if (!analogEnabled) return
    let alive = true
    const load = async () => {
      try {
        const r = await api.radios()
        if (alive) setRadios(r.radios)
      } catch {
        // 掉一次拉不到，下一轮自己会再试。这条只读内存状态，不值得为它弹提示。
      }
    }
    void load()
    const tick = () => {
      if (!document.hidden) void load()
    }
    const t = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      alive = false
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [analogEnabled])

  if (!analogEnabled) {
    return (
      <Typography.Text type="secondary" className="live-strip-off">
        模拟守听关着
      </Typography.Text>
    )
  }

  return (
    <div className="live-strip">
      {radios.map((r) => {
        const st = stateOf(r)
        return (
          <div key={`${r.freqMhz}|${r.channel}`} className="live-cell">
            <span className="live-channel">{r.channel}</span>
            <span className={st.cls}>{st.label}</span>
          </div>
        )
      })}
    </div>
  )
}
