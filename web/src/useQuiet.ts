import { useCallback, useEffect, useRef } from 'react'

/** 这些事一发生，就当人正在操作。scroll 用捕获：内层容器滚动不冒泡。 */
const EVENTS = ['pointerdown', 'touchstart', 'keydown', 'scroll'] as const

/**
 * 页面静了多久。返回一个函数，最近 ms 毫秒内没有按下、触摸、敲键、滚动就返回 true。
 *
 * 收听页每 15 秒刷一次，刷出新行时底下的行会往下挪。手指刚落下去的那一刻列表不能动，
 * 光看「有没有展开、有没有开抽屉」判不出来：直接点一行上的按钮，这些都是原样。
 * 返回函数而不是布尔值：它在轮询回来的那一刻才被问，不用跟着渲染走。
 */
export function useQuiet(ms = 3000): () => boolean {
  const last = useRef(-Infinity)
  useEffect(() => {
    const mark = () => {
      last.current = Date.now()
    }
    for (const e of EVENTS) window.addEventListener(e, mark, { capture: true, passive: true })
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, mark, { capture: true })
    }
  }, [])
  return useCallback(() => Date.now() - last.current >= ms, [ms])
}
