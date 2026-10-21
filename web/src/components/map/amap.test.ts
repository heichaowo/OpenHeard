import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gcj02ToWgs84, gridBounds, wgs84ToGcj02 } from '@core'
import { buildAmap, qthFromAmap } from './amap'
import type { AmapNamespace } from './amap'

/** 高德的 LngLat：只有 getLng/getLat。 */
const ll = (lng: number, lat: number) => ({ getLng: () => lng, getLat: () => lat })

/** 假的高德命名空间：记下每个对象收到的坐标，用来查进出有没有换。 */
function fakeAmap() {
  const handlers: Record<string, (e?: unknown) => void> = {}
  const markerHandlers: Record<string, () => void> = {}
  const calls = {
    mapOpts: undefined as unknown,
    markerOpts: undefined as unknown,
    markerPos: undefined as unknown,
    polygonOpts: undefined as unknown,
    zoomCenter: undefined as unknown,
    removed: [] as string[],
  }
  let markerPos: [number, number] = [0, 0]
  const Namespace: AmapNamespace = {
    Map: class {
      constructor(_el: HTMLElement, opts: unknown) {
        calls.mapOpts = opts
      }
      on(ev: string, cb: (e?: unknown) => void) {
        handlers[ev] = cb
      }
      setZoomAndCenter(zoom: number, center: [number, number]) {
        calls.zoomCenter = { zoom, center }
      }
      getZoom() {
        return 11
      }
      destroy() {
        calls.removed.push('map')
      }
    },
    Marker: class {
      constructor(opts: { position: [number, number] }) {
        calls.markerOpts = opts
        markerPos = opts.position
      }
      setPosition(p: [number, number]) {
        calls.markerPos = p
        markerPos = p
      }
      getPosition() {
        return ll(markerPos[0], markerPos[1])
      }
      on(ev: string, cb: () => void) {
        markerHandlers[ev] = cb
      }
      setMap(m: unknown) {
        if (m === null) calls.removed.push('marker')
      }
    },
    Polygon: class {
      constructor(opts: unknown) {
        calls.polygonOpts = opts
      }
      setMap(m: unknown) {
        if (m === null) calls.removed.push('polygon')
      }
    },
    PlaceSearch: class {
      search(_kw: string, cb: (s: 'complete' | 'no_data' | 'error', r: { poiList?: { pois: unknown[] } }) => void) {
        searchImpl(cb)
      }
    },
    Geocoder: class {
      getAddress(p: [number, number], cb: (s: 'complete' | 'no_data' | 'error', r: unknown) => void) {
        reverseImpl(p, cb)
      }
    },
  } as unknown as AmapNamespace
  let searchImpl: (cb: (s: 'complete' | 'no_data' | 'error', r: { poiList?: { pois: unknown[] } }) => void) => void = () => undefined
  let reverseImpl: (p: [number, number], cb: (s: 'complete' | 'no_data' | 'error', r: unknown) => void) => void = () => undefined
  return {
    AMap: Namespace,
    calls,
    handlers,
    markerHandlers,
    onSearch: (f: typeof searchImpl) => (searchImpl = f),
    onReverse: (f: typeof reverseImpl) => (reverseImpl = f),
  }
}

const BEIJING = { lat: 39.9042, lon: 116.4074 }
const init = (center = BEIJING) => ({ el: document.createElement('div'), center, zoom: 11 })

// 高德的坐标系是 GCJ-02，比 WGS-84 偏几百米。网格按 WGS-84 算，进出的每一个点都要换。
describe('高德适配器的坐标换算', () => {
  it('初始视图中心：WGS-84 换成 GCJ-02 再给地图', () => {
    const f = fakeAmap()
    buildAmap(f.AMap, init())
    const g = wgs84ToGcj02(BEIJING.lat, BEIJING.lon)
    expect((f.calls.mapOpts as { center: number[] }).center).toEqual([g.lon, g.lat])
  })

  it('摆标记：位置是换过的 GCJ-02，顺序是 [lng, lat]', () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    adapter.setMarker(BEIJING)
    const g = wgs84ToGcj02(BEIJING.lat, BEIJING.lon)
    expect((f.calls.markerOpts as { position: number[]; draggable: boolean }).position).toEqual([g.lon, g.lat])
    expect((f.calls.markerOpts as { draggable: boolean }).draggable).toBe(true)
    adapter.setMarker({ lat: 31.2304, lon: 121.4737 })
    const s = wgs84ToGcj02(31.2304, 121.4737)
    expect(f.calls.markerPos).toEqual([s.lon, s.lat])
  })

  it('点地图：读到的 GCJ-02 换回 WGS-84 再交出去', () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    const got: { lat: number; lon: number }[] = []
    adapter.onPick((p) => got.push(p))
    const g = wgs84ToGcj02(BEIJING.lat, BEIJING.lon)
    f.handlers.click!({ lnglat: ll(g.lon, g.lat) })
    expect(got).toHaveLength(1)
    expect(got[0]!.lat).toBeCloseTo(BEIJING.lat, 9)
    expect(got[0]!.lon).toBeCloseTo(BEIJING.lon, 9)
  })

  it('拖标记：从标记当前位置读，同样换回 WGS-84', () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    const got: { lat: number; lon: number }[] = []
    adapter.onPick((p) => got.push(p))
    adapter.setMarker(BEIJING)
    f.markerHandlers.dragend!()
    expect(got[0]!.lat).toBeCloseTo(BEIJING.lat, 9)
    expect(got[0]!.lon).toBeCloseTo(BEIJING.lon, 9)
  })

  it('程序摆标记不算人选点', () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    const got: unknown[] = []
    adapter.onPick((p) => got.push(p))
    adapter.setMarker(BEIJING)
    adapter.setMarker({ lat: 31, lon: 121 })
    expect(got).toEqual([])
  })

  it('格子：四个角各自换成 GCJ-02 的多边形，不加中点', () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    adapter.setCell('OM89EV')
    const b = gridBounds('OM89EV')
    const corner = (lat: number, lon: number) => {
      const g = wgs84ToGcj02(lat, lon)
      return [g.lon, g.lat]
    }
    expect((f.calls.polygonOpts as { path: number[][] }).path).toEqual([
      corner(b.south, b.west),
      corner(b.south, b.east),
      corner(b.north, b.east),
      corner(b.north, b.west),
    ])
    adapter.setCell(null)
    expect(f.calls.removed).toContain('polygon')
  })

  it('移视图：中心也换', () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    adapter.setView(BEIJING, 13)
    const g = wgs84ToGcj02(BEIJING.lat, BEIJING.lon)
    expect(f.calls.zoomCenter).toEqual({ zoom: 13, center: [g.lon, g.lat] })
  })

  it('搜地名：结果的 GCJ-02 换回 WGS-84，没有位置的（公交线路）跳过', async () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    const g = wgs84ToGcj02(BEIJING.lat, BEIJING.lon)
    f.onSearch((cb) =>
      cb('complete', {
        poiList: {
          pois: [
            { name: '天安门', cityname: '北京市', adname: '东城区', location: ll(g.lon, g.lat) },
            { name: '1路', location: undefined },
          ],
        },
      }),
    )
    const hits = await adapter.search('天安门')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.name).toBe('天安门')
    expect(hits[0]!.detail).toBe('北京市 东城区')
    expect(hits[0]!.point.lat).toBeCloseTo(BEIJING.lat, 9)
    expect(hits[0]!.point.lon).toBeCloseTo(BEIJING.lon, 9)
  })

  it('搜不到是空数组，出错是抛错', async () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    f.onSearch((cb) => cb('no_data', {}))
    expect(await adapter.search('x')).toEqual([])
    f.onSearch((cb) => cb('error', {}))
    await expect(adapter.search('x')).rejects.toThrow()
  })

  it('反查：传给高德的是换过的 GCJ-02，结果取城市加区', async () => {
    const f = fakeAmap()
    const { adapter } = buildAmap(f.AMap, init())
    let sent: number[] = []
    f.onReverse((p, cb) => {
      sent = p
      cb('complete', { regeocode: { addressComponent: { province: '广东省', city: '深圳市', district: '南山区' } } })
    })
    expect(await adapter.reverse(BEIJING)).toBe('深圳市南山区')
    const g = wgs84ToGcj02(BEIJING.lat, BEIJING.lon)
    expect(sent).toEqual([g.lon, g.lat])
  })

  it('换算本身互逆：WGS→GCJ→WGS 回到原点', () => {
    const g = wgs84ToGcj02(BEIJING.lat, BEIJING.lon)
    const w = gcj02ToWgs84(g.lat, g.lon)
    expect(w.lat).toBeCloseTo(BEIJING.lat, 9)
  })
})

describe('qthFromAmap', () => {
  it('城市加区', () => {
    expect(qthFromAmap({ province: '广东省', city: '深圳市', district: '南山区' })).toBe('深圳市南山区')
  })

  it('直辖市的 city 是空数组：退回省名', () => {
    expect(qthFromAmap({ province: '北京市', city: [], district: '海淀区' })).toBe('北京市海淀区')
  })

  it('没有任何信息是 undefined', () => {
    expect(qthFromAmap({})).toBeUndefined()
    expect(qthFromAmap(undefined)).toBeUndefined()
  })
})

describe('loadAMap', () => {
  const scripts = () => [...document.head.querySelectorAll<HTMLScriptElement>('script[src*="webapi.amap.com"]')]
  // 加载状态是模块级的，每个用例要一份新的。
  let loadAMap: typeof import('./amap').loadAMap
  beforeEach(async () => {
    vi.resetModules()
    loadAMap = (await import('./amap')).loadAMap
    delete window.AMap
    delete window._AMapSecurityConfig
  })
  afterEach(() => {
    scripts().forEach((s) => s.remove())
    delete window.AMap
  })

  it('先设安全配置再加脚本：走本站的代理，安全密钥不进页面', () => {
    void loadAMap('pubkey').catch(() => undefined)
    expect(window._AMapSecurityConfig).toEqual({ serviceHost: `${location.origin}/_AMapService` })
    const [s] = scripts()
    expect(s!.src).toBe(
      'https://webapi.amap.com/maps?v=2.0&key=pubkey&plugin=AMap.AutoComplete,AMap.PlaceSearch,AMap.Geocoder',
    )
    s!.onerror?.(new Event('error'))
  })

  it('加载成功给回 AMap；已经有了就不再加脚本', async () => {
    const p = loadAMap('k1')
    const [s] = scripts()
    window.AMap = { tag: 1 } as unknown as AmapNamespace
    s!.onload?.(new Event('load'))
    expect(await p).toBe(window.AMap)
    const before = scripts().length
    expect(await loadAMap('k1')).toBe(window.AMap)
    expect(scripts().length).toBe(before)
  })

  it('加载中再叫一次，等的是同一个脚本', () => {
    const a = loadAMap('k2').catch(() => undefined)
    const b = loadAMap('k2').catch(() => undefined)
    expect(scripts()).toHaveLength(1)
    scripts()[0]!.onerror?.(new Event('error'))
    return Promise.all([a, b])
  })

  it('失败之后能重试：旧脚本标签撤掉，再叫一次重新加', async () => {
    const first = loadAMap('k3')
    scripts()[0]!.onerror?.(new Event('error'))
    await expect(first).rejects.toThrow('高德脚本加载失败')
    expect(scripts()).toHaveLength(0)

    const again = loadAMap('k3')
    expect(scripts()).toHaveLength(1)
    window.AMap = { tag: 2 } as unknown as AmapNamespace
    scripts()[0]!.onload?.(new Event('load'))
    expect(await again).toBe(window.AMap)
  })

  // key 写在脚本的地址里，加载过之后换不了。认不出来的话，换了 key 的人永远在用旧的。
  it('加载过之后换 key：不假装用上了新的，要人刷新页面', async () => {
    const p = loadAMap('old')
    window.AMap = { tag: 3 } as unknown as AmapNamespace
    scripts()[0]!.onload?.(new Event('load'))
    await p

    await expect(loadAMap('new')).rejects.toThrow('改了高德 key，要刷新页面才能用新的')
    expect(scripts()).toHaveLength(1)
    // 同一个 key 照常。
    expect(await loadAMap('old')).toBe(window.AMap)
  })

  it('脚本加载了却没有 AMap 也算失败', async () => {
    const p = loadAMap('k4')
    scripts()[0]!.onload?.(new Event('load'))
    await expect(p).rejects.toThrow()
  })
})
