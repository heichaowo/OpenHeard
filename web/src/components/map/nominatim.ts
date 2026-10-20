import type { LatLon, SearchHit } from './adapter'

/**
 * Nominatim 的使用规定：整个应用合起来每秒最多一个请求，不能边输边搜。
 * 所以所有请求走同一条队列，起点之间隔 1.1 秒。反查地名可以丢：人拖着标记走时，
 * 排着队还没发的反查只留最后一个，前面的发出去也没人看。搜索不丢。
 */
export function createLimiter(gapMs: number) {
  let chain: Promise<unknown> = Promise.resolve()
  let last = -Infinity
  let latestReverse = 0
  return function limited<T>(kind: 'search' | 'reverse', run: () => Promise<T>): Promise<T | undefined> {
    const mine = kind === 'reverse' ? ++latestReverse : 0
    const job = chain.then(async () => {
      if (kind === 'reverse' && mine !== latestReverse) return undefined
      const wait = last + gapMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      // 等的时候又来了新的反查，这个就不发了。
      if (kind === 'reverse' && mine !== latestReverse) return undefined
      last = Date.now()
      return run()
    })
    // 一个请求失败不能卡住后面的。
    chain = job.catch(() => undefined)
    return job
  }
}

export const nominatimLimited = createLimiter(1100)

const BASE = 'https://nominatim.openstreetmap.org'

interface NominatimAddress {
  city?: string
  town?: string
  county?: string
  state?: string
  municipality?: string
  city_district?: string
  district?: string
  suburb?: string
}

/** 城市加区县，不用 display_name：那是一长串逗号隔开的地址。 */
export function qthFromNominatim(a: NominatimAddress | undefined): string | undefined {
  if (a === undefined) return undefined
  const place = a.city ?? a.town ?? a.municipality ?? a.county ?? a.state
  const district = a.city_district ?? a.district ?? (a.county !== place ? a.county : undefined) ?? a.suburb
  const out = [place, district].filter((v, i, all): v is string => !!v && all.indexOf(v) === i).join('')
  return out === '' ? undefined : out
}

async function getJson(path: string, params: Record<string, string | number>): Promise<unknown> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  // 不设 referrerPolicy、不加自定义头：规定要求浏览器带上有效的 Referer。
  const res = await fetch(`${BASE}${path}?${qs}`)
  if (!res.ok) throw new Error(`地名服务回了 ${res.status}`)
  return res.json()
}

interface NominatimHit {
  lat: string
  lon: string
  display_name: string
}

export function nominatimSearch(q: string): Promise<SearchHit[]> {
  return nominatimLimited('search', async () => {
    const hits = (await getJson('/search', {
      q,
      format: 'jsonv2',
      limit: 5,
      countrycodes: 'cn',
      'accept-language': 'zh',
      addressdetails: 1,
    })) as NominatimHit[]
    return hits.map((h) => {
      const [name = h.display_name, ...rest] = h.display_name.split(', ')
      return { name, detail: rest.join(', ') || undefined, point: { lat: Number(h.lat), lon: Number(h.lon) } }
    })
  }).then((r) => r ?? [])
}

export function nominatimReverse(p: LatLon): Promise<string | undefined> {
  return nominatimLimited('reverse', async () => {
    const r = (await getJson('/reverse', {
      lat: p.lat,
      lon: p.lon,
      format: 'jsonv2',
      zoom: 14,
      addressdetails: 1,
      'accept-language': 'zh',
    })) as { address?: NominatimAddress }
    return qthFromNominatim(r.address)
  }).then((r) => r)
}
