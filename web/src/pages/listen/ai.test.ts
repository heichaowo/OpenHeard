import { describe, expect, it } from 'vitest'
import type { ActivityAi, Conversation, HeardItem } from '../../api'
import { aiLine, aiTagCounts, aiTagOf, noSpeechRaw, reasonLine, recognized, transcriptOf, transcriptText } from './ai'

const fm = (id: string, ai?: ActivityAi, over: Partial<HeardItem> = {}): HeardItem => ({
  id,
  origin: 'sdr-fm',
  startAt: 1_789_000_000,
  durationS: 3,
  mine: false,
  channel: '438.500 中继',
  ai,
  ...over,
})

const bm = (id: string): HeardItem => ({ id, origin: 'brandmeister', startAt: 1_789_000_000, durationS: 3, mine: false })

const convOf = (activities: HeardItem[]): Conversation => ({
  id: activities[0]!.id,
  startAt: activities[0]!.startAt,
  endAt: activities[0]!.startAt + 3,
  channel: 'ch:438.500 中继',
  origin: activities[0]!.origin,
  status: 'unlogged',
  activities,
  meaningless: false,
})

describe('aiTagOf', () => {
  it('没识别过的模拟发射写识别中，识别关着时不写', () => {
    expect(aiTagOf(fm('a'), true)).toBe('识别中')
    expect(aiTagOf(fm('a'), false)).toBeUndefined()
  })

  it('数字侧的发射永远没有标记', () => {
    expect(aiTagOf(bm('a'), true)).toBeUndefined()
  })

  it('只有人工判定、没有识别内容的发射还在队列里，照样写识别中', () => {
    expect(aiTagOf(fm('a', { meaningless: false, verdict: 'keep' }), true)).toBe('识别中')
  })

  it('出错、无人声、测试、噪声各有各的标记，正常的 qso 没有', () => {
    expect(aiTagOf(fm('a', { error: '超时', meaningless: false }), true)).toBe('识别失败')
    expect(aiTagOf(fm('a', { hasSpeech: false, meaningless: true }), true)).toBe('无人声')
    expect(aiTagOf(fm('a', { hasSpeech: true, category: 'test', meaningless: true }), true)).toBe('测试')
    expect(aiTagOf(fm('a', { hasSpeech: true, category: 'noise', meaningless: true }), true)).toBe('噪声')
    expect(aiTagOf(fm('a', { hasSpeech: true, category: 'qso', transcript: '你好', meaningless: false }), true)).toBeUndefined()
  })

  it('有人声才算有转写；没人声的原文只在悬停里', () => {
    const quiet = fm('a', { hasSpeech: false, transcript: '(字幕製作:貝爾)', meaningless: true })
    expect(transcriptOf(quiet)).toBeUndefined()
    expect(noSpeechRaw(quiet)).toBe('(字幕製作:貝爾)')
    expect(transcriptOf(fm('b', { hasSpeech: true, transcript: ' CQ CQ ', meaningless: false }))).toBe('CQ CQ')
    expect(transcriptOf(fm('c', { hasSpeech: true, transcript: '', meaningless: false }))).toBeUndefined()
    expect(recognized(fm('c', { hasSpeech: true, transcript: '', meaningless: false }))).toBe(true)
    expect(recognized(fm('d'))).toBe(false)
  })
})

describe('一段对话的转写和标记', () => {
  it('转写依次接起来，数字侧的不算', () => {
    const c = convOf([
      fm('a', { hasSpeech: true, transcript: '这里是 BG0CG', meaningless: false }),
      bm('b'),
      fm('c', { hasSpeech: true, transcript: '收到', meaningless: false }),
    ])
    expect(transcriptText(c)).toBe('这里是 BG0CG / 收到')
  })

  it('标记按出现的先后数个数', () => {
    const c = convOf([
      fm('a', { hasSpeech: false, meaningless: true }),
      fm('b'),
      fm('c', { hasSpeech: false, meaningless: true }),
    ])
    expect(aiTagCounts(c, true)).toEqual([
      { tag: '无人声', n: 2, title: undefined },
      { tag: '识别中', n: 1, title: undefined },
    ])
    expect(aiTagCounts(c, false)).toEqual([])
  })
})

describe('标记的悬停', () => {
  it('无人声的原文、识别失败的原因，一段里几次的接起来', () => {
    const c = convOf([
      fm('a', { hasSpeech: false, transcript: '(字幕製作:貝爾)', meaningless: true }),
      fm('b', { hasSpeech: false, transcript: '谢谢观看', meaningless: true }),
      fm('c', { error: '超时', meaningless: false }),
    ])
    expect(aiTagCounts(c, true)).toEqual([
      { tag: '无人声', n: 2, title: '(字幕製作:貝爾) / 谢谢观看' },
      { tag: '识别失败', n: 1, title: '超时' },
    ])
  })
})

describe('aiLine', () => {
  it('列出 AI 填的字段，呼号除外，备注只写名字', () => {
    expect(aiLine({ call: 'BA1AA', qth: '深圳', rstRcvd: '57', note: '对方设备 UV-5R' }, ['call', 'qth', 'rstRcvd', 'note'])).toBe(
      'AI：QTH 深圳 · 收到 57 · 备注',
    )
  })

  it('只有呼号是 AI 填的就没有这一行', () => {
    expect(aiLine({ call: 'BA1AA' }, ['call'])).toBeUndefined()
  })
})

describe('reasonLine', () => {
  it('按原因数个数', () => {
    const c = convOf([
      fm('a', { hasSpeech: false, meaningless: true }),
      fm('b', { hasSpeech: false, meaningless: true }),
      fm('c', { hasSpeech: true, category: 'test', meaningless: true }),
      fm('d', { hasSpeech: true, category: 'noise', meaningless: true }),
    ])
    expect(reasonLine(c)).toBe('没有人声 2 · 测试 1 · 噪声 1')
  })

  it('全是人工判定就只写人工判定', () => {
    const c = convOf([fm('a', { meaningless: true, verdict: 'meaningless' })])
    expect(reasonLine(c)).toBe('人工判定')
  })

  it('人工判定和 AI 判定混在一起时分开数', () => {
    const c = convOf([fm('a', { meaningless: true, verdict: 'meaningless' }), fm('b', { hasSpeech: false, meaningless: true })])
    expect(reasonLine(c)).toBe('人工判定 1 · 没有人声 1')
  })
})
