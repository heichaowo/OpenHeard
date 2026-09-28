import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'

const POLL_MS = 15000

/**
 * 未入库 N：不管现在哪一档被选中都要拉，徽标才不会显示上一次选中未入库
 * 时留下的旧数。items.length 就是数，next 还在就说明还不止这 200 条。
 */
export function useUnloggedCount(): { count: number; capped: boolean } {
  const [state, setState] = useState({ count: 0, capped: false })
  const seq = useRef(0)

  useEffect(() => {
    const load = async () => {
      const mine = ++seq.current
      try {
        const r = await api.conversations({ view: 'unlogged', limit: 200 })
        if (mine !== seq.current) return
        setState({ count: r.items.length, capped: r.next !== undefined })
      } catch {
        // 拉不到就留着上一次的数，不闪成 0——那看着像是未入库全清空了。
      }
    }
    void load()
    const tick = () => {
      if (!document.hidden) void load()
    }
    const t = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  return state
}
