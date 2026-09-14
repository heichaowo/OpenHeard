import { App as AntApp, ConfigProvider, Layout, Typography } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import PendingQueue from './pages/PendingQueue'

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <AntApp>
        <Layout style={{ minHeight: '100vh' }}>
          <Layout.Header style={{ display: 'flex', alignItems: 'center' }}>
            <Typography.Title level={4} style={{ color: '#fff', margin: 0 }}>
              OpenHeard · 待确认队列
            </Typography.Title>
          </Layout.Header>
          <Layout.Content style={{ padding: 24 }}>
            <PendingQueue />
          </Layout.Content>
        </Layout>
      </AntApp>
    </ConfigProvider>
  )
}
