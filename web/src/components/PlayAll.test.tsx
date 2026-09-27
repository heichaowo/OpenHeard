import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerProvider } from '../PlayerProvider'
import { StoreContext } from '../store'
import type { Store } from '../store'
import { PlayAll } from './PlayAll'

class FakeAudio {
  static instances: FakeAudio[] = []
  src = ''
  currentTime = 0
  duration = NaN
  paused = true
  private listeners = new Map<string, Set<() => void>>()

  constructor() {
    FakeAudio.instances.push(this)
  }

  addEventListener(type: string, cb: () => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(cb)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb)
  }

  dispatch(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb()
  }

  play() {
    this.paused = false
  }

  pause() {
    this.paused = true
  }

  load() {}
  removeAttribute() {
    this.src = ''
  }
}

beforeEach(() => {
  FakeAudio.instances = []
  vi.stubGlobal('Audio', FakeAudio)
})

const store = (recordings: string[]): Store =>
  ({ recordings: new Set(recordings) }) as unknown as Store

const mount = (activities: { id: string; durationS: number }[], recordings: string[]) =>
  render(
    <MemoryRouter>
      <StoreContext value={store(recordings)}>
        <PlayerProvider>
          <PlayAll activities={activities} />
        </PlayerProvider>
      </StoreContext>
    </MemoryRouter>,
  )

const acts = [
  { id: 'a1', durationS: 4 },
  { id: 'a2', durationS: 3.5 },
  { id: 'a3', durationS: 2 },
]

describe('PlayAll', () => {
  it('一条录音都没有：禁用的「无录音」按钮，还是占着这个位置', () => {
    mount(acts, [])
    const btn = screen.getByRole('button', { name: '没有录音' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent('无录音')
  })

  it('只数有录音的那几条：段数和总时长', () => {
    mount(acts, ['a1', 'a3'])
    expect(screen.getByRole('button')).toHaveTextContent('▶ 2 段 · 6.0 秒')
  })

  it('点一下从第一条有录音的开始连播，放着时显示第几/共几', async () => {
    mount(acts, ['a1', 'a2'])
    await userEvent.click(screen.getByRole('button'))

    expect(FakeAudio.instances[0]!.src).toContain('/api/recordings/a1')
    expect(screen.getByRole('button')).toHaveTextContent('❚❚ 1/2')
  })

  it('数字侧成员永远没有录音，不算进段数和时长', () => {
    mount(
      [{ id: 'd1', durationS: 5 }, { id: 'a1', durationS: 4 }],
      ['a1'],
    )
    expect(screen.getByRole('button')).toHaveTextContent('▶ 1 段 · 4.0 秒')
  })
})
