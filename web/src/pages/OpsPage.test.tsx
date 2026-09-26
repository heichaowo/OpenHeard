import { App } from 'antd'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Ops, Radio } from '../api'
import { Preferences } from '../Preferences'
import OpsPage from './OpsPage'

const ops = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, ops } }
})

const now = 1_789_000_000
const radio = (over: Partial<Radio>): Radio => ({
  freqMhz: 438.5,
  channel: '438.500 中继',
  gainDb: 49.6,
  idleDb: 102.6,
  openBelowDb: 90.6,
  closeAboveDb: 95.6,
  noiseDb: 102.1,
  open: false,
  at: now,
  ageS: 1,
  fresh: true,
  closestDb: 7.9,
  ...over,
})

const snapshot = (radios: Radio[]): Ops => ({
  health: { ok: true, problems: [], activityCount: 0, qsoCount: 0 },
  machine: { rssBytes: 1, uptimeS: 1, cores: 8, memFreeBytes: 1, memTotalBytes: 2, load1: 0.1 },
  recordings: { files: 0, bytes: 0 },
  radios,
  polls: [],
  activities: [],
  queries: [],
  clusterGapS: 120,
  activityRetentionDays: 90,
  pendingWindowDays: 7,
  now,
})

const mount = () =>
  render(
    <Preferences>
      <App>
        <OpsPage />
      </App>
    </Preferences>,
  )

describe('OpsPage 的电台', () => {
  it('一支接收机守两个信道，各有一段，各说各的离门限多远', async () => {
    ops.mockResolvedValue(
      snapshot([
        radio({}),
        radio({ freqMhz: 438.975, channel: '438.975', open: true, noiseDb: 80.0, closestDb: -10.6 }),
      ]),
    )
    mount()

    expect(await screen.findByText('438.5 MHz（438.500 中继）')).toBeInTheDocument()
    expect(screen.getByText('438.975 MHz（438.975）')).toBeInTheDocument()
    expect(screen.getByText(/守 2 个信道/)).toBeInTheDocument()
    expect(screen.getByText('静噪开着，正在收')).toBeInTheDocument()
    expect(screen.getByText(/离开门限还差 11.5 dB/)).toBeInTheDocument()
  })

  it('没有守听时说清楚，不是一片空白', async () => {
    ops.mockResolvedValue(snapshot([]))
    mount()
    expect(await screen.findByText(/没有模拟守听/)).toBeInTheDocument()
  })
})
