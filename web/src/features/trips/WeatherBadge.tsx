import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { weatherIcon, type Weather } from './openMeteo'

export function WeatherBadge({ weather }: { weather: Weather | undefined | null }) {
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
  return (
    <span className="weather small">
      <span role="img" aria-label={t(`weather.codes.${icon.key}`)}>
        {icon.emoji}
      </span>{' '}
      {Math.round(weather.max)}° / {Math.round(weather.min)}°
      {weather.precipProbability !== null && <> · ☔ {weather.precipProbability}%</>}
      {weather.precipProbability === null && weather.precipSum !== null && <> · {weather.precipSum} mm</>}
    </span>
  )
}
