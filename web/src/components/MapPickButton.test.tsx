import { App, Form } from 'antd'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gridCenter } from '@core'
import type { MapProvider, StationMap } from '../api'
import { setViewportWidth } from '../testSetup'
import { StoreContext } from '../store'
import type { Store } from '../store'
import { QsoFields } from './QsoFields'
import type { AdapterInit, LatLon, MapAdapter } from './map/adapter'

// 真地图不进测试：换成假适配器，点哪里由测试决定。
let pick: ((p: LatLon) => void) | undefined
const adapter: MapAdapter = {
  setMarker: vi.fn(),
  setCell: vi.fn(),
  setView: vi.fn(),
  onPick: vi.fn((cb) => {
    pick = cb
  }),
  search: vi.fn(async () => []),
  reverse: vi.fn(async () => '北京海淀'),
  destroy: vi.fn(),
}
const createOsm = vi.hoisted(() => vi.fn())
const createAmap = vi.hoisted(() => vi.fn())
vi.mock('./map/osm', () => ({ createOsm }))
vi.mock('./map/amap', () => ({ createAmap }))

const BEIJING = { lat: 39.9042, lon: 116.4074 }

function Harness({ provider, initial }: { provider?: MapProvider; initial?: Record<string, string> }) {
  const [form] = Form.useForm()
  return (
    <Form form={form} initialValues={initial}>
      <QsoFields autoFocus={false} mapProvider={provider} />
    </Form>
  )
}

const mount = (provider?: MapProvider, map: StationMap = { provider: provider ?? 'none' }, initial?: Record<string, string>) =>
  render(
    <App>
      <StoreContext value={{ map, station: { myGridsquare: 'PM01RF' } } as unknown as Store}>
        <Harness provider={provider} initial={initial} />
      </StoreContext>
    </App>,
  )

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: /在地图上选/ }))
  await waitFor(() => expect(adapter.onPick).toHaveBeenCalled())
}

beforeEach(() => {
  vi.clearAllMocks()
  createOsm.mockImplementation(async () => adapter)
  createAmap.mockImplementation(async () => adapter)
})
afterEach(() => setViewportWidth(1280))

describe('QsoFields 的地图按钮', () => {
  it('没给 mapProvider 就没有按钮，也不读 store（recall.test.tsx 不在 StoreProvider 里渲染它）', () => {
    render(
      <Form>
        <QsoFields autoFocus={false} />
      </Form>,
    )
    expect(screen.queryByRole('button', { name: /在地图上选/ })).not.toBeInTheDocument()
  })

  it('没选地图：按钮禁用；手机上原因写成字，不靠悬停', () => {
    setViewportWidth(375)
    mount('none')
    expect(screen.getByRole('button', { name: /在地图上选/ })).toBeDisabled()
    expect(screen.getByText('在设置里选一种地图')).toBeInTheDocument()
  })

  it('桌面上原因在悬停提示里，页面上不多一行字', () => {
    mount('none')
    expect(screen.getByRole('button', { name: /在地图上选/ })).toBeDisabled()
    expect(screen.queryByText('在设置里选一种地图')).not.toBeInTheDocument()
  })

  it('选了地图：点开才加载，点一下地图再确认，网格填进「对方网格」', async () => {
    mount('osm')
    expect(createOsm).not.toHaveBeenCalled()
    await open()
    expect(createOsm).toHaveBeenCalledOnce()
    act(() => pick!(BEIJING))
    await userEvent.click(await screen.findByRole('button', { name: /用这个网格/ }))
    expect(screen.getByLabelText('对方网格')).toHaveValue('OM89EV')
    expect(screen.queryByRole('button', { name: /用这个网格/ })).not.toBeInTheDocument()
  })

  it('输入框里已有网格：从它开始，没动就确认，填回去的还是它（大写）', async () => {
    mount('osm', undefined, { gridsquare: 'om89ev' })
    await open()
    expect((createOsm.mock.calls[0]![0] as AdapterInit).center).toEqual(gridCenter('OM89EV'))
    await userEvent.click(await screen.findByRole('button', { name: /用这个网格/ }))
    expect(screen.getByLabelText('对方网格')).toHaveValue('OM89EV')
  })

  it('网格没填时，本台网格当起点，但没有标记，不能直接确认', async () => {
    mount('osm')
    await open()
    expect((createOsm.mock.calls[0]![0] as AdapterInit).center).toEqual(gridCenter('PM01RF'))
    expect(screen.getByRole('button', { name: /用这个网格/ })).toBeDisabled()
  })

  it('勾「同时填 QTH」：QTH 也填进「对方 QTH」', async () => {
    mount('osm')
    await open()
    act(() => pick!(BEIJING))
    await userEvent.click(await screen.findByRole('checkbox', { name: /同时填 QTH/ }))
    await screen.findByText(/北京海淀/)
    await userEvent.click(screen.getByRole('button', { name: /用这个网格/ }))
    expect(screen.getByLabelText('对方网格')).toHaveValue('OM89EV')
    expect(screen.getByLabelText('对方 QTH')).toHaveValue('北京海淀')
  })

  it('没勾：已有的 QTH 不动', async () => {
    mount('osm', undefined, { qth: '原来的' })
    await open()
    act(() => pick!(BEIJING))
    await userEvent.click(await screen.findByRole('button', { name: /用这个网格/ }))
    expect(screen.getByLabelText('对方 QTH')).toHaveValue('原来的')
  })

  it('取消：什么都不填', async () => {
    mount('osm', undefined, { gridsquare: 'PM01' })
    await open()
    act(() => pick!(BEIJING))
    await userEvent.click(screen.getByRole('button', { name: /取\s*消/ }))
    expect(screen.getByLabelText('对方网格')).toHaveValue('PM01')
    await waitFor(() => expect(adapter.destroy).toHaveBeenCalled())
  })

  it('高德：把 store 里的 key 交给地图', async () => {
    mount('amap', { provider: 'amap', amapKey: 'pubkey' })
    await open()
    expect(createAmap).toHaveBeenCalledOnce()
    expect((createAmap.mock.calls[0]![0] as AdapterInit).amapKey).toBe('pubkey')
    expect(createOsm).not.toHaveBeenCalled()
  })
})
