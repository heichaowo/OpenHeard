import { App as AntApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
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
          Layout: {
            bodyBg: 'var(--app-bg)',
            headerBg: 'var(--app-elevated)',
            siderBg: 'var(--app-elevated)',
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
