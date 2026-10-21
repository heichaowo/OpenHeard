import type { Settings, SettingsBody } from '../../api'

/**
 * 只写不读的密钥输入框。它不是表单字段：getFieldsValue 带回去的东西会原样 PUT，
 * 框里敲错一个字再删掉，空串就会把存着的 key 清了。所以输入框的内容单独存在页面的
 * state 里，保存时按规矩翻译：框里有字才发，清除只来自「清除」链接。
 */
export interface SecretState {
  value: string
  /** 点了「清除」，保存时发 ''。 */
  clear: boolean
}

export const NO_SECRET: SecretState = { value: '', clear: false }

/** 保存时这个密钥发什么：undefined 是不发（服务端保留原值），'' 是清掉，其余是新值。 */
export function secretToSend(s: SecretState): string | undefined {
  if (s.value !== '') return s.value
  return s.clear ? '' : undefined
}

/** 表单里的值：Settings 加上 extraBody 的文本形式。密钥不在表单里，见 secret.tsx。 */
export type FormValues = Settings & { extra?: { asr?: string; text?: string } }

const showJson = (o: Record<string, unknown> | undefined) => (o === undefined || Object.keys(o).length === 0 ? '' : JSON.stringify(o))

/** 服务端回的设置放进表单：*Set 是只读的状态，不进表单；extraBody 转成文本给输入框。 */
export function toForm(s: Settings): FormValues {
  const { apiKeySet: _a, ...asr } = s.ai.asr
  const { apiKeySet: _t, ...text } = s.ai.text
  const { amapSecurityCodeSet: _m, ...map } = s.map
  return {
    ...s,
    ai: { ...s.ai, asr, text },
    map,
    extra: { asr: showJson(s.ai.asr.extraBody), text: showJson(s.ai.text.extraBody) },
  }
}

export interface Secrets {
  asr: SecretState
  text: SecretState
  amap: SecretState
}

/** 哪几段被人改过。没改的段不发：配置文件里写坏的段，GET 回的是缺省值，整段发回去会把它换掉。 */
export interface Touched {
  ai: boolean
  map: boolean
}

/**
 * 表单里的值加上密钥框，翻成要 PUT 的内容。从来不发 *Set 和 *Problem，密钥只在框里有字或者点了清除时才发。
 * ai 只在 ai 字段、额外参数或 ai 密钥改过时发，map 只在 map 字段或安全密钥改过时发。
 */
export function toBody(v: FormValues, secrets: Secrets, touched: Touched): SettingsBody {
  const { extra, ai, map, aiProblem: _a, mapProblem: _m, ...rest } = v
  const body: SettingsBody = rest
  const a = secretToSend(secrets.asr)
  const t = secretToSend(secrets.text)
  const m = secretToSend(secrets.amap)
  if (touched.ai || a !== undefined || t !== undefined) {
    const asr = { ...ai.asr, extraBody: parseJson(extra?.asr) }
    const text = { ...ai.text, extraBody: parseJson(extra?.text) }
    delete asr.apiKeySet
    delete text.apiKeySet
    delete asr.apiKey
    delete text.apiKey
    if (a !== undefined) asr.apiKey = a
    if (t !== undefined) text.apiKey = t
    body.ai = { ...ai, asr, text }
  }
  if (touched.map || m !== undefined) {
    const next = { ...map }
    delete next.amapSecurityCodeSet
    delete next.amapSecurityCode
    if (m !== undefined) next.amapSecurityCode = m
    body.map = next
  }
  return body
}

function parseJson(s: string | undefined): Record<string, unknown> {
  return s === undefined || s.trim() === '' ? {} : (JSON.parse(s) as Record<string, unknown>)
}
