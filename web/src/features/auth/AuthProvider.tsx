import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { setLanguage } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import type { Profile } from '../../lib/types'
import { AuthContext, type AuthState } from './AuthContext'

interface ProfileResult {
  uid: string
  profile: Profile | null
  error: string | null
}

async function fetchProfile(uid: string): Promise<ProfileResult> {
  const { data, error } = await supabase.from('profiles').select('id, display_name, language').eq('id', uid).maybeSingle()
  return { uid, profile: error ? null : ((data as Profile | null) ?? null), error: error?.message ?? null }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [profileResult, setProfileResult] = useState<ProfileResult | null>(null)

  useEffect(() => {
    let alive = true
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      setSession(data.session)
      setSessionLoading(false)
    })
    // Only set state here: calling supabase inside this callback can deadlock.
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setSessionLoading(false)
    })
    return () => {
      alive = false
      data.subscription.unsubscribe()
    }
  }, [])

  const userId = session?.user.id ?? null

  const applyProfile = useCallback((res: ProfileResult) => {
    setProfileResult(res)
    const lang = res.profile?.language
    if (lang === 'en' || lang === 'zh-Hant') setLanguage(lang)
  }, [])

  useEffect(() => {
    if (!userId) return
    let alive = true
    fetchProfile(userId).then((res) => alive && applyProfile(res))
    return () => {
      alive = false
    }
  }, [userId, applyProfile])

  const refreshProfile = useCallback(async () => {
    if (userId) applyProfile(await fetchProfile(userId))
  }, [userId, applyProfile])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setProfileResult(null)
  }, [])

  const current = profileResult && profileResult.uid === userId ? profileResult : null

  const value = useMemo<AuthState>(
    () => ({
      loading: sessionLoading || (!!userId && !current),
      session,
      user: session?.user ?? null,
      profile: current?.profile ?? null,
      profileError: current?.error ?? null,
      refreshProfile,
      signOut,
    }),
    [sessionLoading, userId, current, session, refreshProfile, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
