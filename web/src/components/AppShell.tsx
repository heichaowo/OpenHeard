import {
  BulbOutlined,
  DatabaseOutlined,
  EditOutlined,
  MonitorOutlined,
  PoweroffOutlined,
  SettingOutlined,
  SoundOutlined,
} from '@ant-design/icons'
import { Badge, Button, Dropdown, Grid, Layout } from 'antd'
import type { MenuProps } from 'antd'
import type { ReactNode } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { ZonePicker } from './ZonePicker'
import { PlayerProvider } from '../PlayerProvider'
import { useSession } from '../session'
import { usePreferences } from '../theme'
import { useStore } from '../store'

function Brand() {
  // 本台呼号跟设置走。写死的话，换了呼号头里还是旧的。
  const { station } = useStore()
  return (
    <div className="brand">
      <div className="brand-mark">OH</div>
      <div>
        <div className="brand-name">OpenHeard</div>
        {station.myCallsign && <div className="brand-call">{station.myCallsign}</div>}
      </div>
    </div>
  )
}

function ThemeMenu() {
  const { mode, setMode } = usePreferences()
  const tick = (m: string) => (mode === m ? '✓' : null)
  const items: MenuProps['items'] = [
    { key: 'system', label: '跟随系统', icon: tick('system') },
    { key: 'light', label: '亮色', icon: tick('light') },
    { key: 'dark', label: '暗色', icon: tick('dark') },
  ]
  return (
    <Dropdown
      trigger={['click']}
      menu={{ items, onClick: ({ key }) => setMode(key as 'system' | 'light' | 'dark') }}
    >
      <Button type="text" icon={<BulbOutlined />} aria-label="外观" />
    </Dropdown>
  )
}

interface NavItem {
  key: string
  icon: ReactNode
  label: string
  badge: number
}

/**
 * 导航项。待确认队列和收听记录合并成收听一页，五档共用一张图。
 */
function useNavItems(): NavItem[] {
  const { pending } = useStore()
  return [
    { key: '/heard', icon: <SoundOutlined />, label: '收听', badge: pending.length },
    { key: '/log', icon: <DatabaseOutlined />, label: '日志', badge: 0 },
    { key: '/new', icon: <EditOutlined />, label: '补录', badge: 0 },
    { key: '/ops', icon: <MonitorOutlined />, label: '运维', badge: 0 },
    { key: '/settings', icon: <SettingOutlined />, label: '设置', badge: 0 },
  ]
}

/** 桌面上顶栏里的胶囊页签。 */
function NavPills({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation()
  return (
    <nav className="nav-pills" aria-label="页面导航">
      {items.map((item) => {
        const active = pathname === item.key
        return (
          <Link
            key={item.key}
            to={item.key}
            className={active ? 'nav-pill active' : 'nav-pill'}
            aria-current={active ? 'page' : undefined}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.badge > 0 && <Badge count={item.badge} size="small" />}
          </Link>
        )
      })}
    </nav>
  )
}

/** 手机上贴底的标签栏。安全区内边距给 Home Indicator 留位置。 */
function BottomTabs({ items }: { items: NavItem[] }) {
  const { pathname } = useLocation()
  return (
    <nav className="bottom-tabs" aria-label="页面导航">
      {items.map((item) => {
        const active = pathname === item.key
        return (
          <Link
            key={item.key}
            to={item.key}
            className={active ? 'bottom-tab active' : 'bottom-tab'}
            aria-current={active ? 'page' : undefined}
          >
            <Badge count={item.badge} size="small" offset={[2, 0]}>
              {item.icon}
            </Badge>
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function AppShell() {
  const { signOut } = useSession()
  const items = useNavItems()
  // 768px 以上桌面，以下手机。和别的页面判断宽窄用的同一个断点。
  const wide = Grid.useBreakpoint().md ?? true

  return (
    <PlayerProvider>
      <Layout className="app-shell">
        <Layout.Header className="shell-header">
          <Brand />
          {wide && <NavPills items={items} />}
          <div className="header-actions">
            <ZonePicker />
            <ThemeMenu />
            <Button
              type="text"
              icon={<PoweroffOutlined />}
              aria-label="退出"
              onClick={() => void signOut()}
            />
          </div>
        </Layout.Header>
        <Layout.Content className="shell-content">
          <Outlet />
        </Layout.Content>
        {!wide && <BottomTabs items={items} />}
      </Layout>
    </PlayerProvider>
  )
}
