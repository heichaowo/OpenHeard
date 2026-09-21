import { useMemo } from 'react'
import type { Dayjs } from 'dayjs'
import { usePreferences } from './theme'
import {
  atIn,
  fmt,
  fmtMin,
  fmtShort,
  mergeDateTime,
  nowIn,
  unixFromDisplayed,
  zoneLabel,
} from './time'

/**
 * 界面上所有的时间都从这里拿，这样换时区时每一处跟着一起变。
 *
 * 不做成模块级的全局变量：那样改了时区 React 不知道要重画。
 */
export function useTime() {
  const { zone } = usePreferences()
  return useMemo(
    () => ({
      zone,
      /** 写在表头和标签里的那个短名，例如 UTC 或 Asia/Shanghai UTC+08:00。 */
      label: zoneLabel(zone),
      at: (unix: number) => fmt(unix, zone),
      atMin: (unix: number) => fmtMin(unix, zone),
      /** 手机上用的短式，今天只给时分。 */
      atShort: (unix: number) => fmtShort(unix, zone),
      now: () => nowIn(zone),
      value: (unix: number) => atIn(unix, zone),
      fromDisplayed: (d: Dayjs) => unixFromDisplayed(d, zone),
      merge: (date: Dayjs, time: Dayjs) => mergeDateTime(date, time, zone),
    }),
    [zone],
  )
}
