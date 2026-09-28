import { TABS, TAB_LABEL, badgeText } from './model'
import type { Tab } from './model'

/**
 * 五档切换。只有待确认、未入库带计数，全部/已入库/已忽略不带——那三档
 * 本来就不需要一眼看出「有多少条」。
 *
 * 手机上是固定的五等分网格，数字涨到两位数、三位数也不会把布局挤成
 * 两行：计数徽标自己留了三位数的宽度，网格本身的列宽不随文字变。
 */
export function Chips({
  tab,
  onSelect,
  pendingCount,
  unloggedCount,
}: {
  tab: Tab
  onSelect: (tab: Tab) => void
  pendingCount: number
  unloggedCount: number
}) {
  const counts: Partial<Record<Tab, number>> = { pending: pendingCount, unlogged: unloggedCount }
  return (
    <div className="listen-chips" role="tablist" aria-label="收听页视图">
      {TABS.map((t) => {
        const count = counts[t]
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'chip active' : 'chip'}
            onClick={() => onSelect(t)}
          >
            <span className="chip-label">{TAB_LABEL[t]}</span>
            {count !== undefined && <span className="chip-count">{badgeText(count)}</span>}
          </button>
        )
      })}
    </div>
  )
}
