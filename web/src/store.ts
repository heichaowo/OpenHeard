import { createContext, use } from 'react'
import type { PendingItem, Qso, QsoDraft, QsoField, StationDefaults } from '@core'

export type PendingRow = PendingItem & { missing: QsoField[] }

export interface Store {
  station: StationDefaults
  pending: PendingRow[]
  qsos: Qso[]
  /** 把一次对话提升成通联。草稿必须已经补齐。 */
  promote: (clusterId: string, draft: QsoDraft) => void
  ignore: (clusterId: string) => void
  addQso: (draft: QsoDraft) => void
  removeQso: (id: string) => void
}

export const StoreContext = createContext<Store | null>(null)

export function useStore() {
  const store = use(StoreContext)
  if (!store) throw new Error('useStore 必须在 StoreProvider 里用')
  return store
}
