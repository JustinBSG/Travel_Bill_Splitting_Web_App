import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { ErrorBox, PageHeader } from '../../app/ui/common'
import { eachDate, isISODate } from '../../lib/dates'
import type { ISODate } from '../../lib/types'
import { DayLocationsEditor } from './DayLocationsEditor'
import { createTrip, type DayLocation } from './tripApi'
import { MAX_TRIP_DAYS, durationText, tripDatesError } from './tripText'

export function CreateTripPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [days, setDays] = useState<Map<ISODate, DayLocation>>(new Map())
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const datesErr = tripDatesError(start, end)
  const dates = useMemo(() => (datesErr ? [] : eachDate(start, end)), [start, end, datesErr])
  const missing = dates.filter((d) => !days.get(d))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitted(true)
    if (!name.trim() || !isISODate(start) || !isISODate(end) || datesErr || missing.length) return
    setBusy(true)
    setError(null)
    try {
      const id = await createTrip({ name: name.trim(), start_date: start, end_date: end, dates, days })
      navigate(`/trips/${id}/overview`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="screen">
      <PageHeader title={t('create.title')} backTo="/trips" />
      <main className="content">
        <form className="stack" onSubmit={submit} noValidate>
          <label className="field">
            <span>{t('create.name')}</span>
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={submitted && !name.trim()}
            />
            {submitted && !name.trim() && <span className="error-text">{t('form.required')}</span>}
          </label>
          <div className="row-gap">
            <label className="field grow">
              <span>{t('create.startDate')}</span>
              <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="field grow">
              <span>{t('create.endDate')}</span>
              <input type="date" required min={start || undefined} value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
          {submitted && (!isISODate(start) || !isISODate(end)) && <p className="error-text">{t('create.datesRequired')}</p>}
          {datesErr === 'order' && <p className="error-text">{t('create.endBeforeStart')}</p>}
          {datesErr === 'length' && <p className="error-text">{t('create.tooLong', { max: MAX_TRIP_DAYS })}</p>}

          {dates.length > 0 && (
            <>
              <p className="muted">{durationText(t, start, end)}</p>
              <h2 className="section-title">{t('create.locations')}</h2>
              <p className="muted small">{t('create.locationsHint')}</p>
              <DayLocationsEditor dates={dates} value={days} onChange={setDays} />
              {submitted && missing.length > 0 && (
                <p className="error-text">{t('create.missingLocations', { count: missing.length })}</p>
              )}
            </>
          )}

          {error && <ErrorBox message={error} />}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? t('app.saving') : t('create.submit')}
          </button>
        </form>
      </main>
    </div>
  )
}
