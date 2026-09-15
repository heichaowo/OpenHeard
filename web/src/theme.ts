import { createContext, use } from 'react'
import type { Zone } from './time'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Preferences {
  mode: ThemeMode
  /** 算上系统偏好之后实际是不是暗色。 */
  dark: boolean
  setMode: (mode: ThemeMode) => void
  /** 界面按哪个时区显示。记录本身一律 UTC，这只管显示。 */
  zone: Zone
  setZone: (zone: Zone) => void
}

export const PreferencesContext = createContext<Preferences | null>(null)

export function usePreferences() {
  const p = use(PreferencesContext)
  if (!p) throw new Error('usePreferences 必须在 Preferences 里用')
  return p
}

export const STORAGE_KEY = 'openheard.theme'
export const ZONE_KEY = 'openheard.zone'
