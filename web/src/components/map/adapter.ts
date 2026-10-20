/** 地图选点用到的坐标，一律 WGS-84。高德的 GCJ-02 在适配器里进出时换，别处看不到。 */
export interface LatLon {
  lat: number
  lon: number
}

export interface SearchHit {
  name: string
  detail?: string
  point: LatLon
}

/**
 * MapPicker 只认这个接口，所以选点的逻辑不用真地图就能测。
 * 四个 set/on 方法同步，search 和 reverse 走网络。setMarker、setCell、setView 是
 * 程序在摆，不触发 onPick；onPick 只在人点地图或拖标记时触发。
 */
export interface MapAdapter {
  /** 标记，null 是去掉。标记可以拖。 */
  setMarker(p: LatLon | null): void
  /** 画出这个网格那一格，null 是去掉。 */
  setCell(grid: string | null): void
  setView(center: LatLon, zoom?: number): void
  onPick(cb: (p: LatLon) => void): void
  /** 地名搜索，最多几条，没找到是空数组，网络出错抛错。 */
  search(q: string): Promise<SearchHit[]>
  /** 这个点的地名，用城市加区县这一级，没有就是 undefined。 */
  reverse(p: LatLon): Promise<string | undefined>
  destroy(): void
}

export interface AdapterInit {
  el: HTMLElement
  center: LatLon
  zoom: number
  /** 只有高德要。 */
  amapKey?: string
}

/** 地图画出来、能用了才 resolve。加载不了的话一直不 resolve，由调用方的 10 秒超时兜。 */
export type AdapterFactory = (provider: 'amap' | 'osm', init: AdapterInit) => Promise<MapAdapter>
