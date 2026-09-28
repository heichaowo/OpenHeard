import { App, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StationDefaults } from '@core'
import { Preferences } from '../Preferences'
import { StoreContext } from '../store'
import type { Store } from '../store'
import QuickEntry from './QuickEntry'

const addQso = vi.fn()
const removeQso = vi.fn()

const store = (station: StationDefaults): Store =>
  ({
    station,
    channels: [{ name: '438.500 中继', freqMhz: 438.5, mode: 'FM' }],
    qsos: [],
    addQso,
    removeQso,
  }) as unknown as Store

const tree = (station: StationDefaults) => (
  // 撤销条的 Popconfirm 用 antd 的缺省按钮文案（确定/取消），真实的 App.tsx
  // 套了 zhCN 这层 ConfigProvider 才有中文；这里补上，不然点到的是英文 OK。
  <ConfigProvider locale={zhCN}>
    <Preferences>
      <App>
        <StoreContext value={store(station)}>
          <QuickEntry />
        </StoreContext>
      </App>
    </Preferences>
  </ConfigProvider>
)

describe('QuickEntry', () => {
  beforeEach(() => {
    addQso.mockReset()
    removeQso.mockReset()
  })

  it('说明文字说经过采集的走收听页，不是待确认队列', () => {
    render(tree({}))
    expect(screen.getByText(/经过采集的在收听页入库/)).toBeInTheDocument()
  })

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

// 只管这一页刚记的最后一条，撤销走删除，删除照样留痕。
describe('QuickEntry 的撤销条', () => {
  beforeEach(() => {
    addQso.mockReset()
    removeQso.mockReset()
  })

  const fillAndSubmit = async (call: string) => {
    await userEvent.type(screen.getByLabelText('对方呼号'), call)
    await userEvent.type(screen.getByLabelText('频率 MHz'), '438.525')
    // antd 给两个汉字的按钮文案自动插了一个空格（别处「保存」按钮的查法一样）。
    await userEvent.click(screen.getByRole('button', { name: /^入\s*库$/ }))
  }

  it('入库成功后出现撤销条，写着刚记下的呼号', async () => {
    addQso.mockResolvedValue({ id: 'q1', call: 'BD7KLO' })
    render(tree({}))

    await fillAndSubmit('bd7klo')

    expect(await screen.findByText('已记下 BD7KLO')).toBeInTheDocument()
  })

  it('撤销要先确认，确认了才调 removeQso', async () => {
    addQso.mockResolvedValue({ id: 'q1', call: 'BD7KLO' })
    removeQso.mockResolvedValue(undefined)
    render(tree({}))
    await fillAndSubmit('bd7klo')
    await screen.findByText('已记下 BD7KLO')

    await userEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(removeQso).not.toHaveBeenCalled()

    await userEvent.click(await screen.findByRole('button', { name: /^确\s*定$/ }))
    expect(removeQso).toHaveBeenCalledWith('q1')
    await waitFor(() => expect(screen.queryByText('已记下 BD7KLO')).not.toBeInTheDocument())
  })

  it('再记一条之后，撤销条换成新的那条', async () => {
    addQso.mockResolvedValueOnce({ id: 'q1', call: 'BD7KLO' })
    addQso.mockResolvedValueOnce({ id: 'q2', call: 'BA1AA' })
    render(tree({}))

    await fillAndSubmit('bd7klo')
    await screen.findByText('已记下 BD7KLO')

    await fillAndSubmit('ba1aa')
    expect(await screen.findByText('已记下 BA1AA')).toBeInTheDocument()
    expect(screen.queryByText('已记下 BD7KLO')).not.toBeInTheDocument()
  })
})
