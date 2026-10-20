import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuiet } from './useQuiet'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useQuiet', () => {
  it('什么都没发生过就是静的', () => {
    const { result } = renderHook(() => useQuiet())
    expect(result.current()).toBe(true)
  })

  it.each(['pointerdown', 'touchstart', 'keydown'])('%s 之后 3 秒内不静，3 秒后静', (type) => {
    const { result } = renderHook(() => useQuiet())
    act(() => {
      document.body.dispatchEvent(new Event(type, { bubbles: true }))
    })
    expect(result.current()).toBe(false)
    vi.advanceTimersByTime(2999)
    expect(result.current()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(result.current()).toBe(true)
  })

  it('内层容器的滚动不冒泡，也算', () => {
    const { result } = renderHook(() => useQuiet())
    const inner = document.createElement('div')
    document.body.append(inner)
    act(() => {
      inner.dispatchEvent(new Event('scroll'))
    })
    expect(result.current()).toBe(false)
    inner.remove()
  })

  it('卸载之后不再听', () => {
    const { result, unmount } = renderHook(() => useQuiet())
    unmount()
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(result.current()).toBe(true)
  })
})
