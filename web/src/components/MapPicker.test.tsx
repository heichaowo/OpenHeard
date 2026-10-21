import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gridCenter } from '@core'
import MapPicker, { LOAD_TIMEOUT_MS } from './MapPicker'
import type { MapPickerProps } from './MapPicker'
import type { AdapterFactory, LatLon, MapAdapter, SearchHit } from './map/adapter'

// 选点的逻辑和地图本身分开：这里用一个假适配器，真地图（高德、Leaflet）各有自己的测试。
function fake() {
  let pick: ((p: LatLon) => void) | undefined
  const adapter = {
    setMarker: vi.fn(),
    setCell: vi.fn(),
    setView: vi.fn(),
    onPick: vi.fn((cb: (p: LatLon) => void) => {
      pick = cb
    }),
    search: vi.fn(async (): Promise<SearchHit[]> => []),
    reverse: vi.fn(async (): Promise<string | undefined> => '深圳南山区'),
    destroy: vi.fn(),
  } satisfies MapAdapter
  const factory = vi.fn<AdapterFactory>(async () => adapter)
  return { adapter, factory, click: (p: LatLon) => act(() => pick!(p)) }
}

const BEIJING: LatLon = { lat: 39.9042, lon: 116.4074 }
const SHANGHAI: LatLon = { lat: 31.2304, lon: 121.4737 }

const onPick = vi.fn()
const onCancel = vi.fn()

const mount = (f: ReturnType<typeof fake>, over: Partial<MapPickerProps> = {}) =>
  render(<MapPicker open provider="osm" factory={f.factory} onPick={onPick} onCancel={onCancel} {...over} />)

const ready = (f: ReturnType<typeof fake>) => waitFor(() => expect(f.adapter.onPick).toHaveBeenCalled())
const useButton = () => screen.getByRole('button', { name: /用这个网格/ })

beforeEach(() => vi.clearAllMocks())

describe('MapPicker 的起点和标记', () => {
  it('没有任何线索：起点是中国，不摆标记，「用这个网格」禁用', async () => {
    const f = fake()
    mount(f)
    await ready(f)
    expect(f.factory.mock.calls[0]![1]).toMatchObject({ center: { lat: 35, lon: 104 }, zoom: 4 })
    expect(f.adapter.setMarker).toHaveBeenLastCalledWith(null)
    expect(useButton()).toBeDisabled()
  })

  it('只有本台网格：以它为起点，但不摆标记，不能把本台网格填成对方的', async () => {
    const f = fake()
    mount(f, { stationGrid: 'OM89EV' })
    await ready(f)
    expect(f.factory.mock.calls[0]![1].center).toEqual(gridCenter('OM89EV'))
    expect(f.adapter.setMarker).toHaveBeenLastCalledWith(null)
    expect(useButton()).toBeDisabled()
  })

  it('输入框里本来就有合法网格：从它开始，标记摆在中心，格子画出来', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'OM89EV', stationGrid: 'PM01RF' })
    await ready(f)
    expect(f.factory.mock.calls[0]![1].center).toEqual(gridCenter('OM89EV'))
    await waitFor(() => expect(f.adapter.setMarker).toHaveBeenLastCalledWith(gridCenter('OM89EV')))
    expect(f.adapter.setCell).toHaveBeenLastCalledWith('OM89EV')
    expect(useButton()).toBeEnabled()
  })

  it('输入框里的网格不合法：当没有，起点退到本台网格', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'ZZ99', stationGrid: 'PM01RF' })
    await ready(f)
    expect(f.factory.mock.calls[0]![1].center).toEqual(gridCenter('PM01RF'))
    expect(useButton()).toBeDisabled()
  })

  it('网格没填、QTH 填了：用 QTH 查一次起点，只移视图，不摆标记', async () => {
    const f = fake()
    f.adapter.search.mockResolvedValueOnce([{ name: '深圳', point: { lat: 22.54, lon: 114.06 } }])
    mount(f, { fieldQth: '深圳' })
    await waitFor(() => expect(f.adapter.setView).toHaveBeenCalledWith({ lat: 22.54, lon: 114.06 }, 10))
    expect(f.adapter.search).toHaveBeenCalledExactlyOnceWith('深圳')
    // 摆标记的 effect 要等「就绪」那次渲染提交之后才跑，可能比搜索回来还晚。
    await waitFor(() => expect(f.adapter.setMarker).toHaveBeenLastCalledWith(null))
    expect(useButton()).toBeDisabled()
  })

  it('网格已经有了，不再拿 QTH 去搜', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'OM89EV', fieldQth: '北京' })
    await ready(f)
    expect(f.adapter.search).not.toHaveBeenCalled()
  })
})

describe('MapPicker 填回网格', () => {
  // 打开、不动、按「用这个网格」，填回去的必须是原来的那个。
  it('打开 OM89EV，没动就按：还是 OM89EV', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'OM89EV' })
    await ready(f)
    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'OM89EV', qth: undefined })
  })

  it('原来是 4 位的，没动就按：还是 4 位，不凭空多出 2 位精度；小写变大写', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'om89' })
    await ready(f)
    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'OM89', qth: undefined })
  })

  it('没动过时显示的就是要填回去的：4 位的输入显示 4 位，不显示成 6 位', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'OM89' })
    await ready(f)
    expect(await screen.findByText(/4 位/)).toBeInTheDocument()
    expect(screen.getByText('OM89')).toBeInTheDocument()
    expect(screen.queryByText(/6 位/)).not.toBeInTheDocument()
  })

  it('点地图：显示 6 位（要填的）和 8 位（参考），标记和格子跟着走，填回 6 位', async () => {
    const f = fake()
    mount(f)
    await ready(f)
    f.click(BEIJING)
    expect(await screen.findByText('OM89EV')).toBeInTheDocument()
    expect(screen.getByText('OM89EV87')).toBeInTheDocument()
    expect(f.adapter.setMarker).toHaveBeenLastCalledWith(BEIJING)
    expect(f.adapter.setCell).toHaveBeenLastCalledWith('OM89EV')

    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'OM89EV', qth: undefined })
  })

  it('输入框里有网格，但人又点了别处：填新点的，不是原来的', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'OM89EV' })
    await ready(f)
    f.click(SHANGHAI)
    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'PM01RF', qth: undefined })
  })

  it('取消不填', async () => {
    const f = fake()
    mount(f, { fieldGrid: 'OM89EV' })
    await ready(f)
    await userEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('MapPicker 搜地名', () => {
  const hit = (name: string, p: LatLon): SearchHit => ({ name, point: p })

  it('边输边不搜，只在回车时搜一次，搜到的第一个摆上标记并移过去', async () => {
    const f = fake()
    f.adapter.search.mockResolvedValueOnce([hit('北京', BEIJING)])
    mount(f)
    await ready(f)
    await userEvent.type(screen.getByPlaceholderText(/搜地名/), '北京')
    expect(f.adapter.search).not.toHaveBeenCalled()

    await userEvent.type(screen.getByPlaceholderText(/搜地名/), '{Enter}')
    await waitFor(() => expect(f.adapter.setMarker).toHaveBeenLastCalledWith(BEIJING))
    expect(f.adapter.search).toHaveBeenCalledExactlyOnceWith('北京')
    expect(f.adapter.setView).toHaveBeenCalledWith(BEIJING, 13)
    expect(useButton()).toBeEnabled()
  })

  it('搜索按钮同样搜一次', async () => {
    const f = fake()
    f.adapter.search.mockResolvedValueOnce([hit('上海', SHANGHAI)])
    mount(f)
    await ready(f)
    await userEvent.type(screen.getByPlaceholderText(/搜地名/), '上海')
    await userEvent.click(screen.getByRole('button', { name: /搜\s*索/ }))
    await waitFor(() => expect(f.adapter.setMarker).toHaveBeenLastCalledWith(SHANGHAI))
    expect(f.adapter.search).toHaveBeenCalledOnce()
  })

  it('有多个结果时列出来，点哪个就摆在哪个', async () => {
    const f = fake()
    f.adapter.search.mockResolvedValueOnce([hit('北京', BEIJING), hit('上海', SHANGHAI)])
    mount(f)
    await ready(f)
    await userEvent.type(screen.getByPlaceholderText(/搜地名/), '市{Enter}')
    await userEvent.click(await screen.findByText('上海'))
    expect(f.adapter.setMarker).toHaveBeenLastCalledWith(SHANGHAI)
  })

  it('没搜到：说一声，不摆标记', async () => {
    const f = fake()
    mount(f)
    await ready(f)
    await userEvent.type(screen.getByPlaceholderText(/搜地名/), '不存在{Enter}')
    expect(await screen.findByText('没有找到这个地名')).toBeInTheDocument()
    expect(useButton()).toBeDisabled()
  })

  it('搜索出错：说一声，输入框和按钮照常', async () => {
    const f = fake()
    f.adapter.search.mockRejectedValueOnce(new Error('503'))
    mount(f)
    await ready(f)
    await userEvent.type(screen.getByPlaceholderText(/搜地名/), '北京{Enter}')
    expect(await screen.findByText('搜不到，地名服务没有回应')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/搜地名/)).toBeEnabled()
  })
})

describe('MapPicker 的 QTH', () => {
  it('没勾「同时填 QTH」：怎么选点都不反查，填回来也没有 QTH', async () => {
    const f = fake()
    mount(f)
    await ready(f)
    f.click(BEIJING)
    f.click(SHANGHAI)
    await userEvent.click(useButton())
    expect(f.adapter.reverse).not.toHaveBeenCalled()
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'PM01RF', qth: undefined })
  })

  it('勾了：反查当前点，结果显示出来，随网格一起填回', async () => {
    const f = fake()
    mount(f)
    await ready(f)
    f.click(BEIJING)
    await userEvent.click(screen.getByRole('checkbox', { name: /同时填 QTH/ }))
    expect(await screen.findByText(/深圳南山区/)).toBeInTheDocument()
    expect(f.adapter.reverse).toHaveBeenLastCalledWith(BEIJING)

    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'OM89EV', qth: '深圳南山区' })
  })

  // 反查还没回来就按，qth 是 undefined，表单里的 QTH 原样不动，勾了却什么都没填，没有一点声音。
  it('反查还没回来：「用这个网格」先转圈禁用，回来之后才能按，QTH 跟着填回', async () => {
    const f = fake()
    let answer!: (q: string) => void
    f.adapter.reverse.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    mount(f)
    await ready(f)
    f.click(BEIJING)
    await userEvent.click(screen.getByRole('checkbox', { name: /同时填 QTH/ }))
    await screen.findByText(/查地名/)
    expect(useButton()).toBeDisabled()
    expect(useButton()).toHaveClass('ant-btn-loading')

    await act(async () => answer('北京东城'))
    await waitFor(() => expect(useButton()).toBeEnabled())
    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'OM89EV', qth: '北京东城' })
  })

  it('反查失败：按钮放开，没查到就不填 QTH，不会卡住', async () => {
    const f = fake()
    f.adapter.reverse.mockRejectedValueOnce(new Error('503'))
    mount(f)
    await ready(f)
    f.click(BEIJING)
    await userEvent.click(screen.getByRole('checkbox', { name: /同时填 QTH/ }))
    await screen.findByText(/没查到/)
    expect(useButton()).toBeEnabled()
  })

  it('没勾 QTH：「用这个网格」不转圈', async () => {
    const f = fake()
    mount(f)
    await ready(f)
    f.click(BEIJING)
    expect(useButton()).toBeEnabled()
    expect(useButton()).not.toHaveClass('ant-btn-loading')
  })

  it('勾着的时候换点，反查跟着换；先发的晚回来，不盖掉后发的', async () => {
    const f = fake()
    let late!: (q: string) => void
    f.adapter.reverse.mockImplementationOnce(() => new Promise((r) => (late = r)))
    f.adapter.reverse.mockResolvedValueOnce('上海浦东')
    mount(f)
    await ready(f)
    await userEvent.click(screen.getByRole('checkbox', { name: /同时填 QTH/ }))
    f.click(BEIJING)
    f.click(SHANGHAI)
    expect(await screen.findByText(/上海浦东/)).toBeInTheDocument()
    await act(async () => late('北京海淀'))
    expect(screen.getByText(/上海浦东/)).toBeInTheDocument()
    expect(screen.queryByText(/北京海淀/)).not.toBeInTheDocument()
  })

  it('取消勾选：不再反查，填回来的没有 QTH', async () => {
    const f = fake()
    mount(f)
    await ready(f)
    f.click(BEIJING)
    await userEvent.click(screen.getByRole('checkbox', { name: /同时填 QTH/ }))
    await screen.findByText(/深圳南山区/)
    await userEvent.click(screen.getByRole('checkbox', { name: /同时填 QTH/ }))
    f.adapter.reverse.mockClear()
    f.click(SHANGHAI)
    await userEvent.click(useButton())
    expect(f.adapter.reverse).not.toHaveBeenCalled()
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'PM01RF', qth: undefined })
  })

  it('反查没有结果：显示没查到，只填网格', async () => {
    const f = fake()
    f.adapter.reverse.mockResolvedValue(undefined)
    mount(f)
    await ready(f)
    f.click(BEIJING)
    await userEvent.click(screen.getByRole('checkbox', { name: /同时填 QTH/ }))
    expect(await screen.findByText(/没查到/)).toBeInTheDocument()
    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'OM89EV', qth: undefined })
  })
})

describe('MapPicker 打不开', () => {
  const failure = '地图打不开，网格可以直接填'

  it('打不开时没有网格线索，不再催人点地图', async () => {
    const f = fake()
    f.factory.mockRejectedValueOnce(new Error('脚本加载失败'))
    mount(f)
    await screen.findByText(failure)
    expect(screen.queryByText(/点地图、拖标记/)).not.toBeInTheDocument()
    expect(useButton()).toBeDisabled()
  })

  it('加载失败立刻说：弹窗还在，输入框里已有的网格照样能填回去', async () => {
    const f = fake()
    f.factory.mockRejectedValueOnce(new Error('脚本加载失败'))
    mount(f, { fieldGrid: 'OM89EV' })
    expect(await screen.findByText(failure)).toBeInTheDocument()
    await userEvent.click(useButton())
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ grid: 'OM89EV', qth: undefined })
  })

  it('高德加载失败：把原因写在警告里', async () => {
    const f = fake()
    f.factory.mockRejectedValueOnce(new Error('改了高德 key，要刷新页面才能用新的'))
    mount(f, { provider: 'amap', amapKey: 'k' })
    await screen.findByText(failure)
    expect(screen.getByText('改了高德 key，要刷新页面才能用新的')).toBeInTheDocument()
  })

  describe('一直转圈', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
    afterEach(() => vi.useRealTimers())

    it('10 秒还没画出来：说打不开；OpenStreetMap 再提一句国内可能连不上', async () => {
      const f = fake()
      f.factory.mockImplementationOnce(() => new Promise(() => undefined))
      mount(f)
      expect(screen.queryByText(failure)).not.toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(LOAD_TIMEOUT_MS - 1)
      })
      expect(screen.queryByText(failure)).not.toBeInTheDocument()
      await act(async () => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.getByText(failure)).toBeInTheDocument()
      expect(screen.getByText(/国内可能连不上/)).toBeInTheDocument()
    })

    it('高德超时不提 OpenStreetMap', async () => {
      const f = fake()
      f.factory.mockImplementationOnce(() => new Promise(() => undefined))
      mount(f, { provider: 'amap', amapKey: 'k' })
      await act(async () => {
        vi.advanceTimersByTime(LOAD_TIMEOUT_MS)
      })
      expect(screen.getByText(failure)).toBeInTheDocument()
      expect(screen.queryByText(/国内可能连不上/)).not.toBeInTheDocument()
    })

    it('超时之后才画完的地图丢掉，不留在后台', async () => {
      const f = fake()
      let done!: (a: MapAdapter) => void
      f.factory.mockImplementationOnce(() => new Promise((r) => (done = r)))
      mount(f)
      await act(async () => {
        vi.advanceTimersByTime(LOAD_TIMEOUT_MS)
      })
      await act(async () => done(f.adapter))
      expect(f.adapter.destroy).toHaveBeenCalledOnce()
      expect(f.adapter.onPick).not.toHaveBeenCalled()
    })
  })

  it('弹窗关掉（卸载）时把地图销毁', async () => {
    const f = fake()
    const { unmount } = mount(f)
    await ready(f)
    unmount()
    expect(f.adapter.destroy).toHaveBeenCalledOnce()
  })

  it('把 provider 和高德 key 交给工厂', async () => {
    const f = fake()
    mount(f, { provider: 'amap', amapKey: 'pubkey' })
    await ready(f)
    expect(f.factory.mock.calls[0]![0]).toBe('amap')
    expect(f.factory.mock.calls[0]![1].amapKey).toBe('pubkey')
  })
})
