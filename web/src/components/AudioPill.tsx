import { formatDuration, playingLabel } from '../duration'
import { usePlayer } from '../player'
import { useStore } from '../store'

/**
 * 一次发射的播放按钮。
 *
 * 时长采集时就记了，不用等录音下载完才知道有多长；真放起来之后换成
 * 文件的实长（loadedmetadata），中间那一小段差是静噪打开前的前导。
 * 没有录音时还是显示时长，只是点不动——听得到多长，即使这次没录到。
 */
export function AudioPill({ id, durationS }: { id: string; durationS: number }) {
  const { recordings } = useStore()
  const { state, play, toggle } = usePlayer()
  const hasRecording = recordings.has(id)
  const isCurrent = state.currentId === id
  const playing = isCurrent && state.playing
  const duration = isCurrent && state.duration > 0 ? state.duration : durationS
  const label = playing ? playingLabel(state.position, duration) : formatDuration(duration)
  const progress = duration > 0 ? Math.min(1, state.position / duration) : 0

  return (
    <button
      type="button"
      className={playing ? 'audio-pill playing' : 'audio-pill'}
      disabled={!hasRecording}
      aria-label={hasRecording ? `播放 ${formatDuration(durationS)}的录音` : '没有录音'}
      onClick={() => (isCurrent ? toggle() : play([{ id, durationS }], 0))}
    >
      {isCurrent && (
        <span className="audio-pill-fill" style={{ transform: `scaleX(${progress})` }} />
      )}
      <span className="audio-pill-label">
        {playing ? '❚❚' : '▶'} {label}
      </span>
    </button>
  )
}
