import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useSearchParams } from 'react-router'
import { InstallPrompt } from '../../app/InstallPrompt'
import { isIOS, isStandalone } from '../../app/install'
import { FullPageSpinner } from '../../app/ui/common'
import { setLanguage } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { useAuth } from './AuthContext'

/** Only allow same-app relative redirects. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/trips'
  return raw
}

type Step = 'choose' | 'email' | 'code'

export function LoginPage() {
  const { t, i18n } = useTranslation()
  const { session, loading } = useAuth()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))

  const [step, setStep] = useState<Step>('choose')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(id)
  }, [cooldown])

  if (loading) return <FullPageSpinner />
  if (session) return <Navigate to={next} replace />

  async function sendCode(e?: FormEvent) {
    e?.preventDefault()
    const addr = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      setError(t('auth.invalidEmail'))
      return
    }
    setBusy(true)
    setError(null)
    // Code typed in-app, never a magic link (iOS would open Safari, not the PWA).
    const { error } = await supabase.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: true } })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setStep('code')
    setCooldown(60)
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    const token = code.replace(/\D/g, '')
    if (token.length !== 6) {
      setError(t('auth.codeLength'))
      return
    }
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'email' })
    setBusy(false)
    if (error) setError(t('auth.codeInvalid'))
    // On success onAuthStateChange sets the session and we redirect.
  }

  async function oauth(provider: 'google' | 'apple') {
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}${next}` },
    })
    if (error) {
      setBusy(false)
      setError(error.message)
    }
  }

  const iosPwa = isIOS() && isStandalone()

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand">
          <img src="/pwa-192x192.png" alt="" width={72} height={72} />
          <h1>{t('app.name')}</h1>
          <p className="muted">{t('auth.tagline')}</p>
        </div>

        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}

        {step === 'choose' && (
          <div className="stack">
            <button type="button" className="btn btn-primary btn-block" onClick={() => setStep('email')}>
              {t('auth.emailCode')}
            </button>
            <button type="button" className="btn btn-block" disabled={busy} onClick={() => oauth('google')}>
              {t('auth.google')}
            </button>
            <button type="button" className="btn btn-block" disabled={busy} onClick={() => oauth('apple')}>
              {t('auth.apple')}
            </button>
            {iosPwa && <p className="muted small">{t('auth.iosOauthHint')}</p>}
          </div>
        )}

        {step === 'email' && (
          <form className="stack" onSubmit={sendCode} noValidate>
            <label className="field">
              <span>{t('auth.email')}</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
              {busy ? t('auth.sending') : t('auth.sendCode')}
            </button>
            <button type="button" className="btn-link" onClick={() => setStep('choose')}>
              {t('app.back')}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form className="stack" onSubmit={verify} noValidate>
            <p>{t('auth.codeSent', { email: email.trim() })}</p>
            <label className="field">
              <span>{t('auth.code')}</span>
              <input
                className="otp-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                autoFocus
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
              {busy ? t('auth.verifying') : t('auth.verify')}
            </button>
            <button type="button" className="btn-link" disabled={cooldown > 0 || busy} onClick={() => sendCode()}>
              {cooldown > 0 ? t('auth.resendIn', { s: cooldown }) : t('auth.resend')}
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setStep('email')
                setCode('')
              }}
            >
              {t('auth.changeEmail')}
            </button>
          </form>
        )}

        <div className="lang-switch" role="group" aria-label={t('settings.language')}>
          <button
            type="button"
            className={i18n.language === 'en' ? 'chip chip-active' : 'chip'}
            onClick={() => setLanguage('en')}
          >
            English
          </button>
          <button
            type="button"
            className={i18n.language === 'zh-Hant' ? 'chip chip-active' : 'chip'}
            onClick={() => setLanguage('zh-Hant')}
          >
            繁體中文
          </button>
        </div>
      </div>
      <InstallPrompt />
    </div>
  )
}
