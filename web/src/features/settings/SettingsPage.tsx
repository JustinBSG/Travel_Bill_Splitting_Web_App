import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInstallPrompt } from '../../app/install'
import { useToast } from '../../app/ui/toast'
import { ErrorBox, PageHeader } from '../../app/ui/common'
import { supabase } from '../../lib/supabase'
import type { NotificationSetting } from '../../lib/types'
import { useAuth, useUser } from '../auth/AuthContext'
import { NOTIFICATION_TYPES, type NotificationType } from '../notifications/notificationTypes'
import { currentPushSubscription, disablePush, enablePush, pushSupport } from '../notifications/push'
import { LanguageSwitch } from './LanguageSwitch'
import { ThemeSwitch } from './ThemeSwitch'

async function fetchPrefs(userId: string): Promise<Record<string, boolean>> {
  const { data } = await supabase.from('notification_settings').select('user_id, type, enabled').eq('user_id', userId)
  const map: Record<string, boolean> = {}
  for (const r of (data ?? []) as NotificationSetting[]) map[r.type] = r.enabled
  return map
}

export function SettingsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const user = useUser()
  const { profile, refreshProfile, signOut } = useAuth()
  const { canInstall, promptInstall } = useInstallPrompt()

  const [name, setName] = useState(profile?.display_name ?? '')
  const [savingName, setSavingName] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Record<string, boolean>>({})
  const [pushOn, setPushOn] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const support = pushSupport()

  useEffect(() => {
    let alive = true
    fetchPrefs(user.id).then((map) => alive && setPrefs(map))
    void currentPushSubscription().then((s) => alive && setPushOn(!!s))
    return () => {
      alive = false
    }
  }, [user.id])

  async function saveName() {
    const displayName = name.trim()
    if (!displayName) {
      setError(t('profile.nameRequired'))
      return
    }
    setSavingName(true)
    setError(null)
    const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id)
    setSavingName(false)
    if (error) setError(error.message)
    else {
      await refreshProfile()
      toast.show(t('settings.saved'), { tone: 'success' })
    }
  }

  async function togglePref(type: NotificationType, enabled: boolean) {
    setPrefs((p) => ({ ...p, [type]: enabled }))
    const { error } = await supabase
      .from('notification_settings')
      .upsert({ user_id: user.id, type, enabled }, { onConflict: 'user_id,type' })
    if (error) {
      setPrefs((p) => ({ ...p, [type]: !enabled }))
      setError(error.message)
    }
  }

  async function togglePush() {
    setPushBusy(true)
    setError(null)
    try {
      if (pushOn) {
        await disablePush()
        setPushOn(false)
      } else {
        const res = await enablePush(user.id)
        setPushOn(res === 'granted')
        if (res === 'denied') toast.show(t('settings.pushDenied'), { tone: 'error' })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPushBusy(false)
    }
  }

  return (
    <div className="screen">
      <PageHeader title={t('settings.title')} backTo="/trips" />
      <main className="content stack">
        {error && <ErrorBox message={error} />}

        <section className="card stack">
          <h2 className="section-title">{t('settings.profile')}</h2>
          <label className="field">
            <span>{t('profile.displayName')}</span>
            <div className="row-gap">
              <input className="grow" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <button
                type="button"
                className="btn btn-primary"
                disabled={savingName || name.trim() === (profile?.display_name ?? '')}
                onClick={() => void saveName()}
              >
                {t('app.save')}
              </button>
            </div>
          </label>
          <div className="field">
            <span>{t('settings.language')}</span>
            <LanguageSwitch />
          </div>
          <div className="field">
            <span>{t('settings.theme')}</span>
            <ThemeSwitch />
          </div>
          <p className="muted small">{user.email}</p>
        </section>

        <section className="card stack">
          <h2 className="section-title">{t('settings.notifications')}</h2>
          <p className="muted small">{t('settings.notificationsHint')}</p>
          {NOTIFICATION_TYPES.map((type) => (
            <label key={type} className="check-row">
              <input type="checkbox" checked={prefs[type] ?? true} onChange={(e) => void togglePref(type, e.target.checked)} />
              <span>{t(`settings.notif.${type}`)}</span>
            </label>
          ))}

          <h3 className="section-title">{t('settings.push')}</h3>
          {support === 'supported' && (
            <button type="button" className="btn" disabled={pushBusy} onClick={() => void togglePush()}>
              {pushOn ? t('settings.pushDisable') : t('settings.pushEnable')}
            </button>
          )}
          {support === 'needs-install' && <p className="muted small">{t('settings.pushNeedsInstall')}</p>}
          {support === 'unsupported' && <p className="muted small">{t('settings.pushUnsupported')}</p>}
          {support === 'not-configured' && <p className="muted small">{t('settings.pushNotConfigured')}</p>}
        </section>

        {canInstall && (
          <button type="button" className="btn btn-block" onClick={() => void promptInstall()}>
            {t('install.button')}
          </button>
        )}

        <button type="button" className="btn btn-block btn-danger" onClick={() => void signOut()}>
          {t('settings.signOut')}
        </button>
        <p className="muted small center">
          {t('app.name')} v{__APP_VERSION__}
        </p>
      </main>
    </div>
  )
}
