import { App as AntApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import HeardList from './pages/HeardList'
import LogList from './pages/LogList'
import OpsPage from './pages/OpsPage'
import SettingsPage from './pages/SettingsPage'
import PendingQueue from './pages/PendingQueue'
import QuickEntry from './pages/QuickEntry'
import { Preferences } from './Preferences'
import { SessionGate } from './SessionGate'
import { StoreProvider } from './StoreProvider'
import { usePreferences } from './theme'

function Themed() {
  const { dark } = usePreferences()
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 8, fontSize: 14 },
        components: {
          // 用 antd 自己导出的颜色变量。以前引用的 --app-bg 和 --app-elevated
          // 从没定义过，暗色下侧边栏拼成了几块颜色。
          Layout: {
            bodyBg: 'var(--ant-color-bg-layout)',
            headerBg: 'var(--ant-color-bg-container)',
            siderBg: 'var(--ant-color-bg-container)',
          },
          Menu: { itemBorderRadius: 7 },
        },
      }}
    >
      <AntApp>
        <SessionGate>
          <StoreProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/pending" replace />} />
              <Route path="pending" element={<PendingQueue />} />
              <Route path="log" element={<LogList />} />
              <Route path="heard" element={<HeardList />} />
              <Route path="new" element={<QuickEntry />} />
              <Route path="ops" element={<OpsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/pending" replace />} />
          </Routes>
          </StoreProvider>
        </SessionGate>
      </AntApp>
    </ConfigProvider>
  )
}

export default function App() {
  return (
    <Preferences>
      <Themed />
    </Preferences>
  )
}
