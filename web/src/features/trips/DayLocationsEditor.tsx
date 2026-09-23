import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { knownCurrencies } from '../../lib/currencies'
import { tzCity } from '../../lib/dates'
import type { ISODate } from '../../lib/types'
import { CitySearch } from './CitySearch'
import type { DayLocation } from './tripApi'

interface Props {
  dates: ISODate[]
  value: Map<ISODate, DayLocation>
  onChange: (next: Map<ISODate, DayLocation>) => void
  disabled?: boolean
}

/** Lists every trip date with a city search and "Same as previous day". */
export function DayLocationsEditor({ dates, value, onChange, disabled }: Props) {
  const { t } = useTranslation()
  const fmt = useFmt()
  const [editing, setEditing] = useState<ISODate | null>(null)

  const set = (date: ISODate, loc: DayLocation) => {
    const next = new Map(value)
    next.set(date, loc)
    onChange(next)
  }

  return (
    <ol className="day-locations">
      {dates.map((date, i) => {
        const loc = value.get(date)
        const prev = i > 0 ? value.get(dates[i - 1]) : undefined
        const label = `${t('pages.day', { n: i + 1 })} · ${fmt.weekday(date)} ${fmt.dayMonth(date)}`
        const showSearch = !loc || editing === date
        return (
          <li key={date} className="card day-location">
            <div className="row-between">
              <strong>{label}</strong>
              {prev && !disabled && (
                <button type="button" className="btn btn-small" onClick={() => set(date, { ...prev })}>
                  {t('location.sameAsPrevious')}
                </button>
              )}
            </div>
            {loc && editing !== date && (
              <div className="row-between">
                <span>
                  📍 {loc.location_name}
                  {loc.country_code ? `, ${loc.country_code}` : ''}{' '}
                  <span className="muted small">
                    · {tzCity(loc.timezone)} {t('location.time')}
                  </span>
                </span>
                {!disabled && (
                  <button type="button" className="btn-link" onClick={() => setEditing(date)}>
                    {t('app.change')}
                  </button>
                )}
              </div>
            )}
            {showSearch && (
              <CitySearch
                label={label}
                disabled={disabled}
                autoFocus={editing === date}
                onPick={(l) => {
                  set(date, l)
                  setEditing(null)
                }}
              />
            )}
            {loc && (
              <label className="field field-inline">
                <span>{t('location.localCurrency')}</span>
                <select
                  value={loc.currency}
                  disabled={disabled}
                  onChange={(e) => set(date, { ...loc, currency: e.target.value })}
                >
                  {[...new Set([loc.currency, ...knownCurrencies()])].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!loc && <p className="error-text small">{t('location.required')}</p>}
          </li>
        )
      })}
    </ol>
  )
}
