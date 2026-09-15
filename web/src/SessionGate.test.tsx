import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionGate } from './SessionGate'

const { session, login, logout, handler } = vi.hoisted(() => ({
  session: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  handler: { current: undefined as (() => void) | undefined },
}))

vi.mock('./api', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    api: { session, login, logout },
    setUnauthorizedHandler: (fn?: () => void) => {
      handler.current = fn
    },
  }
})

const inside = () => screen.queryByText('进来了')

// antd 会在两个汉字的按钮中间插一个空格（进去 -> 进 去），所以按正则找。
const button = (name: string) =>
  screen.getByRole('button', { name: new RegExp(name.split('').join('\\s*')) })

beforeEach(() => {
  vi.clearAllMocks()
  handler.current = undefined
  session.mockResolvedValue({ signedIn: false })
  login.mockResolvedValue({ signedIn: true })
  logout.mockResolvedValue({ signedIn: false })
})

const mount = () =>
  render(
    <SessionGate>
      <div>进来了</div>
    </SessionGate>,
  )

describe('SessionGate', () => {
  it('没会话就显示登录表单，不渲染里面的东西', async () => {
    mount()
    expect(await screen.findByPlaceholderText('口令')).toBeInTheDocument()
    expect(inside()).not.toBeInTheDocument()
  })

  it('有会话就直接进去', async () => {
    session.mockResolvedValue({ signedIn: true })
    mount()
    await waitFor(() => expect(inside()).toBeInTheDocument())
  })

  it('口令不对时把后端那句话显示出来', async () => {
    const { ApiError } = await import('./api')
    login.mockRejectedValue(new ApiError(401, '口令不对'))
    mount()

    await userEvent.type(await screen.findByPlaceholderText('口令'), 'wrong')
    await userEvent.click(button('进去'))

    expect(await screen.findByText('口令不对')).toBeInTheDocument()
    expect(inside()).not.toBeInTheDocument()
  })

  // 会话是开着页面的时候过期的。过期之后如果不退回登录页，轮询只会一直堆
  // 「没登录」，而页面上没有任何回去的路。
  it('会话过期时退回登录页并说明原因', async () => {
    session.mockResolvedValue({ signedIn: true })
    mount()
    await waitFor(() => expect(inside()).toBeInTheDocument())

    expect(handler.current).toBeTypeOf('function')
    handler.current?.()

    expect(await screen.findByText('会话过期了，重新登录')).toBeInTheDocument()
    expect(inside()).not.toBeInTheDocument()
  })

  it('重新登录之后过期提示就没了', async () => {
    session.mockResolvedValue({ signedIn: true })
    mount()
    await waitFor(() => expect(inside()).toBeInTheDocument())
    handler.current?.()
    await screen.findByText('会话过期了，重新登录')

    await userEvent.type(await screen.findByPlaceholderText('口令'), 'right')
    await userEvent.click(button('进去'))

    await waitFor(() => expect(inside()).toBeInTheDocument())
    expect(screen.queryByText('会话过期了，重新登录')).not.toBeInTheDocument()
  })
})
