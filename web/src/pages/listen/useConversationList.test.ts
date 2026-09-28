import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ConversationsParams } from '../../api'
import { useConversationList } from './useConversationList'

const conversations = vi.hoisted(() => vi.fn())
vi.mock('../../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../api')>()
  return { ...real, api: { ...real.api, conversations } }
})

const conv = (id: string, startAt: number, over: Partial<Conversation> = {}): Conversation => ({
  id,
  startAt,
  endAt: startAt + 4,
  channel: 'tg:46001',
  origin: 'brandmeister',
  status: 'unlogged',
  activities: [],
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

// 收听页的按天看、未入库、搜索三条路都经过这个 hook；日期导航、来源、信道、
// 搜索换挡都只是换一次 viewParams，所以在这里一次测清楚请求顺序，三条路
// 不用各写一遍。原来钉在 HeardList.test.tsx:75/:116/:134 上的三条行为。
describe('请求顺序', () => {
  it('重试失败时留着已经拿到的列表，只多一条错误（HeardList.test.tsx:75）', async () => {
    const params: ConversationsParams = { from: 0, to: 100 }
    conversations.mockResolvedValueOnce({ items: [conv('c1', 10)] })
    const { result } = renderHook(() => useConversationList(params, null))
    await waitFor(() => expect(result.current.items).toEqual([conv('c1', 10)]))

    conversations.mockRejectedValueOnce(new Error('连不上后端'))
    await act(async () => {
      result.current.retry()
    })

    expect(result.current.items).toEqual([conv('c1', 10)])
    expect(result.current.error).toBe('连不上后端')
  })

  it('换视图换得快时，晚回来的旧结果不算数（HeardList.test.tsx:116）', async () => {
    let resolveOld: (v: unknown) => void = () => undefined
    conversations.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
    conversations.mockResolvedValueOnce({ items: [conv('cNew', 20)] })

    const { result, rerender } = renderHook(({ p }: { p: ConversationsParams }) => useConversationList(p, null), {
      initialProps: { p: { from: 0, to: 100 } },
    })

    // 换天/换来源/换搜索词都是换一次 viewParams，效果和这里的 rerender 一样。
    rerender({ p: { from: 100, to: 200 } })
    await waitFor(() => expect(result.current.items).toEqual([conv('cNew', 20)]))

    resolveOld({ items: [conv('cOld', 10)] })
    await new Promise((r) => setTimeout(r, 20))

    expect(result.current.items).toEqual([conv('cNew', 20)])
  })

  it('往前翻还没回来就切了视图，新视图的更早的照样能点（HeardList.test.tsx:134）', async () => {
    conversations.mockResolvedValueOnce({ items: [conv('c1', 10)], next: 'n1' })
    const { result, rerender } = renderHook(({ p }: { p: ConversationsParams }) => useConversationList(p, null), {
      initialProps: { p: { from: 0, to: 100 } },
    })
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    // 往前翻的这次请求挂着不回。
    conversations.mockImplementationOnce(() => new Promise(() => undefined))
    act(() => {
      result.current.loadMore()
    })
    expect(result.current.loadingMore).toBe(true)

    conversations.mockResolvedValueOnce({ items: [conv('c2', 20)], next: 'n2' })
    rerender({ p: { from: 200, to: 300 } })

    await waitFor(() => expect(result.current.items).toEqual([conv('c2', 20)]))
    expect(result.current.loadingMore).toBe(false)
    expect(result.current.hasMore).toBe(true)
  })
})

describe('后台轮询合并', () => {
  it('按 id 更新在原位，比最新一条还新的进新增缓冲区不直接插到最上面', async () => {
    const params: ConversationsParams = { view: 'unlogged' }
    conversations.mockResolvedValueOnce({ items: [conv('c2', 20), conv('c1', 10)] })
    const { result } = renderHook(() => useConversationList(params, null))
    await waitFor(() => expect(result.current.items.length).toBe(2))

    conversations.mockResolvedValueOnce({
      items: [conv('c3', 30), conv('c2', 20, { status: 'logged' })],
    })
    await act(async () => {
      await result.current.settleRefresh()
    })

    // c2 原地更新，c3 比原来最新的 c2(20) 还新，进缓冲区不直接插进来。
    expect(result.current.items.map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(result.current.items[0]!.status).toBe('logged')
    expect(result.current.newCount).toBe(1)

    act(() => {
      result.current.showNew()
    })
    expect(result.current.items.map((c) => c.id)).toEqual(['c3', 'c2', 'c1'])
    expect(result.current.newCount).toBe(0)
  })

  it('结算之后传入的 id 如果不再属于这个视图，直接从列表里摘掉', async () => {
    const params: ConversationsParams = { view: 'unlogged' }
    conversations.mockResolvedValueOnce({ items: [conv('c1', 10), conv('c2', 20)] })
    const { result } = renderHook(() => useConversationList(params, null))
    await waitFor(() => expect(result.current.items.length).toBe(2))

    // c1 入库之后不再是「未入库」，下一页已经不再包含它。
    conversations.mockResolvedValueOnce({ items: [conv('c2', 20)] })
    await act(async () => {
      await result.current.settleRefresh(['c1'])
    })

    expect(result.current.items.map((c) => c.id)).toEqual(['c2'])
  })
})

describe('viewParams 为 null', () => {
  it('不发请求，状态清空', () => {
    const { result } = renderHook(() => useConversationList(null, null))
    expect(conversations).not.toHaveBeenCalled()
    expect(result.current.items).toEqual([])
    expect(result.current.loading).toBe(false)
  })
})

// 收听页每次渲染都新建一个 viewParams 对象。store 每 15 秒刷一次、未入库计数
// 每 15 秒刷一次、放录音时每秒几次，页面一直在重新渲染。定时器跟着对象引用
// 重建的话，15 秒永远走不完，后台轮询一次都不跑。
describe('后台轮询', () => {
  it('父组件不停重新渲染，内容没变，15 秒的轮询照样按时跑', async () => {
    vi.useFakeTimers()
    try {
      conversations.mockResolvedValue({ items: [] })
      const { rerender } = renderHook(({ p }: { p: ConversationsParams }) => useConversationList(p, 15_000), {
        initialProps: { p: { from: 0, to: 100 } },
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const first = conversations.mock.calls.length

      for (let t = 0; t < 60_000; t += 5_000) {
        rerender({ p: { from: 0, to: 100 } })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000)
        })
      }

      expect(conversations.mock.calls.length - first).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
