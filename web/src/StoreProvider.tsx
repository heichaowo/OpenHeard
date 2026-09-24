import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { missingFields } from '@core'
import type { Channel, PendingItem, Qso, StationDefaults } from '@core'
import { api, errorText } from './api'
import { StoreContext } from './store'
import type { PendingRow, Store } from './store'

/** 待确认队列每 15 秒拉一次。采集是后台在跑的，页面开着就该看见新的。 */
const POLL_MS = 15000

export function StoreProvider({ children }: { children: ReactNode }) {
  const [station, setStation] = useState<StationDefaults>({})
  const [channels, setChannels] = useState<Channel[]>([])
  const [pending, setPending] = useState<PendingItem[]>([])
  const [qsos, setQsos] = useState<Qso[]>([])
  const [recordings, setRecordings] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()

  // 每次 refresh 领一个号，只有最新那一次的结果作数。
  //
  // 定时轮询和写完之后的那次刷新会同时在路上，先发的未必先回；照单全收的话
  // 一个早发的响应会把刚入库的那条盖回去，直到下一轮才恢复。挡住旧结果而不是
  // 挡住请求，写完那一次才一定跑得到。
  const seq = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const [s, p, q, r] = await Promise.all([
        api.station(),
        api.pending(),
        api.qsos(),
        // 没配模拟守听时这里是空数组，不该让整页跟着失败。
        api.recordings().catch(() => [] as string[]),
      ])
      if (mine !== seq.current) return
      setStation(s.station)
      setChannels(s.channels)
      setPending(p)
      setQsos(q)
      setRecordings(new Set(r))
      setError(undefined)
    } catch (e) {
      if (mine !== seq.current) return
      setError(errorText(e))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 这里的 setState 都发生在 await 之后，不是同步的。
    // 拉后端正是 effect 该做的「和外部系统同步」，规则认不出异步这一层。
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh()
    // 标签页在后台时定时器不拉，切回来立刻补一次。挡的只是定时器，
    // refresh 本身不挡：入库之后那一次必须跑到，否则页面停在改之前的样子。
    const tick = () => {
      if (!document.hidden) void refresh()
    }
    const t = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
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
      recordings,
      loading,
      error,
      refresh,
      promote: async (clusterId, draft, activityIds) => {
        await api.promote(clusterId, draft, activityIds)
        await refresh()
      },
      ignore: async (clusterId, activityIds) => {
        await api.ignore(clusterId, activityIds)
        await refresh()
      },
      ignoreMany: async (picks) => {
        const r = await api.ignoreMany(picks)
        await refresh()
        return r
      },
      addQso: async (draft) => {
        await api.addQso(draft)
        await refresh()
      },
      editQso: async (id, draft) => {
        await api.editQso(id, draft)
        await refresh()
      },
      removeQso: async (id) => {
        await api.removeQso(id)
        await refresh()
      },
      importAdif: async (text) => {
        const r = await api.importAdif(text)
        await refresh()
        return r
      },
    }),
    [station, channels, rows, qsos, recordings, loading, error, refresh],
  )

  return <StoreContext value={value}>{children}</StoreContext>
}
