import { useMemo } from 'react'
import { formatDuration } from '../duration'
import { usePlayer } from '../player'
import { useStore } from '../store'

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/**
 * 连播一段对话里所有有录音的成员。
 *
 * 一律渲染在同一个位置：数字侧成员永远没有录音，全忽略的话这一格在
 * 不同行之间会跳来跳去，按钮占的位置也跟着变。一条都没有录音时是一个
 * 禁用的「无录音」按钮，位置照样占着。
 */
export function PlayAll({ activities }: { activities: { id: string; durationS: number }[] }) {
  const { recordings } = useStore()
  const { state, play, toggle } = usePlayer()

  const playable = useMemo(
    () => activities.filter((a) => recordings.has(a.id)),
    [activities, recordings],
  )

  if (playable.length === 0) {
    return (
      <button type="button" className="playall-pill" disabled aria-label="没有录音">
        无录音
      </button>
    )
  }

  const ids = playable.map((a) => a.id)
  const isThisQueue = state.currentId !== null && sameIds(state.queueIds, ids)
  const total = playable.reduce((sum, a) => sum + a.durationS, 0)
  const label = isThisQueue ? `${state.index + 1}/${state.total}` : `${playable.length} 段 · ${formatDuration(total)}`

  return (
    <button
      type="button"
      className={isThisQueue && state.playing ? 'playall-pill playing' : 'playall-pill'}
      aria-label={
        isThisQueue
          ? `正在放第 ${state.index + 1} / ${state.total} 段`
          : `连播 ${playable.length} 段，共 ${formatDuration(total)}`
      }
      onClick={() => (isThisQueue ? toggle() : play(playable, 0))}
    >
      {isThisQueue && state.playing ? '❚❚' : '▶'} {label}
    </button>
  )
}
