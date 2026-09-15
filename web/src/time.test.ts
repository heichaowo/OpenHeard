import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utcPlugin from 'dayjs/plugin/utc'
import { describe, expect, it } from 'vitest'
import {
  UTC,
  allZones,
  atIn,
  fmt,
  fmtMin,
  mergeDateTime,
  offsetOf,
  unixFromDisplayed,
  zoneLabel,
} from './time'

dayjs.extend(utcPlugin)
dayjs.extend(timezone)

// 2026-09-15 09:49:33 UTC，也就是成都的 17:49:33
const AT = 1_789_465_773
const CD = 'Asia/Shanghai'
const NY = 'America/New_York'

describe('按时区显示', () => {
  it('同一个时刻在不同时区写出不同的字', () => {
    expect(fmt(AT, UTC)).toBe('2026-09-15 09:49:33')
    expect(fmt(AT, CD)).toBe('2026-09-15 17:49:33')
    expect(fmt(AT, NY)).toBe('2026-09-15 05:49:33')
    expect(fmtMin(AT, CD)).toBe('2026-09-15 17:49')
  })

  it('标签写清楚是哪个时区，光有数字没法确定是什么', () => {
    expect(zoneLabel(UTC)).toBe('UTC')
    expect(zoneLabel(CD)).toBe('Asia/Shanghai UTC+08:00')
  })

  it('偏移带符号和两位数', () => {
    expect(offsetOf(UTC, dayjs.unix(AT))).toBe('+00:00')
    expect(offsetOf(CD, dayjs.unix(AT))).toBe('+08:00')
    expect(offsetOf(NY, dayjs.unix(AT))).toBe('-04:00')
  })

  it('时区表里有 UTC，Intl 自己不给', () => {
    const zones = allZones()
    expect(zones[0]).toBe(UTC)
    expect(zones).toContain(CD)
    expect(zones.length).toBeGreaterThan(300)
  })
})

describe('unixFromDisplayed', () => {
  // 转盘选出来的带时区模式，手打进去的是本地模式，两者的 unix() 差一个时区。
  // 只认显示值，两条路才落在同一个时刻。
  it('两种模式给出同一个时刻', () => {
    const shown = '2026-09-15 17:49:33'
    expect(unixFromDisplayed(dayjs.tz(shown, CD), CD)).toBe(AT)
    expect(unixFromDisplayed(dayjs(shown), CD)).toBe(AT)
    expect(unixFromDisplayed(dayjs.utc(shown), CD)).toBe(AT)
  })

  it('同一串字按不同时区读出不同时刻', () => {
    const shown = '2026-09-15 09:49:33'
    expect(unixFromDisplayed(dayjs(shown), UTC)).toBe(AT)
    expect(unixFromDisplayed(dayjs(shown), CD)).toBe(AT - 8 * 3600)
  })

  // 换时区时界面就是这么把填好的时间搬过去的：按旧时区读成时刻，
  // 再按新时区写出来。时刻不能变。
  it('atIn 和 unixFromDisplayed 往返之后时刻不变', () => {
    const inCd = atIn(AT, CD)
    expect(inCd.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-09-15 17:49:33')
    expect(unixFromDisplayed(inCd, CD)).toBe(AT)

    const moved = atIn(unixFromDisplayed(inCd, CD), NY)
    expect(moved.format('YYYY-MM-DD HH:mm:ss')).toBe('2026-09-15 05:49:33')
    expect(unixFromDisplayed(moved, NY)).toBe(AT)
  })
})

describe('mergeDateTime', () => {
  it('日期和时间分开选，按给定时区拼', () => {
    const d = dayjs('2026-09-15')
    const t = dayjs('2000-01-01 17:49:33')
    expect(unixFromDisplayed(mergeDateTime(d, t, CD), CD)).toBe(AT)
    expect(unixFromDisplayed(mergeDateTime(d, t, UTC), UTC)).toBe(AT + 8 * 3600)
  })
})
