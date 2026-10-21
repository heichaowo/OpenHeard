import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ConversationsParams, HeardItem } from '../../api'
import { useQuiet } from '../../useQuiet'
import { isNewer, mergeLive, useConversationList } from './useConversationList'

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
  meaningless: false,
  ...over,
})

/** 带成员的对话：id 取最早一个成员的 id，和后端一致。 */
const withMembers = (ids: string[], startAt: number, over: Partial<Conversation> = {}): Conversation => {
  const activities: HeardItem[] = ids.map((id, i) => ({
    id,
    origin: 'brandmeister',
    startAt: startAt + i,
    durationS: 4,
    mine: false,
    talkgroup: 46001,
  }))
  return conv(ids[0]!, startAt, { activities, ...over })
}

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


// 页面给的 canInsert 一直变（滚动、展开、抽屉、刚碰过屏幕），所以这里用一个可变的开关。
describe('实时插入', () => {
  const params: ConversationsParams = { view: 'unlogged' }
  let can = false
  beforeEach(() => {
    can = false
  })

  const setup = async (first: Conversation[], next?: string) => {
    conversations.mockResolvedValueOnce({ items: first, next })
    const hook = renderHook(() => useConversationList(params, null, () => can))
    await waitFor(() => expect(hook.result.current.items.length).toBe(first.length))
    const poll = async (items: Conversation[], more?: string, dropIds: string[] = []) => {
      conversations.mockResolvedValueOnce({ items, next: more })
      await act(async () => {
        await hook.result.current.settleRefresh(dropIds)
      })
    }
    return { ...hook, poll }
  }
  const ids = (r: { current: { items: Conversation[] } }) => r.current.items.map((c) => c.id)

  it('列表是空的，拉到的直接显示，不进缓冲区', async () => {
    const { result, poll } = await setup([])
    await poll([conv('c2', 20), conv('c1', 10)])
    expect(ids(result)).toEqual(['c2', 'c1'])
    expect(result.current.newCount).toBe(0)
  })

  it('canInsert 为真：比最上面一行还新的直接插到最上面，不攒', async () => {
    const { result, poll } = await setup([conv('c2', 20), conv('c1', 10)])
    can = true
    await poll([conv('c3', 30), conv('c2', 20), conv('c1', 10)])
    expect(ids(result)).toEqual(['c3', 'c2', 'c1'])
    expect(result.current.newCount).toBe(0)
  })

  it('canInsert 为假：攒着，行不动；能动了下一次轮询连同新来的一起按位置插', async () => {
    const { result, poll } = await setup([conv('c2', 20), conv('c1', 10)])
    await poll([conv('c3', 30), conv('c2', 20), conv('c1', 10)])
    expect(ids(result)).toEqual(['c2', 'c1'])
    expect(result.current.newCount).toBe(1)

    can = true
    await poll([conv('c4', 40), conv('c3', 30), conv('c2', 20), conv('c1', 10)])
    expect(ids(result)).toEqual(['c4', 'c3', 'c2', 'c1'])
    expect(result.current.newCount).toBe(0)
  })

  it('能动了但这次没有新的，攒着的也照样插进去', async () => {
    const { result, poll } = await setup([conv('c2', 20)])
    await poll([conv('c3', 30), conv('c2', 20)])
    expect(result.current.newCount).toBe(1)
    can = true
    await poll([conv('c3', 30), conv('c2', 20)])
    expect(ids(result)).toEqual(['c3', 'c2'])
    expect(result.current.newCount).toBe(0)
  })

  it('比最上面一行老、但不比已加载的最老一条老的，按位置插在中间', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c1', 10)], 'n1')
    can = true
    await poll([conv('c3', 30), conv('c2', 20), conv('c1', 10)], 'n1')
    expect(ids(result)).toEqual(['c3', 'c2', 'c1'])
  })

  it('比已加载的最老一条还老、而且后面还有下一页：不收，留给「更早的」', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c2', 20)], 'n1')
    can = true
    await poll([conv('c3', 30), conv('c2', 20), conv('c0', 5)], 'n1')
    expect(ids(result)).toEqual(['c3', 'c2'])
    expect(result.current.newCount).toBe(0)
  })

  // brief-codebase.md §2：当天只有两行，守护进程回放落盘的批次，补进来一条 00:15 的，
  // 比两行都老，而且没有「更早的」。原来这种直接丢，要刷新页面才出来。
  it('没有下一页时，比所有行都老的补进来的也收：不能动先攒着，能动就插在最后', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c2', 20)])
    await poll([conv('c3', 30), conv('c2', 20), conv('c0', 5)])
    expect(ids(result)).toEqual(['c3', 'c2'])
    expect(result.current.newCount).toBe(1)
    expect(result.current.newKind).toBe('backfill')

    can = true
    await poll([conv('c3', 30), conv('c2', 20), conv('c0', 5)])
    expect(ids(result)).toEqual(['c3', 'c2', 'c0'])
    expect(result.current.newCount).toBe(0)
  })

  it('提示条：攒着的都比最上面一行新写「新的」，有更早的补进来写「新补进来的」', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c2', 20)])
    await poll([conv('c4', 40), conv('c3', 30), conv('c2', 20)])
    expect(result.current.newKind).toBe('new')
    await poll([conv('c4', 40), conv('c3', 30), conv('c2', 20), conv('c1', 10)])
    expect(result.current.newCount).toBe(2)
    expect(result.current.newKind).toBe('backfill')
  })

  it('点「有 n 段新的」：攒着的按位置插进去，条清空', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c1', 10)])
    await poll([conv('c4', 40), conv('c3', 30), conv('c2', 20), conv('c1', 10)])
    expect(result.current.newCount).toBe(2)
    act(() => result.current.showNew())
    expect(ids(result)).toEqual(['c4', 'c3', 'c2', 'c1'])
    expect(result.current.newCount).toBe(0)
  })

  // 手指刚落下去，直接点行上的按钮：展开、抽屉、勾选都没变，只有 useQuiet 看得出来。
  describe('刚碰过屏幕', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
    afterEach(() => vi.useRealTimers())

    it('pointerdown 之后 3 秒内的轮询只攒着，行留在原处；静下来之后的下一轮才插', async () => {
      conversations.mockResolvedValueOnce({ items: [conv('c2', 20), conv('c1', 10)] })
      const { result } = renderHook(() => {
        const quiet = useQuiet()
        return useConversationList(params, null, quiet)
      })
      await waitFor(() => expect(result.current.items.length).toBe(2))

      act(() => {
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      })
      vi.setSystemTime(Date.now() + 1000)
      conversations.mockResolvedValueOnce({ items: [conv('c3', 30), conv('c2', 20), conv('c1', 10)] })
      await act(async () => {
        await result.current.settleRefresh()
      })
      expect(ids(result)).toEqual(['c2', 'c1'])
      expect(result.current.newCount).toBe(1)

      vi.setSystemTime(Date.now() + 3000)
      conversations.mockResolvedValueOnce({ items: [conv('c3', 30), conv('c2', 20), conv('c1', 10)] })
      await act(async () => {
        await result.current.settleRefresh()
      })
      expect(ids(result)).toEqual(['c3', 'c2', 'c1'])
      expect(result.current.newCount).toBe(0)
    })
  })
})

// contract-review.md「Member-overlap replacement」的四个场景：对话 id 是最早一个成员的 id，
// 更早的发射补进来、对话拆开或者合并，id 就变了，行得按成员认出来。
describe('按成员认人', () => {
  const params: ConversationsParams = { view: 'unlogged' }
  let can = false
  beforeEach(() => {
    can = false
  })
  const setup = async (first: Conversation[], next?: string) => {
    conversations.mockResolvedValueOnce({ items: first, next })
    const hook = renderHook(() => useConversationList(params, null, () => can))
    await waitFor(() => expect(hook.result.current.items.length).toBe(first.length))
    const poll = async (items: Conversation[], more?: string) => {
      conversations.mockResolvedValueOnce({ items, next: more })
      await act(async () => {
        await hook.result.current.settleRefresh()
      })
    }
    return { ...hook, poll }
  }
  const ids = (r: { current: { items: Conversation[] } }) => r.current.items.map((c) => c.id)

  it('(1) 更早的发射补进来 id 变了：原地换成新 id，不重复，renamed 记着，行没有标已变', async () => {
    const { result, poll } = await setup([withMembers(['b1'], 50), withMembers(['a1', 'a2', 'a3'], 10)])
    await poll([withMembers(['b1'], 50), withMembers(['a0', 'a1', 'a2', 'a3'], 5)])
    expect(ids(result)).toEqual(['b1', 'a0'])
    expect(result.current.items[1]!.activities.map((a) => a.id)).toEqual(['a0', 'a1', 'a2', 'a3'])
    expect(result.current.renamed).toEqual({ a1: 'a0' })
    expect(result.current.stale.size).toBe(0)
    expect(result.current.newCount).toBe(0)
  })

  it('(1) 连着变两次：a1→a0 再 a0→a_，renamed 接起来', async () => {
    const { result, poll } = await setup([withMembers(['a1', 'a2'], 10)])
    await poll([withMembers(['a0', 'a1', 'a2'], 5)])
    await poll([withMembers(['a_', 'a0', 'a1', 'a2'], 2)])
    expect(ids(result)).toEqual(['a_'])
    expect(result.current.renamed).toEqual({ a1: 'a_', a0: 'a_' })
  })

  it('(2) 中间的成员单独结算，一段拆成两段：一个认领原来的位置，另一个走插入的规矩，不出现重复的 key', async () => {
    const { result, poll } = await setup([withMembers(['a0', 'a1', 'a2', 'a3'], 10)])
    await poll([withMembers(['a2', 'a3'], 12), withMembers(['a0', 'a1'], 10)])
    // 拉到的顺序是新到旧，先拉到的 a2 那段认领原来那一行，a0 那段重叠的只剩已认领的格子，走插入的规矩。
    expect(ids(result)).toEqual(['a2'])
    expect(result.current.renamed).toEqual({ a0: 'a2' })
    expect(result.current.items[0]!.activities.length).toBe(2)
    expect(result.current.newCount).toBe(1)

    can = true
    await poll([withMembers(['a2', 'a3'], 12), withMembers(['a0', 'a1'], 10)])
    const got = ids(result)
    expect(got).toEqual(['a2', 'a0'])
    expect(new Set(got).size).toBe(got.length)
    expect(result.current.newCount).toBe(0)
  })

  it('(3) 攒着的那条 id 变了：缓冲区里只留新的一份，条上还是 1 段', async () => {
    const { result, poll } = await setup([conv('c1', 10)])
    await poll([withMembers(['b1', 'b2'], 30), conv('c1', 10)])
    expect(result.current.newCount).toBe(1)
    await poll([withMembers(['b0', 'b1', 'b2'], 25), conv('c1', 10)])
    expect(result.current.newCount).toBe(1)
    expect(result.current.renamed).toEqual({ b1: 'b0' })
    act(() => result.current.showNew())
    expect(ids(result)).toEqual(['b0', 'c1'])
  })

  it('(4) 「更早的」拉回来的页里，游标那一行换了 id：原地换，不在后面再追加一份', async () => {
    const r = withMembers(['r'], 1000)
    const { result } = await setup([withMembers(['t'], 2000), r], 'cursor1')
    conversations.mockResolvedValueOnce({
      // r 补进了一个更早的成员 b0，id 变成 b0，startAt 990，在游标之前。
      items: [withMembers(['b0', 'r'], 990), withMembers(['o'], 500)],
      next: undefined,
    })
    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.loadingMore).toBe(false))
    expect(ids(result)).toEqual(['t', 'b0', 'o'])
    expect(result.current.renamed).toEqual({ r: 'b0' })
    expect(result.current.hasMore).toBe(false)
  })

  it('「更早的」拉回来的页里已经显示的 id 不重复，新的接在最后，游标取这一页的', async () => {
    const { result } = await setup([conv('c3', 30), conv('c2', 20)], 'n1')
    conversations.mockResolvedValueOnce({ items: [conv('c2', 20), conv('c1', 10)], next: 'n2' })
    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.loadingMore).toBe(false))
    expect(ids(result)).toEqual(['c3', 'c2', 'c1'])
    expect(result.current.hasMore).toBe(true)
    expect(conversations).toHaveBeenLastCalledWith({ ...params, cursor: 'n1' })
  })

  it('结算了一部分发射，剩下的重新聚成新 id：原地换，不是摘掉再攒着', async () => {
    const { result } = await setup([withMembers(['a1', 'a2', 'a3'], 10)])
    conversations.mockResolvedValueOnce({ items: [withMembers(['a3'], 12)] })
    await act(async () => {
      await result.current.settleRefresh(['a1'])
    })
    expect(ids(result)).toEqual(['a3'])
    expect(result.current.renamed).toEqual({ a1: 'a3' })
    expect(result.current.newCount).toBe(0)
  })
})

describe('游标', () => {
  const params: ConversationsParams = { view: 'unlogged' }
  const setup = async (first: Conversation[], next?: string) => {
    conversations.mockResolvedValueOnce({ items: first, next })
    const hook = renderHook(() => useConversationList(params, null))
    await waitFor(() => expect(hook.result.current.items.length).toBe(first.length))
    return hook
  }
  const poll = async (hook: Awaited<ReturnType<typeof setup>>, items: Conversation[], next?: string) => {
    conversations.mockResolvedValueOnce({ items, next })
    await act(async () => {
      await hook.result.current.settleRefresh()
    })
  }

  it('原来没有下一页，现在一页装不下了：有「更早的」，游标用这一页的', async () => {
    const hook = await setup([conv('c1', 10)])
    expect(hook.result.current.hasMore).toBe(false)
    await poll(hook, [conv('c1', 10)], 'n9')
    expect(hook.result.current.hasMore).toBe(true)
    conversations.mockResolvedValueOnce({ items: [], next: undefined })
    await act(async () => {
      hook.result.current.loadMore()
    })
    expect(conversations).toHaveBeenLastCalledWith({ ...params, cursor: 'n9' })
  })

  it('已经往后翻过：轮询第一页的游标不覆盖往后翻到的那一头', async () => {
    const hook = await setup([conv('c3', 30)], 'n1')
    conversations.mockResolvedValueOnce({ items: [conv('c2', 20)], next: 'n2' })
    await act(async () => {
      hook.result.current.loadMore()
    })
    await waitFor(() => expect(hook.result.current.loadingMore).toBe(false))
    await poll(hook, [conv('c3', 30)], 'n1')
    conversations.mockResolvedValueOnce({ items: [], next: undefined })
    await act(async () => {
      hook.result.current.loadMore()
    })
    expect(conversations).toHaveBeenLastCalledWith({ ...params, cursor: 'n2' })
  })

  it('翻到了头：之后的轮询不把「更早的」带回来', async () => {
    const hook = await setup([conv('c3', 30)], 'n1')
    conversations.mockResolvedValueOnce({ items: [conv('c2', 20)], next: undefined })
    await act(async () => {
      hook.result.current.loadMore()
    })
    await waitFor(() => expect(hook.result.current.loadingMore).toBe(false))
    expect(hook.result.current.hasMore).toBe(false)

    await poll(hook, [conv('c3', 30)], 'n1')

    expect(hook.result.current.hasMore).toBe(false)
    expect(hook.result.current.items.map((c) => c.id)).toEqual(['c3', 'c2'])
  })

  it('第一页已经是全部：没有「更早的」', async () => {
    const hook = await setup([conv('c2', 20), conv('c1', 10)], 'n1')
    await poll(hook, [conv('c2', 20), conv('c1', 10)])
    expect(hook.result.current.hasMore).toBe(false)
  })
})

// 轮询和结算之后的刷新会同时在路上，先发的未必先回。
describe('旧的响应', () => {
  const params: ConversationsParams = { view: 'unlogged' }

  it('结算之前发出的轮询迟到了：不把已经摘掉的行带回来', async () => {
    const c = [conv('c3', 30), conv('c2', 20), conv('c1', 10)]
    conversations.mockResolvedValueOnce({ items: c })
    const hook = renderHook(() => useConversationList(params, null, () => true))
    await waitFor(() => expect(hook.result.current.items.length).toBe(3))

    let late!: (v: unknown) => void
    conversations.mockReturnValueOnce(new Promise((r) => (late = r)))
    let slow!: Promise<void>
    act(() => {
      slow = hook.result.current.settleRefresh()
    })
    conversations.mockResolvedValueOnce({ items: [c[0]!, c[2]!] })
    await act(async () => {
      await hook.result.current.settleRefresh(['c2'])
    })
    expect(hook.result.current.items.map((x) => x.id)).toEqual(['c3', 'c1'])

    await act(async () => {
      late({ items: c })
      await slow
    })

    expect(hook.result.current.items.map((x) => x.id)).toEqual(['c3', 'c1'])
  })
})

// 行要离开视图（比如 AI 刚把它判成无意义）和行要进来受同一道门：人在操作时先留在原处。
describe('行离开视图', () => {
  const params: ConversationsParams = { view: 'unlogged' }
  let can = false
  beforeEach(() => {
    can = false
  })
  const setup = async (first: Conversation[], next?: string) => {
    conversations.mockResolvedValueOnce({ items: first, next })
    const hook = renderHook(() => useConversationList(params, null, () => can))
    await waitFor(() => expect(hook.result.current.items.length).toBe(first.length))
    const poll = async (items: Conversation[], more?: string, dropIds: string[] = []) => {
      conversations.mockResolvedValueOnce({ items, next: more })
      await act(async () => {
        await hook.result.current.settleRefresh(dropIds)
      })
    }
    return { ...hook, poll }
  }
  const ids = (r: { current: { items: Conversation[] } }) => r.current.items.map((c) => c.id)

  it('不能动列表时，在这一页范围里却没出现的行留在原处，标已变；能动了再摘', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c2', 20), conv('c1', 10)])
    await poll([conv('c3', 30), conv('c1', 10)])
    expect(ids(result)).toEqual(['c3', 'c2', 'c1'])
    expect([...result.current.stale]).toEqual(['c2'])

    // 下一轮人还在操作，照样留着。
    await poll([conv('c3', 30), conv('c1', 10)])
    expect([...result.current.stale]).toEqual(['c2'])
    expect(ids(result)).toEqual(['c3', 'c2', 'c1'])

    can = true
    await poll([conv('c3', 30), conv('c1', 10)])
    expect(ids(result)).toEqual(['c3', 'c1'])
    expect(result.current.stale.size).toBe(0)
  })

  it('能动列表时直接摘，不经过已变', async () => {
    const { result, poll } = await setup([conv('c2', 20), conv('c1', 10)])
    can = true
    await poll([conv('c1', 10)])
    expect(ids(result)).toEqual(['c1'])
    expect(result.current.stale.size).toBe(0)
  })

  it('比这一页最老一条还老的行，这一页看不到它，原样留着，不标已变', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c2', 20), conv('c1', 10)], 'n1')
    can = true
    // 第一页只有两行：c1 落在页外。
    await poll([conv('c3', 30), conv('c2', 20)], 'n1')
    expect(ids(result)).toEqual(['c3', 'c2', 'c1'])
    expect(result.current.stale.size).toBe(0)
  })

  it('人自己结算掉的（dropIds）不再属于这个视图，直接摘，不标已变', async () => {
    const { result, poll } = await setup([conv('c2', 20), conv('c1', 10)])
    await poll([conv('c2', 20)], undefined, ['c1'])
    expect(ids(result)).toEqual(['c2'])
    expect(result.current.stale.size).toBe(0)
  })

  it('标了已变的行又出现在结果里：恢复正常', async () => {
    const { result, poll } = await setup([conv('c2', 20), conv('c1', 10)])
    await poll([conv('c1', 10)])
    expect(result.current.stale.has('c2')).toBe(true)
    await poll([conv('c2', 20, { status: 'ignored' }), conv('c1', 10)])
    expect(result.current.stale.size).toBe(0)
    expect(result.current.items[0]!.status).toBe('ignored')
  })

  it('一页装得下全部（没有 next）：没出现的行不论位置都算没了', async () => {
    const { result, poll } = await setup([conv('c3', 30), conv('c2', 20), conv('c1', 10)])
    await poll([conv('c3', 30), conv('c2', 20)])
    expect([...result.current.stale]).toEqual(['c1'])
  })

  it('攒着还没露面的就没了：悄悄丢掉，条上不再算它', async () => {
    const { result, poll } = await setup([conv('c1', 10)])
    await poll([conv('c2', 20), conv('c1', 10)])
    expect(result.current.newCount).toBe(1)
    await poll([conv('c1', 10)])
    expect(result.current.newCount).toBe(0)
  })

  it('这一页拉回来是空的：所有行都没了，同样先留着，能动了再清', async () => {
    const { result, poll } = await setup([conv('c2', 20), conv('c1', 10)])
    await poll([])
    expect(ids(result)).toEqual(['c2', 'c1'])
    expect(result.current.stale.size).toBe(2)
    can = true
    await poll([])
    expect(ids(result)).toEqual([])
  })
})

// 待确认不走这个 hook，但用同一套规矩，只是旧到新排。
describe('mergeLive 的排序可以换', () => {
  it('旧到新排时，新来的按位置插，能动列表时没出现的行才摘', () => {
    const asc = (a: Conversation, b: Conversation) => isNewer(b, a)
    const cur = { items: [conv('p1', 10), conv('p2', 20)], buffer: [], stale: new Set<string>() }
    const held = mergeLive(cur, [conv('p2', 20), conv('p3', 30)], { canInsert: false, hasNext: false, complete: true, before: asc })
    expect(held.items.map((c) => c.id)).toEqual(['p1', 'p2'])
    expect([...held.stale]).toEqual(['p1'])
    expect(held.buffer.map((c) => c.id)).toEqual(['p3'])

    const go = mergeLive(held, [conv('p2', 20), conv('p3', 30)], { canInsert: true, hasNext: false, complete: true, before: asc })
    expect(go.items.map((c) => c.id)).toEqual(['p2', 'p3'])
    expect(go.stale.size).toBe(0)
  })
})
