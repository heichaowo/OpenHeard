import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { missingFields } from '@core'
import type { Channel, PendingItem, Qso, StationDefaults } from '@core'
import { ApiError, api } from './api'
import { StoreContext } from './store'
import type { PendingRow, Store } from './store'

/** 待确认队列每 15 秒拉一次。采集是后台在跑的，页面开着就该看见新的。 */
const POLL_MS = 15000

export function StoreProvider({ children }: { children: ReactNode }) {
  const [station, setStation] = useState<StationDefaults>({})
  const [channels, setChannels] = useState<Channel[]>([])
  const [pending, setPending] = useState<PendingItem[]>([])
  const [qsos, setQsos] = useState<Qso[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      const [s, p, q] = await Promise.all([api.station(), api.pending(), api.qsos()])
      setStation(s.station)
      setChannels(s.channels)
      setPending(p)
      setQsos(q)
      setError(undefined)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  const rows = useMemo<PendingRow[]>(
    () => pending.map((item) => ({ ...item, missing: missingFields(item.draft) })),
    [pending],
  )

  const value = useMemo<Store>(
    () => ({
      station,
      channels,
      pending: rows,
      qsos,
      loading,
      error,
      refresh,
      promote: async (clusterId, draft) => {
        await api.promote(clusterId, draft)
        await refresh()
      },
      ignore: async (clusterId) => {
        await api.ignore(clusterId)
        await refresh()
      },
      addQso: async (draft) => {
        await api.addQso(draft)
        await refresh()
      },
      removeQso: async (id) => {
        await api.removeQso(id)
        await refresh()
      },
    }),
    [station, channels, rows, qsos, loading, error, refresh],
  )

  return <StoreContext value={value}>{children}</StoreContext>
}
