import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Qso, QsoDraft } from '@core'
import { StoreProvider } from './StoreProvider'
import { useStore } from './store'

const m = vi.hoisted(() => ({
  station: vi.fn(),
  pending: vi.fn(),
  qsos: vi.fn(),
  editQso: vi.fn(),
  promote: vi.fn(),
  ignore: vi.fn(),
  addQso: vi.fn(),
  removeQso: vi.fn(),
}))

vi.mock('./api', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, api: m }
})

const qso = (id: string, call: string): Qso => ({
  id,
  call,
  startAt: 1_789_000_000,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: 1_789_000_000,
})

const draft: QsoDraft = { ...qso('x', 'BA1AA'), rstSent: '41' }

const store: { current?: ReturnType<typeof useStore> } = {}

function Probe() {
  store.current = useStore()
  return (
    <div>
      <p data-testid="calls">
        {store.current?.qsos.map((q) => `${q.call}:${q.rstSent}`).join(',')}
      </p>
      <p data-testid="error">{store.current?.error ?? ''}</p>
      <p data-testid="loading">{String(store.current?.loading)}</p>
      <button
        type="button"
        onClick={() => void store.current?.editQso('q1', draft).catch(() => undefined)}
      >
        改
      </button>
    </div>
  )
}

const mount = () =>
  render(
    <StoreProvider>
      <Probe />
    </StoreProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  m.station.mockResolvedValue({ station: {}, channels: [] })
  m.pending.mockResolvedValue([])
  m.qsos.mockResolvedValue([qso('q1', 'BD7KLO')])
  m.editQso.mockResolvedValue(qso('q1', 'BD7KLO'))
})

describe('StoreProvider', () => {
  it('首次加载三个请求一起发，完了 loading 落下来', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('calls')).toHaveTextContent('BD7KLO:59')
    expect(m.station).toHaveBeenCalledOnce()
    expect(m.pending).toHaveBeenCalledOnce()
  })

  // 改完必须重拉，否则页面停在改之前的样子，人会以为没保存上。
  it('改完之后重新拉一遍', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    m.qsos.mockResolvedValue([{ ...qso('q1', 'BD7KLO'), rstSent: '41' }])

    await userEvent.click(screen.getByRole('button', { name: /改/ }))

    await waitFor(() => expect(screen.getByTestId('calls')).toHaveTextContent('BD7KLO:41'))
    expect(m.editQso).toHaveBeenCalledWith('q1', draft)
  })

  // 轮询和写完之后的刷新会同时在路上，先发的未必先回。照单全收的话，
  // 一个早发的响应会把刚入库的那条盖回去，直到下一轮才恢复。
  it('慢的那个响应回来晚了就丢掉，不盖住新的', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))

    // 第一次 refresh 慢，第二次快。第二次先落地，第一次回来时必须被丢掉。
    let releaseSlow: (v: Qso[]) => void = () => undefined
    m.qsos.mockImplementationOnce(
      () => new Promise<Qso[]>((resolve) => { releaseSlow = resolve }),
    )
    m.qsos.mockResolvedValue([{ ...qso('q1', 'BD7KLO'), rstSent: '41' }])

    let slow: Promise<void> | undefined
    let fast: Promise<void> | undefined
    await act(async () => {
      slow = store.current?.refresh()
      fast = store.current?.refresh()
      await fast
    })
    expect(screen.getByTestId('calls')).toHaveTextContent('BD7KLO:41')

    await act(async () => {
      releaseSlow([{ ...qso('q1', 'BD7KLO'), rstSent: '59' }])
      await slow
    })

    expect(screen.getByTestId('calls')).toHaveTextContent('BD7KLO:41')
  })

  it('拉不动时把原因放出来，手上的数据不丢', async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))

    m.qsos.mockRejectedValue(new Error('连不上'))
    m.editQso.mockResolvedValue(qso('q1', 'BD7KLO'))
    await userEvent.click(screen.getByRole('button', { name: /改/ }))

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('连不上'))
    expect(screen.getByTestId('calls')).toHaveTextContent('BD7KLO:59')
  })
})
