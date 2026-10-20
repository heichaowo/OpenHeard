import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setViewportWidth } from '../testSetup'
import { FakeAudio, act, button, confirm, conv, fm, mocks, poll, resetMocks, store, tree } from './listenKit'

const conversations = vi.hoisted(() => vi.fn())
const radios = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, conversations, radios } }
})

const { deleteConversations, setVerdict } = mocks

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

const del = /^删\s*除$/

/** 含这段文字的那一行（表格行），列表很长时不用 getAllByRole。 */
const rowOf = (text: string | RegExp) =>
  screen
    .getAllByText(text)
    .map((e) => e.closest('tr'))
    .find((r): r is HTMLTableRowElement => r !== null)!

describe('删除一段对话', () => {
  const two = [act('m1', 0, { mine: true }), act('x1', 10, { callsign: 'BA1AA' })]
  const grown = [...two, act('x9', 40, { callsign: 'BD7BBB' })]

  it('确认框开着时段里长了一次，删的还是打开时看到的那两次', async () => {
    conversations.mockResolvedValue({ items: [conv(two)] })
    render(tree(store([]), '/heard?tab=unlogged'))
    const line = (await screen.findByText('BA1AA')).closest('tr')!

    await userEvent.click(within(line).getByRole('button', { name: del }))
    expect(await screen.findByText('删掉这 2 次发射？')).toBeInTheDocument()
    expect(screen.getByText('连同录音删掉，删了找不回来。')).toBeInTheDocument()

    // 此刻页面算静的，只有确认框开着在挡：别人回了一句，这一行长到 3 次。
    goQuiet()
    conversations.mockResolvedValue({ items: [conv(grown)] })
    poll()
    expect(await screen.findByText(/^3 次/)).toBeInTheDocument()
    expect(screen.getByText('删掉这 2 次发射？')).toBeInTheDocument()

    await confirm()
    await waitFor(() => expect(deleteConversations).toHaveBeenCalledOnce())
    expect(deleteConversations.mock.calls[0]![0]).toEqual([{ id: 'm1', activityIds: ['m1', 'x1'] }])
  })

  it('删掉之后这一行从列表里摘走', async () => {
    conversations.mockResolvedValueOnce({ items: [conv(two)] })
    render(tree(store([]), '/heard?tab=unlogged'))
    const line = (await screen.findByText('BA1AA')).closest('tr')!

    conversations.mockResolvedValue({ items: [] })
    await userEvent.click(within(line).getByRole('button', { name: del }))
    await confirm()

    await waitFor(() => expect(screen.queryByText('BA1AA')).not.toBeInTheDocument())
    expect(deleteConversations).toHaveBeenCalledOnce()
  })

  it('已忽略的行能删，已入库的行删除禁用', async () => {
    const ignored = conv([act('i1', 0, { mine: true }), act('i2', 10, { callsign: 'BA1AA' })], { status: 'ignored', draft: undefined })
    const logged = conv([act('l1', 100, { mine: true }), act('l2', 110, { callsign: 'BD7BBB' })], {
      status: 'logged',
      draft: undefined,
      qso: { id: 'q1', call: 'BD7BBB', rstSent: '59', rstRcvd: '59' },
    })
    conversations.mockResolvedValue({ items: [logged, ignored] })
    render(tree(store([]), '/heard?tab=all&day=2026-09-20'))

    await screen.findByText('BD7BBB 59/59')
    const ignoredRow = rowOf('已忽略')
    const loggedRow = rowOf('已入库')
    expect(within(ignoredRow).getByText(del).closest('button')).toBeEnabled()
    expect(within(loggedRow).getByText(del).closest('button')).toBeDisabled()
  })

  it('手机上已入库的卡片把不能删的原因写在按钮下面，不靠悬停', async () => {
    setViewportWidth(375)
    const logged = conv([act('l1', 100, { mine: true }), act('l2', 110, { callsign: 'BD7BBB' })], {
      status: 'logged',
      draft: undefined,
      qso: { id: 'q1', call: 'BD7BBB', rstSent: '59', rstRcvd: '59' },
    })
    conversations.mockResolvedValue({ items: [logged] })
    render(tree(store([]), '/heard?tab=logged&day=2026-09-20'))

    expect(await screen.findByText('先在日志里删掉这条通联')).toBeVisible()
    expect(screen.getByText(del).closest('button')).toBeDisabled()
  })

  it('批量：删除选中只带选中的那几段，确认框上写的是打开时的段数', async () => {
    const a = conv([act('a1', 0, { mine: true })])
    const b = conv([act('b1', 100, { mine: true })])
    const c = conv([act('c1', 200, { mine: true }), act('c2', 210, { callsign: 'BA1AA' })])
    conversations.mockResolvedValue({ items: [c, b, a] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await userEvent.click(await screen.findByRole('button', { name: /选中没人回的/ }))

    await userEvent.click(button('删除选中', true))
    expect(await screen.findByText('删掉选中的 2 段？')).toBeInTheDocument()
    await confirm()

    await waitFor(() => expect(deleteConversations).toHaveBeenCalledOnce())
    expect(deleteConversations.mock.calls[0]![0]).toEqual([
      { id: 'b1', activityIds: ['b1'] },
      { id: 'a1', activityIds: ['a1'] },
    ])
  })

  it('有一段没删成时消息里说清楚，成功的那几段照样摘走', async () => {
    const a = conv([act('a1', 0, { mine: true })])
    const b = conv([act('b1', 100, { mine: true })])
    conversations.mockResolvedValueOnce({ items: [b, a] })
    render(tree(store([]), '/heard?tab=unlogged'))
    await userEvent.click(await screen.findByRole('button', { name: /选中没人回的/ }))

    deleteConversations.mockResolvedValue({ deleted: 1, missing: ['a1'] })
    conversations.mockResolvedValue({ items: [a] })
    await userEvent.click(button('删除选中', true))
    await confirm()

    expect(await screen.findByText('删掉了 1 段，1 段已经变了')).toBeInTheDocument()
  })
})

describe('无意义档', () => {
  const m = (id: string, at: number, ai: object, over = {}) => fm(id, at, { mine: true, ai: { meaningless: true, ...ai }, ...over })
  const kerchunk = conv(
    [m('a1', 0, { hasSpeech: false, transcript: '(字幕製作:貝爾)' }), m('a2', 5, { hasSpeech: false }), m('a3', 9, { hasSpeech: true, category: 'test', transcript: '测试测试' })],
    { meaningless: true, channel: 'ch:438.500 中继', origin: 'sdr-fm', draft: undefined, status: 'pending' },
  )
  const human = conv([m('h1', 100, { verdict: 'meaningless', hasSpeech: true })], {
    meaningless: true,
    channel: 'ch:438.500 中继',
    origin: 'sdr-fm',
    draft: undefined,
    status: 'ignored',
  })

  const serve = (items = [human, kerchunk], total = items.length) =>
    conversations.mockImplementation((p: { limit?: number; view?: string }) =>
      Promise.resolve(p.view === 'meaningless' ? { items: p.limit === 1 ? items.slice(0, 1) : items, total } : { items: [] }),
    )

  it('chip 上的数来自 view=meaningless&limit=1 的 total', async () => {
    serve([human, kerchunk], 7)
    render(tree(store([])))

    const chip = (await screen.findAllByRole('tab')).find((t) => t.textContent?.includes('无意义'))!
    await waitFor(() => expect(within(chip).getByText('7')).toBeInTheDocument())
    expect(conversations).toHaveBeenCalledWith({ view: 'meaningless', limit: 1 })
  })

  it('删除或改判之后 chip 的数马上重拉，不等下一个 15 秒', async () => {
    serve([kerchunk], 2)
    render(tree(store([]), '/heard?tab=meaningless'))
    const chip = (await screen.findAllByRole('tab')).find((t) => t.textContent?.includes('无意义'))!
    await waitFor(() => expect(within(chip).getByText('2')).toBeInTheDocument())

    serve([], 1)
    await userEvent.click(screen.getByText('不是无意义'))

    await waitFor(() => expect(within(chip).getByText('1')).toBeInTheDocument())
  })

  it('每行只有播放、不是无意义、删除；没有勾选框；原因按个数写', async () => {
    serve()
    const { container } = render(tree(store([]), '/heard?tab=meaningless'))

    expect(await screen.findByText('没有人声 2 · 测试 1')).toBeInTheDocument()
    expect(screen.getByText('人工判定')).toBeInTheDocument()
    expect(container.querySelector('.ant-table-tbody input[type="checkbox"]')).toBeNull()
    expect(screen.queryByText(/直接入库|^忽\s*略$|^编\s*辑$|^确\s*认$/)).not.toBeInTheDocument()
    expect(screen.getAllByText('不是无意义')).toHaveLength(2)
    expect(screen.getAllByText(del)).toHaveLength(2)
  })

  it('手机上也一样：卡片里只有不是无意义和删除', async () => {
    setViewportWidth(375)
    serve([kerchunk])
    const { container } = render(tree(store([]), '/heard?tab=meaningless'))

    expect(await screen.findByText('没有人声 2 · 测试 1')).toBeInTheDocument()
    expect(container.querySelector('.pending-card-actions')!.children).toHaveLength(2)
    expect(screen.getByText('不是无意义')).toBeInTheDocument()
    expect(screen.getByText(del)).toBeInTheDocument()
    expect(screen.queryByText('直接入库')).not.toBeInTheDocument()
  })

  it('不是无意义：这一段每次发射都改判成保留，行从这一档里走掉', async () => {
    serve([kerchunk])
    render(tree(store([]), '/heard?tab=meaningless'))
    await screen.findByText('没有人声 2 · 测试 1')

    serve([])
    await userEvent.click(screen.getByText('不是无意义'))

    await waitFor(() => expect(setVerdict).toHaveBeenCalledWith(['a1', 'a2', 'a3'], false))
    await waitFor(() => expect(screen.queryByText('没有人声 2 · 测试 1')).not.toBeInTheDocument())
  })

  it('删除已加载的 n 段：确认框开着时插进来一行，删的还是打开时那几段', async () => {
    const x = conv([m('x1', 300, { hasSpeech: false })], { meaningless: true, origin: 'sdr-fm', channel: 'ch:438.500 中继', draft: undefined })
    const y = conv([m('y1', 200, { hasSpeech: false })], { meaningless: true, origin: 'sdr-fm', channel: 'ch:438.500 中继', draft: undefined })
    const fresh = conv([m('n1', 900, { hasSpeech: false })], { meaningless: true, origin: 'sdr-fm', channel: 'ch:438.500 中继', draft: undefined })
    serve([x, y, kerchunk])
    render(tree(store([]), '/heard?tab=meaningless'))
    await screen.findByText('没有人声 2 · 测试 1')

    await userEvent.click(button('删除已加载的 3 段'))
    expect(await screen.findByText('删掉已加载的 3 段？')).toBeInTheDocument()

    goQuiet()
    serve([fresh, x, y, kerchunk])
    poll()
    // 确认框开着，新来的那一行不插进列表，攒在提示条里。
    expect(await screen.findByRole('button', { name: /有 1 段新的/ })).toBeInTheDocument()
    expect(screen.getByText('删掉已加载的 3 段？')).toBeInTheDocument()

    await confirm()
    await waitFor(() => expect(deleteConversations).toHaveBeenCalledOnce())
    expect(deleteConversations.mock.calls[0]![0]).toEqual([
      { id: 'x1', activityIds: ['x1'] },
      { id: 'y1', activityIds: ['y1'] },
      { id: 'a1', activityIds: ['a1', 'a2', 'a3'] },
    ])
  })

  it('点了更早的之后，已加载的包括翻出来的那些', async () => {
    const older = conv([m('o1', -500, { hasSpeech: false })], { meaningless: true, origin: 'sdr-fm', channel: 'ch:438.500 中继', draft: undefined })
    conversations.mockImplementation((p: { limit?: number; cursor?: string; view?: string }) =>
      Promise.resolve(
        p.limit === 1
          ? { items: [kerchunk], total: 2 }
          : p.cursor === undefined
            ? { items: [kerchunk], next: 'c1', total: 2 }
            : { items: [older], total: 2 },
      ),
    )
    render(tree(store([]), '/heard?tab=meaningless'))
    await screen.findByText('没有人声 2 · 测试 1')
    expect(button('删除已加载的 1 段')).toBeInTheDocument()

    await userEvent.click(button('更早的'))
    expect(await screen.findByRole('button', { name: /删除已加载的\s*2 段/ })).toBeInTheDocument()
  })
})
