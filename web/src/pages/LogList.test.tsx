import { App } from 'antd'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Qso } from '@core'
import { Preferences } from '../Preferences'
import { setViewportWidth } from '../testSetup'
import { StoreContext } from '../store'
import type { Store } from '../store'
import { ZONE_KEY } from '../theme'
import LogList from './LogList'

const qsoHistory = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, qsoHistory } }
})

const qso = (over: Partial<Qso> = {}): Qso => ({
  id: 'q1',
  call: 'BD7KLO',
  startAt: 1_789_000_000,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: 1_789_000_000,
  ...over,
})

const editQso = vi.fn()
const removeQso = vi.fn()

const store = (qsos: Qso[]): Store => ({
  station: {},
  channels: [],
  pending: [],
  qsos,
  recordings: new Set<string>(),
  loading: false,
  error: undefined,
  promote: vi.fn(),
  ignore: vi.fn(),
  ignoreMany: vi.fn(),
  addQso: vi.fn(),
  editQso,
  removeQso,
  importAdif: vi.fn(),
  refresh: vi.fn(),
})

const mount = (qsos: Qso[] = [qso()], zone?: string) => {
  if (zone) localStorage.setItem(ZONE_KEY, zone)
  else localStorage.removeItem(ZONE_KEY)
  return render(
    <Preferences>
      <App>
        <StoreContext value={store(qsos)}>
          <LogList />
        </StoreContext>
      </App>
    </Preferences>,
  )
}

const button = (name: string) =>
  screen.getByRole('button', { name: new RegExp(name.split('').join('\\s*')) })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

// 记录是 Unix 秒 UTC，显示按选定的时区。同一行在两个时区里是两串字。
// 手机上是一条一张卡，不是那张要横滚的表。这一页在楼下是拿手机看的。
describe('LogList 在手机上', () => {
  it('窄屏出卡片，不出表格，编辑和删除都在一屏里', () => {
    setViewportWidth(375)
    try {
      mount([qso({ qth: '深圳' })])
      // 表头不该出现
      expect(screen.queryAllByText('时间 UTC')).toHaveLength(0)
      expect(screen.getByText('BD7KLO')).toBeInTheDocument()
      expect(button('编辑')).toBeInTheDocument()
      expect(button('删除')).toBeInTheDocument()
    } finally {
      setViewportWidth(1280)
    }
  })
})

describe('LogList 的时间显示', () => {
  // antd 的 Table 会把表头渲染两处（量宽度那一行和真正那一行），所以按数量断言。
  const seen = (text: string) => screen.getAllByText(text).length > 0

  it('缺省 UTC，表头写明时区', () => {
    mount()
    expect(seen('时间 UTC')).toBe(true)
    expect(seen('2026-09-10 00:26:40')).toBe(true)
  })

  it('选了成都就按成都显示，表头跟着改', () => {
    mount([qso()], 'Asia/Shanghai')
    expect(seen('时间 Asia/Shanghai UTC+08:00')).toBe(true)
    expect(seen('2026-09-10 08:26:40')).toBe(true)
  })
})

describe('LogList 的编辑抽屉', () => {
  it('打开时填的是这一行的值', async () => {
    mount([qso({ qth: '深圳' })])
    await userEvent.click(button('编辑'))

    expect(await screen.findByDisplayValue('BD7KLO')).toBeInTheDocument()
    expect(screen.getByLabelText('对方 QTH')).toHaveValue('深圳')
  })

  it('改完保存，把整份发回去', async () => {
    editQso.mockResolvedValue(undefined)
    mount()
    await userEvent.click(button('编辑'))
    await screen.findByDisplayValue('BD7KLO')

    await userEvent.type(screen.getByLabelText('对方 QTH'), '深圳')
    await userEvent.click(button('保存'))

    await waitFor(() => expect(editQso).toHaveBeenCalledOnce())
    expect(editQso.mock.calls[0][0]).toBe('q1')
    expect(editQso.mock.calls[0][1]).toMatchObject({ call: 'BD7KLO', qth: '深圳' })
  })

  // 没动过就直接关，别为了预填的内容拦一道。
  it('没改过就直接关掉', async () => {
    mount()
    await userEvent.click(button('编辑'))
    await screen.findByDisplayValue('BD7KLO')

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryAllByText('丢掉刚改的内容？')).toHaveLength(0))
    expect(editQso).not.toHaveBeenCalled()
  })

  it('改过再关就先问一句', async () => {
    mount()
    await userEvent.click(button('编辑'))
    await screen.findByDisplayValue('BD7KLO')
    await userEvent.type(screen.getByLabelText('对方 QTH'), '深圳')

    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    // antd 的 Modal 把标题渲染两处，所以按数量断言。
    expect((await screen.findAllByText('丢掉刚改的内容？')).length).toBeGreaterThan(0)
  })
})

describe('LogList 的改动记录', () => {
  // 展开过一次就缓存了。改完不重拉的话，再展开看到的还是改之前的次数。
  it('改完之后重拉那一行的改动记录', async () => {
    qsoHistory.mockResolvedValue([])
    editQso.mockResolvedValue(undefined)
    const { container } = mount()

    await userEvent.click(container.querySelector('.ant-table-row-expand-icon')!)
    await waitFor(() => expect(qsoHistory).toHaveBeenCalledTimes(1))

    const change = { at: 1_789_000_100, action: 'edit', before: { ...qso(), call: 'BD7KLO' } }
    qsoHistory.mockResolvedValue([change])
    await userEvent.click(button('编辑'))
    await screen.findByDisplayValue('BD7KLO')
    await userEvent.type(screen.getByLabelText('对方 QTH'), '深圳')
    await userEvent.click(button('保存'))

    await waitFor(() => expect(qsoHistory).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/改过 1 次/)).toBeInTheDocument()
  })
})
