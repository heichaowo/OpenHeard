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

/** 无衬线字体栈。不加载网络字体，这台机器在国内，等不起也不该等。 */
const FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ' +
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

/**
 * 向 OpenLogTool Live 看齐的两套色板，浅色和深色各一套显式的值。
 *
 * 不只是把 darkAlgorithm 套上去：那样算出来的色阶和参考站点对不上。
 * 数值取自 brief-live-look.md 里記的 index.css 变量。
 */
const LIGHT_TOKEN = {
  colorPrimary: '#2168d5',
  colorBgLayout: '#f4f7fb',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBorder: '#dfe6ef',
  colorBorderSecondary: '#ccd7e5',
  colorText: '#172033',
  colorTextSecondary: '#5f6b7e',
  colorTextTertiary: '#8490a3',
  colorSuccess: '#16845b',
  colorSuccessBg: '#e3f6ed',
  colorWarning: '#a65c08',
  colorWarningBg: '#fff2dd',
  colorError: '#c33a47',
  colorErrorBg: '#fdecef',
  borderRadius: 10,
  borderRadiusLG: 14,
  fontFamily: FONT_FAMILY,
  fontSize: 13,
  fontSizeSM: 12,
  boxShadow: '0 12px 34px rgba(21,40,72,.09)',
  boxShadowSecondary: '0 1px 2px rgba(21,40,72,.06)',
  boxShadowTertiary: '0 1px 2px rgba(21,40,72,.06)',
}

const DARK_TOKEN = {
  colorPrimary: '#6ba5ff',
  colorBgLayout: '#0d1421',
  colorBgContainer: '#141e2d',
  colorBgElevated: '#182437',
  colorBorder: '#29384d',
  colorBorderSecondary: '#354860',
  colorText: '#edf3fb',
  colorTextSecondary: '#aab7ca',
  colorTextTertiary: '#7e8ca2',
  colorSuccess: '#51d2a1',
  colorSuccessBg: '#163b31',
  colorWarning: '#f2b55c',
  colorWarningBg: '#402f18',
  colorError: '#ff8a94',
  colorErrorBg: '#44242c',
  borderRadius: 10,
  borderRadiusLG: 14,
  fontFamily: FONT_FAMILY,
  fontSize: 13,
  fontSizeSM: 12,
  boxShadow: '0 16px 42px rgba(0,0,0,.24)',
  boxShadowSecondary: '0 1px 2px rgba(0,0,0,.25)',
  boxShadowTertiary: '0 1px 2px rgba(0,0,0,.25)',
}

function Themed() {
  const { dark } = usePreferences()
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: dark ? DARK_TOKEN : LIGHT_TOKEN,
        components: {
          // 用 antd 自己导出的颜色变量。以前引用的 --app-bg 和 --app-elevated
          // 从没定义过，暗色下侧边栏拼成了几块颜色。
          Layout: {
            bodyBg: 'var(--ant-color-bg-layout)',
            headerBg: 'var(--ant-color-bg-container)',
          },
          Table: {
            headerBg: 'var(--surface-soft)',
            headerColor: 'var(--ant-color-text)',
            rowHoverBg: 'var(--surface-hover)',
            borderColor: 'var(--ant-color-border-secondary)',
          },
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
