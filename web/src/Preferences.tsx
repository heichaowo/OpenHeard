import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PreferencesContext, STORAGE_KEY, ZONE_KEY } from './theme'
import type { ThemeMode } from './theme'
import { UTC, allZones } from './time'
import type { Zone } from './time'

const read = (): ThemeMode => {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

// 缺省 UTC，因为日志本来就是 UTC，业余无线电也按 UTC 记。
// 存下来的名字要对一遍：换台机器或者换个浏览器版本，IANA 的名字会被并掉。
const readZone = (): Zone => {
  const v = localStorage.getItem(ZONE_KEY)
  return v && allZones().includes(v) ? v : UTC
}

export function Preferences({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(read)
  const [zone, setZoneState] = useState<Zone>(readZone)
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
      zone,
      setZone: (z: Zone) => {
        setZoneState(z)
        localStorage.setItem(ZONE_KEY, z)
      },
    }),
    [mode, dark, zone],
  )

  return <PreferencesContext value={value}>{children}</PreferencesContext>
}
