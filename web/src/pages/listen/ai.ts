import type { QsoDraft, QsoField } from '@core'
import type { ActivityAi, Conversation, HeardItem } from '../../api'

/** 发射行上的识别标记。 */
export type AiTag = '无人声' | '测试' | '噪声' | '识别失败' | '识别中'

export const AI_TAG_COLOR: Record<AiTag, string> = {
  无人声: 'default',
  测试: 'cyan',
  噪声: 'default',
  识别失败: 'red',
  识别中: 'processing',
}

/** 识别结果有没有真的出来。只有人工判定、没有识别内容的 ai 不算：那一次发射还在队列里。 */
const hasResult = (ai: ActivityAi | undefined): ai is ActivityAi =>
  ai !== undefined &&
  (ai.hasSpeech !== undefined || ai.transcript !== undefined || ai.category !== undefined || ai.error !== undefined)

/**
 * 一次发射该挂什么标记。数字侧不送去识别，识别关着时也不挂：
 * 那样每一行都写「识别中」，其实根本没人在识别。
 */
export function aiTagOf(a: HeardItem, aiEnabled: boolean): AiTag | undefined {
  if (!aiEnabled || a.origin !== 'sdr-fm') return undefined
  const ai = a.ai
  if (!hasResult(ai)) return '识别中'
  if (ai.error !== undefined) return '识别失败'
  if (ai.hasSpeech === false) return '无人声'
  if (ai.category === 'test') return '测试'
  if (ai.category === 'noise') return '噪声'
  return undefined
}

/** 没有人声的那次，转写是 whisper 凭空编的，只放在标记的悬停里，不当内容显示。 */
export const noSpeechRaw = (a: HeardItem): string | undefined =>
  a.ai?.hasSpeech === false ? a.ai.transcript : undefined

/** 能显示的转写：有人声、不是空串。 */
export function transcriptOf(a: HeardItem): string | undefined {
  if (a.origin !== 'sdr-fm') return undefined
  const t = a.ai?.transcript?.trim()
  return a.ai?.hasSpeech !== false && t !== undefined && t !== '' ? t : undefined
}

/** 识别结果有了没有。手机卡片的两行位置在有之前写「还没识别」。 */
export const recognized = (a: HeardItem): boolean => hasResult(a.ai)

/** 一段里模拟侧的发射。数字侧没有录音，没有识别这回事。 */
export const fmMembers = (conv: Conversation): HeardItem[] => conv.activities.filter((a) => a.origin === 'sdr-fm')

/** 手机卡片上转写那两行的内容：各次发射的转写依次接起来。 */
export function transcriptText(conv: Conversation): string | undefined {
  const parts = fmMembers(conv)
    .map(transcriptOf)
    .filter((t): t is string => t !== undefined)
  return parts.length > 0 ? parts.join(' / ') : undefined
}

/** 一段对话上各个标记出现了几次，按出现的先后。手机卡片的标签行用。 */
export function aiTagCounts(conv: Conversation, aiEnabled: boolean): [AiTag, number][] {
  const counts = new Map<AiTag, number>()
  for (const a of conv.activities) {
    const tag = aiTagOf(a, aiEnabled)
    if (tag !== undefined) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts]
}

const AI_FIELD_TEXT: Partial<Record<QsoField, (d: QsoDraft) => string>> = {
  qth: (d) => `QTH ${d.qth}`,
  rstRcvd: (d) => `收到 ${d.rstRcvd}`,
  rstSent: (d) => `发出 ${d.rstSent}`,
  note: () => '备注',
}

/**
 * AI 填了哪些字段，呼号除外（呼号旁边有 AI 标签）。手机卡片上写成一行，
 * 桌面上放进呼号格的悬停提示：直接入库也会带上这些，行上不写的话人看不到。
 */
export function aiLine(draft: QsoDraft, aiFilled: QsoField[]): string | undefined {
  const parts = aiFilled.flatMap((k) => {
    const f = AI_FIELD_TEXT[k]
    return f === undefined ? [] : [f(draft)]
  })
  return parts.length > 0 ? `AI：${parts.join(' · ')}` : undefined
}

/**
 * 无意义档那一行写原因：各次发射为什么算无意义，按原因数个数。人工判定过的
 * 记为人工判定，全是人工判定就只写这四个字。
 */
export function reasonLine(conv: Conversation): string {
  const counts = new Map<string, number>()
  for (const a of conv.activities) {
    const ai = a.ai
    const why =
      ai?.verdict === 'meaningless'
        ? '人工判定'
        : ai?.hasSpeech === false
          ? '没有人声'
          : ai?.category === 'test'
            ? '测试'
            : ai?.category === 'noise'
              ? '噪声'
              : '无意义'
    counts.set(why, (counts.get(why) ?? 0) + 1)
  }
  if (counts.size === 1 && counts.has('人工判定')) return '人工判定'
  return [...counts].map(([why, n]) => `${why} ${n}`).join(' · ')
}
