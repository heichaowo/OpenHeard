/**
 * 时长怎么写。
 *
 * 播放器和 PlayAll 共用同一套口径，不然一个显示 3.2 秒、另一个显示 3 秒，
 * 看着像是量错了。
 */

/** 10 秒以内留一位小数，一分钟以内取整秒，再往上写成「1 分 05 秒」。 */
export function formatDuration(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  const total = Math.round(seconds)
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m} 分 ${String(s).padStart(2, '0')} 秒`
}

/** 不带单位的数字，供「1.4 / 3.6 秒」这种合并展示用。 */
function durationNumber(seconds: number): string {
  return seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))
}

/**
 * 播放中那一句：「进度 / 总长」。
 *
 * 两边都不到一分钟时合用一个「秒」字（1.4 / 3.6 秒）；有一边到了分钟，
 * 各自按 formatDuration 写全，合并会把「05」和「秒」拆得认不出来。
 */
export function playingLabel(position: number, duration: number): string {
  if (position >= 60 || duration >= 60) {
    return `${formatDuration(position)} / ${formatDuration(duration)}`
  }
  return `${durationNumber(position)} / ${durationNumber(duration)} 秒`
}
