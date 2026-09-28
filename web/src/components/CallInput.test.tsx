import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Qso } from '@core'
import { Preferences } from '../Preferences'
import { CallInput } from './CallInput'

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

// 三个不同呼号，BD7KLO 通联过两次（新旧各一条），用来看去重和排序。
const QSOS: Qso[] = [
  qso('BD7KLO', 1_000, { qth: '旧的' }),
  qso('BD7ABC', 2_000, { qth: '成都' }),
  qso('BD7KLO', 3_000, { qth: '新的' }),
]

function Harness({ qsos }: { qsos: Qso[] }) {
  const [value, setValue] = useState('')
  return <CallInput qsos={qsos} value={value} onChange={setValue} />
}

describe('CallInput', () => {
  it('按前缀匹配，同一个呼号只留最近那次', async () => {
    render(
      <Preferences>
        <Harness qsos={QSOS} />
      </Preferences>,
    )
    await userEvent.type(screen.getByRole('combobox'), 'BD7K')

    const options = await screen.findAllByText('BD7KLO')
    expect(options).toHaveLength(1)
    expect(screen.getByText('新的')).toBeInTheDocument()
    expect(screen.queryByText('旧的')).not.toBeInTheDocument()
    expect(screen.queryByText('BD7ABC')).not.toBeInTheDocument()
  })

  it('最近联系过的排在前面', async () => {
    render(
      <Preferences>
        <Harness qsos={QSOS} />
      </Preferences>,
    )
    await userEvent.type(screen.getByRole('combobox'), 'BD7')

    const calls = (await screen.findAllByText(/^BD7/)).map((el) => el.textContent)
    expect(calls).toEqual(['BD7KLO', 'BD7ABC'])
  })

  it('超过 8 个只留最近的 8 个', async () => {
    const many = Array.from({ length: 10 }, (_, i) => qso(`BD7A${i}`, 1_000 + i))
    render(
      <Preferences>
        <Harness qsos={many} />
      </Preferences>,
    )
    await userEvent.type(screen.getByRole('combobox'), 'BD7')

    expect((await screen.findAllByText(/^BD7A/)).length).toBe(8)
  })

  it('没有联系记录时不带联想，也不出错', async () => {
    render(
      <Preferences>
        <Harness qsos={[]} />
      </Preferences>,
    )
    await userEvent.type(screen.getByRole('combobox'), 'BD7K')

    expect(screen.queryByText('BD7KLO')).not.toBeInTheDocument()
  })
})
