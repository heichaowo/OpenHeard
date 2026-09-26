import { App } from 'antd'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeardItem } from '../api'
import { Preferences } from '../Preferences'
import { setViewportWidth } from '../testSetup'
import { StoreContext } from '../store'
import type { Store } from '../store'
import HeardList from './HeardList'

const heard = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, heard } }
})

const fm = (id: string, over: Partial<HeardItem> = {}): HeardItem => ({
  id,
  origin: 'sdr-fm',
  startAt: 1_789_000_000,
  durationS: 4.2,
  mine: false,
  freqMhz: 438.5,
  channel: '438.500 中继',
  ...over,
})

const mount = (recordings: string[] = []) =>
  render(
    <Preferences>
      <App>
        <StoreContext value={{ recordings: new Set(recordings) } as unknown as Store}>
          <HeardList />
        </StoreContext>
      </App>
    </Preferences>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})
afterEach(() => setViewportWidth(1280))

describe('HeardList', () => {
  // 别人的发射进不了待确认队列，以前只在运维页上是一个计数。
  it('列出别人的模拟发射，有录音的能放，结算过的标出来', async () => {
    heard.mockResolvedValue({
      items: [fm('f2', { settled: 'logged' }), fm('f1', { callsign: undefined })],
    })
    const { container } = mount(['f2'])

    await screen.findAllByText('438.500 中继')
    expect(heard).toHaveBeenCalledWith('sdr-fm')
    expect(screen.getAllByText('对方').length).toBe(2)
    expect(screen.getByText('已入库')).toBeInTheDocument()
    const players = container.querySelectorAll('audio')
    expect(players.length).toBe(1)
    expect(players[0]!.getAttribute('src')).toBe('/api/recordings/f2')
  })

  it('切到数字就按 BrandMeister 取', async () => {
    heard.mockResolvedValue({ items: [] })
    mount()
    await waitFor(() => expect(heard).toHaveBeenCalledWith('sdr-fm'))

    heard.mockResolvedValue({
      items: [fm('b1', { origin: 'brandmeister', channel: undefined, talkgroup: 46001, dmrId: 4616472 })],
    })
    await userEvent.click(screen.getByText('数字'))

    expect(await screen.findByText('TG 46001')).toBeInTheDocument()
    expect(heard).toHaveBeenLastCalledWith('brandmeister')
    expect(screen.getByText('DMR 4616472')).toBeInTheDocument()
  })

  it('还有更早的就能接着往前翻，接在后面', async () => {
    heard.mockResolvedValueOnce({ items: [fm('f3')], next: '1789000000:f3' })
    heard.mockResolvedValueOnce({ items: [fm('f2', { channel: '更早那条' })] })
    mount()

    await userEvent.click(await screen.findByRole('button', { name: /更\s*早\s*的/ }))

    expect(await screen.findByText('更早那条')).toBeInTheDocument()
    expect(heard).toHaveBeenLastCalledWith('sdr-fm', '1789000000:f3')
    expect(screen.getByText('438.500 中继')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /更\s*早\s*的/ })).not.toBeInTheDocument()
  })

  // 先发的请求后回来，不能把刚切过去的那一边盖掉。
  it('切得快时，晚回来的旧结果不作数', async () => {
    let slow: (v: unknown) => void = () => undefined
    heard.mockImplementationOnce(() => new Promise((r) => (slow = r)))
    heard.mockResolvedValueOnce({
      items: [fm('b1', { origin: 'brandmeister', channel: undefined, talkgroup: 46001 })],
    })
    mount()

    await userEvent.click(screen.getByText('数字'))
    await screen.findByText('TG 46001')
    slow({ items: [fm('f1', { channel: '旧的模拟' })] })

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText('旧的模拟')).not.toBeInTheDocument()
    expect(screen.getByText('TG 46001')).toBeInTheDocument()
  })

  // 往前翻还在路上时切了来源，新列表的「更早的」不能跟着转圈点不动。
  it('往前翻还没回来就切来源，新列表的「更早的」照样能点', async () => {
    heard.mockResolvedValueOnce({ items: [fm('f3')], next: '1789000000:f3' })
    heard.mockImplementationOnce(() => new Promise(() => undefined))
    heard.mockResolvedValueOnce({
      items: [fm('b1', { origin: 'brandmeister', channel: undefined, talkgroup: 46001 })],
      next: '1789000000:b1',
    })
    mount()

    await userEvent.click(await screen.findByRole('button', { name: /更\s*早\s*的/ }))
    await userEvent.click(screen.getByText('数字'))
    await screen.findByText('TG 46001')

    const button = screen.getByRole('button', { name: /更\s*早\s*的/ })
    expect(button).not.toHaveClass('ant-btn-loading')
  })

  it('手机上一条一张卡，不出表格', async () => {
    setViewportWidth(375)
    heard.mockResolvedValue({ items: [fm('f1')] })
    mount(['f1'])

    await screen.findByText('438.500 中继')
    expect(screen.queryAllByText(/^时间 /)).toHaveLength(0)
    expect(document.querySelector('audio')).not.toBeNull()
  })
})
