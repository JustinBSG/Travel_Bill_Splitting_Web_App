import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorBox, Seal } from '../../app/ui/common'
import { detectDeviceLanguage, setLanguage } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import type { Language } from '../../lib/types'
import { useAuth, useUser } from './AuthContext'

/** First login: display name is required; language defaults to the device. */
export function ProfileSetupPage() {
  const { t, i18n } = useTranslation()
  const { refreshProfile, profile, profileError, signOut } = useAuth()
  const user = useUser()
  const [name, setName] = useState(profile?.display_name ?? '')
  const [lang, setLang] = useState<Language>(
    profile?.language ?? (i18n.language === 'zh-Hant' ? 'zh-Hant' : detectDeviceLanguage()),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const displayName = name.trim()
    if (!displayName) {
      setError(t('profile.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    const { error } = await supabase
      .from('profiles')
      .upsert({ id: user.id, display_name: displayName, language: lang }, { onConflict: 'id' })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setLanguage(lang)
    await refreshProfile()
  }

  return (
    <div className="login">
      <form className="login-card stack" onSubmit={submit} noValidate>
        <Seal size={56} />
        <h1 className="page-title">{t('profile.welcome')}</h1>
        <p className="muted">{t('profile.intro')}</p>
        {profileError && <ErrorBox message={profileError} onRetry={refreshProfile} />}
        {error && <ErrorBox message={error} />}
        <label className="field">
          <span>{t('profile.displayName')}</span>
          <input
            autoFocus
            required
            maxLength={40}
            autoComplete="nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('settings.language')}</span>
          <select
            value={lang}
            onChange={(e) => {
              const v = e.target.value as Language
              setLang(v)
              setLanguage(v)
            }}
          >
            <option value="en">English</option>
            <option value="zh-Hant">繁體中文</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t('app.saving') : t('profile.continue')}
        </button>
        <button type="button" className="btn-link" onClick={() => void signOut()}>
          {t('settings.signOut')}
        </button>
      </form>
    </div>
  )
}
