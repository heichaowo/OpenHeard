import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerProvider } from '../PlayerProvider'
import { StoreContext } from '../store'
import type { Store } from '../store'
import { AudioPill } from './AudioPill'

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

const mount = (id: string, durationS: number, recordings: string[]) =>
  render(
    <MemoryRouter>
      <StoreContext value={store(recordings)}>
        <PlayerProvider>
          <AudioPill id={id} durationS={durationS} />
        </PlayerProvider>
      </StoreContext>
    </MemoryRouter>,
  )

describe('AudioPill', () => {
  it('没有录音：禁用，还是显示时长', () => {
    mount('a1', 3.2, [])
    const btn = screen.getByRole('button', { name: '没有录音' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveTextContent('▶ 3.2 秒')
  })

  it('有录音，闲着时显示 ▶ 加时长，aria-label 报时长', () => {
    mount('a1', 3.2, ['a1'])
    const btn = screen.getByRole('button', { name: '播放 3.2 秒的录音' })
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveTextContent('▶ 3.2 秒')
  })

  it('点一下开始放，变成 ❚❚ 加进度/总长', async () => {
    mount('a1', 3.2, ['a1'])
    await userEvent.click(screen.getByRole('button'))

    expect(screen.getByRole('button')).toHaveTextContent('❚❚')
    expect(FakeAudio.instances[0]!.src).toContain('/api/recordings/a1')
  })

  it('放着的时候再点一下就暂停', async () => {
    mount('a1', 3.2, ['a1'])
    const btn = screen.getByRole('button')
    await userEvent.click(btn)
    await userEvent.click(btn)

    expect(FakeAudio.instances[0]!.paused).toBe(true)
  })
})
