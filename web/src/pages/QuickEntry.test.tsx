import { App } from 'antd'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { StationDefaults } from '@core'
import { Preferences } from '../Preferences'
import { StoreContext } from '../store'
import type { Store } from '../store'
import QuickEntry from './QuickEntry'

const store = (station: StationDefaults): Store =>
  ({
    station,
    channels: [{ name: '438.500 中继', freqMhz: 438.5, mode: 'FM' }],
    qsos: [],
    addQso: vi.fn(),
  }) as unknown as Store

const tree = (station: StationDefaults) => (
  <Preferences>
    <App>
      <StoreContext value={store(station)}>
        <QuickEntry />
      </StoreContext>
    </App>
  </Preferences>
)

describe('QuickEntry', () => {
  // 直接打开这一页时本台信息还没回来，表单的初值只在挂载时读一次。
  it('本台信息晚到了也补进还空着的那几格', async () => {
    const { rerender } = render(tree({}))
    rerender(tree({ myQth: '克拉玛依区', myDevice: 'Quansheng UV-K6', myHeightM: 30 }))

    expect(await screen.findByDisplayValue('克拉玛依区')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Quansheng UV-K6')).toBeInTheDocument()
    expect(screen.getByDisplayValue('30')).toBeInTheDocument()
  })

  it('人已经填了的那一格不被本台信息盖掉', async () => {
    const { rerender } = render(tree({}))
    await userEvent.type(screen.getByLabelText('设备'), '手台')
    rerender(tree({ myDevice: 'Quansheng UV-K6' }))

    await waitFor(() => expect(screen.getByLabelText('设备')).toHaveValue('手台'))
  })

  // 本台信息每 15 秒重拉一次，每次都是新对象。人清空了准备重填，不能被填回去。
  it('人清空的那一格，本台信息重拉之后也不填回去', async () => {
    const station = { myQth: '克拉玛依区' }
    const { rerender } = render(tree(station))
    const qth = await screen.findByDisplayValue('克拉玛依区')

    await userEvent.clear(qth)
    rerender(tree({ ...station }))

    await waitFor(() => expect(qth).toHaveValue(''))
  })

  it('本台信息晚到时补过一次，之后清空也不再填回去', async () => {
    const { rerender } = render(tree({}))
    rerender(tree({ myQth: '克拉玛依区' }))
    const qth = await screen.findByDisplayValue('克拉玛依区')

    await userEvent.clear(qth)
    rerender(tree({ myQth: '克拉玛依区' }))

    await waitFor(() => expect(qth).toHaveValue(''))
  })

  // 选了信道再手改频率，下拉还挂着旧信道名的话，看上去像是按那个信道记的。
  it('信道下拉跟着频率走，频率改了就不再显示原来的信道', async () => {
    render(tree({}))
    const freq = screen.getByLabelText('频率 MHz')

    await userEvent.type(freq, '438.5')
    expect(await screen.findByText('438.500 中继')).toBeInTheDocument()

    await userEvent.clear(freq)
    await userEvent.type(freq, '438.6')
    await waitFor(() => expect(screen.queryByText('438.500 中继')).not.toBeInTheDocument())
  })
})
