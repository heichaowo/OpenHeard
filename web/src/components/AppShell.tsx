import {
  BulbOutlined,
  DatabaseOutlined,
  EditOutlined,
  InboxOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MonitorOutlined,
} from '@ant-design/icons'
import { Badge, Button, Drawer, Dropdown, Layout, Menu } from 'antd'
import type { MenuProps } from 'antd'
import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { usePreferences } from '../theme'
import { useStore } from '../store'

const COLLAPSED_KEY = 'openheard.sidebar-collapsed'

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className="brand">
      <div className="brand-mark">OH</div>
      {!collapsed && (
        <div>
          <div className="brand-name">OpenHeard</div>
          <div className="brand-call">BG0CG</div>
        </div>
      )}
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

export function AppShell() {
  const { pending } = useStore()
  const location = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === 'true',
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const width = collapsed ? 72 : 232

  const items: MenuProps['items'] = [
    {
      key: '/pending',
      icon: <InboxOutlined />,
      label: (
        <>
          待确认队列{' '}
          {pending.length > 0 && <Badge count={pending.length} size="small" offset={[4, -2]} />}
        </>
      ),
    },
    { key: '/log', icon: <DatabaseOutlined />, label: '日志' },
    { key: '/new', icon: <EditOutlined />, label: '快速补录' },
    { key: '/ops', icon: <MonitorOutlined />, label: '运维' },
  ]

  const go: MenuProps['onClick'] = ({ key }) => {
    navigate(key)
    setDrawerOpen(false)
  }

  const menu = (
    <Menu
      className="sidebar-menu"
      mode="inline"
      selectedKeys={[location.pathname]}
      items={items}
      onClick={go}
    />
  )

  const toggle = () => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSED_KEY, String(!v))
      return !v
    })
  }

  return (
    <Layout className="app-shell">
      <Layout.Sider className="app-sider" width={width} collapsedWidth={72} collapsed={collapsed}>
        <Brand collapsed={collapsed} />
        {menu}
        <div className="sidebar-foot">
          <Button
            type="text"
            block
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={toggle}
          >
            {collapsed ? '' : '收起'}
          </Button>
        </div>
      </Layout.Sider>

      <Layout className="shell-main" style={{ marginInlineStart: width }}>
        <Layout.Header className="shell-header">
          <Button
            className="only-narrow"
            type="text"
            icon={<MenuOutlined />}
            onClick={() => setDrawerOpen(true)}
            aria-label="菜单"
          />
          <div className="header-actions">
            <ThemeMenu />
          </div>
        </Layout.Header>
        <Layout.Content className="shell-content">
          <Outlet />
        </Layout.Content>
      </Layout>

      <Drawer
        placement="left"
        size={232}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        styles={{ body: { padding: 0 } }}
        title={<Brand />}
      >
        {menu}
      </Drawer>
    </Layout>
  )
}
