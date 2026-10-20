import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'

const POLL_MS = 15000

/**
 * 无意义 N：view=meaningless 的总数，和运维页 ops.ai.meaningless 是同一个数。
 * limit=1 只为了读 total，不拉整页对话。
 */
export function useMeaninglessCount(refreshKey = 0): number {
  const [count, setCount] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    const load = async () => {
      const mine = ++seq.current
      try {
        const r = await api.conversations({ view: 'meaningless', limit: 1 })
        if (mine !== seq.current) return
        setCount(r.total ?? 0)
      } catch {
        // 拉不到就留着上一次的数，不闪成 0。
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
  }, [refreshKey])

  return count
}
