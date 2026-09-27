import { createContext, use } from 'react'
import type { Channel, PendingItem, Qso, QsoDraft, QsoField, StationDefaults } from '@core'
import type { ConversationPick } from './api'

export type PendingRow = PendingItem & { missing: QsoField[] }

export interface Store {
  station: StationDefaults
  channels: Channel[]
  pending: PendingRow[]
  qsos: Qso[]
  /** 有录音的那几次发射的 id。 */
  recordings: Set<string>
  /** 模拟守听、BrandMeister 查询的效果开关，来自 /api/station。 */
  analogEnabled: boolean
  brandmeisterEnabled: boolean
  /** 首次加载还没回来。 */
  loading: boolean
  /** 连不上后端或后端报错时的说明，正常是 undefined。 */
  error?: string

  /** 下面这些都会打到后端，失败时抛 ApiError，调用方负责显示。 */
  /** 结算认发射 id，不认段 id：界面一律带上看到的那几次。回入库之后的那条通联。 */
  promote: (activityIds: string[], draft: QsoDraft) => Promise<Qso>
  /** 忽略一段。id 是对话 id（PendingRow 里就是 cluster.id）。 */
  ignore: (id: string, activityIds: string[]) => Promise<void>
  /** 一次忽略好几段。一条一条调的话，剩下那些段的 id 会变，后面全会 409。 */
  ignoreMany: (picks: ConversationPick[]) => Promise<{ ignored: number; missing: string[] }>
  addQso: (draft: QsoDraft) => Promise<Qso>
  /** 改一条已入库的。id、创建时间和来源聚类不动。 */
  editQso: (id: string, draft: QsoDraft) => Promise<void>
  removeQso: (id: string) => Promise<void>
  /** 从 ADIF 文本导入。返回读了几条、进了几条、跳了几条。 */
  importAdif: (text: string) => Promise<{ parsed: number; imported: number; skipped: number; problems: string[] }>
  refresh: () => Promise<void>
}

export const StoreContext = createContext<Store | null>(null)

export function useStore() {
  const store = use(StoreContext)
  if (!store) throw new Error('useStore 必须在 StoreProvider 里用')
  return store
}
