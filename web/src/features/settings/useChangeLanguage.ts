import { useCallback } from 'react'
import { setLanguage } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import type { Language } from '../../lib/types'
import { useUser } from '../auth/AuthContext'

/** Switch the UI language now and save it to the profile. Returns an error message, if any. */
export function useChangeLanguage() {
  const user = useUser()
  return useCallback(
    async (lang: Language): Promise<string | null> => {
      setLanguage(lang)
      const { error } = await supabase.from('profiles').update({ language: lang }).eq('id', user.id)
      return error?.message ?? null
    },
    [user.id],
  )
}
