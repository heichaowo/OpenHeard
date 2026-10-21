import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from 'antd'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingItem } from '@core'
import { PlayerProvider } from '../PlayerProvider'
import { Preferences } from '../Preferences'
import { StoreProvider } from '../StoreProvider'
import { setViewportWidth } from '../testSetup'
import Listen from './Listen'
import { FakeAudio, act, conv, row } from './listenKit'

// 用真的 StoreProvider 加一个有状态的假后端：入库/忽略之后 /pending 真的少一行。
// 其余 Listen*.test 都是静态 store 加 rerender，看不出结算之后 store 才刷新这一步。
const server = vi.hoisted(() => ({
  pending: [] as unknown[],
  conversations: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  const settle = (ids: string[]) => {
    server.pending = server.pending.filter((p) => !ids.includes((p as PendingItem).cluster.id))
  }
  return {
    ...real,
    api: {
      ...real.api,
      station: async () => ({ station: { myCallsign: 'BG0CG' }, channels: [] }),
      pending: async () => server.pending,
      qsos: async () => [],
      recordings: async () => [],
      radios: async () => ({ analogEnabled: false, radios: [] }),
      conversations: server.conversations,
      promoteActivities: async (ids: string[]) => {
        settle(server.pending.filter((p) => (p as PendingItem).cluster.activities.some((a) => ids.includes(a.id))).map((p) => (p as PendingItem).cluster.id))
        return {}
      },
      ignoreActivities: async (picks: { id: string }[]) => {
        settle(picks.map((p) => p.id))
        return { ignored: picks.length, missing: [] }
      },
    },
  }
})

const a = row([act('a1', 0, { mine: true }), act('ax', 10, { callsign: 'BA1AA' })])
const b = row([act('b1', 100, { mine: true }), act('bx', 110, { callsign: 'BD7BBB' })])
const c = row([act('c1', 200, { mine: true }), act('cx', 210, { callsign: 'BD7CCC' })])

const mount = (path = '/heard?tab=pending') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Preferences>
        <App>
          <StoreProvider>
            <PlayerProvider>
              <Listen />
            </PlayerProvider>
          </StoreProvider>
        </App>
      </Preferences>
    </MemoryRouter>,
  )

const rowOf = (text: string) =>
  screen
    .getAllByText(text)
    .map((e) => e.closest('tr.ant-table-row:not(.ant-table-expanded-row tr)'))
    .find((r): r is HTMLTableRowElement => r !== null)!

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('Audio', FakeAudio)
  server.pending = [a, b, c]
  server.conversations.mockResolvedValue({ items: [] })
})

afterEach(() => setViewportWidth(1280))

describe('待确认里自己结算的行：store 刷新回来就直接摘，不留已变', () => {
  it('直接入库：真点一下（有 pointerdown）之后那一行消失，没有已变', async () => {
    mount()
    await screen.findByText('BA1AA')

    await userEvent.click(within(rowOf('BA1AA')).getByText(/^直\s*接\s*入\s*库$/))

    await waitFor(() => expect(screen.queryByText('BA1AA')).not.toBeInTheDocument())
    expect(screen.queryByText('已变')).not.toBeInTheDocument()
    expect(screen.getByText('BD7BBB')).toBeInTheDocument()
  })

  it('忽略加确认：同样直接摘', async () => {
    mount()
    await screen.findByText('BA1AA')

    await userEvent.click(within(rowOf('BA1AA')).getByText(/^忽\s*略$/))
    await userEvent.click(await screen.findByRole('button', { name: 'OK' }))

    await waitFor(() => expect(screen.queryByText('BA1AA')).not.toBeInTheDocument())
    expect(screen.queryByText('已变')).not.toBeInTheDocument()
  })

  it('手机卡片上直接入库：同样直接摘', async () => {
    setViewportWidth(375)
    mount()
    await screen.findByText('BA1AA')

    await userEvent.click(screen.getAllByText(/^直\s*接\s*入\s*库$/)[0]!)

    await waitFor(() => expect(screen.queryByText('BA1AA')).not.toBeInTheDocument())
    expect(screen.queryByText('已变')).not.toBeInTheDocument()
  })
})


// 勾掉的几次不结算，余下的一段拆出来留在视图里。上一轮的挑选不能带到它身上。
describe('结算一个挑过子集的对话之后，余下的一段是全选的', () => {
  const trio = [act('m1', 10, { callsign: 'BA1AA' }), act('x1', 20, { callsign: 'BA1AA' }), act('x2', 30, { callsign: 'BA1AA' })]
  const expandIcon = (line: HTMLElement) => line.querySelector('.ant-table-row-expand-icon') as HTMLElement

  const untick = async (index: number) => {
    server.conversations.mockResolvedValue({ items: [conv(trio)] })
    const { container } = mount('/heard?tab=unlogged')
    await screen.findByText('BA1AA')
    await userEvent.click(expandIcon(rowOf('BA1AA')))
    const boxes = await waitFor(() => {
      const b = container.querySelectorAll('.ant-table-expanded-row .ant-table-tbody tr.ant-table-row .ant-checkbox-input')
      expect(b.length).toBe(3)
      return b
    })
    await userEvent.click(boxes[index] as HTMLElement)
    expect(await screen.findByText('挑中 2 / 3 次')).toBeInTheDocument()
  }

  const straightIn = () => within(rowOf('BA1AA')).getByText(/^直\s*接\s*入\s*库$/).closest('button')!

  it('勾掉最后一次：余下的 id 变了，不是「挑中 0」', async () => {
    await untick(2)
    server.conversations.mockResolvedValue({ items: [conv([trio[2]!])] })
    await userEvent.click(straightIn())

    await waitFor(() => expect(screen.queryByText(/挑中/)).not.toBeInTheDocument())
    await waitFor(() => expect(straightIn()).toBeEnabled())
  })

  it('勾掉第一次：余下的 id 不变，不带着已经入库的两次', async () => {
    await untick(0)
    server.conversations.mockResolvedValue({ items: [conv([trio[0]!])] })
    await userEvent.click(straightIn())

    await waitFor(() => expect(screen.queryByText(/挑中/)).not.toBeInTheDocument())
    await waitFor(() => expect(straightIn()).toBeEnabled())
  })
})
