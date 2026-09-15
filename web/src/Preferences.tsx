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

  // dataset.theme 给我们自己的选择器用，colorScheme 让浏览器的滚动条和
  // 原生控件跟着走。只设前者的话暗色下滚动条还是亮的。
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
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
