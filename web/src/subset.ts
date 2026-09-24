import type { QsoDraft } from '@core'
import type { PendingRow } from './store'

/**
 * 只挑了一段里的几次时，开始时间和对方呼号按挑中的那几次重算。
 *
 * 后端的草稿按整段算。两段对话被并成一段、挑出后一段来记的时候，整段的
 * 开始时间和对方呼号都属于前一段，照抄就把前一段的人记到了后一段上。
 */
export function draftFor(row: PendingRow, ids: string[]): QsoDraft {
  const acts = row.cluster.activities.filter((a) => ids.includes(a.id))
  if (acts.length === row.cluster.activities.length || acts.length === 0) return row.draft
  return {
    ...row.draft,
    startAt: Math.min(...acts.map((a) => a.startAt)),
    // 后端还会拿以前见过的 DMR ID 补呼号，那张对照表不在前端。挑中的这几次
    // 自己没带呼号就留空让人填，不拿整段的去顶。
    call: acts.find((a) => !a.mine && a.callsign)?.callsign,
  }
}
