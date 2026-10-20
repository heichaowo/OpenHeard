import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('api 的请求体', () => {
  // 服务端按平铺的草稿读字段。包了一层 draft 的话，每次入库都 422。
  it('入库时草稿字段和 activityIds 平铺在同一层', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'q1' }), { status: 201 }))
    vi.stubGlobal('fetch', fetch)

    await api.promoteActivities(['a1', 'a2'], { call: 'BA1AA', rstSent: '59' })

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/conversations/promote')
    expect(JSON.parse(init.body as string)).toEqual({ call: 'BA1AA', rstSent: '59', activityIds: ['a1', 'a2'] })
  })

  it('删除带上每段看到的那几次发射，回 200 的 deleted 和 missing 原样给出', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ deleted: 1, missing: ['b1'] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const picks = [{ id: 'a1', activityIds: ['a1', 'a2'] }, { id: 'b1', activityIds: ['b1'] }]

    expect(await api.deleteConversations(picks)).toEqual({ deleted: 1, missing: ['b1'] })

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/conversations/delete')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ picks })
  })

  it('改判回 204，没有响应体', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)

    expect(await api.setVerdict(['a1', 'a2'], false)).toBeUndefined()

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/conversations/verdict')
    expect(JSON.parse(init.body as string)).toEqual({ activityIds: ['a1', 'a2'], meaningless: false })
  })
})
