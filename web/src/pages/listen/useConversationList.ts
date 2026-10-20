import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api'
import type { Conversation, ConversationsParams } from '../../api'

/** 行里的实时状态：显示着的、攒着没插的、已经没了但还留着的。 */
export interface Live {
  items: Conversation[]
  /** 攒着还没插进列表的对话。人正在操作时不直接插，免得手指正按着的行在按下去那一刻底下换了一行。 */
  buffer: Conversation[]
  /** 已经不在最新一次拉取里、但先留在原处（按钮禁用、标「已变」）的行 id，等 canInsert 再摘。 */
  stale: ReadonlySet<string>
}

interface ListState extends Live {
  next?: string
  channels?: { key: string; label: string }[]
  total?: number
  /** 旧 id 到新 id：更早的发射补进来、对话拆开合并时 id 会变，页面按它把挑中的、展开的搬到新 id 上。
   *  累积到换视图为止；搬过一次的旧 id 再搬一次没有影响。 */
  renamed: Record<string, string>
  loading: boolean
  loadingMore: boolean
  error?: string
}

const EMPTY: ListState = {
  items: [],
  buffer: [],
  stale: new Set(),
  renamed: {},
  loading: false,
  loadingMore: false,
}

/** 列表按新到旧排：谁排在谁前面。 */
export const isNewer = (a: Conversation, b: Conversation) =>
  a.startAt > b.startAt || (a.startAt === b.startAt && a.id > b.id)

type Before = (a: Conversation, b: Conversation) => boolean

const bySorted = (before: Before) => (a: Conversation, b: Conversation) => (before(a, b) ? -1 : before(b, a) ? 1 : 0)

/** 按排序位置插进去，不动别的行的相对次序。 */
function insertSorted(rows: Conversation[], add: Conversation[], before: Before): Conversation[] {
  const out = [...rows]
  for (const f of [...add].sort(bySorted(before))) {
    const at = out.findIndex((r) => before(f, r))
    if (at < 0) out.push(f)
    else out.splice(at, 0, f)
  }
  return out
}

interface Slot {
  c: Conversation
  claimed: boolean
  gone: boolean
}

/**
 * 按成员认人：拉到的每个对话认领第一个和它有重叠成员、还没被认领的格子（先看显示
 * 着的，再看攒着的），换上新内容，格子位置不变。还重叠的其他没认领的格子摘掉。
 * 只和已经被认领的格子重叠的，是拆出来的一段，交给调用方走插入的规矩。
 *
 * 对话 id 就是最早一个成员的 id，所以更早的发射补进来、id 变了，成员重叠照样认得出是同一段。
 * 对话自己的 id 也当成员建索引：没带成员的对话（测试里常见）退回到按 id 认。
 */
function claimSlots(items: Conversation[], buffer: Conversation[], fetched: Conversation[]) {
  const shown: Slot[] = items.map((c) => ({ c, claimed: false, gone: false }))
  const held: Slot[] = buffer.map((c) => ({ c, claimed: false, gone: false }))
  const all = [...shown, ...held]
  const order = new Map(all.map((s, i) => [s, i]))
  const byAct = new Map<string, Slot[]>()
  for (const s of all) {
    for (const k of [s.c.id, ...s.c.activities.map((a) => a.id)]) {
      const list = byAct.get(k)
      if (list === undefined) byAct.set(k, [s])
      else if (!list.includes(s)) list.push(s)
    }
  }
  const renamed: Record<string, string> = {}
  const fresh: Conversation[] = []
  for (const f of fetched) {
    const hit = new Set<Slot>()
    for (const k of [f.id, ...f.activities.map((a) => a.id)]) for (const s of byAct.get(k) ?? []) hit.add(s)
    const free = [...hit].filter((s) => !s.claimed && !s.gone).sort((a, b) => order.get(a)! - order.get(b)!)
    const [first, ...rest] = free
    if (first === undefined) {
      fresh.push(f)
      continue
    }
    if (first.c.id !== f.id) {
      const old = first.c.id
      for (const k of Object.keys(renamed)) if (renamed[k] === old) renamed[k] = f.id
      delete renamed[f.id]
      renamed[old] = f.id
    }
    first.c = f
    first.claimed = true
    for (const s of rest) s.gone = true
  }
  return { shown, held, fresh, renamed }
}

/** 旧的 renamed 和这次的接起来：a→b 再来 b→c 就是 a→c。 */
function composeRenamed(prev: Record<string, string>, add: Record<string, string>): Record<string, string> {
  if (Object.keys(add).length === 0) return prev
  const out = { ...prev }
  for (const [k, v] of Object.entries(out)) if (add[v] !== undefined) out[k] = add[v]
  for (const [k, v] of Object.entries(add)) {
    if (v !== k) out[k] = v
  }
  for (const k of Object.keys(out)) if (out[k] === k) delete out[k]
  return out
}

export interface MergeOpts {
  /** 此刻能不能动列表：能，新的直接插、没了的直接摘；不能，新的攒着、没了的留原处标「已变」。 */
  canInsert: boolean
  /** 结算动作报过的对话 id：不在这一页里就说明不再属于这个视图，直接摘，不走「已变」。 */
  dropIds?: readonly string[]
  /** 视图后面还有没拉的页。没有的话，比最老一条还老的补进来的也照收。 */
  hasNext: boolean
  /** fetched 就是视图的全部（响应没有 next）。没出现的行一律算没了，不看位置。 */
  complete?: boolean
  /** 排序：a 排在 b 前面。缺省新到旧；待确认是旧到新，传进来用。 */
  before?: Before
}

/**
 * 把新拉到的第一页合并进已经显示的行。
 *
 * - 空列表直接显示拉到的。
 * - 成员重叠的认作同一段，原地换（见 claimSlots），id 变了记进 renamed。
 * - 新对话：排在最前面，或者不比已加载的最老一条还老（没有下一页时不论多老），
 *   能动列表就按位置插，不能就攒着；能动的时候连攒着的一起插。
 * - 没出现的行（在这一页的范围里，或者上次就已经标了「已变」）：能动列表就摘，
 *   不能就原处不动标「已变」。比这一页最老一条还老的行，这一页看不到，原样留着。
 */
export function mergeLive(cur: Live, fetched: Conversation[], opts: MergeOpts): Live & { renamed: Record<string, string> } {
  const before = opts.before ?? isNewer
  if (cur.items.length === 0) return { items: fetched, buffer: [], stale: new Set(), renamed: {} }

  const { shown, held, fresh, renamed } = claimSlots(cur.items, cur.buffer, fetched)
  const last = fetched[fetched.length - 1]
  const dropIds = opts.dropIds ?? []
  const stale = new Set<string>()
  for (const s of shown) {
    if (s.claimed || s.gone) continue
    const id = s.c.id
    if (dropIds.includes(id)) s.gone = true
    else if (opts.complete === true || last === undefined || before(s.c, last) || cur.stale.has(id)) {
      if (opts.canInsert) s.gone = true
      else stale.add(id)
    }
  }
  // 攒着的那些如果已经不在这一页里，说明还没露面就没了，悄悄丢掉。
  for (const s of held) {
    if (s.claimed || s.gone) continue
    if (opts.complete === true || last === undefined || before(s.c, last)) s.gone = true
  }

  const rows = shown.filter((s) => !s.gone).map((s) => s.c)
  let buffer = held.filter((s) => !s.gone).map((s) => s.c)
  const head = rows[0]
  const tail = rows[rows.length - 1]
  const eligible = fresh.filter(
    (f) => head === undefined || tail === undefined || !opts.hasNext || before(f, head) || !before(tail, f),
  )
  if (opts.canInsert) {
    return { items: insertSorted(rows, [...buffer, ...eligible], before), buffer: [], stale, renamed }
  }
  const seen = new Set(buffer.map((c) => c.id))
  buffer = [...buffer, ...eligible.filter((c) => !seen.has(c.id))].sort(bySorted(before))
  return { items: rows, buffer, stale, renamed }
}

/** loadMore 拉回来的更早的一页：同样按成员认人，认得出的原地换，剩下的接在最后。不摘任何行。 */
function mergeMore(cur: Live, page: Conversation[]): Live & { renamed: Record<string, string> } {
  const { shown, held, fresh, renamed } = claimSlots(cur.items, cur.buffer, page)
  const rows = shown.filter((s) => !s.gone).map((s) => s.c)
  // 被认领换新的那几行已经是新鲜的，不再算「已变」。
  const untouched = new Set(shown.filter((s) => !s.claimed && !s.gone).map((s) => s.c.id))
  return {
    items: [...rows, ...fresh],
    buffer: held.filter((s) => !s.gone).map((s) => s.c),
    stale: new Set([...cur.stale].filter((id) => untouched.has(id))),
    renamed,
  }
}

/**
 * 收听页按天看、未入库、搜索三种视图共用的取数逻辑（待确认走 store.pending，
 * 不经过这里，但用同一套 mergeLive）。
 *
 * 三条路各走各的：viewParams 变了（换档、换天、换来源、换信道、换搜索词）
 * 整份重来，走 loading 状态，这时旧内容被替换成加载态；后台轮询和结算
 * 之后的刷新都只拉第一页，按成员合并进已经显示的行（见 mergeLive），不碰 loading。
 *
 * canInsert 由页面给：页面停在顶上、没展开、没开抽屉、没勾选、最近几秒没碰过屏幕时
 * 才返回 true。缺省永远 false，等于一直攒着，点「有 n 段新的」才插。
 */
export function useConversationList(
  viewParams: ConversationsParams | null,
  pollMs: number | null,
  canInsert: () => boolean = () => false,
) {
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
  // 轮询一次都跑不到。canInsert 同理。
  const paramsRef = useRef(viewParams)
  const canInsertRef = useRef(canInsert)
  useEffect(() => {
    paramsRef.current = viewParams
    canInsertRef.current = canInsert
  })

  const runFull = useCallback((mine: number, p: ConversationsParams) => {
    return api.conversations(p).then(
      (r) => {
        if (mine !== seq.current) return
        setState({
          ...EMPTY,
          items: r.items,
          next: r.next,
          channels: r.channels,
          total: r.total,
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
        // 此刻能不能动列表，在回来的这一刻问一次：请求在路上时人可能已经按下去了。
        const can = canInsertRef.current()
        setState((s) => {
          if (s.loading) return s
          const m = mergeLive(s, r.items, {
            canInsert: can,
            dropIds,
            hasNext: s.next !== undefined,
            complete: r.next === undefined,
          })
          return {
            ...s,
            items: m.items,
            buffer: m.buffer,
            stale: m.stale,
            renamed: composeRenamed(s.renamed, m.renamed),
            channels: r.channels ?? s.channels,
            total: r.total ?? s.total,
            // 整个视图一页装得下，后面就没有了。原来没有下一页、现在装不下了，
            // 才用这一页的游标。已经往后翻了的不动：游标得是翻到的那一头。
            next: r.next === undefined ? undefined : (s.next ?? r.next),
          }
        })
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
        setState((v) => {
          const m = mergeMore(v, r.items)
          return {
            ...v,
            items: m.items,
            buffer: m.buffer,
            stale: m.stale,
            renamed: composeRenamed(v.renamed, m.renamed),
            next: r.next,
            loadingMore: false,
          }
        })
      },
      (e: unknown) => {
        if (mine !== seq.current) return
        setState((v) => ({ ...v, loadingMore: false, error: errorText(e) }))
      },
    )
  }, [])

  const showNew = useCallback(() => {
    setState((s) => {
      if (s.buffer.length === 0) return s
      return { ...s, items: insertSorted(s.items, s.buffer, isNewer), buffer: [] }
    })
  }, [])

  const head = state.items[0]
  return {
    items: state.items,
    channels: state.channels,
    total: state.total,
    newCount: state.buffer.length,
    /** 提示条怎么写：「有 n 段新的」，还是攒着的里有比最上面一行还早的，写「有 n 段新补进来的」。 */
    newKind: (head !== undefined && state.buffer.some((c) => isNewer(head, c)) ? 'backfill' : 'new') as 'new' | 'backfill',
    /** 已经不在最新结果里、先留在原处的行 id。这些行的按钮要禁用，标「已变」。 */
    stale: state.stale,
    /** 旧 id 到新 id。页面把挑中的、展开的、选中的搬到新 id 上，和新成员取交集，不加新成员。 */
    renamed: state.renamed,
    loading: state.loading,
    loadingMore: state.loadingMore,
    error: state.error,
    hasMore: state.next !== undefined,
    loadMore,
    showNew,
    retry,
    /** 结算（入库/忽略/删除）之后调用：拉第一页合并，结算过的那几个 id 如果
     *  不再属于这个视图（比如未入库里入库掉的那一段）就从列表里摘掉。 */
    settleRefresh: mergeLatest,
  }
}
