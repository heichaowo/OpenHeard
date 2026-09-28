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

  it('模拟守听打开后填了一格，就至少要有一个信道', async () => {
    mount(base)
    await userEvent.click(await screen.findByRole('switch', { name: '模拟守听开关' }))
    await userEvent.type(screen.getByLabelText('本台 MDC unit ID'), '6460')

    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    expect(await screen.findByText('至少要有一个信道')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  const one = { channels: [{ freqMhz: 438.5, channel: '438.500 中继' }], openMarginDb: 12, closeMarginDb: 7 }

  // 一支接收机同时守 438.500 和 438.975。
  it('加一个信道，当场说接收机怎么收，存的时候两个都带上', async () => {
    mount({ ...base, analog: one })
    await screen.findByDisplayValue('438.500 中继')

    await userEvent.click(screen.getByRole('button', { name: /加一个信道/ }))
    const freqs = screen.getAllByLabelText('信道频率 MHz')
    const names = screen.getAllByLabelText('信道名')
    await userEvent.type(freqs[1]!, '438.975')
    await userEvent.type(names[1]!, '438.975')

    expect(await screen.findByText(/接收机调到 438.753 MHz/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(saveSettings.mock.calls[0][0].analog.channels).toEqual([
      { freqMhz: 438.5, channel: '438.500 中继' },
      { freqMhz: 438.975, channel: '438.975' },
    ])
  })

  // 信道表的规则挂在整张表上，改某一行时不会自己重跑，要专门补一下。
  it('信道名重复不用等保存，填的时候就说', async () => {
    mount({ ...base, analog: one })
    await screen.findByDisplayValue('438.500 中继')

    await userEvent.click(screen.getByRole('button', { name: /加一个信道/ }))
    await userEvent.type(screen.getAllByLabelText('信道频率 MHz')[1]!, '438.975')
    await userEvent.type(screen.getAllByLabelText('信道名')[1]!, '438.500 中继')

    expect(await screen.findByText('信道名不能重复')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  // 一支接收机收得下，不等于是业余波段。存的时候 api 会拒，提示不能先说行。
  it('不在 2m 或 70cm 的频率，提示当场说不行', async () => {
    mount({ ...base, analog: one })
    await screen.findByDisplayValue('438.500 中继')

    const freq = screen.getAllByLabelText('信道频率 MHz')[0]!
    await userEvent.clear(freq)
    await userEvent.type(freq, '100')

    expect((await screen.findAllByText(/100 MHz 不在 2m/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/接收机调到/)).not.toBeInTheDocument()
  })

  it('一支接收机收不下就当场说出来，也存不了', async () => {
    mount({ ...base, analog: one })
    await screen.findByDisplayValue('438.500 中继')

    await userEvent.click(screen.getByRole('button', { name: /加一个信道/ }))
    await userEvent.type(screen.getAllByLabelText('信道频率 MHz')[1]!, '440.5')
    await userEvent.type(screen.getAllByLabelText('信道名')[1]!, '远的')

    expect((await screen.findAllByText(/最多 1.8 MHz/)).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))
    await new Promise((r) => setTimeout(r, 50))
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('静噪余量在表单里，能改', async () => {
    mount({
      ...base,
      analog: one,
    })
    const open = await screen.findByLabelText('静噪打开余量 dB')

    await userEvent.clear(open)
    await userEvent.type(open, '9')
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(saveSettings.mock.calls[0][0].analog).toMatchObject({ openMarginDb: 9, closeMarginDb: 7 })
  })

  // 名字是轮询记录和运维页上认一条查询的唯一办法，重了就分不开。
  it('两条查询名字一样就不让存', async () => {
    const q = (key: string) => ({
      key,
      rule: { id: 'DestinationID', operator: 'equal', value: 46001 },
      amount: 200,
      intervalS: 900,
    })
    mount({ ...base, queries: [q('dst:46001'), q('dst:46001')] })
    await screen.findAllByDisplayValue('dst:46001')

    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    expect(await screen.findByText('查询名字不能重复')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('查询名字重复不用等保存，填的时候就说', async () => {
    mount({
      ...base,
      queries: [{ key: 'dst:46001', rule: { id: 'DestinationID', operator: 'equal', value: 46001 }, amount: 200, intervalS: 900 }],
    })
    await screen.findByDisplayValue('dst:46001')

    const adds = screen.getAllByRole('button', { name: /加一条/ })
    await userEvent.click(adds[adds.length - 1]!)
    const names = screen.getAllByPlaceholderText('dst:46001')
    await userEvent.type(names[names.length - 1]!, 'dst:46001')

    expect(await screen.findByText('查询名字不能重复')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  // 手机上一行折成几行时，没有标签就认不出哪一格是什么。
  it('查询的每一格都带标签', async () => {
    mount({
      ...base,
      queries: [{ key: 'dst:46001', rule: { id: 'DestinationID', operator: 'equal', value: 46001 }, amount: 200, intervalS: 900 }],
    })
    await screen.findByDisplayValue('dst:46001')
    for (const label of ['名字', '查什么', '号码', '每次取', '间隔']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })
})

describe('SettingsPage 的两个开关', () => {
  const one = { channels: [{ freqMhz: 438.5, channel: '438.500 中继' }], openMarginDb: 12, closeMarginDb: 7 }
  const query = {
    key: 'dst:46001',
    rule: { id: 'DestinationID', operator: 'equal', value: 46001 },
    amount: 200,
    intervalS: 900,
  }

  // rc-field-form 的 onFinish 只给校验过、已挂载的字段；关着的卡把值藏起来但
  // 没卸载，body 得靠 getFieldsValue(true) 才拿得全，这里直接盯着 PUT 的内容。
  it('两张卡都关了存，PUT 里原来的信道和查询照原样带回去', async () => {
    mount({ ...base, analog: one, queries: [query] })
    await screen.findByDisplayValue('438.500 中继')

    await userEvent.click(screen.getByRole('switch', { name: '模拟守听开关' }))
    await userEvent.click(screen.getByRole('switch', { name: 'BrandMeister 开关' }))
    expect(screen.getAllByText('关着。打开后才能改，原来的设置都留着。')).toHaveLength(2)

    await userEvent.type(await screen.findByLabelText('QTH'), '成都')
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    const sent = saveSettings.mock.calls[0][0]
    expect(sent.analog).toMatchObject({ enabled: false, channels: one.channels })
    expect(sent.brandmeisterEnabled).toBe(false)
    expect(sent.queries).toEqual([query])
    expect(sent.station.myQth).toBe('成都')
  })

  // 数字侧独有的机器，模拟卡本来就是空的。开关缺省是关，不拦下别处的保存。
  it('数字侧独有的机器，模拟开关缺省关着，也存得下本台信息', async () => {
    mount(base)
    await screen.findByLabelText('QTH')

    expect(screen.getByRole('switch', { name: '模拟守听开关' })).not.toBeChecked()
    expect(screen.getByText(/还没配模拟守听/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('QTH'), '克拉玛依区')
    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    const sent = saveSettings.mock.calls[0][0]
    expect(sent.analog?.enabled).not.toBe(true)
    expect(sent.station.myQth).toBe('克拉玛依区')
  })

  it('没配过模拟守听时，打开开关才展开信道表', async () => {
    mount(base)
    const unitId = await screen.findByLabelText('本台 MDC unit ID')
    expect(unitId).not.toBeVisible()

    await userEvent.click(screen.getByRole('switch', { name: '模拟守听开关' }))
    expect(unitId).toBeVisible()
    expect(screen.queryByText(/还没配模拟守听/)).not.toBeInTheDocument()
  })

  // 填了一格本来会触发「至少要有一个信道」（见上面那条不带开关的测试）；
  // 关掉开关既清了这一格，也不再拦保存。开关一变，卡的校验要跟着重算一次。
  it('填了一格但关着开关，不拦保存，字段也回到空', async () => {
    mount(base)
    await userEvent.click(await screen.findByRole('switch', { name: '模拟守听开关' }))
    await userEvent.type(screen.getByLabelText('本台 MDC unit ID'), '6460')
    await userEvent.click(screen.getByRole('switch', { name: '模拟守听开关' }))
    expect(screen.queryByText('至少要有一个信道')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^保\s*存$/ }))

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(saveSettings.mock.calls[0][0].analog).toEqual({ enabled: false, channels: [] })
  })
})

