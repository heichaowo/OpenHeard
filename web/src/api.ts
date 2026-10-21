import type { Channel, Conversation, ConversationStatus, Origin, PendingItem, Qso, QsoDraft, StationDefaults } from '@core'

// 对话和发射的形状在 core 里定义，api 和页面共用同一份：识别结果、无意义判定、
// AI 填了哪几个字段都在里面。
export type { ActivityAi, AiFields, Conversation, ConversationStatus, HeardItem } from '@core'

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

export type VadProvider = 'local' | 'off'
export type AsrProvider = 'local' | 'openai-transcriptions' | 'chat-audio' | 'off'
export type TextProvider = 'local' | 'openai-chat' | 'off'
export type MapProvider = 'amap' | 'osm' | 'none'

/**
 * AI 的三步。key 只写不读：GET 回 apiKeySet，不回 key；PUT 里缺省或 null 是不动，
 * '' 是清掉，非空是设上。apiKeySet 是 GET 才有的，PUT 里带了也被忽略。
 */
export interface AiSettings {
  enabled: boolean
  vad: { provider: VadProvider; binPath: string; modelPath: string; threshold: number }
  asr: {
    provider: AsrProvider
    binPath: string
    modelPath: string
    language: string
    prompt: string
    baseUrl: string
    model: string
    extraBody: Record<string, unknown>
    apiKey?: string
    apiKeySet?: boolean
  }
  text: {
    provider: TextProvider
    binPath: string
    modelPath: string
    port: number
    idleUnloadS: number
    baseUrl: string
    model: string
    extraBody: Record<string, unknown>
    apiKey?: string
    apiKeySet?: boolean
  }
}

/** 地图。高德的 JS key 是公开的，照常回；安全密钥只写不读。 */
export interface MapSettings {
  provider: MapProvider
  amapKey: string
  amapSecurityCode?: string
  amapSecurityCodeSet?: boolean
}

/** 人能在界面上改的那几项。dbPath、监听地址和三个密钥只在配置文件里改。 */
export interface Settings {
  station: StationDefaults
  channels: Channel[]
  queries: { key: string; rule: { id: string; operator: string; value: number | string }; amount: number; intervalS: number }[]
  analog?: AnalogSettings
  /** BrandMeister 查询的开关。缺省开。关掉之后 queries 原样留在文件里。 */
  brandmeisterEnabled?: boolean
  ai: AiSettings
  map: MapSettings
  /** 配置文件里的 ai 段写坏了：GET 回的 ai 是缺省值，这里说坏在哪。存 ai 会把文件里的这一段换掉。 */
  aiProblem?: string
  /** 同上，map 段。 */
  mapProblem?: string
}

/** PUT /api/settings 的 body：ai 和 map 没改就不发，服务端留着文件里的原样。 */
export type SettingsBody = Omit<Settings, 'ai' | 'map' | 'aiProblem' | 'mapProblem'> & {
  ai?: AiSettings
  map?: MapSettings
}

/** 通联本身之外还带上它用到的哪几次发射，只有受保护的 /api/qsos 才给。
 *  手工录入和 ADIF 导入的通联没有观测，这里是空数组。 */
export type QsoWithActivities = Qso & {
  activities: { id: string; startAt: number; durationS: number }[]
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

/** /api/station 里的地图：只有页面要用到的那几项，安全密钥不在里面。 */
export interface StationMap {
  provider: MapProvider
  amapKey?: string
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
  ai: OpsAi
  /** 配置文件里 map 段写坏了，坏在哪。这时地图按「不用」处理。 */
  mapProblem?: string
}

/** 识别队列。meaningless 和收听页 无意义 档的数字是同一个：view=meaningless 的总数。 */
export interface OpsAi {
  enabled: boolean
  vad: VadProvider
  asrProvider: AsrProvider
  textProvider: TextProvider
  /** 还没识别的录音。 */
  todo: number
  doneLast24h: number
  meaningless: number
  /** 守护进程最近一次报的状态，只在 api 内存里。 */
  worker?: { at: number; ok: boolean; message: string }
  lastError?: { at: number; message: string }
  /** 配置文件里 ai 段写坏了，坏在哪。这时识别按关着处理。 */
  problem?: string
}

/** GET /api/conversations 的查询条件。三种视图选一种，见 contract.md。 */
export interface ConversationsParams {
  /** 按天看：[from, to)，Unix 秒。 */
  from?: number
  to?: number
  /** 未入库：出了待确认窗口、还没结算、还在保留期内的对话。无意义：AI 或人判成无意义、还没入库的对话。 */
  view?: 'unlogged' | 'meaningless'
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
  /** 只有 未入库 和 无意义 才有，q view 不给总数，见 contract.md。 */
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
  saveSettings: (next: SettingsBody) =>
    call<Settings>('/settings', { method: 'PUT', body: JSON.stringify(next) }),

  importAdif: (text: string) =>
    call<{ parsed: number; imported: number; skipped: number; problems: string[] }>(
      '/qsos/import',
      { method: 'POST', body: text, textBody: true },
    ),

  qsoHistory: (id: string) => call<QsoChange[]>(`/qsos/${encodeURIComponent(id)}/history`),

  station: () =>
    call<{
      station: StationDefaults
      channels: Channel[]
      analogEnabled: boolean
      brandmeisterEnabled: boolean
      aiEnabled: boolean
      map: StationMap
    }>('/station'),
  pending: () => call<PendingItem[]>('/pending'),
  /** 受保护的这一份带 activities，公开的 /public/qsos 不带。 */
  qsos: () => call<QsoWithActivities[]>('/qsos'),

  /** 按天看、未入库、搜呼号三种视图，见 contract.md「GET /api/conversations」。 */
  conversations: (params: ConversationsParams) =>
    call<ConversationsResponse>(`/conversations${qs(params)}`),

  /** 结算认发射 id，不认对话 id：界面一律带上看到的那几次。 */
  // 草稿字段和 activityIds 平铺在同一层，见 docs/admin-api-v1.md。包成
  // {activityIds, draft} 的话，服务端读不到任何字段，回 422 说必填项全缺。
  promoteActivities: (activityIds: string[], draft: QsoDraft) =>
    call<Qso>('/conversations/promote', {
      method: 'POST',
      body: JSON.stringify({ ...draft, activityIds }),
    }),

  /** 一次忽略好几段，服务端一起做。一段结算不了就报在 missing 里，不挡别的段。 */
  ignoreActivities: (picks: ConversationPick[]) =>
    call<{ ignored: number; missing: string[] }>('/conversations/ignore', {
      method: 'POST',
      body: JSON.stringify({ picks }),
    }),

  /**
   * 整段删掉没入库的对话，连同录音。picks 里每一项带上人看到的那几次发射。
   * 永远 200：删不了的那段（已入库、已经没了、信道不一样）报在 missing 里，不挡别的段。
   */
  deleteConversations: (picks: ConversationPick[]) =>
    call<{ deleted: number; missing: string[] }>('/conversations/delete', {
      method: 'POST',
      body: JSON.stringify({ picks }),
    }),

  /** 人工判定：meaningless 为 false 是「不是无意义」，改判回来。204。 */
  setVerdict: (activityIds: string[], meaningless: boolean) =>
    call<void>('/conversations/verdict', {
      method: 'POST',
      body: JSON.stringify({ activityIds, meaningless }),
    }),

  /** 每个模拟信道此刻开没开，api 内存里的状态，每 3 秒拉一次，不碰数据库。 */
  radios: () => call<RadiosResponse>('/radios'),

  addQso: (draft: QsoDraft) =>
    call<Qso>('/qsos', { method: 'POST', body: JSON.stringify(draft) }),

  editQso: (id: string, draft: QsoDraft) =>
    call<Qso>(`/qsos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(draft) }),

  removeQso: (id: string) => call<void>(`/qsos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
