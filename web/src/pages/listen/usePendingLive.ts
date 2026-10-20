import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Conversation } from '../../api'
import type { PendingRow } from '../../store'
import { fromPending } from '../../subset'
import { composeRenamed, isNewer, mergeLive } from './useConversationList'
import type { Live } from './useConversationList'

/** 待确认是从早到晚排的队列：新的排在最后。 */
const oldestFirst = (a: Conversation, b: Conversation) => isNewer(b, a)

interface PendingLive extends Live {
  renamed: Record<string, string>
}

/**
 * 待确认走 store.pending，不经过 useConversationList，但行的去留用同一套规矩：
 * 手指正按着的行不能因为刷新而消失或者换位置。
 *
 * 这一档每 15 秒整份重拉，所以没出现的行一律算没了（complete）。新来的排在队尾，
 * 插进去不会推动任何已有的行，直接显示；补进中间的（更早的发射补进来）人在操作时先攒着。
 * 自己刚结算掉的那几段（own）不走「已变」，直接摘。
 */
export function usePendingLive(pending: PendingRow[], canInsert: () => boolean, own: RefObject<Set<string>>) {
  const fetched = useMemo(() => pending.map(fromPending), [pending])
  const [live, setLive] = useState<PendingLive>({ items: [], buffer: [], stale: new Set(), renamed: {} })
  const latest = useRef(fetched)

  useEffect(() => {
    latest.current = fetched
    const can = canInsert()
    const dropIds = [...own.current]
    // 拉回来的这一刻问一次，和 useConversationList 一样。
    setLive((prev) => {
      const m = mergeLive(prev, fetched, { canInsert: can, dropIds, hasNext: false, complete: true, before: oldestFirst })
      const last = m.items[m.items.length - 1]
      const tail = can || last === undefined ? [] : m.buffer.filter((c) => oldestFirst(last, c))
      return {
        items: tail.length > 0 ? [...m.items, ...tail] : m.items,
        buffer: tail.length > 0 ? m.buffer.filter((c) => !tail.includes(c)) : m.buffer,
        stale: m.stale,
        renamed: composeRenamed(prev.renamed, m.renamed),
      }
    })
    // canInsert 和 own 都是稳定引用，读的是调用那一刻的值，不进依赖。
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched])

  // 首次加载回来的那一帧，effect 还没跑，直接用拉到的，免得闪一下空态。
  const items = live.items.length === 0 ? fetched : live.items
  return {
    items,
    buffer: live.buffer,
    stale: live.stale,
    renamed: live.renamed,
    /** 人要的话把攒着的补进来，按队列的顺序。 */
    showNew: () =>
      setLive((p) => {
        if (p.buffer.length === 0) return p
        const merged = [...p.items, ...p.buffer].sort((a, b) => (oldestFirst(a, b) ? -1 : oldestFirst(b, a) ? 1 : 0))
        return { ...p, items: merged, buffer: [] }
      }),
    /** 结算之后摘掉自己结算的那几段，不标已变。结算没成的（最新一份里还在）原样留着。 */
    drop: (ids: readonly string[]) => {
      const still = new Set(latest.current.map((c) => c.id))
      const gone = ids.filter((id) => !still.has(id))
      setLive((p) => ({
        ...p,
        items: p.items.filter((c) => !gone.includes(c.id)),
        stale: new Set([...p.stale].filter((id) => !gone.includes(id))),
      }))
    },
  }
}
