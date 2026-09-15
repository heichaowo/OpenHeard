import type { Mode, StationDefaults } from '@core'

export interface RecentQso {
  id: string
  call: string
  startAt: number
  band: string
  mode: Mode
  rstSent: string
  rstRcvd: string
  qth?: string
  gridsquare?: string
}

export interface Summary {
  station: StationDefaults
  total: number
  distinctCalls: number
  firstAt?: number
  lastAt?: number
  byBand: { key: string; n: number }[]
  byMode: { key: string; n: number }[]
  recent: RecentQso[]
  generatedAt: number
}

/**
 * 整页只发这一个请求。
 *
 * 将来这份数据可能不是从 HTTP 来，而是一个导出的 JSON 文件，
 * 所以形状定成一个整体，换来源时只改这里。
 */
export async function fetchSummary(): Promise<Summary> {
  const res = await fetch('/public/summary')
  if (!res.ok) throw new Error(`拿不到数据，服务端回了 ${res.status}`)
  return (await res.json()) as Summary
}
