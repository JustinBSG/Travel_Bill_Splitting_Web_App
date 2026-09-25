import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../app/ui/toast'
import { Modal } from '../../app/ui/Modal'
import { useAuth } from '../auth/AuthContext'
import { enablePush, pushSupport } from './push'

const askedKey = (userId: string) => `tbs-push-asked:${userId}`

function wasAsked(userId: string): boolean {
  try {
    return localStorage.getItem(askedKey(userId)) === '1'
  } catch {
    return true // no storage: don't nag on every visit
  }
}

function markAsked(userId: string) {
  try {
    localStorage.setItem(askedKey(userId), '1')
  } catch {
    /* ignore */
  }
}

/**
 * After a user's first sign-in on this device, offer push once. Only when push
 * can actually work here (on iPhone that means installed to the Home Screen, so
 * the offer waits until then) and the browser hasn't been asked yet. The
 * permission request itself runs from the Enable tap, as iOS requires.
 */
export function PushPrompt() {
  const { t } = useTranslation()
  const toast = useToast()
  const { user } = useAuth()
  // Decided once on mount: RequireAuth only renders this with a signed-in user.
  const [open, setOpen] = useState(
    () => !!user && !wasAsked(user.id) && pushSupport() === 'supported' && Notification.permission === 'default',
  )
  const [busy, setBusy] = useState(false)

  if (!open || !user) return null

  function close() {
    if (user) markAsked(user.id)
    setOpen(false)
  }

  async function enable() {
    if (!user) return
    setBusy(true)
    try {
      const res = await enablePush(user.id)
      if (res === 'denied') toast.show(t('settings.pushDenied'), { tone: 'error' })
    } catch (e) {
      toast.show(t('app.errorWith', { message: e instanceof Error ? e.message : String(e) }), { tone: 'error' })
    } finally {
      setBusy(false)
      close()
    }
  }

  return (
    <Modal
      title={t('notifications.promptTitle')}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {t('notifications.promptLater')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void enable()}>
            {t('notifications.promptEnable')}
          </button>
        </>
      }
    >
      <p>{t('notifications.promptBody')}</p>
    </Modal>
  )
}
