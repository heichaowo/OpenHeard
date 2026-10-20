import { aiFill, aiMapOf, applyAiFill, channelKey } from '@core'
import type { PendingItem, QsoDraft, QsoField } from '@core'
import type { Conversation, HeardItem } from './api'

/** 把 AI 填过的字段还原成没有 AI 时的样子：呼号、QTH、备注留空，报告回到缺省的 59。 */
const REVERT: Partial<Record<QsoField, string | undefined>> = {
  call: undefined,
  qth: undefined,
  note: undefined,
  rstSent: '59',
  rstRcvd: '59',
}

/**
 * 只挑了一段里的几次时，开始时间、对方呼号和 AI 填的字段按挑中的那几次重算。
 *
 * 后端的草稿按整段算。两段对话被并成一段、挑出后一段来记的时候，整段的
 * 开始时间和对方呼号都属于前一段，照抄就把前一段的人记到了后一段上。
 * AI 填的字段同理：整段的 QTH 是前一个人说的，不能留在后一段的草稿里。
 *
 * activities 是这一段/这次对话的全部成员，draft 是整段的草稿，aiFilled 是整段草稿里
 * 哪几个字段是 AI 填的——待确认队列的 PendingRow 和收听页的 Conversation 都有这三样，
 * 用同一个函数就不用给两种行写两套挑子集的逻辑。
 *
 * @returns 全选或一个都没选时原样返回传进来的 draft 和 aiFilled。
 */
export function draftForWithAi(
  activities: HeardItem[],
  draft: QsoDraft,
  ids: string[],
  aiFilled: QsoField[] = [],
  myCall?: string,
): { draft: QsoDraft; aiFilled: QsoField[] } {
  const acts = activities.filter((a) => ids.includes(a.id))
  if (acts.length === activities.length || acts.length === 0) return { draft, aiFilled }
  const reverted: QsoDraft = { ...draft }
  for (const key of aiFilled) (reverted as Record<string, unknown>)[key] = REVERT[key]
  const base: QsoDraft = {
    ...reverted,
    startAt: Math.min(...acts.map((a) => a.startAt)),
    // 后端还会拿以前见过的 DMR ID 补呼号，那张对照表不在前端。挑中的这几次
    // 自己没带呼号就留空让人填，不拿整段的去顶。AI 认出的呼号由下面的 aiFill 补。
    call: acts.find((a) => !a.mine && a.callsign)?.callsign,
  }
  const out = applyAiFill(base, aiFill(acts, aiMapOf(acts), myCall))
  return { draft: out.draft, aiFilled: out.filled }
}

/** draftForWithAi 的草稿那一半。 */
export function draftFor(
  activities: HeardItem[],
  draft: QsoDraft,
  ids: string[],
  aiFilled?: QsoField[],
  myCall?: string,
): QsoDraft {
  return draftForWithAi(activities, draft, ids, aiFilled, myCall).draft
}

/**
 * 把 /api/pending 的一项看成一次 Conversation。
 *
 * 待确认队列和收听页（未入库、全部……）用的是两种后端形状，但行/卡片
 * 组件只认 Conversation 一种，这样两边共用同一份渲染代码。
 * 待确认永远不是无意义的：/api/pending 把无意义的排除了。
 */
export function fromPending(item: PendingItem): Conversation {
  const { activities } = item.cluster
  const first = activities[0]!
  return {
    id: item.cluster.id,
    startAt: item.cluster.startAt,
    endAt: item.cluster.endAt,
    channel: channelKey(first),
    origin: first.origin,
    status: 'pending',
    activities,
    draft: item.draft,
    meaningless: false,
    aiFilled: item.aiFilled,
  }
}
