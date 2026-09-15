import dayjs from 'dayjs'
import utcPlugin from 'dayjs/plugin/utc'
import { describe, expect, it } from 'vitest'
import { mergeDateTime, unixFromDisplayedUtc, utcMin, utcSec } from './time'

dayjs.extend(utcPlugin)

// 2026-09-15 09:49:33 UTC
const AT = 1_789_465_773

describe('时间显示', () => {
  it('一律按 UTC 显示，不看本机时区', () => {
    expect(utcSec(AT)).toBe('2026-09-15 09:49:33')
    expect(utcMin(AT)).toBe('2026-09-15 09:49')
  })
})

describe('unixFromDisplayedUtc', () => {
  // 转盘选出来的是 UTC 模式的 dayjs，手打进去的是本地模式。两者的 unix()
  // 差一个时区，成都就是 8 小时。只认显示值，两条路才落在同一个时刻。
  it('UTC 模式和本地模式给出同一个时刻', () => {
    const shown = '2026-09-15 09:49:33'
    const fromPicker = dayjs.utc(shown)
    const fromTyping = dayjs(shown)

    expect(unixFromDisplayedUtc(fromPicker)).toBe(AT)
    expect(unixFromDisplayedUtc(fromTyping)).toBe(AT)
  })
})

describe('mergeDateTime', () => {
  it('日期和时间分开选，拼出来还是 UTC', () => {
    const merged = mergeDateTime(dayjs('2026-09-15'), dayjs('2000-01-01 09:49:33'))
    expect(merged.unix()).toBe(AT)
    expect(unixFromDisplayedUtc(merged)).toBe(AT)
  })

  it('两边是 UTC 模式时结果一样', () => {
    const merged = mergeDateTime(dayjs.utc('2026-09-15'), dayjs.utc('2000-01-01 09:49:33'))
    expect(merged.unix()).toBe(AT)
  })
})
