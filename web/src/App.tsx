import { App as AntApp, ConfigProvider, Layout, Menu, Typography } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import LogList from './pages/LogList'
import PendingQueue from './pages/PendingQueue'
import PublicPage from './pages/PublicPage'
import QuickEntry from './pages/QuickEntry'
import { StoreProvider } from './StoreProvider'

const NAV = [
  { key: '/pending', label: <Link to="/pending">待确认队列</Link> },
  { key: '/log', label: <Link to="/log">日志</Link> },
  { key: '/new', label: <Link to="/new">快速补录</Link> },
  { key: '/p', label: <Link to="/p">公开页</Link> },
]

function AdminLayout() {
  const { pathname } = useLocation()
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Typography.Title level={5} style={{ color: '#fff', margin: 0, whiteSpace: 'nowrap' }}>
          OpenHeard
        </Typography.Title>
        <Menu theme="dark" mode="horizontal" selectedKeys={[pathname]} items={NAV} style={{ flex: 1, minWidth: 0 }} />
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  )
}

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <StoreProvider>
          <Routes>
            <Route element={<AdminLayout />}>
              <Route index element={<Navigate to="/pending" replace />} />
              <Route path="pending" element={<PendingQueue />} />
              <Route path="log" element={<LogList />} />
              <Route path="new" element={<QuickEntry />} />
            </Route>
            <Route path="/p" element={<PublicPage />} />
            <Route path="*" element={<Navigate to="/pending" replace />} />
          </Routes>
        </StoreProvider>
      </AntApp>
    </ConfigProvider>
  )
}
