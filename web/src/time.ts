import { zoneName } from '@core'
import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)
dayjs.extend(timezone)

/**
 * 记录一律是 Unix 秒 UTC，显示时区可选。
 *
 * 存和显示是两件事。日志、ADIF 和接口全都按 UTC 走，界面只是把同一个时刻
 * 换个时区写出来。业余无线电的惯例是 UTC，所以缺省仍然是 UTC。
 */

/** 时区名，IANA 那一套，外加 UTC 本身。 */
export type Zone = string

export const UTC: Zone = 'UTC'

/** 浏览器所在的时区。取不到就当 UTC。 */
export function localZone(): Zone {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC
  } catch {
    return UTC
  }
}

/**
 * 全世界的时区名。
 *
 * Intl 给的是 IANA 的规范名，里面没有 UTC，所以单独放在最前面。
 */
export function allZones(): Zone[] {
  let names: string[] = []
  try {
    names = Intl.supportedValuesOf('timeZone')
  } catch {
    names = []
  }
  return [UTC, ...names.filter((n) => n !== UTC)]
}

/** 这个时区此刻相对 UTC 的偏移，写成 +08:00 这样。 */
export function offsetOf(zone: Zone, at = dayjs()): string {
  const m = at.tz(zone).utcOffset()
  const sign = m < 0 ? '-' : '+'
  const abs = Math.abs(m)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * 时间旁边写的那个短标签。
 *
 * 光写一串数字而不说是哪个时区，比只用 UTC 更糟：看的人没法确定它是什么。
 */
export function zoneLabel(zone: Zone): string {
  return zone === UTC ? 'UTC' : `${zoneName(zone)} UTC${offsetOf(zone)}`
}

/** 选择器里那一行。 */
export function zoneOption(zone: Zone): string {
  return zone === UTC ? 'UTC（协调世界时）' : `${zoneName(zone)}（UTC${offsetOf(zone)}）`
}

export const fmt = (unix: number, zone: Zone) =>
  dayjs.unix(unix).tz(zone).format('YYYY-MM-DD HH:mm:ss')

export const fmtMin = (unix: number, zone: Zone) =>
  dayjs.unix(unix).tz(zone).format('YYYY-MM-DD HH:mm')

/** 此刻，用这个时区表示。给选择器当初值。 */
export const nowIn = (zone: Zone) => dayjs().tz(zone)

/** 一个时刻，用这个时区表示。给选择器当初值。 */
export const atIn = (unix: number, zone: Zone) => dayjs.unix(unix).tz(zone)

/**
 * 把选择器里显示的那串时间当成这个时区读。
 *
 * 转盘选出来的是带时区模式的 dayjs，直接键入的是本地模式，两者的 unix() 差一个
 * 时区。只认显示值就和模式无关了，而显示值正是标签承诺的那个时间。
 */
export const unixFromDisplayed = (d: dayjs.Dayjs, zone: Zone) =>
  dayjs.tz(d.format('YYYY-MM-DD HH:mm:ss'), zone).unix()

/**
 * 把一个只看日期的值和一个只看时间的值拼起来。
 *
 * 两边各自可能是本地模式也可能是别的模式，所以只认它们显示出来的那串字，
 * 和 unixFromDisplayed 同一个口径。
 */
export const mergeDateTime = (date: dayjs.Dayjs, time: dayjs.Dayjs, zone: Zone) =>
  dayjs.tz(`${date.format('YYYY-MM-DD')} ${time.format('HH:mm:ss')}`, zone)
