import { channelKey } from '@core'
import type { Activity, PendingItem, QsoDraft } from '@core'
import type { Conversation } from './api'

/**
 * 只挑了一段里的几次时，开始时间和对方呼号按挑中的那几次重算。
 *
 * 后端的草稿按整段算。两段对话被并成一段、挑出后一段来记的时候，整段的
 * 开始时间和对方呼号都属于前一段，照抄就把前一段的人记到了后一段上。
 *
 * activities 是这一段/这次对话的全部成员，draft 是整段的草稿——待确认
 * 队列的 PendingRow 和收听页的 Conversation 都有这两样，用同一个函数就
 * 不用给两种行写两套挑子集的逻辑。
 */
export function draftFor(activities: Activity[], draft: QsoDraft, ids: string[]): QsoDraft {
  const acts = activities.filter((a) => ids.includes(a.id))
  if (acts.length === activities.length || acts.length === 0) return draft
  return {
    ...draft,
    startAt: Math.min(...acts.map((a) => a.startAt)),
    // 后端还会拿以前见过的 DMR ID 补呼号，那张对照表不在前端。挑中的这几次
    // 自己没带呼号就留空让人填，不拿整段的去顶。
    call: acts.find((a) => !a.mine && a.callsign)?.callsign,
  }
}

/**
 * 把 /api/pending 的一项看成一次 Conversation。
 *
 * 待确认队列和收听页（未入库、全部……）用的是两种后端形状，但行/卡片
 * 组件只认 Conversation 一种，这样两边共用同一份渲染代码。
 */
export function fromPending(item: PendingItem): Conversation {
  const { activities } = item.cluster
  const first = activities[0]
  return {
    id: item.cluster.id,
    startAt: item.cluster.startAt,
    endAt: item.cluster.endAt,
    channel: channelKey(first),
    origin: first.origin,
    status: 'pending',
    activities,
    draft: item.draft,
  }
}
