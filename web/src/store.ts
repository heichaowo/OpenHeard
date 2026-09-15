import { createContext, use } from 'react'
import type { Channel, PendingItem, Qso, QsoDraft, QsoField, StationDefaults } from '@core'

export type PendingRow = PendingItem & { missing: QsoField[] }

export interface Store {
  station: StationDefaults
  channels: Channel[]
  pending: PendingRow[]
  qsos: Qso[]
  /** 首次加载还没回来。 */
  loading: boolean
  /** 连不上后端或后端报错时的说明，正常是 undefined。 */
  error?: string

  /** 下面这些都会打到后端，失败时抛 ApiError，调用方负责显示。 */
  promote: (clusterId: string, draft: QsoDraft) => Promise<void>
  ignore: (clusterId: string) => Promise<void>
  addQso: (draft: QsoDraft) => Promise<void>
  removeQso: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

export const StoreContext = createContext<Store | null>(null)

export function useStore() {
  const store = use(StoreContext)
  if (!store) throw new Error('useStore 必须在 StoreProvider 里用')
  return store
}
