import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utcPlugin from 'dayjs/plugin/utc'
import { describe, expect, it } from 'vitest'
import type { Activity } from '@core'
import {
  agoText,
  badgeText,
  dayLabel,
  dayRange,
  dayValue,
  isDayTab,
  isUnresolved,
  originOfSrc,
  senderText,
  statusOfTab,
} from './model'

dayjs.extend(utcPlugin)
dayjs.extend(timezone)

const CD = 'Asia/Shanghai'

describe('isDayTab / statusOfTab', () => {
  it('待确认和未入库两档不分天，别的三档分天', () => {
    expect(isDayTab('pending')).toBe(false)
    expect(isDayTab('unlogged')).toBe(false)
    expect(isDayTab('all')).toBe(true)
    expect(isDayTab('logged')).toBe(true)
    expect(isDayTab('ignored')).toBe(true)
  })

  it('全部不筛 status（含旁听），已入库/已忽略各自筛一个', () => {
    expect(statusOfTab('all')).toBeUndefined()
    expect(statusOfTab('logged')).toBe('logged')
    expect(statusOfTab('ignored')).toBe('ignored')
  })
})

describe('isUnresolved', () => {
  it('待确认、未入库、旁听没结算，已入库、已忽略结算过了', () => {
    expect(isUnresolved('pending')).toBe(true)
    expect(isUnresolved('unlogged')).toBe(true)
    expect(isUnresolved('overheard')).toBe(true)
    expect(isUnresolved('logged')).toBe(false)
    expect(isUnresolved('ignored')).toBe(false)
  })
})

describe('originOfSrc', () => {
  it('模拟/数字对应各自的 origin，全部不筛', () => {
    expect(originOfSrc('fm')).toBe('sdr-fm')
    expect(originOfSrc('digital')).toBe('brandmeister')
    expect(originOfSrc('all')).toBeUndefined()
  })
})

describe('badgeText', () => {
  it('99 以内照实数，超过封顶 99+，0 也照样显示', () => {
    expect(badgeText(0)).toBe('0')
    expect(badgeText(12)).toBe('12')
    expect(badgeText(99)).toBe('99')
    expect(badgeText(100)).toBe('99+')
    expect(badgeText(250)).toBe('99+')
  })
})

describe('senderText', () => {
  const base: Activity = {
    id: 'a1',
    origin: 'brandmeister',
    startAt: 0,
    durationS: 1,
    mine: false,
  }

  it('有呼号就用呼号，本台没呼号时用本台呼号或「本台」，别的用 DMR ID 或呼号未知', () => {
    expect(senderText({ ...base, callsign: 'BA1AA' })).toBe('BA1AA')
    expect(senderText({ ...base, mine: true }, 'BG0CG')).toBe('BG0CG')
    expect(senderText({ ...base, mine: true })).toBe('本台')
    expect(senderText({ ...base, dmrId: 4616472 })).toBe('DMR 4616472')
    expect(senderText(base)).toBe('呼号未知')
  })
})

describe('dayLabel / dayValue / dayRange', () => {
  it('today 每次都按当前时区重算', () => {
    const v = dayValue('today', CD)
    expect(v.format('YYYY-MM-DD')).toBe(dayjs().tz(CD).format('YYYY-MM-DD'))
  })

  it('写死的日期按给定时区读', () => {
    const v = dayValue('2026-09-27', CD)
    expect(v.format('YYYY-MM-DD')).toBe('2026-09-27')
  })

  it('日期标签带星期', () => {
    // 2026-09-27 是周日。
    expect(dayLabel(dayjs.tz('2026-09-27', CD))).toBe('9月27日 周日')
  })

  it('[from, to) 跨度正好一天，按时区的午夜切', () => {
    const [from, to] = dayRange('2026-09-27', CD)
    expect(to - from).toBe(86400)
    expect(dayjs.unix(from).tz(CD).format('HH:mm:ss')).toBe('00:00:00')
  })
})

describe('agoText', () => {
  it('一分钟以内写秒，再往上写分钟、小时、天', () => {
    expect(agoText(1000, 970)).toBe('30 秒前')
    expect(agoText(1000, 400)).toBe('10 分钟前')
    expect(agoText(10000, 3400)).toBe('1.8 小时前')
    expect(agoText(200000, 1000)).toBe('2.3 天前')
  })
})
