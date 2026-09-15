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

/**
 * 会话失效时通知谁。
 *
 * 管理端会开着好几个小时等自动入库，而会话有 30 天的期限。到期之后每一次轮询
 * 都只是多一条「没登录」，页面上没有任何回到登录页的路，队列会一直堆着没人管。
 * SessionGate 挂上这个回调，401 一出现就退回登录页。
 */
let onUnauthorized: (() => void) | undefined

export function setUnauthorizedHandler(fn: (() => void) | undefined) {
  onUnauthorized = fn
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
  // /session 自己的 401 是口令不对，不是会话过期，交给登录表单显示。
  if (res.status === 401 && !path.startsWith('/session')) onUnauthorized?.()
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

/**
 * 任何异常都变成一句能显示的话。
 *
 * 同一段三元式原来在 StoreProvider、SessionGate 和 OpsPage 各写了一遍。
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export interface Machine {
  rssBytes: number
  uptimeS: number
  cores: number
  memFreeBytes: number
  memTotalBytes: number
  /** 一分钟平均负载除以核数，和 1.0 比。 */
  load1: number
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
  machine: Machine
  polls: PollRow[]
  activities: { origin: string; n: number; latest: number }[]
  queries: { key: string; intervalS: number; amount: number }[]
  clusterGapS: number
  activityRetentionDays: number
  pendingWindowDays: number
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

  editQso: (id: string, draft: QsoDraft) =>
    call<Qso>(`/qsos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(draft) }),

  removeQso: (id: string) => call<void>(`/qsos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
