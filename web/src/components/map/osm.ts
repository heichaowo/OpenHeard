import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'
import { gridBounds } from '@core'
import type { AdapterInit, MapAdapter } from './adapter'
import { nominatimReverse, nominatimSearch } from './nominatim'

// 打包之后 leaflet.css 里的图标被内联成 data URL，Leaflet 靠样式表猜图标目录的做法落空，
// 标记图标会变成相对路径，被单页应用的兜底路由换成 index.html。这里把三张图的地址直接给它。
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl
L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl })

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
// 规定要求署名清楚地显示在地图上。
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'

/** 同步地搭好地图，不等瓦片。tiles 给调用方去听 load。 */
export function buildOsm(init: AdapterInit) {
  const map = L.map(init.el, { center: [init.center.lat, init.center.lon], zoom: init.zoom })
  const tiles = L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map)
  let marker: L.Marker | undefined
  let cell: L.Rectangle | undefined
  let pick: ((p: { lat: number; lon: number }) => void) | undefined

  // 弹窗开合时容器尺寸会变，Leaflet 自己不知道。
  const ro = new ResizeObserver(() => map.invalidateSize())
  ro.observe(init.el)

  map.on('click', (e: L.LeafletMouseEvent) => {
    const ll = e.latlng.wrap()
    pick?.({ lat: ll.lat, lon: ll.lng })
  })

  const adapter: MapAdapter = {
    setMarker(p) {
      if (p === null) {
        marker?.remove()
        marker = undefined
        return
      }
      if (marker === undefined) {
        marker = L.marker([p.lat, p.lon], { draggable: true }).addTo(map)
        marker.on('dragend', () => {
          const ll = marker!.getLatLng().wrap()
          pick?.({ lat: ll.lat, lon: ll.lng })
        })
      } else {
        marker.setLatLng([p.lat, p.lon])
      }
    },
    setCell(grid) {
      cell?.remove()
      cell = undefined
      if (grid === null) return
      const b = gridBounds(grid)
      cell = L.rectangle(
        [
          [b.south, b.west],
          [b.north, b.east],
        ],
        { weight: 2, fillOpacity: 0.15, interactive: false },
      ).addTo(map)
    },
    setView(center, zoom) {
      map.setView([center.lat, center.lon], zoom ?? map.getZoom())
    },
    onPick(cb) {
      pick = cb
    },
    search: nominatimSearch,
    reverse: nominatimReverse,
    destroy() {
      ro.disconnect()
      map.remove()
    },
  }
  return { adapter, tiles, map }
}

/**
 * 第一块瓦片到了就算能用。不能等 load：Leaflet 在这一屏所有瓦片都结束时才触发它，
 * 国内常见的是个别瓦片卡住，等它会把画了大半的地图判成打不开。
 * 但 load 也会在瓦片全出错（连接被拒绝、域名解析不了）时触发，那时一块都没到，要判失败。
 * 什么都没来的情况（一直转圈）不在这里管，由 MapPicker 的 10 秒超时兜。
 */
export function tilesUsable(tiles: L.TileLayer): Promise<void> {
  return new Promise((resolve, reject) => {
    let any = false
    tiles.on('tileload', () => {
      any = true
      resolve()
    })
    tiles.once('load', () => {
      if (!any) reject(new Error('瓦片一块都没加载到'))
    })
  })
}

export function createOsm(init: AdapterInit): Promise<MapAdapter> {
  const { adapter, tiles } = buildOsm(init)
  return tilesUsable(tiles).then(
    () => adapter,
    (e: unknown) => {
      // 没人会拿到这个适配器，地图要自己拆掉。
      adapter.destroy()
      throw e
    },
  )
}
