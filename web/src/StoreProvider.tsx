import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { draftFromCluster, missingFields } from '@core'
import type { Qso, QsoDraft } from '@core'
import { MOCK_CLUSTERS, MOCK_QSOS, STATION } from './mock/pending'
import { StoreContext } from './store'
import type { PendingRow, Store } from './store'

/** 后端接上之前，全部状态放在内存里。这里就是将来放 fetch 的地方。 */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [clusters, setClusters] = useState(MOCK_CLUSTERS)
  const [qsos, setQsos] = useState(MOCK_QSOS)

  const pending = useMemo<PendingRow[]>(
    () =>
      clusters.map((cluster) => {
        const draft = draftFromCluster(cluster, STATION)
        return { cluster, draft, missing: missingFields(draft) }
      }),
    [clusters],
  )

  const append = useCallback((draft: QsoDraft) => {
    const qso = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: Math.floor(Date.now() / 1000),
    } as Qso
    setQsos((prev) => [qso, ...prev])
  }, [])

  const ignore = useCallback(
    (clusterId: string) => setClusters((prev) => prev.filter((c) => c.id !== clusterId)),
    [],
  )

  const value = useMemo<Store>(
    () => ({
      station: STATION,
      pending,
      qsos,
      promote: (clusterId, draft) => {
        append(draft)
        ignore(clusterId)
      },
      ignore,
      addQso: append,
      removeQso: (id) => setQsos((prev) => prev.filter((q) => q.id !== id)),
    }),
    [pending, qsos, append, ignore],
  )

  return <StoreContext value={value}>{children}</StoreContext>
}
