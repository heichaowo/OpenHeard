import { App } from 'antd'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Qso } from '@core'
import type { Ops, Radio } from '../api'
import { Preferences } from '../Preferences'
import { setViewportWidth } from '../testSetup'
import { StoreContext } from '../store'
import type { Store } from '../store'
import { UTC, dayStartIn } from '../time'
import OpsPage from './OpsPage'

const ops = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, ops } }
})

const now = 1_789_000_000
const radio = (over: Partial<Radio>): Radio => ({
  freqMhz: 438.5,
  channel: '438.500 中继',
  gainDb: 49.6,
  idleDb: 102.6,
  openBelowDb: 90.6,
  closeAboveDb: 95.6,
  noiseDb: 102.1,
  open: false,
  at: now,
  ageS: 1,
  fresh: true,
  closestDb: 7.9,
  ...over,
})

const snapshot = (radios: Radio[]): Ops => ({
  health: { ok: true, problems: [], activityCount: 0, qsoCount: 0 },
  machine: { rssBytes: 1, uptimeS: 1, cores: 8, memFreeBytes: 1, memTotalBytes: 2, load1: 0.1 },
  recordings: { files: 0, bytes: 0 },
  radios,
  polls: [],
  activities: [],
  queries: [],
  clusterGapS: 120,
  activityRetentionDays: 90,
  pendingWindowDays: 7,
  now,
  analogEnabled: true,
  brandmeisterEnabled: true,
})

const qso = (id: string, startAt: number): Qso => ({
  id,
  call: 'BD7KLO',
  startAt,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: startAt,
})

const store = (qsos: Qso[]): Store => ({ qsos }) as unknown as Store

const mount = (qsos: Qso[] = []) =>
  render(
    <Preferences>
      <App>
        <StoreContext value={store(qsos)}>
          <OpsPage />
        </StoreContext>
      </App>
    </Preferences>,
  )

describe('OpsPage 的电台', () => {
  it('一支接收机守两个信道，各有一段，各说各的离门限多远', async () => {
    ops.mockResolvedValue(
      snapshot([
        radio({}),
        radio({ freqMhz: 438.975, channel: '438.975', open: true, noiseDb: 80.0, closestDb: -10.6 }),
      ]),
    )
    mount()

    expect(await screen.findByText('438.5 MHz（438.500 中继）')).toBeInTheDocument()
    expect(screen.getByText('438.975 MHz（438.975）')).toBeInTheDocument()
    expect(screen.getByText(/守 2 个信道/)).toBeInTheDocument()
    expect(screen.getByText('静噪开着，正在收')).toBeInTheDocument()
    expect(screen.getByText(/离开门限还差 11.5 dB/)).toBeInTheDocument()
  })

  it('没有守听时说清楚，不是一片空白', async () => {
    ops.mockResolvedValue(snapshot([]))
    mount()
    expect(await screen.findByText(/没有模拟守听/)).toBeInTheDocument()
  })
})

describe('OpsPage 的时间和采集记录', () => {
  afterEach(() => setViewportWidth(1280))

  // 3426 秒前要人自己除 60 才知道是多久。
  it('多久以前写成分钟和小时，不写原始秒数', async () => {
    ops.mockResolvedValue({
      ...snapshot([]),
      health: { ok: true, problems: [], activityCount: 1, qsoCount: 0, lastPollAt: now - 3426 },
    })
    mount()
    expect((await screen.findAllByText(/57 分钟前/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/3426 秒前/)).not.toBeInTheDocument()
  })

  // 手机上表格要横滚才看得到计数，自带的纵向滚动还会截住整页的滑动。
  it('手机上的采集记录一次一行，计数和结果都在屏幕上', async () => {
    setViewportWidth(375)
    ops.mockResolvedValue({
      ...snapshot([]),
      polls: [{ queryKey: 'src:4616460', at: now - 60, fetched: 200, parsed: 200, written: 3, ok: true, ms: 812 }],
    })
    const { container } = mount()
    expect(await screen.findByText('200 / 200 / 3')).toBeInTheDocument()
    expect(screen.getByText(/812 ms/)).toBeInTheDocument()
    expect(container.querySelector('.ant-table')).toBeNull()
  })
})

describe('OpsPage 的刷新按钮', () => {
  // 第一次拉完之后 loading 一直是假，按了刷新看不出有没有在拉。
  it('手动刷新时按钮转圈，拉完停下', async () => {
    ops.mockResolvedValueOnce(snapshot([]))
    mount()
    const button = await screen.findByRole('button', { name: /刷\s*新/ })
    await waitFor(() => expect(button).not.toHaveClass('ant-btn-loading'))

    let finish!: (o: Ops) => void
    ops.mockReturnValueOnce(new Promise<Ops>((r) => (finish = r)))
    await userEvent.click(button)
    expect(button).toHaveClass('ant-btn-loading')

    finish(snapshot([]))
    await waitFor(() => expect(button).not.toHaveClass('ant-btn-loading'))
  })
})

describe('OpsPage 的今天和最近 7 天', () => {
  // 按 startAt 数，不是 createdAt：导入的老通联不该让「今天」显得很热闹。
  it('今天和最近 7 天分开算，缺省时区是 UTC', async () => {
    const todayStart = dayStartIn(UTC)
    const last7Start = dayStartIn(UTC, 6)
    ops.mockResolvedValue(snapshot([]))
    mount([
      qso('a', todayStart + 10), // 今天，也算进最近 7 天
      qso('b', last7Start + 10), // 6 天前，只算最近 7 天
      qso('c', last7Start - 10), // 刚好在 7 天窗口之前，两边都不算
    ])

    const today = await screen.findByText(`今天 ${UTC}`)
    expect(today.closest('.ant-statistic')).toHaveTextContent('1')
    const last7 = screen.getByText(`最近 7 天 ${UTC}`)
    expect(last7.closest('.ant-statistic')).toHaveTextContent('2')
  })
})

describe('OpsPage 的备份', () => {
  it('下载链接指向 /api/backup，带一句说明', async () => {
    ops.mockResolvedValue(snapshot([]))
    mount()

    const link = await screen.findByRole('link', { name: '下载数据库备份' })
    expect(link).toHaveAttribute('href', '/api/backup')
    expect(screen.getByText(/不含录音文件/)).toBeInTheDocument()
  })
})

describe('OpsPage 的开关关着时', () => {
  it('模拟守听关着时说明白，不报接收机可能掉了', async () => {
    ops.mockResolvedValue({ ...snapshot([]), analogEnabled: false })
    mount()

    expect(await screen.findByText(/模拟守听关着/)).toBeInTheDocument()
    expect(screen.queryByText(/接收机可能掉了/)).not.toBeInTheDocument()
    expect(screen.queryByText(/没有模拟守听，或者守护进程还没报上来/)).not.toBeInTheDocument()
  })

  it('BrandMeister 关着时说明白，不当成健康问题', async () => {
    ops.mockResolvedValue({ ...snapshot([]), brandmeisterEnabled: false })
    mount()

    expect(await screen.findByText(/BrandMeister 查询关着/)).toBeInTheDocument()
  })
})
