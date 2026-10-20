import type { Settings } from '../../api'
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

/** 表单里的值加上密钥框，翻成要 PUT 的内容。从来不发 *Set；密钥只在框里有字或者点了清除时才发。 */
export function toBody(v: FormValues, secrets: Secrets): Settings {
  const { extra, ...rest } = v
  const asr = { ...rest.ai.asr, extraBody: parseJson(extra?.asr) }
  const text = { ...rest.ai.text, extraBody: parseJson(extra?.text) }
  delete asr.apiKeySet
  delete text.apiKeySet
  delete asr.apiKey
  delete text.apiKey
  const map = { ...rest.map }
  delete map.amapSecurityCodeSet
  delete map.amapSecurityCode
  const a = secretToSend(secrets.asr)
  const t = secretToSend(secrets.text)
  const m = secretToSend(secrets.amap)
  if (a !== undefined) asr.apiKey = a
  if (t !== undefined) text.apiKey = t
  if (m !== undefined) map.amapSecurityCode = m
  return { ...rest, ai: { ...rest.ai, asr, text }, map }
}

function parseJson(s: string | undefined): Record<string, unknown> {
  return s === undefined || s.trim() === '' ? {} : (JSON.parse(s) as Record<string, unknown>)
}
