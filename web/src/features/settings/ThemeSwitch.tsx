import { useTranslation } from 'react-i18next'
import { setThemePref, useThemePref, type ThemePref } from '../../app/theme'

/** System / Light / Dark toggle (trip menu, settings). Saved per device. */
export function ThemeSwitch() {
  const { t } = useTranslation()
  const current = useThemePref()
  const options: { value: ThemePref; label: string }[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ]
  return (
    <div className="segmented segmented-3" role="group" aria-label={t('settings.theme')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={current === o.value ? 'active' : ''}
          aria-pressed={current === o.value}
          onClick={() => setThemePref(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
