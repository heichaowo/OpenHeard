/**
 * 记录一律是 Unix 秒 UTC，显示时区可选。
 *
 * 这个应用没有运行时依赖，所以格式化直接用 Intl，不引日期库。
 */

import { zoneName } from '@core'

export const UTC = 'UTC'

/** 全世界的时区名。Intl 给的是 IANA 规范名，里面没有 UTC，单独补在最前面。 */
export function allZones(): string[] {
  let names: string[] = []
  try {
    names = Intl.supportedValuesOf('timeZone')
  } catch {
    names = []
  }
  return [UTC, ...names.filter((n) => n !== UTC)]
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC
  } catch {
    return UTC
  }
}

/** 这个时区此刻相对 UTC 的偏移，写成 +08:00 这样。 */
export function offsetOf(zone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  }).formatToParts(at)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const sign = name.replace('GMT', '')
  return sign === '' ? '+00:00' : sign
}

/** 时间旁边写的那个短标签。光有数字不说时区，看的人没法确定它是什么。 */
export function zoneLabel(zone: string): string {
  return zone === UTC ? 'UTC' : `${zoneName(zone)} UTC${offsetOf(zone)}`
}

const two = (n: number) => String(n).padStart(2, '0')

/** 一个时刻在这个时区里的年月日时分。 */
function parts(unix: number, zone: string) {
  const got = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(unix * 1000))
  const pick = (t: Intl.DateTimeFormatPartTypes) => got.find((p) => p.type === t)?.value ?? '00'
  // hour12:false 在某些环境下把午夜给成 24，日期那边却已经跨到第二天。
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return {
    day: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${two(Number(hour))}:${pick('minute')}`,
  }
}

export function at(unix: number, zone: string, withTime = true): string {
  const p = parts(unix, zone)
  return withTime ? `${p.day} ${p.time}` : p.day
}

export const ZONE_KEY = 'openheard.zone'
