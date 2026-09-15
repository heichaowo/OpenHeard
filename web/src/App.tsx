import { App as AntApp, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import LogList from './pages/LogList'
import PendingQueue from './pages/PendingQueue'
import PublicPage from './pages/PublicPage'
import QuickEntry from './pages/QuickEntry'
import { Preferences } from './Preferences'
import { StoreProvider } from './StoreProvider'
import { usePreferences } from './theme'

// 主题取值取自 OpenLogTool Server，Copyright © 2026 Mazha0309 与贡献者，AGPL-3.0-only。
// 来源 https://github.com/Mazha0309/OpenLogToolServer （web/src/App.tsx 的 ThemedApp）
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
        <StoreProvider>
          <Routes>
            <Route element={<AppShell />}>
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

export default function App() {
  return (
    <Preferences>
      <Themed />
    </Preferences>
  )
}
