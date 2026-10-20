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

const store = (map: Store['map'] = { provider: 'none' }) => ({ refresh: vi.fn(), map, station: {} }) as unknown as Store

/** 服务端存完回的样子：密钥不回，只回设了没有。 */
const echo = (next: Settings): Settings => {
  const had = (sent: string | undefined, before: boolean) => (sent === undefined ? before : sent !== '')
  return {
    ...next,
    ai: {
      ...next.ai,
      asr: { ...next.ai.asr, apiKey: undefined, apiKeySet: had(next.ai.asr.apiKey, current.ai.asr.apiKeySet === true) },
      text: { ...next.ai.text, apiKey: undefined, apiKeySet: had(next.ai.text.apiKey, current.ai.text.apiKeySet === true) },
    },
    map: {
      ...next.map,
      amapSecurityCode: undefined,
      amapSecurityCodeSet: had(next.map.amapSecurityCode, current.map.amapSecurityCodeSet === true),
    },
  }
}
let current: Settings

const mount = (s: Settings, map?: Store['map']) => {
  current = s
  settings.mockResolvedValue(s)
  saveSettings.mockImplementation(async (next: Settings) => echo(next))
  return render(
    <Preferences>
      <App>
        <StoreContext value={store(map)}>
          <SettingsPage />
        </StoreContext>
      </App>
    </Preferences>,
  )
}

// 服务端回的是带缺省值的有效配置，AI 关着、地图没选。
const aiDefaults: Settings['ai'] = {
  enabled: false,
  vad: { provider: 'local', binPath: '/opt/homebrew/bin/whisper-vad-speech-segments', modelPath: '/m/silero.bin', threshold: 0.5 },
  asr: {
    provider: 'local',
    binPath: '/opt/homebrew/bin/whisper-cli',
    modelPath: '/m/large.bin',
    language: 'zh',
    prompt: '',
    baseUrl: '',
    model: '',
    extraBody: {},
    apiKeySet: false,
  },
  text: {
    provider: 'local',
    binPath: '/opt/homebrew/bin/llama-server',
    modelPath: '/m/qwen.gguf',
    port: 8091,
    idleUnloadS: 120,
    baseUrl: '',
    model: '',
    extraBody: {},
    apiKeySet: false,
  },
}

const base: Settings = {
  station: { myCallsign: 'BG0CG', networkFreqMhz: 439.525 },
  channels: [],
  queries: [],
  ai: aiDefaults,
  map: { provider: 'none', amapKey: '', amapSecurityCodeSet: false },
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


const saveBtn = () => screen.getByRole('button', { name: /^保\s*存$/ })
const sentBody = () => saveSettings.mock.calls[0]![0] as Settings

// 云端识别：key 已经存着。页面只知道设了没有。
const cloud: Settings = {
  ...base,
  ai: {
    ...aiDefaults,
    enabled: true,
    asr: {
      ...aiDefaults.asr,
      provider: 'chat-audio',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-asr',
      extraBody: { thinking: { type: 'disabled' } },
      apiKeySet: true,
    },
    text: { ...aiDefaults.text, provider: 'off' },
  },
}

describe('SettingsPage 的识别卡', () => {
  it('缺省关着，说明原来的设置都留着', async () => {
    mount(base)
    expect(await screen.findByText('识别关着。打开后才能改，原来的设置都留着。')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: '识别开关' })).not.toBeChecked()
  })

  it('开着时分人声判断、识别、提取三块，提示词旁写明利弊', async () => {
    mount(cloud)
    expect(await screen.findByText('人声判断')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '识别' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '提取' })).toBeInTheDocument()
    expect(screen.getByLabelText('提示词')).toBeInTheDocument()
    expect(screen.getByText(/CQTEST 会被转成「QQ赛」/)).toBeInTheDocument()
    expect(screen.getByLabelText('识别 模型名')).toHaveValue('mimo-v2.5-asr')
  })

  it('本机识别显示程序和模型路径，云端显示地址、模型、key', async () => {
    mount({ ...cloud, ai: { ...cloud.ai, asr: { ...cloud.ai.asr, provider: 'local' } } })
    expect(await screen.findByLabelText('识别 程序路径')).toHaveValue('/opt/homebrew/bin/whisper-cli')
    expect(screen.queryByLabelText('识别 接口地址')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('识别 key')).not.toBeInTheDocument()
  })

  it('已经设了 key：框是空的，旁边写已设置，不会把 key 读出来', async () => {
    mount(cloud)
    const key = await screen.findByLabelText('识别 key')
    expect(key).toHaveValue('')
    expect(screen.getAllByText('已设置').length).toBeGreaterThan(0)
  })

  // 密钥框不是表单字段，原样 PUT 回去会把它清掉。
  it('没碰 key 框就保存：不带 apiKey，也不带 apiKeySet', async () => {
    mount(cloud)
    await screen.findByLabelText('识别 key')
    await userEvent.type(screen.getByLabelText('QTH'), '成都')
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    const asr = sentBody().ai.asr
    expect('apiKey' in asr).toBe(false)
    expect('apiKeySet' in asr).toBe(false)
    expect('apiKey' in sentBody().ai.text).toBe(false)
    expect('apiKeySet' in sentBody().ai.text).toBe(false)
    expect('amapSecurityCode' in sentBody().map).toBe(false)
    expect('amapSecurityCodeSet' in sentBody().map).toBe(false)
  })

  it('敲了一个字又删掉再保存：当作没碰，存着的 key 不清', async () => {
    mount(cloud)
    const key = await screen.findByLabelText('识别 key')
    await userEvent.type(key, 'x')
    await userEvent.clear(key)
    await userEvent.type(screen.getByLabelText('QTH'), '成都')
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect('apiKey' in sentBody().ai.asr).toBe(false)
  })

  it('框里有字才发；存完框清空，仍显示已设置', async () => {
    mount(cloud)
    const key = await screen.findByLabelText('识别 key')
    await userEvent.type(key, 'sk-new')
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(sentBody().ai.asr.apiKey).toBe('sk-new')
    await waitFor(() => expect(screen.getByLabelText('识别 key')).toHaveValue(''))
    expect(screen.getAllByText('已设置').length).toBeGreaterThan(0)
  })

  it('只有点「清除」才发空串，存完显示还没设', async () => {
    mount(cloud)
    await screen.findByLabelText('识别 key')
    await userEvent.click(screen.getByText('清除'))
    expect(screen.getByText('保存后清除')).toBeInTheDocument()
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(sentBody().ai.asr.apiKey).toBe('')
    await waitFor(() => expect(screen.queryByText('已设置')).not.toBeInTheDocument())
    expect(screen.getByText(/还没设|只写不读/)).toBeInTheDocument()
  })

  it('点了清除又反悔：不发', async () => {
    mount(cloud)
    await screen.findByLabelText('识别 key')
    await userEvent.click(screen.getByText('清除'))
    await userEvent.click(screen.getByText('不清除了'))
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect('apiKey' in sentBody().ai.asr).toBe(false)
  })

  it('额外参数是 JSON 文本：存时解析成对象带上', async () => {
    mount(cloud)
    const extra = await screen.findByLabelText('识别 额外参数')
    expect(extra).toHaveValue('{"thinking":{"type":"disabled"}}')
    await userEvent.clear(extra)
    await userEvent.click(extra)
    await userEvent.paste('{"max_completion_tokens":512}')
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(sentBody().ai.asr.extraBody).toEqual({ max_completion_tokens: 512 })
  })

  it('额外参数不是 JSON 对象：当场说，也存不了', async () => {
    mount(cloud)
    const extra = await screen.findByLabelText('识别 额外参数')
    await userEvent.clear(extra)
    await userEvent.click(extra)
    await userEvent.paste('[1,2]')
    await userEvent.click(saveBtn())

    expect(await screen.findByText(/要写成 JSON 对象/)).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('云端要填地址和模型名：开着时必填', async () => {
    mount({ ...cloud, ai: { ...cloud.ai, asr: { ...cloud.ai.asr, baseUrl: '' } } })
    await screen.findByLabelText('识别 key')
    await userEvent.click(saveBtn())
    expect(await screen.findByText('地址必填')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('识别改成关闭：提取跟着关，提取的云端和本机选项都选不了', async () => {
    mount({ ...cloud, ai: { ...cloud.ai, text: { ...cloud.ai.text, provider: 'local' } } })
    await userEvent.click(await screen.findByRole('combobox', { name: '识别方式' }))
    const option = (await screen.findAllByTitle('关闭')).find((e) => e.classList.contains('ant-select-item-option'))
    await userEvent.click(option!)
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(sentBody().ai.asr.provider).toBe('off')
    expect(sentBody().ai.text.provider).toBe('off')
    expect(screen.getByText('识别关着，提取也只能关。')).toBeInTheDocument()
  })
})

describe('SettingsPage 的地图卡', () => {
  it('三选一：高德、OpenStreetMap、不用地图', async () => {
    mount(base)
    expect(await screen.findByRole('radio', { name: '高德' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'OpenStreetMap' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '不用地图' })).toBeChecked()
  })

  it('选 OpenStreetMap：说国内可能打不开，不要 key', async () => {
    mount(base)
    await userEvent.click(await screen.findByRole('radio', { name: 'OpenStreetMap' }))
    expect(screen.getByText(/国内可能打不开/)).toBeInTheDocument()
    expect(screen.queryByLabelText('高德 key')).not.toBeInTheDocument()
  })

  it('选高德：要 key 和安全密钥，写明去哪申请', async () => {
    mount(base)
    await userEvent.click(await screen.findByRole('radio', { name: '高德' }))
    expect(screen.getByLabelText('高德 key')).toBeInTheDocument()
    expect(screen.getByLabelText('高德安全密钥')).toHaveValue('')
    expect(screen.getByText(/console\.amap\.com/)).toBeInTheDocument()
  })

  it('高德 key 必填', async () => {
    mount(base)
    await userEvent.click(await screen.findByRole('radio', { name: '高德' }))
    await userEvent.click(saveBtn())
    expect(await screen.findByText('key 必填')).toBeInTheDocument()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  const amap: Settings = { ...base, map: { provider: 'amap', amapKey: 'pubkey', amapSecurityCodeSet: true } }

  it('高德 key 是公开的照常显示；安全密钥只显示已设置，没碰就不发', async () => {
    mount(amap)
    expect(await screen.findByLabelText('高德 key')).toHaveValue('pubkey')
    expect(screen.getByLabelText('高德安全密钥')).toHaveValue('')
    await userEvent.type(screen.getByLabelText('QTH'), '成都')
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(sentBody().map).toEqual({ provider: 'amap', amapKey: 'pubkey' })
  })

  it('安全密钥敲了字才发', async () => {
    mount(amap)
    await userEvent.type(await screen.findByLabelText('高德安全密钥'), 'secret123')
    await userEvent.click(saveBtn())

    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(sentBody().map.amapSecurityCode).toBe('secret123')
    expect('amapSecurityCodeSet' in sentBody().map).toBe(false)
  })

  it('安全密钥敲了又删：不发；点清除：发空串', async () => {
    mount(amap)
    const box = await screen.findByLabelText('高德安全密钥')
    await userEvent.type(box, 'a')
    await userEvent.clear(box)
    await userEvent.click(saveBtn())
    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect('amapSecurityCode' in sentBody().map).toBe(false)

    saveSettings.mockClear()
    await userEvent.click(await screen.findByText('清除'))
    await userEvent.click(saveBtn())
    await waitFor(() => expect(saveSettings).toHaveBeenCalledOnce())
    expect(sentBody().map.amapSecurityCode).toBe('')
  })
})

describe('SettingsPage 本台网格旁的地图按钮', () => {
  it('没选地图：按钮禁用', async () => {
    mount(base)
    const btn = await screen.findByRole('button', { name: /在地图上选/ })
    expect(btn).toBeDisabled()
  })

  it('选了 OpenStreetMap：按钮能点', async () => {
    mount(base, { provider: 'osm' })
    expect(await screen.findByRole('button', { name: /在地图上选/ })).toBeEnabled()
  })
})
