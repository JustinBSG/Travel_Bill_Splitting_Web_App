import { useTranslation } from 'react-i18next'
import { useToast } from '../../app/ui/toast'
import type { Language } from '../../lib/types'
import { useChangeLanguage } from './useChangeLanguage'

const OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh-Hant', label: '繁體中文' },
]

/** EN / 繁中 toggle usable anywhere behind login (trip menu, settings). */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const changeLanguage = useChangeLanguage()
  const current: Language = i18n.language === 'zh-Hant' ? 'zh-Hant' : 'en'

  return (
    <div className="segmented" role="group" aria-label={t('settings.language')}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.value}
          className={current === o.value ? 'active' : ''}
          aria-pressed={current === o.value}
          onClick={async () => {
            if (o.value === current) return
            const err = await changeLanguage(o.value)
            if (err) toast.show(t('app.errorWith', { message: err }), { tone: 'error' })
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
