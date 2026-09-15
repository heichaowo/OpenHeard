import { App } from 'antd'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Qso } from '@core'
import { StoreContext } from '../store'
import type { Store } from '../store'
import LogList from './LogList'

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
  loading: false,
  error: undefined,
  promote: vi.fn(),
  ignore: vi.fn(),
  addQso: vi.fn(),
  editQso,
  removeQso,
  refresh: vi.fn(),
})

const mount = (qsos: Qso[] = [qso()]) =>
  render(
    <App>
      <StoreContext value={store(qsos)}>
        <LogList />
      </StoreContext>
    </App>,
  )

const button = (name: string) =>
  screen.getByRole('button', { name: new RegExp(name.split('').join('\\s*')) })

beforeEach(() => vi.clearAllMocks())

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
