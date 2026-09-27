import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlayerProvider } from './PlayerProvider'
import { usePlayer, usePlayerViewKey } from './player'

/**
 * jsdom 没有真正的媒体播放（HTMLMediaElement.play/pause 是空实现），所以
 * 用一个假的 Audio 类接管 PlayerProvider 里 `new Audio()` 那一下，
 * 事件靠手动 dispatch 模拟浏览器真放的时候会报的那几个。
 */
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

function Probe() {
  const { state, play, toggle, stop } = usePlayer()
  return (
    <div>
      <p data-testid="state">{JSON.stringify(state)}</p>
      <button onClick={() => play([{ id: 'a', durationS: 3.2 }, { id: 'b', durationS: 5 }], 0)}>
        放 a+b
      </button>
      <button onClick={() => play([{ id: 'c', durationS: 2 }], 0)}>放 c</button>
      <button onClick={toggle}>切换</button>
      <button onClick={stop}>停</button>
    </div>
  )
}

function Nav() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate('/other')}>
      去别处
    </button>
  )
}

const mount = (initialPath = '/heard') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PlayerProvider>
        <Nav />
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </PlayerProvider>
    </MemoryRouter>,
  )

const stateOf = () => JSON.parse(screen.getByTestId('state').textContent!) as {
  currentId: string | null
  playing: boolean
  position: number
  duration: number
  index: number
  total: number
}

describe('PlayerProvider', () => {
  it('放一个队列：当前 id、时长（还没 loadedmetadata 前用采集时记的那个）', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))

    const s = stateOf()
    expect(s).toMatchObject({ currentId: 'a', playing: true, duration: 3.2, index: 0, total: 2 })
    expect(FakeAudio.instances[0]!.src).toContain('/api/recordings/a')
    expect(FakeAudio.instances[0]!.paused).toBe(false)
  })

  it('全程只用一个 audio 元素，放别的之前先停掉正在放的', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))
    await userEvent.click(screen.getByText('放 c'))

    expect(FakeAudio.instances).toHaveLength(1)
    expect(stateOf()).toMatchObject({ currentId: 'c', total: 1 })
    expect(FakeAudio.instances[0]!.src).toContain('/api/recordings/c')
  })

  it('切换暂停和续播', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))
    await userEvent.click(screen.getByText('切换'))
    expect(stateOf().playing).toBe(false)
    expect(FakeAudio.instances[0]!.paused).toBe(true)

    await userEvent.click(screen.getByText('切换'))
    expect(stateOf().playing).toBe(true)
    expect(FakeAudio.instances[0]!.paused).toBe(false)
  })

  it('一段放完自动接上队列里下一段，一段对话能连着放完', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))

    act(() => FakeAudio.instances[0]!.dispatch('ended'))
    expect(stateOf()).toMatchObject({ currentId: 'b', index: 1, total: 2, playing: true })
    expect(FakeAudio.instances[0]!.src).toContain('/api/recordings/b')

    act(() => FakeAudio.instances[0]!.dispatch('ended'))
    expect(stateOf()).toMatchObject({ currentId: null, playing: false })
  })

  it('loadedmetadata 到了之后时长换成文件的实长', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))

    FakeAudio.instances[0]!.duration = 3.6
    act(() => FakeAudio.instances[0]!.dispatch('loadedmetadata'))
    expect(stateOf().duration).toBe(3.6)
  })

  it('timeupdate 更新播放进度', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))

    FakeAudio.instances[0]!.currentTime = 1.4
    act(() => FakeAudio.instances[0]!.dispatch('timeupdate'))
    expect(stateOf().position).toBe(1.4)
  })

  it('停：清空队列，audio 暂停', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))
    await userEvent.click(screen.getByText('停'))

    expect(stateOf()).toMatchObject({ currentId: null, playing: false })
    expect(FakeAudio.instances[0]!.paused).toBe(true)
  })

  it('换页时自动停，跟今天内联 audio 卸载就停一个道理', async () => {
    mount()
    await userEvent.click(screen.getByText('放 a+b'))
    expect(stateOf().currentId).toBe('a')

    await userEvent.click(screen.getByText('去别处'))
    expect(stateOf()).toMatchObject({ currentId: null, playing: false })
  })
})

function ViewKeyProbe({ viewKey }: { viewKey: string }) {
  usePlayerViewKey(viewKey)
  return null
}

describe('usePlayerViewKey', () => {
  it('收听页换了筛选（key 变了）时也停，路由没变也一样', async () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/heard']}>
        <PlayerProvider>
          <Probe />
          <ViewKeyProbe viewKey="all:today:fm" />
        </PlayerProvider>
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByText('放 a+b'))
    expect(stateOf().currentId).toBe('a')

    rerender(
      <MemoryRouter initialEntries={['/heard']}>
        <PlayerProvider>
          <Probe />
          <ViewKeyProbe viewKey="pending:today:fm" />
        </PlayerProvider>
      </MemoryRouter>,
    )
    expect(stateOf()).toMatchObject({ currentId: null, playing: false })
  })
})
