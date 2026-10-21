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

// 真实的反查结果，参数和应用一致（jsonv2、zoom 14、addressdetails、accept-language zh）。
// 大陆的 city 是区，地级市不在 address 里，只在 display_name 里。
const RECORDED = {
  beijing: {
    display_name: '台基厂社区, 东华门街道, 首都功能核心区, 东城区, 北京市, 100010, 中国',
    address: { quarter: '台基厂社区', suburb: '东华门街道', city: '东城区', postcode: '100010', country: '中国' },
  },
  chengdu: {
    display_name: '春熙路街道, 锦江区, 成都市, 四川省, 中国',
    address: { suburb: '春熙路街道', city: '锦江区', state: '四川省', country: '中国' },
  },
  shenzhen: {
    display_name: '福中社区, 莲花街道, 福田区, 深圳市, 广东省, 518000, 中国',
    address: { quarter: '福中社区', suburb: '莲花街道', city: '福田区', state: '广东省', postcode: '518000', country: '中国' },
  },
  chongqing: {
    display_name: '罗家院社区, 大溪沟街道, 渝中区, 重庆市, 400014, 中国',
    address: { quarter: '罗家院社区', city_district: '大溪沟街道', city: '渝中区', state: '重庆市', postcode: '400014', country: '中国' },
  },
  tianjin: {
    display_name: '福明社区, 劝业场街道, 海光寺, 和平区, 天津市, 300010, 中国',
    address: { quarter: '福明社区', suburb: '劝业场街道', village: '海光寺', city: '和平区', state: '天津市', postcode: '300010', country: '中国' },
  },
  karamay: {
    display_name: '雅典娜社区, 迎宾街道, 克拉玛依区, 克拉玛依市, 新疆维吾尔自治区, 中国',
    address: { quarter: '雅典娜社区', suburb: '迎宾街道', city: '克拉玛依区', state: '新疆维吾尔自治区', country: '中国' },
  },
}

describe('qthFromNominatim', () => {
  const qth = (r: { display_name: string; address: object }) => qthFromNominatim(r.address, r.display_name)

  it('地级市加区：地级市只在 display_name 里，取 city 后面那一段', () => {
    expect(qth(RECORDED.chengdu)).toBe('成都市锦江区')
    expect(qth(RECORDED.shenzhen)).toBe('深圳市福田区')
    expect(qth(RECORDED.karamay)).toBe('克拉玛依市克拉玛依区')
  })

  it('直辖市：后面那一段就是省名，用它。北京没有 state，后面那段是北京市', () => {
    expect(qth(RECORDED.beijing)).toBe('北京市东城区')
    expect(qth(RECORDED.chongqing)).toBe('重庆市渝中区')
    expect(qth(RECORDED.tianjin)).toBe('天津市和平区')
  })

  it('街道不要：city_district 是街道时也只写到区', () => {
    expect(qth(RECORDED.chongqing)).not.toContain('街道')
    expect(qth(RECORDED.karamay)).not.toContain('街道')
  })

  it('city 后面不是地级单位：退到省名', () => {
    expect(
      qthFromNominatim({ city: '某区', state: '某省' }, '某街道, 某区, 某省, 中国'),
    ).toBe('某省某区')
  })

  it('display_name 里找不到 city 或根本没有：退到省名，省名也没有就只写区', () => {
    expect(qthFromNominatim({ city: '锦江区', state: '四川省' })).toBe('四川省锦江区')
    expect(qthFromNominatim({ city: '东城区' })).toBe('东城区')
  })

  it('city 本身就是地级市：不再往前加', () => {
    expect(qthFromNominatim({ state: '广东省', city: '深圳市', city_district: '南山区' })).toBe('深圳市南山区')
    expect(qthFromNominatim({ city: '嘉峪关市', district: '嘉峪关市' })).toBe('嘉峪关市')
  })

  it('县级：没有 city 时用县，再加镇或街道一级之外的区', () => {
    expect(qthFromNominatim({ state: '新疆', county: '克拉玛依区' })).toBe('克拉玛依区')
    expect(qthFromNominatim({ state: '甘肃省', town: '某镇', county: '某县' })).toBe('某镇某县')
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

  it('反查：WGS-84 坐标直接传，结果是地级市加区，不是 display_name', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => RECORDED.shenzhen })
    // 上一个测试排过队，等限速过去。
    await new Promise((r) => setTimeout(r, 1150))
    expect(await nominatimReverse({ lat: 22.5431, lon: 114.0579 })).toBe('深圳市福田区')
    const u = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(u.pathname).toBe('/reverse')
    expect(u.searchParams.get('lat')).toBe('22.5431')
    expect(u.searchParams.get('lon')).toBe('114.0579')
    expect(u.searchParams.get('accept-language')).toBe('zh')
  })

  it('服务回非 2xx 就抛错', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 })
    await new Promise((r) => setTimeout(r, 1150))
    await expect(nominatimSearch('北京')).rejects.toThrow('429')
  })
})
