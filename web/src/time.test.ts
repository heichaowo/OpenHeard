import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utcPlugin from 'dayjs/plugin/utc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UTC,
  allZones,
  atIn,
  dayStartIn,
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

describe('dayStartIn', () => {
  afterEach(() => vi.useRealTimers())

  // 此刻是成都的 2026-09-15 17:49:33，UTC 的 2026-09-15 09:49:33，
  // 两个时区的「今天 0 点」因此落在不同的 Unix 秒上。
  it('今天 0 点按时区算，时区不同界就不同', () => {
    vi.useFakeTimers()
    vi.setSystemTime(dayjs.unix(AT).toDate())

    expect(dayStartIn(CD)).toBe(1_789_401_600)
    expect(dayStartIn(UTC)).toBe(1_789_430_400)
  })

  it('daysAgo 往前数的是整天，不是 24 小时的倍数减出来的余量', () => {
    vi.useFakeTimers()
    vi.setSystemTime(dayjs.unix(AT).toDate())

    expect(dayStartIn(CD, 6)).toBe(1_789_401_600 - 6 * 86400)
  })

  // 浏览器所在的时区在显示时区西边时，tz 对象的 startOf 会按浏览器的时区
  // 重新读墙上时间，切换当天的 0 点差一两个小时。
  it('浏览器在显示时区西边，切换当天的今天 0 点照样对', () => {
    try {
      vi.stubEnv('TZ', 'America/Los_Angeles')
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-08T05:30:00Z')) // 纽约 00:30 EST
      expect(dayStartIn('America/New_York')).toBe(Date.UTC(2026, 2, 8, 5) / 1000)

      vi.stubEnv('TZ', 'America/New_York')
      vi.setSystemTime(new Date('2026-03-29T00:30:00Z')) // 伦敦 00:30 GMT
      expect(dayStartIn('Europe/London')).toBe(Date.UTC(2026, 2, 29, 0) / 1000)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // 纽约 2026-03-08 凌晨从 EST 换到 EDT。先取今天 0 点再往前减 6 天，
  // 减出来的那天还带着今天的 -04:00，比那天真正的 0 点早了一小时。
  it('往前数的那天跨过夏令时切换，照样落在那天当地的 0 点', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-13T16:00:00Z'))

    // 2026-03-07 00:00 EST，即 05:00 UTC。
    expect(dayStartIn('America/New_York', 6)).toBe(Date.UTC(2026, 2, 7, 5) / 1000)
  })
})
