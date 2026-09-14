import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

// 日志时间一律 UTC，界面不做时区转换。

export const utcSec = (unix: number) => dayjs.unix(unix).utc().format('YYYY-MM-DD HH:mm:ss')
export const utcMin = (unix: number) => dayjs.unix(unix).utc().format('YYYY-MM-DD HH:mm')

export const nowUtc = () => dayjs.utc()

/**
 * 把选择器里显示的那串时间当成 UTC 读。
 *
 * 转盘选出来的是 UTC 模式的 dayjs，直接键入的是本地模式，两者的 unix() 差一个时区。
 * 只认显示值就和模式无关了，而显示值正是标签承诺的那个时间。
 */
export const unixFromDisplayedUtc = (d: dayjs.Dayjs) =>
  dayjs.utc(d.format('YYYY-MM-DD HH:mm:ss')).unix()
