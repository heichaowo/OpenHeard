import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setViewportWidth } from '../testSetup'
import { FakeAudio, act, conv, mocks, poll, resetMocks, row, store, tree } from './listenKit'

const conversations = vi.hoisted(() => vi.fn())
const radios = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, conversations, radios } }
})

const { promote, ignoreMany } = mocks

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('Audio', FakeAudio)
  // 只拨 Date：useQuiet 看它，其余的计时器照常走。
  vi.useFakeTimers({ toFake: ['Date'] })
  resetMocks()
  conversations.mockResolvedValue({ items: [] })
  radios.mockResolvedValue({ analogEnabled: false, radios: [] })
})

afterEach(() => {
  vi.useRealTimers()
  setViewportWidth(1280)
})

/** 装作人已经几秒没碰过页面了。 */
const goQuiet = () => vi.setSystemTime(Date.now() + 10_000)

const u1 = conv([act('u1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' })])
const u2 = conv([act('u2', 100, { mine: true }), act('x2', 110, { callsign: 'BD7BBB' })])

/** 含这段文字的外层表格行；展开之后内层表格里也有同样的字，不要它。 */
const rowOf = (text: string) =>
  screen
    .getAllByText(text)
    .map((e) => e.closest('tr.ant-table-row:not(.ant-table-expanded-row tr)'))
    .find((r): r is HTMLTableRowElement => r !== null)!
const expandIcon = (line: HTMLElement) => line.querySelector('.ant-table-row-expand-icon') as HTMLElement

describe('新对话自己出现', () => {
  it('停在顶上、没在操作：新对话直接插到最上面，不用点提示条', async () => {
    conversations.mockResolvedValue({ items: [u1] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')

    conversations.mockResolvedValue({ items: [u2, u1] })
    poll()

    expect(await screen.findByText('BD7BBB')).toBeInTheDocument()
    expect(screen.getByText('没有更新的')).toBeInTheDocument()
  })

  it('展开着一行时先攒着，收起之后下一轮自己插进来', async () => {
    conversations.mockResolvedValue({ items: [u1] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')
    await userEvent.click(expandIcon(rowOf('BA1AA')))
    goQuiet()

    conversations.mockResolvedValue({ items: [u2, u1] })
    poll()
    expect(await screen.findByText('有 1 段新的')).toBeInTheDocument()
    expect(screen.queryByText('BD7BBB')).not.toBeInTheDocument()

    await userEvent.click(expandIcon(rowOf('BA1AA')))
    goQuiet()
    poll()
    expect(await screen.findByText('BD7BBB')).toBeInTheDocument()
    expect(screen.getByText('没有更新的')).toBeInTheDocument()
  })

  it('刚按过一下：轮询回来也不动，过了几秒再来才插', async () => {
    conversations.mockResolvedValue({ items: [u1] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')

    fireEvent.pointerDown(document.body)
    conversations.mockResolvedValue({ items: [u2, u1] })
    poll()
    expect(await screen.findByText('有 1 段新的')).toBeInTheDocument()
    expect(screen.queryByText('BD7BBB')).not.toBeInTheDocument()

    goQuiet()
    poll()
    expect(await screen.findByText('BD7BBB')).toBeInTheDocument()
  })

  it('页面滚到下面去了（scrollY 不小于 120）就先攒着', async () => {
    conversations.mockResolvedValue({ items: [u1] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')

    Object.defineProperty(window, 'scrollY', { value: 500, configurable: true })
    try {
      conversations.mockResolvedValue({ items: [u2, u1] })
      poll()
      expect(await screen.findByText('有 1 段新的')).toBeInTheDocument()
    } finally {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    }
  })

  it('开着确认框或者勾着选中的时候不插', async () => {
    const a = conv([act('a1', 0, { mine: true })])
    conversations.mockResolvedValue({ items: [a] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await userEvent.click(await screen.findByRole('button', { name: /选中没人回的/ }))
    goQuiet()

    conversations.mockResolvedValue({ items: [u2, a] })
    poll()
    expect(await screen.findByText('有 1 段新的')).toBeInTheDocument()
  })

  it('列表是空的就直接显示拉到的', async () => {
    conversations.mockResolvedValue({ items: [] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('未入库里没有等着处理的对话')

    fireEvent.pointerDown(document.body)
    conversations.mockResolvedValue({ items: [u1] })
    poll()
    expect(await screen.findByText('BA1AA')).toBeInTheDocument()
  })

  it('没有下一页时，比所有行都早的补进来的也收，提示条写补进来的', async () => {
    const late = conv([act('l1', 500, { mine: true }), act('lx', 510, { callsign: 'BA1AA' })])
    conversations.mockResolvedValue({ items: [late] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')

    // 守护进程补发了落盘的那批：这一条比已经显示的所有行都早。
    fireEvent.pointerDown(document.body)
    conversations.mockResolvedValue({ items: [late, u1] })
    poll()
    expect(await screen.findByText('有 1 段新补进来的')).toBeInTheDocument()

    goQuiet()
    poll()
    await waitFor(() => expect(screen.getAllByText('BA1AA')).toHaveLength(2))
  })
})

describe('对话 id 变了：挑中的、勾选的、展开的搬到新 id 上', () => {
  const three = [act('m1', 10, { mine: true }), act('x1', 20, { callsign: 'BA1AA' }), act('x2', 30, { callsign: 'BA1AA' })]
  const backfilled = [act('m0', 0, { mine: true }), ...three]

  it('取消了一次之后更早的发射补进来，挑中的还是那两次，补进来的那次没看过不跟着入库', async () => {
    conversations.mockResolvedValue({ items: [conv(three)] })
    const { container } = render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')
    await userEvent.click(expandIcon(rowOf('BA1AA')))
    const boxes = await waitFor(() => {
      const b = container.querySelectorAll('.ant-table-expanded-row .ant-table-tbody .ant-checkbox-input')
      expect(b.length).toBe(3)
      return b
    })
    await userEvent.click(boxes[2] as HTMLElement)
    expect(await screen.findByText('挑中 2 / 3 次')).toBeInTheDocument()

    // 补进一条更早的发射：对话 id 从 m1 变成 m0。
    conversations.mockResolvedValue({ items: [conv(backfilled)] })
    poll()
    expect(await screen.findByText('挑中 2 / 4 次')).toBeInTheDocument()
    // 展开的状态也跟着搬过去了。
    expect(container.querySelectorAll('.ant-table-expanded-row .ant-table-tbody .ant-checkbox-input').length).toBe(4)

    await userEvent.click(screen.getByText(/^直\s*接\s*入\s*库$/))
    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0]![0]).toEqual(['m1', 'x1'])
  })

  it('勾选也搬过去，批量忽略带的是勾选时看到的那几次', async () => {
    const alone = [act('a1', 10, { mine: true })]
    conversations.mockResolvedValue({ items: [conv(alone)] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await userEvent.click(await screen.findByRole('button', { name: /选中没人回的/ }))

    conversations.mockResolvedValue({ items: [conv([act('a0', 0, { mine: true }), ...alone])] })
    poll()
    await screen.findByText('2 次 · 14 秒')
    await userEvent.click(screen.getByRole('button', { name: /忽略选中/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'OK' }))

    await waitFor(() => expect(ignoreMany).toHaveBeenCalledOnce())
    expect(ignoreMany.mock.calls[0]![0]).toEqual([{ id: 'a0', activityIds: ['a1'] }])
  })

  it('待确认也一样：store.pending 里 id 变了，挑中的跟着走', async () => {
    setViewportWidth(375)
    const { rerender } = render(tree(store([row(three)])))
    await userEvent.click(screen.getByText(/逐次发射/))
    await userEvent.click(screen.getAllByRole('checkbox')[3]!)
    expect(screen.getByText('挑中 2 / 3 次')).toBeInTheDocument()

    rerender(tree(store([row(backfilled)])))
    expect(await screen.findByText('挑中 2 / 4 次')).toBeInTheDocument()
    await userEvent.click(screen.getByText(/^直\s*接\s*入\s*库$/))
    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0]![0]).toEqual(['m1', 'x1'])
  })
})

describe('行要离开视图：先留在原处、按钮禁用，等人不在操作再拿掉', () => {
  it('未入库里一行不在最新结果里了：标已变、禁用，过几秒再来才摘', async () => {
    conversations.mockResolvedValue({ items: [u2, u1] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')

    fireEvent.pointerDown(document.body)
    // AI 刚把 u1 判成了无意义，它不在未入库里了。
    conversations.mockResolvedValue({ items: [u2] })
    poll()

    const line = await waitFor(() => {
      const r = rowOf('BA1AA')
      expect(within(r).getByText('已变')).toBeInTheDocument()
      return r
    })
    for (const name of [/^直\s*接\s*入\s*库$/, /^确\s*认$|^编\s*辑$/, /^忽\s*略$/, /^删\s*除$/]) {
      expect(within(line).getByText(name).closest('button')).toBeDisabled()
    }
    expect(within(rowOf('BD7BBB')).getByText(/^直\s*接\s*入\s*库$/).closest('button')).toBeEnabled()

    goQuiet()
    poll()
    await waitFor(() => expect(screen.queryByText('BA1AA')).not.toBeInTheDocument())
  })

  it('自己结算掉的不走已变，直接摘', async () => {
    conversations.mockResolvedValue({ items: [u2, u1] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await screen.findByText('BA1AA')

    conversations.mockResolvedValue({ items: [u2] })
    await userEvent.click(within(rowOf('BA1AA')).getByText(/^直\s*接\s*入\s*库$/))

    await waitFor(() => expect(screen.queryByText('BA1AA')).not.toBeInTheDocument())
    expect(screen.queryByText('已变')).not.toBeInTheDocument()
  })

  it('待确认也走同一套：store.pending 里少了一行，先标已变，静下来之后才摘', async () => {
    const a = row([act('a1', 0, { mine: true }), act('ax', 10, { callsign: 'BA1AA' })])
    const b = row([act('b1', 100, { mine: true }), act('bx', 110, { callsign: 'BD7BBB' })])
    const { rerender } = render(tree(store([a, b])))
    await screen.findByText('BA1AA')

    fireEvent.pointerDown(document.body)
    rerender(tree(store([b])))
    const line = await waitFor(() => {
      const r = rowOf('BA1AA')
      expect(within(r).getByText('已变')).toBeInTheDocument()
      return r
    })
    expect(within(line).getByText(/^直\s*接\s*入\s*库$/).closest('button')).toBeDisabled()

    goQuiet()
    rerender(tree(store([b])))
    await waitFor(() => expect(screen.queryByText('BA1AA')).not.toBeInTheDocument())
    expect(screen.getByText('BD7BBB')).toBeInTheDocument()
  })

  it('待确认里新来的排在队尾，人在操作也直接显示，不推动已有的行', async () => {
    const a = row([act('a1', 0, { mine: true }), act('ax', 10, { callsign: 'BA1AA' })])
    const b = row([act('b1', 100, { mine: true }), act('bx', 110, { callsign: 'BD7BBB' })])
    const { rerender } = render(tree(store([a])))
    await screen.findByText('BA1AA')

    fireEvent.pointerDown(document.body)
    rerender(tree(store([a, b])))
    expect(await screen.findByText('BD7BBB')).toBeInTheDocument()
  })

  it('待确认里补进中间的一条：人在操作时攒着，提示条写补进来的', async () => {
    const a = row([act('a1', 100, { mine: true }), act('ax', 110, { callsign: 'BA1AA' })])
    const early = row([act('e1', 0, { mine: true }), act('ex', 10, { callsign: 'BD7BBB' })])
    const { rerender } = render(tree(store([a])))
    await screen.findByText('BA1AA')

    fireEvent.pointerDown(document.body)
    rerender(tree(store([early, a])))
    expect(await screen.findByText('有 1 段新补进来的')).toBeInTheDocument()
    expect(screen.queryByText('BD7BBB')).not.toBeInTheDocument()

    await userEvent.click(screen.getByText('有 1 段新补进来的'))
    expect(await screen.findByText('BD7BBB')).toBeInTheDocument()
  })
})
