import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { Icon } from '../../app/ui/Icon'
import { weatherIcon, type Weather } from './openMeteo'

/**
 * Icon, high / low and rain. `inline` for page headers, `stack` for the
 * itinerary column (temperatures over the rain line).
 */
export function WeatherBadge({ weather, layout = 'inline' }: { weather: Weather | undefined | null; layout?: 'inline' | 'stack' }) {
  const { t } = useTranslation()
  const fmt = useFmt()
  if (!weather) return <span className="weather muted small">…</span>
  if (weather.kind === 'later') {
    return (
      <span className="weather muted small">{t('weather.availableFrom', { date: fmt.dayMonth(weather.availableFrom) })}</span>
    )
  }
  if (weather.kind === 'unavailable') return <span className="weather muted small">{t('weather.unavailable')}</span>
  const icon = weatherIcon(weather.code)
  const rain =
    weather.precipProbability !== null
      ? t('weather.rainChance', { percent: weather.precipProbability })
      : weather.precipSum !== null
        ? t('weather.rainSum', { mm: weather.precipSum })
        : null
  const temps = (
    <span className="weather-temps">
      {Math.round(weather.max)}° <span className="muted">/ {Math.round(weather.min)}°</span>
    </span>
  )
  return (
    <span className={`weather weather-${layout}`}>
      <Icon name={icon.icon} size={layout === 'stack' ? 20 : 18} label={t(`weather.codes.${icon.key}`)} />
      {layout === 'stack' ? (
        <span className="weather-text">
          {temps}
          {rain && <span className="muted small">{rain}</span>}
        </span>
      ) : (
        <span>
          {temps}
          {rain && <span className="muted"> · {rain}</span>}
        </span>
      )}
    </span>
  )
}
