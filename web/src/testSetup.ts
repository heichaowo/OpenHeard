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

// antd 的响应式断点走 matchMedia，jsdom 没有。默认当宽屏，窄屏的分支各自在
// 测试里覆盖。
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

// antd 的 Drawer 和 Table 会量尺寸，jsdom 没有 ResizeObserver。
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
