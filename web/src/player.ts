import { createContext, use, useEffect } from 'react'

/** 播放列表里的一项。放音频用得着的字段。 */
export interface PlayQueueItem {
  id: string
  durationS: number
}

export interface PlayerState {
  currentId: string | null
  playing: boolean
  position: number
  duration: number
  /** 在队列里排第几个，从 0 数。 */
  index: number
  total: number
  /** 这一队列都有哪些 id，用来认出「正在放的是不是我这一组」。 */
  queueIds: string[]
}

export interface PlayerContextValue {
  state: PlayerState
  /** 放一个队列，从 startIndex 开始。放的时候先停掉正在放的那段。 */
  play: (queue: PlayQueueItem[], startIndex: number) => void
  /** 暂停/续播当前这段。队列空时什么也不做。 */
  toggle: () => void
  /** 停掉并清空队列。换页、换了收听页的筛选时用。 */
  stop: () => void
}

export const IDLE: PlayerState = {
  currentId: null,
  playing: false,
  position: 0,
  duration: 0,
  index: 0,
  total: 0,
  queueIds: [],
}

export const PlayerContext = createContext<PlayerContextValue | null>(null)

export function usePlayer(): PlayerContextValue {
  const p = use(PlayerContext)
  if (!p) throw new Error('usePlayer 必须在 PlayerProvider 里用')
  return p
}

/** 一次发射的录音在哪。 */
export const recordingUrl = (id: string): string => `/api/recordings/${encodeURIComponent(id)}`

/**
 * 收听页换了筛选（档、天、来源、信道、搜索）时也要停。
 *
 * 路由没变，PlayerProvider 自己按 pathname 换页的判断逮不到这种切换，
 * 所以由收听页把它拼出来的 view key 报给这个 hook。
 */
export function usePlayerViewKey(key: string): void {
  const { stop } = usePlayer()
  useEffect(() => {
    stop()
  }, [key, stop])
}
