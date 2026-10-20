import { gcj02ToWgs84, gridBounds, wgs84ToGcj02 } from '@core'
import type { AdapterInit, LatLon, MapAdapter, SearchHit } from './adapter'

/**
 * 高德 JS API 2.0 只用到的那几个类。官方没有随包的类型，这里照着文档写窄一点。
 * 坐标顺序一律 [lng, lat]，而且都在 GCJ-02 里：进去之前过 wgs84ToGcj02，出来过 gcj02ToWgs84。
 */
interface AmapLngLat {
  getLng(): number
  getLat(): number
}
interface AmapEvent {
  lnglat: AmapLngLat
}
interface AmapOverlay {
  setMap(map: AmapMap | null): void
}
interface AmapMarker extends AmapOverlay {
  setPosition(p: [number, number]): void
  getPosition(): AmapLngLat
  on(ev: 'dragend', cb: () => void): void
}
interface AmapMap {
  on(ev: 'click', cb: (e: AmapEvent) => void): void
  on(ev: 'complete', cb: () => void): void
  setZoomAndCenter(zoom: number, center: [number, number]): void
  getZoom(): number
  destroy(): void
}
type Status = 'complete' | 'no_data' | 'error'
export interface AmapNamespace {
  Map: new (el: HTMLElement, opts: { zoom: number; center: [number, number] }) => AmapMap
  Marker: new (opts: { position: [number, number]; draggable: boolean; map: AmapMap }) => AmapMarker
  Polygon: new (opts: { path: [number, number][]; map: AmapMap; strokeWeight: number; fillOpacity: number }) => AmapOverlay
  PlaceSearch: new (opts: { pageSize: number; city: string }) => {
    search(kw: string, cb: (status: Status, result: { poiList?: { pois: AmapPoi[] } }) => void): void
  }
  Geocoder: new () => {
    getAddress(
      p: [number, number],
      cb: (status: Status, result: { regeocode?: { addressComponent?: AmapAddress } }) => void,
    ): void
  }
}
interface AmapPoi {
  name: string
  address?: string
  cityname?: string
  adname?: string
  location?: AmapLngLat
}
interface AmapAddress {
  province?: string
  /** 直辖市这里是空数组，不是字符串。 */
  city?: string | string[]
  district?: string
}

declare global {
  interface Window {
    AMap?: AmapNamespace
    _AMapSecurityConfig?: { serviceHost: string }
  }
}

/** 城市加区县。直辖市的 city 是空数组，退回到省名（北京市）。 */
export function qthFromAmap(a: AmapAddress | undefined): string | undefined {
  if (a === undefined) return undefined
  const city = typeof a.city === 'string' && a.city !== '' ? a.city : a.province
  const out = [city, a.district].filter((v, i, all): v is string => !!v && all.indexOf(v) === i).join('')
  return out === '' ? undefined : out
}

const gcj = (p: LatLon): [number, number] => {
  const g = wgs84ToGcj02(p.lat, p.lon)
  return [g.lon, g.lat]
}
const wgs = (ll: AmapLngLat): LatLon => {
  const w = gcj02ToWgs84(ll.getLat(), ll.getLng())
  return { lat: w.lat, lon: w.lon }
}

let loading: Promise<AmapNamespace> | undefined

/**
 * 脚本只加载一次。失败了（断网、key 不对）清掉缓存，再打开选点时能重试：
 * 缓存着一个失败的 Promise，人换了网络也永远打不开。
 * 加载过之后换 key 要刷新页面，脚本里的 key 改不了。
 */
export function loadAMap(key: string): Promise<AmapNamespace> {
  if (window.AMap !== undefined) return Promise.resolve(window.AMap)
  if (loading !== undefined) return loading
  // 必须在脚本加载前设好。安全密钥留在 api 里，浏览器只知道代理的地址。
  window._AMapSecurityConfig = { serviceHost: `${location.origin}/_AMapService` }
  const script = document.createElement('script')
  script.async = true
  script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.AutoComplete,AMap.PlaceSearch,AMap.Geocoder`
  loading = new Promise<AmapNamespace>((resolve, reject) => {
    script.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error('高德脚本没有定义 AMap')))
    script.onerror = () => reject(new Error('高德脚本加载失败'))
  })
  loading.catch(() => {
    loading = undefined
    script.remove()
  })
  document.head.append(script)
  return loading
}

/** 搭好适配器，不等地图画完。complete 给调用方去听。 */
export function buildAmap(AMap: AmapNamespace, init: AdapterInit) {
  const map = new AMap.Map(init.el, { zoom: init.zoom, center: gcj(init.center) })
  let marker: AmapMarker | undefined
  let cell: AmapOverlay | undefined
  let pick: ((p: LatLon) => void) | undefined

  map.on('click', (e) => pick?.(wgs(e.lnglat)))

  const adapter: MapAdapter = {
    setMarker(p) {
      if (p === null) {
        marker?.setMap(null)
        marker = undefined
        return
      }
      if (marker === undefined) {
        marker = new AMap.Marker({ position: gcj(p), draggable: true, map })
        marker.on('dragend', () => pick?.(wgs(marker!.getPosition())))
      } else {
        marker.setPosition(gcj(p))
      }
    },
    setCell(grid) {
      cell?.setMap(null)
      cell = undefined
      if (grid === null) return
      const b = gridBounds(grid)
      // 只用四个角：6 位网格边上最大偏差 4 米，加中点没有看得见的好处。
      const corners: LatLon[] = [
        { lat: b.south, lon: b.west },
        { lat: b.south, lon: b.east },
        { lat: b.north, lon: b.east },
        { lat: b.north, lon: b.west },
      ]
      cell = new AMap.Polygon({ path: corners.map(gcj), map, strokeWeight: 2, fillOpacity: 0.15 })
    },
    setView(center, zoom) {
      map.setZoomAndCenter(zoom ?? map.getZoom(), gcj(center))
    },
    onPick(cb) {
      pick = cb
    },
    search(q) {
      return new Promise<SearchHit[]>((resolve, reject) => {
        new AMap.PlaceSearch({ pageSize: 5, city: '全国' }).search(q, (status, result) => {
          if (status === 'error') return reject(new Error('高德搜索没有回应'))
          const pois = status === 'complete' ? (result.poiList?.pois ?? []) : []
          resolve(
            pois
              // 公交线路这类结果没有 location。
              .filter((p): p is AmapPoi & { location: AmapLngLat } => p.location !== undefined)
              .map((p) => ({
                name: p.name,
                detail: [p.cityname, p.adname, p.address].filter(Boolean).join(' ') || undefined,
                point: wgs(p.location),
              })),
          )
        })
      })
    },
    reverse(p) {
      return new Promise<string | undefined>((resolve, reject) => {
        new AMap.Geocoder().getAddress(gcj(p), (status, result) => {
          if (status === 'error') return reject(new Error('高德反查没有回应'))
          resolve(qthFromAmap(result.regeocode?.addressComponent))
        })
      })
    },
    destroy() {
      map.destroy()
    },
  }
  return { adapter, map }
}

/** 脚本加载完、地图第一次画完才 resolve。 */
export async function createAmap(init: AdapterInit): Promise<MapAdapter> {
  if (!init.amapKey) throw new Error('没有高德 key')
  const AMap = await loadAMap(init.amapKey)
  const { adapter, map } = buildAmap(AMap, init)
  return new Promise((resolve) => map.on('complete', () => resolve(adapter)))
}
