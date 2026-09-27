import { App } from 'antd'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { missingFields } from '@core'
import type { Activity, QsoDraft } from '@core'
import { Preferences } from '../Preferences'
import { setViewportWidth } from '../testSetup'
import { StoreContext } from '../store'
import type { PendingRow, Store } from '../store'
import PendingQueue from './PendingQueue'

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

const row = (activities: Activity[], draft: QsoDraft = {}): PendingRow => {
  const full: QsoDraft = {
    call: activities.find((a) => !a.mine)?.callsign,
    startAt: activities[0].startAt,
    freqMhz: 439.525,
    band: '70cm',
    mode: 'DMR',
    rstSent: '59',
    rstRcvd: '59',
    ...draft,
  }
  return {
    cluster: {
      id: activities[0].id,
      startAt: activities[0].startAt,
      endAt: activities[activities.length - 1].startAt + 4,
      activities,
    },
    draft: full,
    missing: missingFields(full),
  }
}

const promote = vi.fn()
const ignore = vi.fn()
const ignoreMany = vi.fn()

const store = (pending: PendingRow[]): Store => ({
  station: {},
  channels: [],
  pending,
  qsos: [],
  recordings: new Set<string>(),
  loading: false,
  error: undefined,
  promote,
  ignore,
  ignoreMany,
  addQso: vi.fn(),
  editQso: vi.fn(),
  removeQso: vi.fn(),
  importAdif: vi.fn(),
  refresh: vi.fn(),
})

const tree = (pending: PendingRow[]) => (
  <Preferences>
    <App>
      <StoreContext value={store(pending)}>
        <PendingQueue />
      </StoreContext>
    </App>
  </Preferences>
)

/** 按钮名要整个对上，「忽略」不能对上「忽略选中（1）」。带计数的那几个传 prefix。 */
const button = (name: string, prefix = false) =>
  within(document.body).getByRole('button', {
    name: new RegExp(`^${name.split('').join('\\s*')}${prefix ? '' : '$'}`),
  })

/** 气泡确认框的「确定」。测试里没有中文语言包，是 OK。 */
const confirm = async () => userEvent.click(await screen.findByRole('button', { name: 'OK' }))

beforeEach(() => {
  vi.clearAllMocks()
  promote.mockResolvedValue(undefined)
  ignore.mockResolvedValue(undefined)
  ignoreMany.mockResolvedValue({ ignored: 1, missing: [] })
})

afterEach(() => setViewportWidth(1280))

// 段 id 跟着最早那条走，段长了 id 不变。只传段 id 的话，后端结算的是点下去
// 那一刻的整段，包括人没看过的那几次。
describe('结算的是人看过的那几次', () => {
  const two = [act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' })]
  const grown = [...two, act('x9', 40, { callsign: 'BD7BBB' })]

  it('直接入库也带上这一段的 id 列表', async () => {
    render(tree([row(two)]))

    await userEvent.click(button('直接入库'))

    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0][2]).toEqual(['m1', 'x1'])
  })

  it('抽屉开着时段长了，确认只结算打开时那几次', async () => {
    const { rerender } = render(tree([row(two)]))
    await userEvent.click(button('编辑'))
    await screen.findByDisplayValue('BA1AA')

    rerender(tree([row(grown)]))
    await userEvent.click(button('入库'))

    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0][0]).toBe('m1')
    expect(promote.mock.calls[0][2]).toEqual(['m1', 'x1'])
  })

  it('选中没人回的之后对方回了，批量忽略只带选中时那一次', async () => {
    const alone = [act('a1', 0, { mine: true })]
    const { rerender } = render(tree([row(alone)]))
    await userEvent.click(button('选中没人回的', true))

    rerender(tree([row([...alone, act('r1', 20, { callsign: 'BA1AA' })])]))
    await userEvent.click(button('忽略选中', true))
    await confirm()

    await waitFor(() => expect(ignoreMany).toHaveBeenCalledOnce())
    expect(ignoreMany.mock.calls[0][0]).toEqual([{ clusterId: 'a1', activityIds: ['a1'] }])
  })
})

describe('手机上只挑一段里的几次', () => {
  // 两段对话被并成一段：本台和 BA1AA，接着本台和 BD7BBB。
  const merged = [
    act('m1', 0, { mine: true }),
    act('x1', 10, { callsign: 'BA1AA' }),
    act('m2', 60, { mine: true }),
    act('x2', 70, { callsign: 'BD7BBB' }),
  ]

  const openActs = async () => {
    setViewportWidth(375)
    const view = render(tree([row(merged)]))
    await userEvent.click(screen.getByText(/逐次发射/))
    return view
  }

  const untick = async (...ids: string[]) => {
    const boxes = screen.getAllByRole('checkbox')
    // 第一个是卡片左上角那个批量选中框，后面按发射的顺序。
    for (const id of ids) {
      await userEvent.click(boxes[1 + merged.findIndex((a) => a.id === id)])
    }
  }

  it('卡片上的忽略只忽略挑中的那几次', async () => {
    await openActs()
    await untick('m2', 'x2')

    await userEvent.click(button('忽略'))
    await confirm()

    await waitFor(() => expect(ignore).toHaveBeenCalledOnce())
    expect(ignore.mock.calls[0]).toEqual(['m1', ['m1', 'x1']])
  })

  it('挑出后一段时，呼号和开始时间按后一段算', async () => {
    await openActs()
    await untick('m1', 'x1')

    expect(document.querySelector('.pending-card-call')).toHaveTextContent('BD7BBB')
    await userEvent.click(button('直接入库'))

    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    const [, draft, ids] = promote.mock.calls[0]
    expect(draft).toMatchObject({ call: 'BD7BBB', startAt: T + 60 })
    expect(ids).toEqual(['m2', 'x2'])
  })

  // 一次都没挑时，后端会把空列表拒掉。按钮先灰掉，别让人点了才知道。
  it('一次都没挑时，确认、入库和忽略都点不了', async () => {
    await openActs()
    await untick('m1', 'x1', 'm2', 'x2')

    expect(screen.getByText(/一次都没挑/)).toBeInTheDocument()
    expect(button('编辑')).toBeDisabled()
    expect(button('直接入库')).toBeDisabled()
    expect(button('忽略')).toBeDisabled()
  })
})

// 热闹的话务组一段能有几百次发射，一口气全列出来没法看。
describe('一段里的发射很多时', () => {
  const many = Array.from({ length: 45 }, (_, i) =>
    act(`b${i}`, i * 5, i % 2 === 0 ? { mine: true, callsign: 'BG0CG' } : { callsign: 'BA1AA' }),
  )

  it('桌面上展开后分页，每页 20 次', async () => {
    const { container } = render(tree([row(many)]))
    await userEvent.click(container.querySelector('.ant-table-row-expand-icon')!)

    const inner = await waitFor(() => {
      const t = container.querySelectorAll('.ant-table-expanded-row .ant-table-tbody tr.ant-table-row')
      expect(t.length).toBe(20)
      return t
    })
    expect(inner.length).toBe(20)
    expect(container.querySelector('.ant-table-expanded-row .ant-pagination')).not.toBeNull()
  })

  it('手机上先列 20 次，按一下再多 20 次', async () => {
    setViewportWidth(375)
    render(tree([row(many)]))
    await userEvent.click(screen.getByText(/逐次发射/))

    expect(screen.getAllByRole('checkbox').length).toBe(1 + 20)
    await userEvent.click(screen.getByRole('button', { name: /再显示 20 次/ }))
    expect(screen.getAllByRole('checkbox').length).toBe(1 + 40)
  })

  // 聚类猜错时，桌面上也要能把不属于这次通联的那几次拿掉。
  it('桌面上也能在展开的表里取消几次，直接入库只带剩下的', async () => {
    const two = [act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' }), act('x2', 20, { callsign: 'BA1AA' })]
    const { container } = render(tree([row(two)]))
    await userEvent.click(container.querySelector('.ant-table-row-expand-icon')!)

    const boxes = await waitFor(() => {
      const b = container.querySelectorAll('.ant-table-expanded-row .ant-table-tbody .ant-checkbox-input')
      expect(b.length).toBe(3)
      return b
    })
    await userEvent.click(boxes[2] as HTMLElement)

    expect(await screen.findByText('挑中 2 / 3 次')).toBeInTheDocument()
    await userEvent.click(button('直接入库'))
    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0][2]).toEqual(['m1', 'x1'])
  })
})

