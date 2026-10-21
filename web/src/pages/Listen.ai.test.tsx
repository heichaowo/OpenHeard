import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QsoDraft, QsoField } from '@core'
import type { Conversation, HeardItem } from '../api'
import { setViewportWidth } from '../testSetup'
import { FakeAudio, act, conv, draftOfActs, fm, mocks, resetMocks, store, tree } from './listenKit'

const conversations = vi.hoisted(() => vi.fn())
const radios = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, conversations, radios } }
})

const { promote } = mocks

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('Audio', FakeAudio)
  resetMocks()
  conversations.mockResolvedValue({ items: [] })
  radios.mockResolvedValue({ analogEnabled: false, radios: [] })
})

afterEach(() => setViewportWidth(1280))

const ai = (over: object = {}) => ({ meaningless: false, hasSpeech: true, ...over })

/** 模拟侧的对话：origin 和信道跟着成员走。 */
const fmConv = (activities: HeardItem[], over: Partial<Conversation> = {}): Conversation =>
  conv(activities, { origin: 'sdr-fm', channel: 'ch:438.500 中继', draft: draftOfActs(activities, { mode: 'FM' }), ...over })

const aiDraft: QsoDraft = { call: 'BA1AA', qth: '深圳', rstRcvd: '57', note: '对方设备 UV-5R' }
const aiFilled: QsoField[] = ['call', 'qth', 'rstRcvd', 'note']
const talk = [
  fm('f1', 0, { mine: true, ai: ai({ transcript: 'BA1AA 这里是 BG0CG', fields: { calledCall: 'BA1AA' } }) }),
  fm('f2', 10, { ai: ai({ transcript: '收到，我在深圳，五七', fields: { call: 'BA1AA', qth: '深圳', rst: '57', device: 'UV-5R' } }) }),
]
const filled = () => fmConv(talk, { draft: draftOfActs(talk, { mode: 'FM', ...aiDraft }), aiFilled })

const serve = (...items: Conversation[]) => conversations.mockResolvedValue({ items })
const unlogged = '/heard?tab=unlogged'

describe('AI 填的内容在行上看得见', () => {
  it('手机卡片：呼号旁边一个 AI，其他字段写成一行', async () => {
    setViewportWidth(375)
    serve(filled())
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))

    await screen.findByText('AI：QTH 深圳 · 收到 57 · 备注')
    const call = container.querySelector('.pending-card-call')!
    expect(call).toHaveTextContent('BA1AA')
    expect(within(call as HTMLElement).getByText('AI')).toBeInTheDocument()
  })

  it('桌面：呼号格带 AI 标签，其他字段在悬停里', async () => {
    serve(filled())
    render(tree(store([], { aiEnabled: true }), unlogged))

    const cell = await screen.findByTitle('AI：QTH 深圳 · 收到 57 · 备注')
    expect(within(cell).getByText('BA1AA')).toBeInTheDocument()
    expect(within(cell).getByText('AI')).toBeInTheDocument()
  })

  it('呼号是发射行自己带的就没有 AI 标签', async () => {
    const own = [act('b1', 0, { mine: true }), act('b2', 10, { callsign: 'BA1AA' })]
    serve(conv(own))
    render(tree(store([], { aiEnabled: true }), unlogged))

    await screen.findByText('BA1AA')
    expect(screen.queryByText('AI')).not.toBeInTheDocument()
  })

  it('挑子集重算：挑前一段，呼号和 QTH 是前一个人的，AI 行跟着变', async () => {
    setViewportWidth(375)
    const two = [
      fm('m1', 0, { mine: true, ai: ai({ fields: { calledCall: 'BA1AA' } }) }),
      fm('x1', 10, { ai: ai({ fields: { call: 'BA1AA', qth: '深圳' } }) }),
      fm('m2', 60, { mine: true, ai: ai({ fields: { calledCall: 'BD7BBB' } }) }),
      fm('x2', 70, { ai: ai({ fields: { call: 'BD7BBB', qth: '广州' } }) }),
    ]
    serve(fmConv(two, { draft: draftOfActs(two, { mode: 'FM', call: 'BD7BBB', qth: '广州' }), aiFilled: ['call', 'qth'] }))
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))
    await screen.findByText('AI：QTH 广州')

    await userEvent.click(screen.getByText(/逐次发射/))
    const boxes = container.querySelectorAll('.ant-collapse input[type="checkbox"]')
    await userEvent.click(boxes[2]!)
    await userEvent.click(boxes[3]!)

    expect(await screen.findByText('AI：QTH 深圳')).toBeInTheDocument()
    expect(container.querySelector('.pending-card-call')).toHaveTextContent('BA1AA')
  })
})

describe('转写和标记', () => {
  it('手机上模拟侧的卡片有固定的转写块，没识别出来之前写还没识别', async () => {
    setViewportWidth(375)
    const waiting = fmConv([fm('w1', 0, { mine: true })])
    serve(filled(), waiting)
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))

    await screen.findByText('BA1AA 这里是 BG0CG / 收到，我在深圳，五七')
    const blocks = container.querySelectorAll('.card-transcript')
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toHaveTextContent('还没识别')
  })

  it('手机上模拟侧的每张卡都留着 AI 字段那一行和两行的标签行，数字侧没有', async () => {
    setViewportWidth(375)
    const waiting = fmConv([fm('w1', 0, { mine: true })])
    const digital = conv([act('d1', 0, { mine: true }), act('d2', 10, { callsign: 'BD7DDD' })])
    serve(filled(), waiting, digital)
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))

    await screen.findByText('BD7DDD')
    const cards = [...container.querySelectorAll('.ant-list-item .ant-card')]
    expect(cards).toHaveLength(3)
    const [withFields, bare, plain] = cards
    // 有字段的写字段，没结果的留空行，两张的行本身一样在。
    expect(withFields!.querySelector('.card-ai-line')).toHaveTextContent('AI：QTH 深圳')
    expect(bare!.querySelector('.card-ai-line')).toHaveTextContent('')
    expect(withFields!.querySelector('.card-tags-reserved')).not.toBeNull()
    expect(bare!.querySelector('.card-tags-reserved')).not.toBeNull()
    expect(plain!.querySelector('.card-ai-line')).toBeNull()
    expect(plain!.querySelector('.card-tags-reserved')).toBeNull()
  })

  it('数字侧的卡片没有转写块', async () => {
    setViewportWidth(375)
    serve(conv([act('d1', 0, { mine: true }), act('d2', 10, { callsign: 'BA1AA' })]))
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))

    await screen.findByText('BA1AA')
    expect(container.querySelector('.card-transcript')).toBeNull()
  })

  it('没人声：只有无人声标记，原文放在悬停里，不当内容显示', async () => {
    setViewportWidth(375)
    const quiet = fmConv([fm('q1', 0, { mine: true, ai: ai({ hasSpeech: false, transcript: '(字幕製作:貝爾)', meaningless: true }) })])
    serve(quiet)
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))

    const tag = await screen.findByTitle('(字幕製作:貝爾)')
    expect(tag).toHaveTextContent('无人声')
    expect(screen.queryByText('(字幕製作:貝爾)')).not.toBeInTheDocument()
    expect(container.querySelector('.card-transcript')).toHaveTextContent('没有识别出文字')
  })

  it('测试、噪声、识别失败、识别中各一个标记；识别关着时一个都没有', async () => {
    setViewportWidth(375)
    const mk = (id: string, at: number, a?: object) => fmConv([fm(id, at, { mine: true, ai: a === undefined ? undefined : ai(a) })])
    serve(
      mk('t1', 0, { category: 'test', meaningless: true }),
      mk('n1', 100, { category: 'noise', meaningless: true }),
      mk('e1', 200, { error: '超时', hasSpeech: undefined }),
      mk('p1', 300),
    )
    const { rerender } = render(tree(store([], { aiEnabled: true }), unlogged))

    for (const tag of ['测试', '噪声', '识别失败', '识别中']) expect(await screen.findByText(tag)).toBeInTheDocument()

    rerender(tree(store([], { aiEnabled: false }), unlogged))
    await waitFor(() => expect(screen.queryByText('识别中')).not.toBeInTheDocument())
    for (const tag of ['测试', '噪声', '识别失败']) expect(screen.queryByText(tag)).not.toBeInTheDocument()
  })

  it('桌面展开后，每次发射一行转写；数字侧没有识别这一列', async () => {
    serve(filled(), conv([act('d1', 500, { mine: true }), act('d2', 510, { callsign: 'BD7BBB' })]))
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))
    await screen.findByText('BD7BBB')

    const icons = container.querySelectorAll('.ant-table-row-expand-icon')
    await userEvent.click(icons[0]!)
    const lines = await waitFor(() => {
      const l = container.querySelectorAll('.ant-table-expanded-row .transcript-line')
      expect(l.length).toBe(2)
      return l
    })
    expect(lines[0]).toHaveTextContent('BA1AA 这里是 BG0CG')
    expect(lines[1]).toHaveTextContent('收到，我在深圳，五七')

    await userEvent.click(icons[1]!)
    await waitFor(() => expect(container.querySelectorAll('.ant-table-expanded-row').length).toBe(2))
    const digital = container.querySelectorAll('.ant-table-expanded-row')[1]!
    expect(digital.querySelector('.transcript-line')).toBeNull()
  })

  it('手机展开后每次发射下面一行转写', async () => {
    setViewportWidth(375)
    serve(filled())
    const { container } = render(tree(store([], { aiEnabled: true }), unlogged))
    await screen.findByText('AI：QTH 深圳 · 收到 57 · 备注')

    await userEvent.click(screen.getByText(/逐次发射/))
    const lines = container.querySelectorAll('.ant-collapse .transcript-line')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toHaveTextContent('收到，我在深圳，五七')
  })
})

describe('确认抽屉', () => {
  const open = async () => {
    serve(filled())
    render(tree(store([], { aiEnabled: true }), unlogged))
    await userEvent.click(await screen.findByText(/^编\s*辑$/))
    return await screen.findByRole('dialog')
  }

  it('AI 填的字段标签带 AI，列出这几次发射的转写', async () => {
    const dialog = await open()

    // 对方呼号、收到报告、QTH、备注四格带 AI，发出报告不带。
    expect(within(dialog).getAllByText('AI')).toHaveLength(4)
    expect(within(dialog).getByText('识别出的内容，仅供参考')).toBeInTheDocument()
    expect(within(dialog).getByText('BA1AA 这里是 BG0CG')).toBeInTheDocument()
    expect(within(dialog).getByText('收到，我在深圳，五七')).toBeInTheDocument()
  })

  it('AI 填的 QTH 和备注开抽屉时还在，提交时也没丢', async () => {
    const dialog = await open()
    expect(within(dialog).getByDisplayValue('深圳')).toBeInTheDocument()
    expect(within(dialog).getByDisplayValue('对方设备 UV-5R')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByText(/^入\s*库$/))
    await waitFor(() => expect(promote).toHaveBeenCalledOnce())
    expect(promote.mock.calls[0]![1]).toMatchObject({ call: 'BA1AA', qth: '深圳', rstRcvd: '57', note: '对方设备 UV-5R', gridsquare: undefined })
  })

  it('没人声那次的转写不列在抽屉里', async () => {
    const acts = [
      fm('q1', 0, { mine: true, ai: ai({ hasSpeech: false, transcript: '(字幕製作:貝爾)', meaningless: true }) }),
      fm('q2', 10, { callsign: 'BA1AA', ai: ai({ transcript: '你好' }) }),
    ]
    serve(fmConv(acts, { draft: draftOfActs(acts, { mode: 'FM' }) }))
    render(tree(store([], { aiEnabled: true }), unlogged))
    await userEvent.click(await screen.findByText(/^编\s*辑$/))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('你好')).toBeInTheDocument()
    expect(within(dialog).queryByText('(字幕製作:貝爾)')).not.toBeInTheDocument()
  })

  it('抽屉带地图按钮：选了地图才能点', async () => {
    serve(filled())
    render(tree(store([], { aiEnabled: true, map: { provider: 'osm' } }), unlogged))
    await userEvent.click(await screen.findByText(/^编\s*辑$/))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('在地图上选').closest('button')).toBeEnabled()
  })
})
