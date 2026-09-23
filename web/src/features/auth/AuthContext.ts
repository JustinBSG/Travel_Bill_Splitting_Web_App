import type { Session, User } from '@supabase/supabase-js'
import { createContext, useContext } from 'react'
import type { Profile } from '../../lib/types'

export interface AuthState {
  loading: boolean
  session: Session | null
  user: User | null
  profile: Profile | null
  profileError: string | null
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}

/** For screens that only render behind RequireAuth. */
export function useUser(): User {
  const { user } = useAuth()
  if (!user) throw new Error('useUser without a session')
  return user
}
