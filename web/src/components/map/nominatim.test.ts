import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLimiter, nominatimReverse, nominatimSearch, qthFromNominatim } from './nominatim'

describe('限速队列', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('请求起点之间至少隔 gap：同时来三个，一个接一个发', async () => {
    const limited = createLimiter(1100)
    const started: number[] = []
    const t0 = Date.now()
    const run = () =>
      limited('search', async () => {
        started.push(Date.now() - t0)
      })
    const all = Promise.all([run(), run(), run()])
    await vi.advanceTimersByTimeAsync(3000)
    await all
    expect(started).toEqual([0, 1100, 2200])
  })

  it('搜索和反查共用一条队列，不是各 1 个每秒', async () => {
    const limited = createLimiter(1100)
    const started: string[] = []
    const t0 = Date.now()
    const all = Promise.all([
      limited('search', async () => void started.push(`s${Date.now() - t0}`)),
      limited('reverse', async () => void started.push(`r${Date.now() - t0}`)),
    ])
    await vi.advanceTimersByTimeAsync(2000)
    await all
    expect(started).toEqual(['s0', 'r1100'])
  })

  it('排着队还没发的反查只留最后一个，前面的丢掉；搜索不丢', async () => {
    const limited = createLimiter(1100)
    const ran: string[] = []
    const first = limited('search', async () => void ran.push('search0'))
    const r1 = limited('reverse', async () => void ran.push('rev1'))
    const r2 = limited('reverse', async () => void ran.push('rev2'))
    const s2 = limited('search', async () => void ran.push('search2'))
    const r3 = limited('reverse', async () => void ran.push('rev3'))
    await vi.advanceTimersByTimeAsync(5000)
    await Promise.all([first, r1, r2, s2, r3])
    expect(ran).toEqual(['search0', 'search2', 'rev3'])
    expect(await r1).toBeUndefined()
  })

  it('一个请求失败，不卡住后面的', async () => {
    const limited = createLimiter(1100)
    const bad = limited('search', async () => {
      throw new Error('boom')
    })
    const good = limited('search', async () => 'ok')
    const caught = bad.catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await caught).toBe('boom')
    expect(await good).toBe('ok')
  })
})

describe('qthFromNominatim', () => {
  it('城市加区：深圳市南山区', () => {
    expect(qthFromNominatim({ state: '广东省', city: '深圳市', city_district: '南山区' })).toBe('深圳市南山区')
  })

  it('县级：没有 city 时用县，再加镇或街道一级之外的区', () => {
    expect(qthFromNominatim({ state: '新疆', county: '克拉玛依区' })).toBe('克拉玛依区')
    expect(qthFromNominatim({ state: '甘肃省', town: '某镇', county: '某县' })).toBe('某镇某县')
  })

  it('街道不要：克拉玛依的反查只有 city（区级）和 suburb（街道），只写区', () => {
    expect(qthFromNominatim({ city: '克拉玛依区', suburb: '昆仑路街道', state: '新疆维吾尔自治区' } as never)).toBe('克拉玛依区')
  })

  it('城市和区重名不写两遍', () => {
    expect(qthFromNominatim({ city: '嘉峪关市', district: '嘉峪关市' })).toBe('嘉峪关市')
  })

  it('什么都没有就是 undefined', () => {
    expect(qthFromNominatim({})).toBeUndefined()
    expect(qthFromNominatim(undefined)).toBeUndefined()
  })
})

describe('Nominatim 请求', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('搜索：限定国内、中文、最多 5 条；不设 referrerPolicy，不加自定义头', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '39.9', lon: '116.4', display_name: '北京, 北京市, 中国' }],
    })
    const hits = await nominatimSearch('北京')
    const [url, init] = fetchMock.mock.calls[0]!
    const u = new URL(url as string)
    expect(u.origin + u.pathname).toBe('https://nominatim.openstreetmap.org/search')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      q: '北京',
      countrycodes: 'cn',
      'accept-language': 'zh',
      limit: '5',
      format: 'jsonv2',
    })
    expect(init).toBeUndefined()
    expect(hits).toEqual([{ name: '北京', detail: '北京市, 中国', point: { lat: 39.9, lon: 116.4 } }])
  })

  it('反查：WGS-84 坐标直接传，结果用城市加区，不是 display_name', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        display_name: '某路, 南山区, 深圳市, 广东省, 中国',
        address: { city: '深圳市', city_district: '南山区', road: '某路' },
      }),
    })
    // 上一个测试排过队，等限速过去。
    await new Promise((r) => setTimeout(r, 1150))
    expect(await nominatimReverse({ lat: 22.5, lon: 113.9 })).toBe('深圳市南山区')
    const u = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(u.pathname).toBe('/reverse')
    expect(u.searchParams.get('lat')).toBe('22.5')
    expect(u.searchParams.get('lon')).toBe('113.9')
    expect(u.searchParams.get('accept-language')).toBe('zh')
  })

  it('服务回非 2xx 就抛错', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 })
    await new Promise((r) => setTimeout(r, 1150))
    await expect(nominatimSearch('北京')).rejects.toThrow('429')
  })
})
