import { describe, expect, it } from 'vitest'
import { draftWithAi } from '@core'
import type { Activity, PendingItem, QsoDraft } from '@core'
import type { HeardItem } from './api'
import { draftFor, draftForWithAi, fromPending } from './subset'

const T = 1_789_000_000

const act = (id: string, at: number, over: Partial<Activity> = {}): Activity => ({
  id,
  origin: 'brandmeister',
  startAt: T + at,
  durationS: 4,
  mine: false,
  talkgroup: 46001,
  ...over,
})

const draft: QsoDraft = { call: 'BA1AA', startAt: T, freqMhz: 439.525, band: '70cm', mode: 'DMR' }

describe('draftFor', () => {
  it('全选或一个都没选时照抄整段的草稿', () => {
    const acts = [act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' })]
    expect(draftFor(acts, draft, ['m1', 'x1'])).toBe(draft)
    expect(draftFor(acts, draft, [])).toBe(draft)
  })

  it('挑出后一段时，开始时间和呼号按挑中的那几次重算', () => {
    const acts = [
      act('m1', 0, { mine: true }),
      act('x1', 10, { callsign: 'BA1AA' }),
      act('m2', 60, { mine: true }),
      act('x2', 70, { callsign: 'BD7BBB' }),
    ]
    const d = draftFor(acts, draft, ['m2', 'x2'])
    expect(d).toMatchObject({ call: 'BD7BBB', startAt: T + 60 })
  })

  it('挑中的那几次里没人回，呼号留空不拿整段的去顶', () => {
    const acts = [act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' })]
    const d = draftFor(acts, draft, ['m1'])
    expect(d.call).toBeUndefined()
  })
})

// 两段对话被并成一段：前一段是 BA1AA（深圳），后一段是 BD7BBB（广州）。
const fmAct = (id: string, at: number, over: Partial<HeardItem>): HeardItem => ({
  id,
  origin: 'sdr-fm',
  startAt: T + at,
  durationS: 4,
  mine: false,
  channel: '438.500 中继',
  ...over,
})
const merged: HeardItem[] = [
  fmAct('m1', 0, { mine: true, ai: { meaningless: false, fields: { calledCall: 'BA1AA', rst: '55' } } }),
  fmAct('x1', 10, { ai: { meaningless: false, fields: { call: 'BA1AA', qth: '深圳', rst: '57', device: 'UV-5R' } } }),
  fmAct('m2', 60, { mine: true, ai: { meaningless: false, fields: { calledCall: 'BD7BBB' } } }),
  fmAct('x2', 70, { ai: { meaningless: false, fields: { call: 'BD7BBB', qth: '广州' } } }),
]
const whole = draftWithAi(
  { id: 'm1', startAt: T, endAt: T + 74, activities: merged },
  { myCallsign: 'BG0CG' },
)

describe('draftForWithAi 挑子集时重算 AI 填的字段', () => {
  it('整段的草稿是后一个人的：呼号取最晚的一方，QTH 取最晚说的', () => {
    expect(whole.draft).toMatchObject({ call: 'BD7BBB', qth: '广州', rstRcvd: '57', rstSent: '55' })
    expect(whole.aiFilled).toEqual(['call', 'qth', 'rstRcvd', 'rstSent', 'note'])
  })

  it('挑前一段：先把 AI 填的还原再重算，不留后一个人的 QTH', () => {
    const r = draftForWithAi(merged, whole.draft, ['m1', 'x1'], whole.aiFilled, 'BG0CG')
    expect(r.draft).toMatchObject({ call: 'BA1AA', qth: '深圳', rstRcvd: '57', rstSent: '55', note: '对方设备 UV-5R', startAt: T })
    expect(r.aiFilled).toEqual(['call', 'qth', 'rstRcvd', 'rstSent', 'note'])
  })

  it('挑后一段：前一段的报告和备注退回缺省，aiFilled 只剩真有的', () => {
    const r = draftForWithAi(merged, whole.draft, ['m2', 'x2'], whole.aiFilled, 'BG0CG')
    expect(r.draft).toMatchObject({ call: 'BD7BBB', qth: '广州', rstRcvd: '59', rstSent: '59', startAt: T + 60 })
    expect(r.draft.note).toBeUndefined()
    expect(r.aiFilled).toEqual(['call', 'qth'])
  })

  it('本台说的呼号也算：只挑本台那一次，叫的是谁就是谁', () => {
    const r = draftForWithAi(merged, whole.draft, ['m2'], whole.aiFilled, 'BG0CG')
    expect(r.draft.call).toBe('BD7BBB')
    expect(r.draft.qth).toBeUndefined()
  })

  it('挑中的几次里没有任何呼号，留空，不拿整段的 AI 呼号去顶', () => {
    const acts = [...merged, fmAct('m3', 120, { mine: true })]
    const r = draftForWithAi(acts, whole.draft, ['m3'], whole.aiFilled, 'BG0CG')
    expect(r.draft.call).toBeUndefined()
    expect(r.aiFilled).toEqual([])
  })

  it('发射行自己带的呼号比 AI 的优先，也不标成 AI 填的', () => {
    const acts = [merged[0]!, fmAct('x9', 20, { callsign: 'BD7XYZ', ai: { meaningless: false, fields: { call: 'BA1AA' } } })]
    const r = draftForWithAi(acts, { call: 'BA1AA' }, ['x9'], ['call'], 'BG0CG')
    expect(r.draft.call).toBe('BD7XYZ')
    expect(r.aiFilled).toEqual([])
  })

  it('全选或一个都没选时原样返回，连 aiFilled 也是传进来的那一份', () => {
    const all = merged.map((a) => a.id)
    expect(draftForWithAi(merged, whole.draft, all, whole.aiFilled, 'BG0CG')).toEqual({ draft: whole.draft, aiFilled: whole.aiFilled })
    expect(draftFor(merged, whole.draft, [], whole.aiFilled, 'BG0CG')).toBe(whole.draft)
  })
})

describe('fromPending', () => {
  it('带上 aiFilled，待确认永远不是无意义', () => {
    const acts = [act('m1', 0, { mine: true })]
    const item: PendingItem = {
      cluster: { id: 'm1', startAt: acts[0].startAt, endAt: acts[0].startAt + 4, activities: acts },
      draft,
      aiFilled: ['qth'],
    }
    expect(fromPending(item)).toMatchObject({ aiFilled: ['qth'], meaningless: false })
  })

  it('映射成 Conversation：状态待确认，信道和来源取第一条', () => {
    const acts = [act('m1', 0, { mine: true, talkgroup: 46001 }), act('x1', 10, { callsign: 'BA1AA' })]
    const item: PendingItem = {
      cluster: { id: 'm1', startAt: acts[0].startAt, endAt: acts[1].startAt + 4, activities: acts },
      draft,
    }
    expect(fromPending(item)).toEqual({
      id: 'm1',
      startAt: acts[0].startAt,
      endAt: acts[1].startAt + 4,
      channel: 'tg:46001',
      origin: 'brandmeister',
      status: 'pending',
      activities: acts,
      draft,
      meaningless: false,
    })
  })

  it('信道按 channelKey 的口径：没有话务组时落到信道名', () => {
    const acts = [act('m1', 0, { mine: true, talkgroup: undefined, channel: '438.500 中继', origin: 'sdr-fm' })]
    const item: PendingItem = {
      cluster: { id: 'm1', startAt: acts[0].startAt, endAt: acts[0].startAt + 4, activities: acts },
      draft,
    }
    expect(fromPending(item).channel).toBe('ch:438.500 中继')
  })
})
