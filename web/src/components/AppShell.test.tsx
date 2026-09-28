import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Preferences } from '../Preferences'
import { SessionContext } from '../session'
import { setViewportWidth } from '../testSetup'
import { StoreContext } from '../store'
import type { Store } from '../store'
import { AppShell } from './AppShell'

const signOut = vi.fn()

const store = (pendingCount: number): Store =>
  ({
    station: { myCallsign: 'BG0CG' },
    pending: Array.from({ length: pendingCount }, (_, i) => ({ id: String(i) })),
  }) as unknown as Store

const mount = (pendingCount = 0, path = '/heard') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Preferences>
        <SessionContext value={{ signedIn: true, signOut }}>
          <StoreContext value={store(pendingCount)}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="heard" element={<div>收听页的内容</div>} />
                <Route path="log" element={<div>日志的内容</div>} />
              </Route>
            </Routes>
          </StoreContext>
        </SessionContext>
      </Preferences>
    </MemoryRouter>,
  )

afterEach(() => setViewportWidth(1280))

describe('AppShell', () => {
  it('顶栏有品牌名和本台呼号，内容走 Outlet', () => {
    mount(3)
    expect(screen.getByText('OpenHeard')).toBeInTheDocument()
    expect(screen.getByText('BG0CG')).toBeInTheDocument()
    expect(screen.getByText('收听页的内容')).toBeInTheDocument()
  })

  it('桌面上：顶栏里的胶囊导航，没有底部标签栏，也没有汉堡菜单', () => {
    mount(3)
    const nav = screen.getByRole('navigation', { name: '页面导航' })
    expect(within(nav).getByText('收听')).toBeInTheDocument()
    expect(document.querySelector('.bottom-tabs')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '菜单' })).not.toBeInTheDocument()
    expect(document.querySelector('.app-sider')).not.toBeInTheDocument()
  })

  it('五个导航项，收听的徽标显示 pending 的条数', () => {
    mount(3)
    const nav = screen.getByRole('navigation', { name: '页面导航' })
    expect(within(nav).getAllByRole('link')).toHaveLength(5)
    expect(within(nav).getByText('3')).toBeInTheDocument()
  })

  it('一条都没有时不显示徽标', () => {
    mount(0)
    const nav = screen.getByRole('navigation', { name: '页面导航' })
    expect(within(nav).queryByText('0')).not.toBeInTheDocument()
  })

  it('当前路由的页签标了 aria-current', () => {
    mount(0, '/log')
    const nav = screen.getByRole('navigation', { name: '页面导航' })
    expect(within(nav).getByText('日志').closest('a')).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByText('收听').closest('a')).not.toHaveAttribute('aria-current')
  })

  it('手机上：底部标签栏代替顶栏导航', () => {
    setViewportWidth(375)
    mount(3)
    expect(screen.queryByRole('navigation', { name: '页面导航' })).toBeInTheDocument()
    // 胶囊导航在窄屏下不渲染，剩下贴底的那一个。
    expect(document.querySelector('.nav-pills')).not.toBeInTheDocument()
    expect(document.querySelector('.bottom-tabs')).toBeInTheDocument()
  })

  it('退出按钮调用 signOut', async () => {
    mount(0)
    await userEvent.click(screen.getByRole('button', { name: '退出' }))
    expect(signOut).toHaveBeenCalledOnce()
  })

  it('时区和外观菜单都在', () => {
    mount(0)
    expect(screen.getByRole('button', { name: '外观' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /显示时区/ })).toBeInTheDocument()
  })
})
