import type {
  Activity,
  Channel,
  Origin,
  PendingItem,
  Qso,
  QsoDraft,
  StationDefaults,
} from '@core'

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
  /** 同一支接收机守的几个信道。 */
  channels: { freqMhz: number; channel: string }[]
  gainDb?: number
  /** 本台的 MDC-1200 unit ID，十六进制字符串。 */
  myUnitId?: string
  /** 静噪打开的余量，dB。缺省 12。 */
  openMarginDb?: number
  /** 静噪关闭的余量，dB。缺省 7。 */
  closeMarginDb?: number
  /** 模拟守听的开关。缺省开。关掉之后这一段原样留在文件里。 */
  enabled?: boolean
}

/** 人能在界面上改的那几项。dbPath、监听地址和三个密钥只在配置文件里改。 */
export interface Settings {
  station: StationDefaults
  channels: Channel[]
  queries: { key: string; rule: { id: string; operator: string; value: number | string }; amount: number; intervalS: number }[]
  analog?: AnalogSettings
  /** BrandMeister 查询的开关。缺省开。关掉之后 queries 原样留在文件里。 */
  brandmeisterEnabled?: boolean
}

/** 收听记录里的一行。结算过的带上结算成了什么。 */
export type HeardItem = Activity & { settled?: 'logged' | 'ignored' }

/** 通联本身之外还带上它用到的哪几次发射，只有受保护的 /api/qsos 才给。
 *  手工录入和 ADIF 导入的通联没有观测，这里是空数组。 */
export type QsoWithActivities = Qso & {
  activities: { id: string; startAt: number; durationS: number }[]
}

/** 对话结算成什么了。旁听没有本台，永远到不了 pending/unlogged。 */
export type ConversationStatus = 'pending' | 'unlogged' | 'logged' | 'ignored' | 'overheard'

/**
 * 发射聚成的一次对话，跨 收听/待确认/日志 三种看法的同一张图。
 *
 * id、startAt、activities 无论从哪个视图（按天、未入库、搜索……）拼出来
 * 都得是同一份，靠后端按 contract.md「Windows and chains」那条规则保证。
 */
export interface Conversation {
  id: string
  startAt: number
  endAt: number
  /** channelKey()：'tg:46001' | 'ch:438.500 中继' | 'fq:438.5' | origin。 */
  channel: string
  origin: Origin
  status: ConversationStatus
  /** 按时间升序。 */
  activities: HeardItem[]
  /** 只有结算成通联（status 'logged'）时才有。 */
  qso?: { id: string; call: string; rstSent: string; rstRcvd: string }
  /** 只有还没结算时才有，和 /api/pending 用的是同一套草稿构造。 */
  draft?: QsoDraft
}

/** 批量结算里挑中的一段。id 是对话 id，不是段里成员的 id。 */
export interface ConversationPick {
  id: string
  activityIds: string[]
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

/** 电台此刻的样子，一个信道一条。守护进程每秒报一次，只在内存里。 */
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
  /** rtl_sdr 最后说的那句话。它起不来的时候唯一的线索。 */
  lastError?: string
  /** rtl_sdr 重开了多少次。一直涨说明它根本起不来。 */
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
  /** 一个信道一条。没配模拟守听、或者守护进程报不上来时是空的。 */
  radios: Radio[]
  polls: PollRow[]
  activities: { origin: string; n: number; latest: number }[]
  queries: { key: string; intervalS: number; amount: number }[]
  clusterGapS: number
  activityRetentionDays: number
  pendingWindowDays: number
  now: number
  /** 效果值：配置里缺省是开，这两个字段告诉界面关没关。 */
  analogEnabled: boolean
  brandmeisterEnabled: boolean
}

/** GET /api/conversations 的查询条件。三种视图选一种，见 contract.md。 */
export interface ConversationsParams {
  /** 按天看：[from, to)，Unix 秒。 */
  from?: number
  to?: number
  /** 未入库：出了待确认窗口、还没结算、还在保留期内的对话。 */
  view?: 'unlogged'
  /** 搜呼号，至少 2 个字符，前缀匹配，跨整个保留期。 */
  q?: string
  origin?: Origin
  status?: ConversationStatus
  /** 精确的 channelKey，例如 'tg:46001'。 */
  channel?: string
  limit?: number
  cursor?: string
}

export interface ConversationsResponse {
  items: Conversation[]
  next?: string
  /** 只有按天看才有：这一天这个来源出现过的信道。 */
  channels?: { key: string; label: string }[]
  /** 只有 未入库 才有，q view 不给总数，见 contract.md。 */
  total?: number
}

/** GET /api/radios。radios 在模拟守听效果上关着时是空数组。 */
export interface RadiosResponse {
  analogEnabled: boolean
  radios: Radio[]
}

// 参数类型没有索引签名（ConversationsParams 逐个字段写死，不想为了这一个
// 帮手函数放开成任意 key），所以这里收 object，内部再当 Record 读。
const qs = (params: object): string => {
  const parts = Object.entries(params as Record<string, string | number | undefined>)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  return parts.length > 0 ? `?${parts.join('&')}` : ''
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

  /** cursor 是上一页给的 next。不给就是最新的一页。 */
  heard: (origin: Origin, cursor?: string) =>
    call<{ items: HeardItem[]; next?: string }>(
      `/activities?origin=${origin}` +
        (cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`),
    ),
  station: () =>
    call<{
      station: StationDefaults
      channels: Channel[]
      analogEnabled: boolean
      brandmeisterEnabled: boolean
    }>('/station'),
  pending: () => call<PendingItem[]>('/pending'),
  /** 受保护的这一份带 activities，公开的 /public/qsos 不带。 */
  qsos: () => call<QsoWithActivities[]>('/qsos'),

  /** 按天看、未入库、搜呼号三种视图，见 contract.md「GET /api/conversations」。 */
  conversations: (params: ConversationsParams) =>
    call<ConversationsResponse>(`/conversations${qs(params)}`),

  /** 结算认发射 id，不认对话 id：界面一律带上看到的那几次。 */
  promoteActivities: (activityIds: string[], draft: QsoDraft) =>
    call<Qso>('/conversations/promote', {
      method: 'POST',
      body: JSON.stringify({ activityIds, draft }),
    }),

  /** 一次忽略好几段，服务端一起做。一段结算不了就报在 missing 里，不挡别的段。 */
  ignoreActivities: (picks: ConversationPick[]) =>
    call<{ ignored: number; missing: string[] }>('/conversations/ignore', {
      method: 'POST',
      body: JSON.stringify({ picks }),
    }),

  /** 每个模拟信道此刻开没开，api 内存里的状态，每 3 秒拉一次，不碰数据库。 */
  radios: () => call<RadiosResponse>('/radios'),

  addQso: (draft: QsoDraft) =>
    call<Qso>('/qsos', { method: 'POST', body: JSON.stringify(draft) }),

  editQso: (id: string, draft: QsoDraft) =>
    call<Qso>(`/qsos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(draft) }),

  removeQso: (id: string) => call<void>(`/qsos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
