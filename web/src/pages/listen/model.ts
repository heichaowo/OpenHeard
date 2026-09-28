import dayjs from 'dayjs'
import type { Activity, ConversationStatus, Origin } from '@core'
import type { Zone } from '../../time'

/** URL 里 tab 的五个值：待确认这一档加对话分的那五档。 */
export type Tab = 'pending' | 'unlogged' | 'all' | 'logged' | 'ignored'

export const TABS: Tab[] = ['pending', 'unlogged', 'all', 'logged', 'ignored']

export const TAB_LABEL: Record<Tab, string> = {
  pending: '待确认',
  unlogged: '未入库',
  all: '全部',
  logged: '已入库',
  ignored: '已忽略',
}

/** 全部/已入库/已忽略按天看；待确认和未入库两档不分天。 */
export const isDayTab = (tab: Tab): boolean => tab === 'all' || tab === 'logged' || tab === 'ignored'

/** 全部按天看不筛 status，已入库/已忽略各自筛一个，覆盖「全部包括旁听」那条。 */
export const statusOfTab = (tab: Tab): ConversationStatus | undefined =>
  tab === 'logged' ? 'logged' : tab === 'ignored' ? 'ignored' : undefined

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  pending: '待确认',
  unlogged: '未入库',
  logged: '已入库',
  ignored: '已忽略',
  overheard: '旁听',
}

export const STATUS_COLOR: Record<ConversationStatus, string> = {
  pending: 'blue',
  unlogged: 'orange',
  logged: 'green',
  ignored: 'default',
  overheard: 'purple',
}

/** 没结算的三档：待确认、未入库、旁听。这三档才有草稿，才能入库或忽略。 */
export const isUnresolved = (status: ConversationStatus): boolean =>
  status === 'pending' || status === 'unlogged' || status === 'overheard'

/** 来源分段。数字现在只有 BrandMeister 一条 feed，sdr-dmr 还没有接收机在产生数据。 */
export type Src = 'fm' | 'digital' | 'all'

export const originOfSrc = (src: Src): Origin | undefined =>
  src === 'fm' ? 'sdr-fm' : src === 'digital' ? 'brandmeister' : undefined

export const ORIGIN_LABEL: Record<Origin, string> = {
  brandmeister: 'BrandMeister',
  'sdr-fm': '模拟接收机',
  'sdr-dmr': '数字接收机',
}

/** 徽标数字：三位数的宽度，封顶 99+，0 也照样显示（不是隐藏）。 */
export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n))

/** 一次发射的发射方怎么写：本台呼号、对方呼号、DMR ID，或者呼号未知。 */
export function senderText(a: Activity, myCall?: string): string {
  if (a.callsign) return a.callsign
  if (a.mine) return myCall ?? '本台'
  if (a.dmrId !== undefined) return `DMR ${a.dmrId}`
  return '呼号未知'
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 日期导航那句 `9月27日 周六`。 */
export function dayLabel(d: dayjs.Dayjs): string {
  return `${d.format('M月D日')} ${WEEKDAY[d.day()]}`
}

/** day 状态（'today' | 'YYYY-MM-DD'）在这个时区里对应的那一天。 */
export function dayValue(day: string, zone: Zone): dayjs.Dayjs {
  return day === 'today' ? dayjs().tz(zone) : dayjs.tz(day, zone)
}

/**
 * day 状态换算成 [from, to)。'today' 每次都从当前时刻的时区重算，
 * 这样它在时区的午夜自动翻篇，接着刷新；写死的日期不会。
 */
export function dayRange(day: string, zone: Zone): [number, number] {
  const start = dayValue(day, zone).startOf('day')
  return [start.unix(), start.add(1, 'day').unix()]
}

/** 多久以前。一分钟以内写秒，再往上写分钟、小时、天。 */
export function agoText(nowS: number, at: number): string {
  const s = Math.max(0, nowS - at)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${(s / 3600).toFixed(1)} 小时前`
  return `${(s / 86400).toFixed(1)} 天前`
}
