import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PreferencesContext, STORAGE_KEY } from './theme'
import type { ThemeMode } from './theme'

const read = (): ThemeMode => {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function Preferences({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(read)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const dark = mode === 'system' ? systemDark : mode === 'dark'

  // CSS 变量按这个属性切换，和 antd 的算法各管一半。
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  const value = useMemo(
    () => ({
      mode,
      dark,
      setMode: (m: ThemeMode) => {
        setModeState(m)
        localStorage.setItem(STORAGE_KEY, m)
      },
    }),
    [mode, dark],
  )

  return <PreferencesContext value={value}>{children}</PreferencesContext>
}
