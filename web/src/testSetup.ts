import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(async () => {
  cleanup()
  // antd 的按钮 loading 走一个延时 state，组件卸下之后那个定时器还会再醒一次。
  // 等它醒完再让 vitest 拆掉 jsdom，否则它会撞上一个已经没有 window 的环境，
  // 抛一个和测试本身无关的 ReferenceError，整份 CI 就红了。
  await new Promise((resolve) => setTimeout(resolve, 20))
})

/**
 * antd 的响应式断点走 matchMedia，jsdom 没有。
 *
 * 照着一个假的视口宽度回答 min-width / max-width，默认当宽屏。回一律 false 的话
 * 每个断点都不成立，于是测试悄悄跑的是手机版面，而断言写的是桌面表格。
 * 要测窄屏就在测试里调 setViewportWidth。
 */
let viewportWidth = 1280

export function setViewportWidth(px: number): void {
  viewportWidth = px
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const max = /max-width:\s*(\d+)px/.exec(query)
    const matches =
      (min === null || viewportWidth >= Number(min[1])) &&
      (max === null || viewportWidth <= Number(max[1]))
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }
  }) as typeof window.matchMedia
}

// antd 的 Drawer 和 Table 会量尺寸，jsdom 没有 ResizeObserver。
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
