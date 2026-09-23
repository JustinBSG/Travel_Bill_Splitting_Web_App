import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isIOS, isStandalone, useInstallPrompt } from './install'
import { Icon, IosShareIcon } from './ui/Icon'

const DISMISS_KEY = 'tbs-ios-install-dismissed'

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Android/desktop Chrome: "Install app" button (beforeinstallprompt).
 * iOS Safari: first-visit banner "Tap Share, then Add to Home Screen".
 * Hidden when already running standalone.
 */
export function InstallPrompt() {
  const { t } = useTranslation()
  const { canInstall, promptInstall } = useInstallPrompt()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (isStandalone()) return null

  if (canInstall) {
    return (
      <div className="install-bar">
        <span>{t('install.androidBody')}</span>
        <button type="button" className="btn btn-primary btn-small" onClick={() => void promptInstall()}>
          {t('install.button')}
        </button>
      </div>
    )
  }

  if (isIOS() && !dismissed) {
    return (
      <div className="install-bar" role="note">
        <span>
          {t('install.iosBefore')}{' '}
          <span className="ios-share" aria-label={t('install.shareIcon')}>
            <IosShareIcon />
          </span>{' '}
          {t('install.iosAfter')}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('app.close')}
          onClick={() => {
            setDismissed(true)
            try {
              localStorage.setItem(DISMISS_KEY, '1')
            } catch {
              /* ignore */
            }
          }}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    )
  }
  return null
}
