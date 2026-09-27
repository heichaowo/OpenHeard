import { describe, expect, it } from 'vitest'
import type { Activity, PendingItem, QsoDraft } from '@core'
import { draftFor, fromPending } from './subset'

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

describe('fromPending', () => {
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
