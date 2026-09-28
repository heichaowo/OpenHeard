import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { IDLE, PlayerContext, recordingUrl } from './player'
import type { PlayerContextValue, PlayerState, PlayQueueItem } from './player'

/**
 * 放不了的时候 play() 的 Promise 会被拒绝，真正的失败由 error 事件处理。
 * 这里只是不让它变成未处理的拒绝。换段时上一次 play() 被打断也会拒绝
 * （AbortError），那不是失败，更不能拿它去重置状态。
 */
const playQuietly = (audio: HTMLAudioElement) => {
  Promise.resolve(audio.play()).catch(() => undefined)
}

/**
 * 全应用一个播放器，一个 audio 元素。
 *
 * 同一页一次只放一段：换队列之前先停掉正在放的那个，因为共用同一个
 * 元素，换 src 本来就会把上一段掐掉，不用另外去追谁在放。换页，或者
 * 收听页换了筛选条件（usePlayerViewKey）时也要停，不然人已经走了声音
 * 还在放，跟今天内联 <audio> 卸载就停是一个道理。
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (audioRef.current === null) audioRef.current = new Audio()
  const [state, setState] = useState<PlayerState>(IDLE)
  const queueRef = useRef<PlayQueueItem[]>([])
  const { pathname } = useLocation()

  const stop = useCallback(() => {
    const audio = audioRef.current!
    audio.pause()
    audio.removeAttribute('src')
    queueRef.current = []
    setState(IDLE)
  }, [])

  // audio 元素本身只建一次，事件也只挂一次；队列和播到第几段走 ref 和
  // setState，不进这个 effect 的依赖。
  useEffect(() => {
    const audio = audioRef.current!

    const onTime = () =>
      setState((s) => (s.currentId === null ? s : { ...s, position: audio.currentTime }))

    const onLoaded = () =>
      setState((s) =>
        s.currentId === null || !Number.isFinite(audio.duration)
          ? s
          : { ...s, duration: audio.duration },
      )

    // 一段放完接着放队列里下一段，一段对话能连着放完。放不了的那段也一样跳过
    // （断网、会话过期、刚被保留期裁掉），不能让胶囊一直停在「在放」上。
    const onEnded = () => {
      const queue = queueRef.current
      setState((s) => {
        const nextIndex = s.index + 1
        const item = queue[nextIndex]
        if (!item) return IDLE
        audio.src = recordingUrl(item.id)
        audio.currentTime = 0
        playQuietly(audio)
        return { ...s, currentId: item.id, position: 0, duration: item.durationS, index: nextIndex, playing: true }
      })
    }

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onEnded)
    }
  }, [])

  const play = useCallback((queue: PlayQueueItem[], startIndex: number) => {
    const item = queue[startIndex]
    if (!item) return
    const audio = audioRef.current!
    queueRef.current = queue
    audio.pause()
    audio.src = recordingUrl(item.id)
    audio.currentTime = 0
    playQuietly(audio)
    setState({
      currentId: item.id,
      playing: true,
      position: 0,
      duration: item.durationS,
      index: startIndex,
      total: queue.length,
      queueIds: queue.map((q) => q.id),
    })
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current!
    setState((s) => {
      if (s.currentId === null) return s
      if (s.playing) {
        audio.pause()
        return { ...s, playing: false }
      }
      playQuietly(audio)
      return { ...s, playing: true }
    })
  }, [])

  useEffect(() => {
    // 换页正是「和外部系统（音频元素）同步」本身，不是可以挪到渲染期间
    // 或者某个事件回调里算的派生值。
    // oxlint-disable-next-line react/set-state-in-effect
    stop()
  }, [pathname, stop])

  const value = useMemo<PlayerContextValue>(
    () => ({ state, play, toggle, stop }),
    [state, play, toggle, stop],
  )

  return <PlayerContext value={value}>{children}</PlayerContext>
}
