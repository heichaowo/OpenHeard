import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

// 日志时间一律 UTC，界面不做时区转换。

export const utcSec = (unix: number) => dayjs.unix(unix).utc().format('YYYY-MM-DD HH:mm:ss')
export const utcMin = (unix: number) => dayjs.unix(unix).utc().format('YYYY-MM-DD HH:mm')

export const nowUtc = () => dayjs.utc()
export const unixOf = (d: dayjs.Dayjs) => d.unix()
