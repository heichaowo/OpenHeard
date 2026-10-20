import { afterEach, describe, expect, it } from 'vitest'
import * as L from 'leaflet'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import { gridBounds } from '@core'
import { buildOsm } from './osm'

const mounted: HTMLElement[] = []
const make = () => {
  const el = document.createElement('div')
  el.style.height = '300px'
  document.body.append(el)
  mounted.push(el)
  return buildOsm({ el, center: { lat: 39.9042, lon: 116.4074 }, zoom: 11 })
}
afterEach(() => {
  mounted.splice(0).forEach((e) => e.remove())
})

describe('OpenStreetMap 适配器', () => {
  it('瓦片是 tile.openstreetmap.org，署名可见', () => {
    const { adapter, tiles } = make()
    expect((tiles as unknown as { _url: string })._url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png')
    expect(mounted[0]!.querySelector('.leaflet-control-attribution')).toHaveTextContent('OpenStreetMap')
    expect(mounted[0]!.querySelector('.leaflet-control-attribution a[href*="openstreetmap"]')).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright',
    )
    // 规定不让设限制性的 Referrer-Policy，瓦片这一层也不设。
    expect((tiles.options as { referrerPolicy?: unknown }).referrerPolicy).toBeFalsy()
    adapter.destroy()
  })

  // 打包后 leaflet.css 里的图标是 data URL，不处理的话图标地址是个相对路径，被单页应用的兜底换成 index.html。
  it('默认标记图标用打包进来的地址，不是靠样式表猜的目录', () => {
    make().adapter.destroy()
    const icon = new L.Icon.Default()
    const url = (icon as unknown as { _getIconUrl(n: string): string })._getIconUrl('icon')
    expect(url).toBe(iconUrl)
  })

  it('点地图：交出 WGS-84 坐标，地图转过一圈的经度回到 ±180 以内', () => {
    const { adapter, map } = make()
    const got: { lat: number; lon: number }[] = []
    adapter.onPick((p) => got.push(p))
    map.fire('click', { latlng: L.latLng(39.9042, 116.4074 + 360) })
    expect(got).toHaveLength(1)
    expect(got[0]!.lat).toBeCloseTo(39.9042, 9)
    expect(got[0]!.lon).toBeCloseTo(116.4074, 9)
    adapter.destroy()
  })

  it('拖标记：拖完交出标记现在的位置', () => {
    const { adapter, map } = make()
    const got: { lat: number; lon: number }[] = []
    adapter.onPick((p) => got.push(p))
    adapter.setMarker({ lat: 39.9, lon: 116.4 })
    let marker: L.Marker | undefined
    map.eachLayer((l) => {
      if (l instanceof L.Marker) marker = l
    })
    marker!.setLatLng([31.2304, 121.4737])
    marker!.fire('dragend')
    expect(got).toHaveLength(1)
    expect(got[0]!.lat).toBeCloseTo(31.2304, 9)
    expect(got[0]!.lon).toBeCloseTo(121.4737, 9)
    adapter.destroy()
  })

  it('摆标记、移标记、去标记；程序摆的不算人选点', () => {
    const { adapter } = make()
    const got: unknown[] = []
    adapter.onPick((p) => got.push(p))
    adapter.setMarker({ lat: 39.9, lon: 116.4 })
    expect(mounted[0]!.querySelectorAll('.leaflet-marker-icon')).toHaveLength(1)
    adapter.setMarker({ lat: 31.2, lon: 121.4 })
    expect(mounted[0]!.querySelectorAll('.leaflet-marker-icon')).toHaveLength(1)
    adapter.setMarker(null)
    expect(mounted[0]!.querySelectorAll('.leaflet-marker-icon')).toHaveLength(0)
    expect(got).toEqual([])
    adapter.destroy()
  })

  it('格子：画一个矩形，边界就是网格的 WGS-84 范围，不做任何偏移', () => {
    const { adapter, map } = make()
    adapter.setCell('OM89EV')
    let rect: L.Rectangle | undefined
    map.eachLayer((l) => {
      if (l instanceof L.Rectangle) rect = l
    })
    const b = gridBounds('OM89EV')
    expect(rect!.getBounds().getSouthWest()).toMatchObject({ lat: b.south, lng: b.west })
    expect(rect!.getBounds().getNorthEast()).toMatchObject({ lat: b.north, lng: b.east })
    adapter.setCell(null)
    let left = 0
    map.eachLayer((l) => {
      if (l instanceof L.Rectangle) left++
    })
    expect(left).toBe(0)
    adapter.destroy()
  })
})
