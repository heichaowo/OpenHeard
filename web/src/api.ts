import type { Channel, ClusterPick, PendingItem, Qso, QsoDraft, StationDefaults } from '@core'

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

async function call<T>(
  path: string,
  init?: RequestInit & { textBody?: boolean },
): Promise<T> {
  let res: Response
  try {
    const { textBody, ...rest } = init ?? {}
    res = await fetch(`/api${path}`, {
      ...rest,
      headers: init?.body
        ? { 'content-type': textBody === true ? 'text/plain' : 'application/json' }
        : undefined,
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

export interface AnalogSettings {
  freqMhz: number
  channel: string
  gainDb?: number
  /** 本台的 MDC-1200 unit ID，十六进制字符串。 */
  myUnitId?: string
  /** 静噪打开的余量，dB。缺省 12。 */
  openMarginDb?: number
  /** 静噪关闭的余量，dB。缺省 7。 */
  closeMarginDb?: number
}

/** 人能在界面上改的那几项。dbPath、监听地址和三个密钥只在配置文件里改。 */
export interface Settings {
  station: StationDefaults
  channels: Channel[]
  queries: { key: string; rule: { id: string; operator: string; value: number | string }; amount: number; intervalS: number }[]
  analog?: AnalogSettings
}

export interface QsoChange {
  at: number
  action: 'edit' | 'delete'
  before: Qso
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

/** 电台此刻的样子。守护进程每秒报一次，只在内存里。 */
export interface Radio {
  freqMhz: number
  channel: string
  gainDb: number
  idleDb?: number
  openBelowDb?: number
  closeAboveDb?: number
  /** 此刻 5–9 kHz 的能量。有载波时会塌下去。 */
  noiseDb?: number
  open: boolean
  lastOpenAt?: number
  /** rtl_fm 最后说的那句话。它起不来的时候唯一的线索。 */
  lastError?: string
  /** rtl_fm 重开了多少次。一直涨说明它根本起不来。 */
  restarts?: number
  at: number
  ageS: number
  fresh: boolean
  /** 这次守听里最接近打开门限的那一刻差了多少 dB。 */
  closestDb?: number
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
  /** 录音占了多少。发射行按保留期裁时录音跟着删，但已入库的那些一直留着。 */
  recordings: { files: number; bytes: number }
  /** 没配模拟守听、或者守护进程报不上来时没有这一项。 */
  radio?: Radio
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
  /** 哪几次发射有录音。界面据此决定给哪几行放播放器。 */
  recordings: () => call<string[]>('/recordings'),

  settings: () => call<Settings>('/settings'),
  saveSettings: (next: Settings) =>
    call<Settings>('/settings', { method: 'PUT', body: JSON.stringify(next) }),

  importAdif: (text: string) =>
    call<{ parsed: number; imported: number; skipped: number; problems: string[] }>(
      '/qsos/import',
      { method: 'POST', body: text, textBody: true },
    ),

  qsoHistory: (id: string) => call<QsoChange[]>(`/qsos/${encodeURIComponent(id)}/history`),
  station: () => call<{ station: StationDefaults; channels: Channel[] }>('/station'),
  pending: () => call<PendingItem[]>('/pending'),
  qsos: () => call<Qso[]>('/qsos'),

  /** activityIds 只结算这一段里的这几次发射，不给就是整段。 */
  promote: (clusterId: string, draft: QsoDraft, activityIds?: string[]) =>
    call<Qso>(`/pending/${encodeURIComponent(clusterId)}/promote`, {
      method: 'POST',
      body: JSON.stringify(activityIds === undefined ? draft : { ...draft, activityIds }),
    }),

  ignore: (clusterId: string, activityIds?: string[]) =>
    call<void>(
      `/pending/${encodeURIComponent(clusterId)}` +
        (activityIds === undefined ? '' : `?activityIds=${activityIds.map(encodeURIComponent).join(',')}`),
      { method: 'DELETE' },
    ),

  ignoreMany: (picks: ClusterPick[]) =>
    call<{ ignored: number; missing: string[] }>('/pending/ignore', {
      method: 'POST',
      body: JSON.stringify({ picks }),
    }),

  addQso: (draft: QsoDraft) =>
    call<Qso>('/qsos', { method: 'POST', body: JSON.stringify(draft) }),

  editQso: (id: string, draft: QsoDraft) =>
    call<Qso>(`/qsos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(draft) }),

  removeQso: (id: string) => call<void>(`/qsos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
