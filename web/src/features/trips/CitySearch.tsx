import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currencyForCountry } from '../../lib/currencies'
import { searchCities, type GeoResult } from './openMeteo'
import type { DayLocation } from './tripApi'

interface Props {
  label: string
  onPick: (loc: DayLocation) => void
  disabled?: boolean
  autoFocus?: boolean
}

function toDayLocation(r: GeoResult): DayLocation {
  return {
    location_name: r.name,
    country_code: r.country_code ?? null,
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone || 'UTC',
    currency: currencyForCountry(r.country_code),
  }
}

/** City search via Open-Meteo geocoding (debounced). */
export function CitySearch({ label, onPick, disabled, autoFocus }: Props) {
  const { t, i18n } = useTranslation()
  const listId = useId()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<GeoResult[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  useEffect(() => {
    if (q.trim().length < 2) return
    const ctrl = new AbortController()
    const id = window.setTimeout(() => {
      setStatus('loading')
      searchCities(q, i18n.language, ctrl.signal)
        .then((r) => {
          // A trip day needs a country (and so a currency); skip the rare result without one.
          setResults(r.filter((x) => x.country_code))
          setStatus('idle')
        })
        .catch((e) => {
          if ((e as Error).name !== 'AbortError') setStatus('error')
        })
    }, 350)
    return () => {
      window.clearTimeout(id)
      ctrl.abort()
    }
  }, [q, i18n.language])

  const shown = q.trim().length < 2 ? [] : results

  return (
    <div className="city-search">
      <label className="field">
        <span className="sr-only">{label}</span>
        <input
          type="search"
          placeholder={t('location.searchPlaceholder')}
          value={q}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={label}
          aria-controls={listId}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {status === 'loading' && <p className="muted small">{t('app.loading')}</p>}
      {status === 'error' && <p className="error-text small">{t('location.searchFailed')}</p>}
      {shown.length > 0 && (
        <ul className="city-results" id={listId}>
          {shown.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="list-button"
                onClick={() => {
                  onPick(toDayLocation(r))
                  setQ('')
                  setResults([])
                }}
              >
                <strong>{r.name}</strong>
                <span className="muted small">
                  {[r.admin1, r.country].filter(Boolean).join(', ')} · {currencyForCountry(r.country_code)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {status === 'idle' && q.trim().length >= 2 && results.length === 0 && (
        <p className="muted small">{t('location.noResults')}</p>
      )}
    </div>
  )
}
