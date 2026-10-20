// 收听页几份测试共用的构造：发射、对话、store 和渲染。
// vi.mock('../api') 要在各个测试文件里自己写（hoist 只认本文件），这里只放纯构造。
import { App } from 'antd'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { missingFields } from '@core'
import type { Activity, QsoDraft } from '@core'
import { Preferences } from '../Preferences'
import { PlayerProvider } from '../PlayerProvider'
import { StoreContext } from '../store'
import type { PendingRow, Store } from '../store'
import type { Conversation, HeardItem } from '../api'
import Listen from './Listen'

export class FakeAudio {
  src = ''
  currentTime = 0
  duration = NaN
  paused = true
  addEventListener() {}
  removeEventListener() {}
  play() {
    this.paused = false
  }
  pause() {
    this.paused = true
  }
  load() {}
  removeAttribute() {
    this.src = ''
  }
}

export const T = 1_789_000_000

export const act = (id: string, at: number, over: Partial<HeardItem> = {}): HeardItem => ({
  id,
  origin: 'brandmeister',
  startAt: T + at,
  durationS: 4,
  mine: false,
  talkgroup: 46001,
  ...over,
})

/** 模拟侧的发射：没有话务组，信道名在 channel 上。 */
export const fm = (id: string, at: number, over: Partial<HeardItem> = {}): HeardItem =>
  act(id, at, { origin: 'sdr-fm', talkgroup: undefined, channel: '438.500 中继', ...over })

export const draftOfActs = (activities: Activity[], draft: QsoDraft = {}): QsoDraft => ({
  call: activities.find((a) => !a.mine)?.callsign,
  startAt: activities[0]!.startAt,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'DMR',
  rstSent: '59',
  rstRcvd: '59',
  ...draft,
})

export const row = (activities: Activity[], draft: QsoDraft = {}): PendingRow => {
  const full = draftOfActs(activities, draft)
  return {
    cluster: {
      id: activities[0]!.id,
      startAt: activities[0]!.startAt,
      endAt: activities[activities.length - 1]!.startAt + 4,
      activities,
    },
    draft: full,
    missing: missingFields(full),
  }
}

/** 收听页里除待确认之外那几档共用的 Conversation 构造。 */
export const conv = (activities: HeardItem[], over: Partial<Conversation> = {}): Conversation => ({
  id: activities[0]!.id,
  startAt: activities[0]!.startAt,
  endAt: activities[activities.length - 1]!.startAt + 4,
  channel: 'tg:46001',
  origin: 'brandmeister',
  status: 'unlogged',
  activities,
  draft: draftOfActs(activities),
  meaningless: false,
  ...over,
})

/** store 里会打到后端的那几个。每个测试文件共用这一组，beforeEach 里重置。 */
export const mocks = {
  promote: vi.fn(),
  ignore: vi.fn(),
  ignoreMany: vi.fn(),
  deleteConversations: vi.fn(),
  setVerdict: vi.fn(),
  refresh: vi.fn(),
}

export const resetMocks = () => {
  mocks.promote.mockResolvedValue(undefined)
  mocks.ignore.mockResolvedValue(undefined)
  mocks.ignoreMany.mockResolvedValue({ ignored: 1, missing: [] })
  mocks.deleteConversations.mockResolvedValue({ deleted: 1, missing: [] })
  mocks.setVerdict.mockResolvedValue(undefined)
  mocks.refresh.mockResolvedValue(undefined)
}

export const store = (pending: PendingRow[] = [], over: Partial<Store> = {}): Store => ({
  station: { myCallsign: 'BG0CG' },
  channels: [],
  pending,
  qsos: [],
  recordings: new Set<string>(),
  analogEnabled: false,
  brandmeisterEnabled: true,
  aiEnabled: false,
  map: { provider: 'none' },
  loading: false,
  error: undefined,
  promote: mocks.promote,
  ignore: mocks.ignore,
  ignoreMany: mocks.ignoreMany,
  deleteConversations: mocks.deleteConversations,
  setVerdict: mocks.setVerdict,
  addQso: vi.fn(),
  editQso: vi.fn(),
  removeQso: vi.fn(),
  importAdif: vi.fn(),
  refresh: mocks.refresh,
  ...over,
})

export const tree = (s: Store, path = '/heard?tab=pending') => (
  <MemoryRouter initialEntries={[path]}>
    <Preferences>
      <App>
        <StoreContext value={s}>
          <PlayerProvider>
            <Listen />
          </PlayerProvider>
        </StoreContext>
      </App>
    </Preferences>
  </MemoryRouter>
)

/** 按钮名要整个对上，「忽略」不能对上「忽略选中（1）」。带计数的那几个传 prefix。 */
export const button = (name: string, prefix = false) =>
  within(document.body).getByRole('button', {
    name: new RegExp(`^${name.split('').join('\\s*')}${prefix ? '' : '$'}`),
  })

export const confirm = async () => userEvent.click(await screen.findByRole('button', { name: 'OK' }))

/**
 * 立刻触发一次后台轮询（hook 在标签页切回可见时也拉一次，借它省掉 15 秒的等待）。
 * useQuiet 看的是 Date.now()，要装作「人已经几秒没碰过了」就 vi.setSystemTime 往后拨。
 */
export const poll = () => document.dispatchEvent(new Event('visibilitychange'))
