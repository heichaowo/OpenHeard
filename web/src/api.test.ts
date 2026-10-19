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
})
