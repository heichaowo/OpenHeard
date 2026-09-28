import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import type { Conversation, ConversationsParams, ConversationsResponse } from '../../api'

interface ListState {
  items: Conversation[]
  next?: string
  channels?: { key: string; label: string }[]
  total?: number
  /** 轮询看到的、比已经显示的最新一条还新的对话。不直接插到列表最上面，
   *  免得手指正按着的行在按下去那一刻底下换了一行。 */
  newItems: Conversation[]
  loading: boolean
  loadingMore: boolean
  error?: string
}

const EMPTY: ListState = { items: [], newItems: [], loading: false, loadingMore: false }

const isNewer = (a: Conversation, b: Conversation) =>
  a.startAt > b.startAt || (a.startAt === b.startAt && a.id > b.id)

/**
 * 把新拉到的第一页合并进已经显示的行：按 id 更新在原位，比最新一条还新的
 * 进 newItems 缓冲区不直接插到最上面。dropIds 是结算动作报过的那几个
 * 对话 id——它们如果不在这一页里，说明结算之后不再属于这个视图（比如
 * 未入库里入库掉的那一段），直接从列表里摘掉，不用等下一次整份重拉。
 */
function mergePage(s: ListState, r: ConversationsResponse, dropIds: readonly string[]): ListState {
  const ids = new Set(s.items.map((c) => c.id))
  const newest = s.items[0]
  const merged = s.items.map((c) => c)
  const freshIds = new Set(s.newItems.map((c) => c.id))
  const newItems = [...s.newItems]
  const seen = new Set(r.items.map((c) => c.id))
  for (const it of r.items) {
    if (ids.has(it.id)) {
      const idx = merged.findIndex((c) => c.id === it.id)
      merged[idx] = it
    } else if ((newest === undefined || isNewer(it, newest)) && !freshIds.has(it.id)) {
      newItems.push(it)
      freshIds.add(it.id)
    }
  }
  const kept = merged.filter((c) => !dropIds.includes(c.id) || seen.has(c.id))
  return {
    ...s,
    items: kept,
    channels: r.channels ?? s.channels,
    total: r.total ?? s.total,
    newItems,
  }
}

/**
 * 收听页按天看、未入库、搜索三种视图共用的取数逻辑（待确认走 store.pending，
 * 不经过这里）。
 *
 * 三条路各走各的：viewParams 变了（换档、换天、换来源、换信道、换搜索词）
 * 整份重来，走 loading 状态，这时旧内容被替换成加载态；后台轮询和结算
 * 之后的刷新都只拉第一页，按 id 合并进已经显示的行，不碰 loading。
 */
export function useConversationList(viewParams: ConversationsParams | null, pollMs: number | null) {
  const [state, setState] = useState<ListState>(EMPTY)
  const seq = useRef(0)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  // viewParams 每次渲染都是新对象；换成字符串才能当 effect 的依赖用，
  // 内容没变就不重新拉。
  const key = viewParams ? JSON.stringify(viewParams) : null
  // 回调里读这个引用，不把对象本身放进依赖。放进去的话，页面每重新渲染
  // 一次，轮询的定时器就重建一次，而收听页每 15 秒内总有几次重新渲染，
  // 轮询一次都跑不到。
  const paramsRef = useRef(viewParams)
  useEffect(() => {
    paramsRef.current = viewParams
  })

  const runFull = useCallback((mine: number, p: ConversationsParams) => {
    return api.conversations(p).then(
      (r) => {
        if (mine !== seq.current) return
        setState({
          items: r.items,
          next: r.next,
          channels: r.channels,
          total: r.total,
          newItems: [],
          loading: false,
          loadingMore: false,
          error: undefined,
        })
      },
      (e: unknown) => {
        if (mine !== seq.current) return
        // 已经显示的列表留着，只多一条提示：这次失败的是换视图，不是清空。
        setState((s) => ({ ...s, loading: false, error: errorText(e) }))
      },
    )
  }, [])

  useEffect(() => {
    const mine = ++seq.current
    if (viewParams === null) {
      // oxlint-disable-next-line react/set-state-in-effect
      setState(EMPTY)
      return
    }
    // 视图换了整份重来：旧视图的内容先让位给加载态，拉后端正是这个 effect
    // 该做的事。
    // oxlint-disable-next-line react/set-state-in-effect
    setState({ ...EMPTY, loading: true })
    runFull(mine, viewParams)
    // key 已经把 viewParams 摊平进依赖；它本身每次渲染都是新对象，放进
    // 依赖数组会让这个 effect 每次渲染都重跑。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runFull])

  const retry = useCallback(() => {
    const viewParams = paramsRef.current
    if (viewParams === null) return
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true, error: undefined }))
    runFull(mine, viewParams)
  }, [runFull])

  const mergeLatest = useCallback(
    async (dropIds: readonly string[] = []) => {
      const viewParams = paramsRef.current
      if (viewParams === null) return
      const mine = seq.current
      try {
        const r = await api.conversations({ ...viewParams, cursor: undefined })
        if (mine !== seq.current) return
        setState((s) => (s.loading ? s : mergePage(s, r, dropIds)))
      } catch {
        // 后台轮询或者结算之后的刷新，不是人直接发起的那种「重试」。
        // 这次失败不打断已经显示的列表，下一轮/下一次操作自己会再试。
      }
    },
    [],
  )

  useEffect(() => {
    if (pollMs === null || key === null) return
    const tick = () => {
      if (!document.hidden) void mergeLatest()
    }
    const t = setInterval(tick, pollMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [pollMs, key, mergeLatest])

  const loadMore = useCallback(() => {
    const viewParams = paramsRef.current
    if (viewParams === null) return
    const s = stateRef.current
    if (s.next === undefined || s.loadingMore) return
    const mine = seq.current
    const cursor = s.next
    setState((v) => ({ ...v, loadingMore: true }))
    api.conversations({ ...viewParams, cursor }).then(
      (r) => {
        if (mine !== seq.current) return
        setState((v) => ({ ...v, items: [...v.items, ...r.items], next: r.next, loadingMore: false }))
      },
      (e: unknown) => {
        if (mine !== seq.current) return
        setState((v) => ({ ...v, loadingMore: false, error: errorText(e) }))
      },
    )
  }, [])

  const showNew = useCallback(() => {
    setState((s) => {
      if (s.newItems.length === 0) return s
      const sorted = [...s.newItems].sort((a, b) => (isNewer(a, b) ? -1 : 1))
      return { ...s, items: [...sorted, ...s.items], newItems: [] }
    })
  }, [])

  return {
    items: state.items,
    channels: state.channels,
    total: state.total,
    newCount: state.newItems.length,
    loading: state.loading,
    loadingMore: state.loadingMore,
    error: state.error,
    hasMore: state.next !== undefined,
    loadMore,
    showNew,
    retry,
    /** 结算（入库/忽略）之后调用：拉第一页合并，结算过的那几个 id 如果
     *  不再属于这个视图（比如未入库里入库掉的那一段）就从列表里摘掉。 */
    settleRefresh: mergeLatest,
  }
}
