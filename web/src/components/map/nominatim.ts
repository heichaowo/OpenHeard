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
}

const PREFECTURE = /[市州盟]$|地区$/
const DISTRICT = /[区县旗]$/

/**
 * 地级市加区县，不用 display_name 整串：那是一长串逗号隔开的地址。街道（suburb）太细，不要：
 * 克拉玛依的反查是 city 克拉玛依区 加 suburb 迎宾街道，写到街道就是把对方的位置说得比事实准。
 *
 * 大陆的反查把区放在 city 里，地级市不在 address 里，只在 display_name 里 city 的下一段
 * （春熙路街道, 锦江区, 成都市, 四川省）。那一段不像地级单位，或者就是省名（直辖市），
 * 就用省名，省名也没有就只写区。
 */
export function qthFromNominatim(a: NominatimAddress | undefined, displayName?: string): string | undefined {
  if (a === undefined) return undefined
  if (a.city !== undefined && DISTRICT.test(a.city)) {
    const parts = displayName?.split(', ') ?? []
    const i = parts.indexOf(a.city)
    const next = i < 0 ? undefined : parts[i + 1]
    const upper = next !== undefined && next !== a.state && PREFECTURE.test(next) ? next : a.state
    return `${upper ?? ''}${a.city}`
  }
  const place = a.city ?? a.town ?? a.municipality ?? a.county ?? a.state
  const district = a.city_district ?? a.district ?? (a.county !== place ? a.county : undefined)
  const out = [place, district].filter((v, i, all): v is string => !!v && all.indexOf(v) === i).join('')
  return out === '' ? undefined : out
}

async function getJson(path: string, params: Record<string, string | number>): Promise<unknown> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  // 不设 referrerPolicy、不加自定义头：规定要求浏览器带上有效的 Referer。
  // 挂住的请求不超时的话，队列里后面的搜索和反查都跟着等。
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(10_000) })
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
    })) as { address?: NominatimAddress; display_name?: string }
    return qthFromNominatim(r.address, r.display_name)
  }).then((r) => r)
}
