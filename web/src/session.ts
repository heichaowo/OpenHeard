import { createContext, use } from 'react'

export interface Session {
  signedIn: boolean
  signOut: () => Promise<void>
}

export const SessionContext = createContext<Session | null>(null)

export function useSession() {
  const s = use(SessionContext)
  if (!s) throw new Error('useSession 必须在 SessionGate 里用')
  return s
}
