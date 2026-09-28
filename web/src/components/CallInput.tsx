import { useMemo } from 'react'
import { AutoComplete, Input, Typography } from 'antd'
import { normalizeCallsign } from '@core'
import type { Qso } from '@core'
import { useTime } from '../useTime'

/**
 * 对方呼号的联想输入。取 qsos 当参数，自己不碰 store。
 *
 * QsoFields 给待确认队列和日志的编辑抽屉用，QuickEntry 自己那一格也用它，
 * 两处都已经有 qsos（useRecall 也要它），不用另开一条数据源。
 *
 * 按前缀匹配，同一个人只留最近那次，最近的排前面，最多 8 个。
 * 不从发射行取：数字侧一天上千个呼号，大多和本台无关。
 */
export function CallInput({
  qsos,
  value,
  onChange,
  autoFocus,
  placeholder = 'BD7KLO',
  id,
}: {
  qsos: Qso[]
  value?: string
  onChange?: (v: string) => void
  autoFocus?: boolean
  placeholder?: string
  id?: string
}) {
  const time = useTime()

  const options = useMemo(() => {
    const prefix = normalizeCallsign(value ?? '')
    const latest = new Map<string, Qso>()
    for (const q of qsos) {
      const cur = latest.get(q.call)
      if (!cur || q.startAt > cur.startAt) latest.set(q.call, q)
    }
    return [...latest.values()]
      .filter((q) => q.call.startsWith(prefix))
      .sort((a, b) => b.startAt - a.startAt)
      .slice(0, 8)
      .map((q) => ({
        value: q.call,
        label: (
          <div>
            <div className="callsign">{q.call}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {q.qth ?? time.atShort(q.startAt)}
            </Typography.Text>
          </div>
        ),
      }))
  }, [qsos, value, time])

  return (
    <AutoComplete
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      popupMatchSelectWidth={false}
    >
      <Input autoFocus={autoFocus} placeholder={placeholder} />
    </AutoComplete>
  )
}
