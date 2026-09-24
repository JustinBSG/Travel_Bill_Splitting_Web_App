import { useTranslation } from 'react-i18next'
import { setPalette, usePalette, type Palette } from '../../app/theme'

/** Colour theme (Washi / Classic) for trip menu and settings. Saved per device. */
export function PaletteSwitch() {
  const { t } = useTranslation()
  const current = usePalette()
  const options: { value: Palette; label: string; hint: string }[] = [
    { value: 'washi', label: t('settings.paletteWashi'), hint: t('settings.paletteWashiHint') },
    { value: 'classic', label: t('settings.paletteClassic'), hint: t('settings.paletteClassicHint') },
  ]
  return (
    <div className="palette-switch" role="group" aria-label={t('settings.palette')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`palette-option${current === o.value ? ' active' : ''}`}
          aria-pressed={current === o.value}
          onClick={() => setPalette(o.value)}
        >
          <span className={`palette-swatch palette-swatch-${o.value}`} aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span className="palette-text">
            <span className="palette-name">{o.label}</span>
            <span className="palette-hint">{o.hint}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
