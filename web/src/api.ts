import type { Channel, PendingItem, Qso, QsoDraft, StationDefaults } from '@core'

/** 后端回的错误。422 会带上还缺哪些字段。 */
export class ApiError extends Error {
  status: number
  missing?: string[]

  constructor(status: number, message: string, missing?: string[]) {
    super(message)
    this.status = status
    this.missing = missing
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    })
  } catch {
    throw new ApiError(0, '连不上后端，确认 api 起来了没有')
  }

  if (res.status === 204) return undefined as T
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; missing?: string[] }
    throw new ApiError(res.status, body.error ?? `后端回了 ${res.status}`, body.missing)
  }
  return (await res.json()) as T
}

export interface PollRow {
  queryKey: string
  at: number
  fetched: number
  parsed: number
  written: number
  ok: boolean
  ms: number
  errorMsg?: string
}

export interface Ops {
  health: {
    ok: boolean
    problems: string[]
    lastPollAt?: number
    activityCount: number
    qsoCount: number
    freeBytes?: number
  }
  polls: PollRow[]
  activities: { origin: string; n: number; latest: number }[]
  queries: { key: string; intervalS: number; amount: number }[]
  clusterGapS: number
  retentionDays: number
  now: number
}

export const api = {
  session: () => call<{ signedIn: boolean }>('/session'),
  login: (password: string) =>
    call<{ signedIn: boolean }>('/session', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => call<{ signedIn: boolean }>('/session', { method: 'DELETE' }),

  ops: () => call<Ops>('/ops'),
  station: () => call<{ station: StationDefaults; channels: Channel[] }>('/station'),
  pending: () => call<PendingItem[]>('/pending'),
  qsos: () => call<Qso[]>('/qsos'),

  promote: (clusterId: string, draft: QsoDraft) =>
    call<Qso>(`/pending/${encodeURIComponent(clusterId)}/promote`, {
      method: 'POST',
      body: JSON.stringify(draft),
    }),

  ignore: (clusterId: string) =>
    call<void>(`/pending/${encodeURIComponent(clusterId)}`, { method: 'DELETE' }),

  addQso: (draft: QsoDraft) =>
    call<Qso>('/qsos', { method: 'POST', body: JSON.stringify(draft) }),

  removeQso: (id: string) => call<void>(`/qsos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
