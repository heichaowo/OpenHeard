import { createContext, use } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Preferences {
  mode: ThemeMode
  /** 算上系统偏好之后实际是不是暗色。 */
  dark: boolean
  setMode: (mode: ThemeMode) => void
}

export const PreferencesContext = createContext<Preferences | null>(null)

export function usePreferences() {
  const p = use(PreferencesContext)
  if (!p) throw new Error('usePreferences 必须在 Preferences 里用')
  return p
}

export const STORAGE_KEY = 'openheard.theme'
