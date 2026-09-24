import { App } from 'antd'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../api'
import { Preferences } from '../Preferences'
import { StoreContext } from '../store'
import type { Store } from '../store'
import SettingsPage from './SettingsPage'

const { settings, saveSettings } = vi.hoisted(() => ({
  settings: vi.fn(),
  saveSettings: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api')>()
  return { ...real, api: { ...real.api, settings, saveSettings } }
})

const store = { refresh: vi.fn() } as unknown as Store

const mount = (s: Settings) => {
  settings.mockResolvedValue(s)
  saveSettings.mockImplementation(async (next: Settings) => next)
  return render(
    <Preferences>
      <App>
        <StoreContext value={store}>
          <SettingsPage />
        </StoreContext>
      </App>
    </Preferences>,
  )
}

const base: Settings = {
  station: { myCallsign: 'BG0CG', networkFreqMhz: 439.525 },
  channels: [],
  queries: [],
}

beforeEach(() => vi.clearAllMocks())

describe('SettingsPage', () => {
  // 没配过模拟守听的机器，那一栏整个空着是正常的，不能因此什么都存不了。
  it('没配模拟守听时，只改本台信息也存得下', async () => {
    mount(base)
    const qth = await screen.findByLabelText('QTH')

    await userEvent.type(qth, '克拉玛依区')
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(saveSettings.mock.calls[0][0].station.myQth).toBe('克拉玛依区')
  })

  it('模拟守听填了一格，频率和信道名就是必填', async () => {
    mount(base)
    await userEvent.type(await screen.findByLabelText('本台 MDC unit ID'), '6460')

    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    expect(await screen.findByText('频率必填')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('静噪余量在表单里，能改', async () => {
    mount({
      ...base,
      analog: { freqMhz: 438.5, channel: '438.500 中继', openMarginDb: 12, closeMarginDb: 7 },
    })
    const open = await screen.findByLabelText('静噪打开余量 dB')

    await userEvent.clear(open)
    await userEvent.type(open, '9')
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(saveSettings.mock.calls[0][0].analog).toMatchObject({ openMarginDb: 9, closeMarginDb: 7 })
  })
})
