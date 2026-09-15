const pad = (n: number) => String(n).padStart(2, '0')

/** 日志时间一律 UTC，这里也不做时区转换。 */
export function utc(unix: number, withTime = true): string {
  const d = new Date(unix * 1000)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return withTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day
}
