import { App } from 'antd'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { missingFields } from '@core'
import type { Activity, Qso, QsoDraft } from '@core'
import { Preferences } from '../Preferences'
import { PlayerProvider } from '../PlayerProvider'
import { setViewportWidth } from '../testSetup'
import { StoreContext } from '../store'
import type { PendingRow, Store } from '../store'
import type { Conversation } from '../api'
import Listen from './Listen'

const conversations = vi.hoisted(() => vi.fn())
const radios = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, conversations, radios } }
})

class FakeAudio {
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

const draftOfActs = (activities: Activity[], draft: QsoDraft = {}): QsoDraft => ({
  call: activities.find((a) => !a.mine)?.callsign,
  startAt: activities[0]!.startAt,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'DMR',
  rstSent: '59',
  rstRcvd: '59',
  ...draft,
})

const row = (activities: Activity[], draft: QsoDraft = {}): PendingRow => {
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

/** 收听页里除待确认之外那四档共用的 Conversation 构造。 */
const conv = (activities: Activity[], over: Partial<Conversation> = {}): Conversation => ({
  id: activities[0]!.id,
  startAt: activities[0]!.startAt,
  endAt: activities[activities.length - 1]!.startAt + 4,
  channel: 'tg:46001',
  origin: 'brandmeister',
  status: 'unlogged',
  activities,
  draft: draftOfActs(activities),
  ...over,
})

const promote = vi.fn()
const ignore = vi.fn()
const ignoreMany = vi.fn()
const refresh = vi.fn()

const store = (pending: PendingRow[] = [], over: Partial<Store> = {}): Store => ({
  station: { myCallsign: 'BG0CG' },
  channels: [],
  pending,
  qsos: [],
  recordings: new Set<string>(),
  analogEnabled: false,
  brandmeisterEnabled: true,
  loading: false,
  error: undefined,
  promote,
  ignore,
  ignoreMany,
  addQso: vi.fn(),
  editQso: vi.fn(),
  removeQso: vi.fn(),
  importAdif: vi.fn(),
  refresh,
  ...over,
})

const tree = (s: Store, path = '/heard?tab=pending') => (
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
const button = (name: string, prefix = false) =>
  within(document.body).getByRole('button', {
    name: new RegExp(`^${name.split('').join('\\s*')}${prefix ? '' : '$'}`),
  })

const confirm = async () => userEvent.click(await screen.findByRole('button', { name: 'OK' }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('Audio', FakeAudio)
  promote.mockResolvedValue(undefined)
  ignore.mockResolvedValue(undefined)
  ignoreMany.mockResolvedValue({ ignored: 1, missing: [] })
  refresh.mockResolvedValue(undefined)
  conversations.mockResolvedValue({ items: [] })
  radios.mockResolvedValue({ analogEnabled: false, radios: [] })
})

afterEach(() => setViewportWidth(1280))

describe('默认档', () => {
  it('待确认有内容时，等加载完停在待确认；之后刷新不再改档', async () => {
    const { rerender } = render(tree(store([], { loading: true }), '/heard'))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()

    rerender(tree(store([row([act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' })])], { loading: false }), '/heard'))
    expect(await screen.findByRole('tab', { name: /待确认/, selected: true })).toBeInTheDocument()

    // 待确认清空之后刷新，已经落定的档不跟着改。
    rerender(tree(store([], { loading: false }), '/heard'))
    expect(screen.getByRole('tab', { name: /待确认/, selected: true })).toBeInTheDocument()
  })

  it('一条待确认都没有时，等加载完停在全部', async () => {
    const { rerender } = render(tree(store([], { loading: true }), '/heard'))
    rerender(tree(store([], { loading: false }), '/heard'))
    expect(await screen.findByRole('tab', { name: /全部/, selected: true })).toBeInTheDocument()
  })

  it('URL 里已经带了 tab 就直接用，不用等加载', () => {
    render(tree(store([], { loading: true }), '/heard?tab=ignored'))
    expect(screen.getByRole('tab', { name: /已忽略/, selected: true })).toBeInTheDocument()
  })
})

// 段 id 跟着最早那条走，段长了 id 不变。只传段 id 的话，后端结算的是点下去
// 那一刻的整段，包括人没看过的那几次。
describe('结算的是人看过的那几次', () => {
  const two = [act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' })]
  const grown = [...two, act('x9', 40, { callsign: 'BD7BBB' })]

  it('直接入库也带上这一段的 id 列表', async () => {
    render(tree(store([row(two)])))

    await userEvent.click(button('直接入库'))

    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0]![0]).toEqual(['m1', 'x1'])
  })

  it('抽屉开着时段长了，确认只结算打开时那几次', async () => {
    const { rerender } = render(tree(store([row(two)])))
    await userEvent.click(button('编辑'))
    await screen.findByDisplayValue('BA1AA')

    rerender(tree(store([row(grown)])))
    await userEvent.click(button('入库'))

    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0]![0]).toEqual(['m1', 'x1'])
  })

  // 和快速补录同一份联想：模拟侧的呼号只能靠人补，以前通联过的人要能点出来。
  it('确认抽屉里输呼号，从日志里联想', async () => {
    const logged = { id: 'q1', call: 'BD7KLO', startAt: T - 86400, qth: '深圳' } as Qso
    render(tree(store([row(two)], { qsos: [logged] })))
    await userEvent.click(button('编辑'))
    const call = await screen.findByDisplayValue('BA1AA')

    await userEvent.clear(call)
    await userEvent.type(call, 'BD7')

    expect(await screen.findByText('深圳')).toBeInTheDocument()
  })

  it('选中没人回的之后对方回了，批量忽略只带选中时那一次', async () => {
    const alone = [act('a1', 0, { mine: true })]
    const { rerender } = render(tree(store([row(alone)])))
    await userEvent.click(button('选中没人回的', true))

    rerender(tree(store([row([...alone, act('r1', 20, { callsign: 'BA1AA' })])])))
    await userEvent.click(button('忽略选中', true))
    await confirm()

    await waitFor(() => expect(ignoreMany).toHaveBeenCalledOnce())
    expect(ignoreMany.mock.calls[0]![0]).toEqual([{ id: 'a1', activityIds: ['a1'] }])
  })
})

describe('手机上只挑一段里的几次', () => {
  const merged = [
    act('m1', 0, { mine: true }),
    act('x1', 10, { callsign: 'BA1AA' }),
    act('m2', 60, { mine: true }),
    act('x2', 70, { callsign: 'BD7BBB' }),
  ]

  const openActs = async () => {
    setViewportWidth(375)
    const view = render(tree(store([row(merged)])))
    await userEvent.click(screen.getByText(/逐次发射/))
    return view
  }

  const untick = async (...ids: string[]) => {
    const boxes = screen.getAllByRole('checkbox')
    for (const id of ids) {
      await userEvent.click(boxes[1 + merged.findIndex((a) => a.id === id)]!)
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
    const [ids, draft] = promote.mock.calls[0]!
    expect(draft).toMatchObject({ call: 'BD7BBB', startAt: T + 60 })
    expect(ids).toEqual(['m2', 'x2'])
  })

  it('一次都没挑时，确认、入库和忽略都点不了', async () => {
    await openActs()
    await untick('m1', 'x1', 'm2', 'x2')

    expect(screen.getByText(/一次都没挑/)).toBeInTheDocument()
    expect(button('编辑')).toBeDisabled()
    expect(button('直接入库')).toBeDisabled()
    expect(button('忽略')).toBeDisabled()
  })
})

describe('一段里的发射很多时', () => {
  const many = Array.from({ length: 45 }, (_, i) =>
    act(`b${i}`, i * 5, i % 2 === 0 ? { mine: true, callsign: 'BG0CG' } : { callsign: 'BA1AA' }),
  )

  it('桌面上展开后分页，每页 20 次', async () => {
    const { container } = render(tree(store([row(many)])))
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
    const { container } = render(tree(store([row(many)])))
    const boxes = () => container.querySelectorAll('input[type="checkbox"]').length
    await userEvent.click(screen.getByText(/逐次发射/))

    expect(boxes()).toBe(1 + 20)
    await userEvent.click(screen.getByText(/再显示 20 次/))
    expect(boxes()).toBe(1 + 40)
  })

  it('桌面上也能在展开的表里取消几次，直接入库只带剩下的', async () => {
    const two = [act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' }), act('x2', 20, { callsign: 'BA1AA' })]
    const { container } = render(tree(store([row(two)])))
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
    expect(promote.mock.calls[0]![0]).toEqual(['m1', 'x1'])
  })
})

describe('五档切换', () => {
  it('五个都在，待确认和未入库带徽标，切换刷新对应视图', async () => {
    conversations.mockResolvedValue({ items: [] })
    render(tree(store([row([act('m1', 0, { mine: true })])])))

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining('待确认'),
      expect.stringContaining('未入库'),
      '全部',
      '已入库',
      '已忽略',
    ])

    await userEvent.click(screen.getByRole('tab', { name: /全部/ }))
    await waitFor(() => expect(conversations).toHaveBeenCalled())
    expect(screen.getByRole('tab', { name: /全部/, selected: true })).toBeInTheDocument()
  })

  it('未入库的徽标数来自 view=unlogged 的加载条数', async () => {
    conversations.mockImplementation((p: { view?: string }) =>
      Promise.resolve(p.view === 'unlogged' ? { items: [conv([act('u1', 0)]), conv([act('u2', 1)])] } : { items: [] }),
    )
    render(tree(store([])))

    const tabs = await screen.findAllByRole('tab')
    const unlogged = tabs.find((t) => t.textContent?.includes('未入库'))!
    expect(within(unlogged).getByText('2')).toBeInTheDocument()
  })
})

describe('未入库', () => {
  const u1 = conv([act('u1', 0, { mine: true }), act('u2', 10, { callsign: 'BA1AA' })])
  const u2 = conv([act('u3', 100, { mine: true })], { status: 'overheard' })

  it('直接入库、忽略跟待确认一样能用，批量条也在', async () => {
    conversations.mockResolvedValue({ items: [u1, u2] })
    render(tree(store([]), '/heard?tab=unlogged'))

    // u1、u2 两段都是待处理的，都有「直接入库」按钮，得按呼号定位到 u1 那一行。
    const row = (await screen.findByText('BA1AA')).closest('tr')!
    expect(screen.getByText('选中没人回的（1）')).toBeInTheDocument()

    await userEvent.click(within(row).getByRole('button', { name: '直接入库' }))
    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0]![0]).toEqual(['u1', 'u2'])
  })

  it('忙锁一直到重拉当前视图完成才解开', async () => {
    conversations.mockResolvedValueOnce({ items: [u1] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')

    let resolveRefetch: (v: unknown) => void = () => undefined
    conversations.mockImplementationOnce(() => new Promise((r) => (resolveRefetch = r)))

    const btn = button('直接入库')
    await userEvent.click(btn)

    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    await new Promise((r) => setTimeout(r, 10))
    // promote 已经回来了，但重拉未入库这一页还没回来，按钮还在锁着。加载态的
    // 图标带着自己的 aria-label，重新按名字查这个按钮会连着「loading」一起
    // 对不上，所以复用点击前拿到的那个节点。
    expect(btn).toHaveClass('ant-btn-loading')

    // 重拉回来还是这一段（没被入库掉），按钮原地解锁，不是被摘掉那种消失。
    resolveRefetch({ items: [u1] })
    await waitFor(() => expect(btn).not.toHaveClass('ant-btn-loading'))
  })
})

describe('按天看', () => {
  it('全部不筛 status，日期导航、来源、信道换挡都重新拉一次', async () => {
    // 模拟守听开着才有「缺省模拟」这回事，关着的默认档在另一组测试里。
    render(tree(store([], { analogEnabled: true }), '/heard?tab=all&day=2026-09-20'))

    await waitFor(() =>
      expect(conversations).toHaveBeenCalledWith(
        expect.objectContaining({ status: undefined, origin: 'sdr-fm' }),
      ),
    )

    conversations.mockClear()
    await userEvent.click(screen.getByText('数字'))
    await waitFor(() =>
      expect(conversations).toHaveBeenCalledWith(expect.objectContaining({ origin: 'brandmeister' })),
    )
  })

  it('已入库档只筛 logged', async () => {
    render(tree(store([]), '/heard?tab=logged&day=2026-09-20'))
    await waitFor(() =>
      expect(conversations).toHaveBeenCalledWith(expect.objectContaining({ status: 'logged' })),
    )
  })

  it('已入库的行链到 /log?q=', async () => {
    const logged = conv([act('l1', 0, { mine: true, callsign: 'BA1AA' })], {
      status: 'logged',
      draft: undefined,
      qso: { id: 'q1', call: 'BA1AA', rstSent: '59', rstRcvd: '59' },
    })
    conversations.mockResolvedValue({ items: [logged] })
    render(tree(store([]), '/heard?tab=logged&day=2026-09-20'))

    const link = await screen.findByRole('link', { name: /BA1AA/ })
    expect(link).toHaveAttribute('href', '/log?q=BA1AA')
  })
})

describe('搜索', () => {
  it('两个字以上，去抖之后按呼号查，代替当前视图', async () => {
    conversations.mockResolvedValue({ items: [] })
    render(tree(store([]), '/heard?tab=all&day=2026-09-20'))
    await waitFor(() => expect(conversations).toHaveBeenCalled())
    conversations.mockClear()

    conversations.mockResolvedValue({ items: [conv([act('s1', 0, { callsign: 'BA1AA' })])] })
    await userEvent.type(screen.getByPlaceholderText(/搜呼号/), 'BA')

    await waitFor(() => expect(conversations).toHaveBeenCalledWith(expect.objectContaining({ q: 'BA' })), {
      timeout: 1000,
    })
    // 顶部面板也会把搜索结果里最新一条的呼号显示一遍，跟列表那行重了名字，
    // 两处都出现才说明搜索结果真的代替了列表。
    expect(await screen.findAllByText('BA1AA')).toHaveLength(2)
  })
})

describe('模拟守听关着', () => {
  it('直播条写模拟守听关着，不去拉 /api/radios', async () => {
    render(tree(store([], { analogEnabled: false })))
    expect(await screen.findByText('模拟守听关着')).toBeInTheDocument()
    expect(radios).not.toHaveBeenCalled()
  })
})
