import { LeftOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Segmented, Select } from 'antd'
import { useTime } from '../../useTime'
import { dayLabel, dayValue } from './model'
import type { Src } from './model'

const SOURCES: { value: Src; label: string }[] = [
  { value: 'fm', label: '模拟' },
  { value: 'digital', label: '数字' },
  { value: 'all', label: '全部' },
]

const ALL_CHANNELS = '__all__'

/**
 * 按天看的三档共用的工具条：日期导航、来源、信道。
 *
 * 只有 全部/已入库/已忽略 用得到——待确认和未入库两档不分天，没有这一条。
 * 日期标签带时区：一串没有时区的数字比只用 UTC 更糟，看的人没法确定它是什么。
 */
export function DayNav({
  day,
  onDay,
  src,
  onSrc,
  channel,
  onChannel,
  channels,
}: {
  day: string
  onDay: (day: string) => void
  src: Src
  onSrc: (src: Src) => void
  channel?: string
  onChannel: (channel?: string) => void
  channels: { key: string; label: string }[]
}) {
  const time = useTime()
  const cur = dayValue(day, time.zone)
  const today = day === 'today'

  const prev = () => onDay(cur.subtract(1, 'day').format('YYYY-MM-DD'))
  const next = () => {
    const n = cur.add(1, 'day')
    onDay(n.isSame(time.now(), 'day') ? 'today' : n.format('YYYY-MM-DD'))
  }

  return (
    <div className="day-nav">
      <div className="day-nav-date">
        <Button type="text" icon={<LeftOutlined />} aria-label="前一天" onClick={prev} />
        <span className="day-nav-label">
          {dayLabel(cur)} · {time.label}
        </span>
        <Button type="text" icon={<RightOutlined />} aria-label="后一天" onClick={next} disabled={today} />
        <Button size="small" onClick={() => onDay('today')} disabled={today}>
          今天
        </Button>
      </div>
      <div className="day-nav-filters">
        <Segmented<Src> options={SOURCES} value={src} onChange={onSrc} />
        <Select<string>
          className="day-nav-channel"
          value={channel ?? ALL_CHANNELS}
          onChange={(v) => onChannel(v === ALL_CHANNELS ? undefined : v)}
          options={[{ value: ALL_CHANNELS, label: '全部信道' }, ...channels.map((c) => ({ value: c.key, label: c.label }))]}
        />
      </div>
    </div>
  )
}
