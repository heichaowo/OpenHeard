import { Form } from 'antd'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Qso } from '@core'
import { QsoFields } from './components/QsoFields'
import type { QsoFormValues } from './components/QsoFields'
import { useRecall } from './recall'

const qso = (call: string, startAt: number, over: Partial<Qso> = {}): Qso => ({
  id: `${call}-${startAt}`,
  call,
  startAt,
  freqMhz: 439.525,
  band: '70cm',
  mode: 'FM',
  rstSent: '59',
  rstRcvd: '59',
  createdAt: startAt,
  ...over,
})

function Harness({ qsos, initial }: { qsos: Qso[]; initial?: Partial<QsoFormValues> }) {
  const [form] = Form.useForm<QsoFormValues>()
  const { recalledAt, onValuesChange } = useRecall(form, qsos)
  return (
    <Form form={form} layout="vertical" initialValues={initial} onValuesChange={onValuesChange}>
      <QsoFields recalledAt={recalledAt} />
    </Form>
  )
}

const qth = () => screen.getByLabelText('对方 QTH') as HTMLInputElement
const grid = () => screen.getByLabelText('对方网格') as HTMLInputElement
const call = () => screen.getByLabelText('对方呼号')

const LOG = [qso('BD7KLO', 1_789_000_000, { qth: '深圳', gridsquare: 'OL72' })]

describe('useRecall', () => {
  it('打完呼号就把上次的 QTH 和网格补上，并说明来处', async () => {
    render(<Harness qsos={LOG} />)

    await userEvent.type(call(), 'bd7klo')

    expect(qth().value).toBe('深圳')
    expect(grid().value).toBe('OL72')
    expect(screen.getByText(/那次通联/)).toBeInTheDocument()
  })

  // 人现在打的那个一定比日志里的新，补进去会把他刚打的盖掉。
  it('已经填了的不覆盖', async () => {
    render(<Harness qsos={LOG} initial={{ qth: '广州' }} />)

    await userEvent.type(call(), 'BD7KLO')

    expect(qth().value).toBe('广州')
    expect(grid().value).toBe('OL72')
  })

  it('没打过的呼号什么都不补，也不出提示', async () => {
    render(<Harness qsos={LOG} />)

    await userEvent.type(call(), 'BA1AA')

    expect(qth().value).toBe('')
    expect(screen.queryByText(/那次通联/)).not.toBeInTheDocument()
  })

  it('呼号改成另一个人之后提示就撤掉', async () => {
    render(<Harness qsos={LOG} />)
    await userEvent.type(call(), 'BD7KLO')
    expect(screen.getByText(/那次通联/)).toBeInTheDocument()

    await userEvent.clear(call())
    await userEvent.type(call(), 'BA1AA')

    expect(screen.queryByText(/那次通联/)).not.toBeInTheDocument()
  })
})
