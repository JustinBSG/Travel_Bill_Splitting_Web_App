import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useToast } from '../../app/ui/toast'
import { Banner, ErrorBox, PageHeader } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { Modal } from '../../app/ui/Modal'
import { eachDate, isISODate } from '../../lib/dates'
import type { ISODate } from '../../lib/types'
import { DayLocationsEditor } from './DayLocationsEditor'
import { useTripData } from './TripDataContext'
import { deleteTrip, regenerateInvite, saveTripSettings, setJoiningEnabled, setTripLocked, type DayLocation } from './tripApi'
import { MAX_TRIP_DAYS, tripDatesError } from './tripText'

/** Admin only. Owner-only: delete trip (type the name to confirm). */
export function TripSettingsPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { trip, days, isAdmin, isOwner, locked, reload } = useTripData()

  const [name, setName] = useState(trip.name)
  const [start, setStart] = useState(trip.start_date)
  const [end, setEnd] = useState(trip.end_date)
  const [locs, setLocs] = useState<Map<ISODate, DayLocation>>(
    () =>
      new Map(
        days
          .filter((d) => d.location_name && d.timezone)
          .map((d) => [
            d.date,
            {
              location_name: d.location_name!,
              country_code: d.country_code,
              latitude: d.latitude,
              longitude: d.longitude,
              timezone: d.timezone!,
              currency: d.currency ?? 'HKD',
            },
          ]),
      ),
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'regenerate' | 'lock' | 'delete' | null>(null)
  const [deleteName, setDeleteName] = useState('')

  const datesErr = tripDatesError(start, end)
  const dates = useMemo(() => (datesErr || !isISODate(start) || !isISODate(end) ? [] : eachDate(start, end)), [start, end, datesErr])
  const missing = dates.filter((d) => !locs.get(d))

  if (!isAdmin) {
    return (
      <div className="screen">
        <PageHeader title={t('menu.tripSettings')} backTo={`/trips/${trip.id}/overview`} />
        <main className="content">
          <p>{t('tripSettings.adminOnly')}</p>
        </main>
      </div>
    )
  }

  async function run(key: string, fn: () => Promise<void>, success: string) {
    setBusy(key)
    setError(null)
    try {
      await fn()
      toast.show(success, { tone: 'success' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function saveDetails(e: FormEvent) {
    e.preventDefault()
    if (!name.trim() || datesErr || !dates.length || missing.length) return
    await run(
      'details',
      async () => {
        await saveTripSettings(trip.id, { name: name.trim(), start_date: start, end_date: end, dates, days: locs })
        // Date changes re-bucket expenses (backend); refetch every page.
        await reload()
      },
      t('tripSettings.saved'),
    )
  }

  return (
    <div className="screen">
      <PageHeader title={t('menu.tripSettings')} backTo={`/trips/${trip.id}/overview`} />
      <main className="content stack">
        {locked && (
          <Banner tone="lock">
            <Icon name="lock" size={16} /> {t('tripSettings.lockedNote')}
          </Banner>
        )}
        {error && <ErrorBox message={error} />}

        <form className="card stack" onSubmit={saveDetails} noValidate>
          <h2 className="section-title">{t('tripSettings.details')}</h2>
          <fieldset disabled={locked || busy !== null} className="stack plain-fieldset">
            <label className="field">
              <span>{t('create.name')}</span>
              <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="row-gap">
              <label className="field grow">
                <span>{t('create.startDate')}</span>
                <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
              <label className="field grow">
                <span>{t('create.endDate')}</span>
                <input type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
            </div>
            {datesErr === 'order' && <p className="error-text">{t('create.endBeforeStart')}</p>}
            {datesErr === 'length' && <p className="error-text">{t('create.tooLong', { max: MAX_TRIP_DAYS })}</p>}
            {(start !== trip.start_date || end !== trip.end_date) && (
              <p className="muted small">{t('tripSettings.rebucketNote')}</p>
            )}
            {dates.length > 0 && <DayLocationsEditor dates={dates} value={locs} onChange={setLocs} disabled={locked} />}
            {missing.length > 0 && <p className="error-text">{t('create.missingLocations', { count: missing.length })}</p>}
            <button type="submit" className="btn btn-primary btn-block" disabled={!name.trim() || !!datesErr || missing.length > 0}>
              {busy === 'details' ? t('app.saving') : t('app.save')}
            </button>
          </fieldset>
        </form>

        <section className="card stack">
          <h2 className="section-title">{t('tripSettings.invite')}</h2>
          <label className="check-row">
            <input
              type="checkbox"
              checked={trip.joining_enabled}
              disabled={locked || busy !== null}
              onChange={(e) =>
                void run(
                  'joining',
                  async () => {
                    await setJoiningEnabled(trip.id, e.target.checked)
                    await reload(['trip'])
                  },
                  e.target.checked ? t('tripSettings.joiningOnDone') : t('tripSettings.joiningOffDone'),
                )
              }
            />
            <span>{t('tripSettings.joiningEnabled')}</span>
          </label>
          <button type="button" className="btn" disabled={locked || busy !== null} onClick={() => setConfirm('regenerate')}>
            {t('tripSettings.regenerate')}
          </button>
          <p className="muted small">{t('tripSettings.regenerateHint')}</p>
        </section>

        <section className="card stack">
          <h2 className="section-title">{t('tripSettings.lockTitle')}</h2>
          <p className="muted small">{t('tripSettings.lockHint')}</p>
          {locked ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'lock',
                  async () => {
                    await setTripLocked(trip.id, false)
                    await reload(['trip'])
                  },
                  t('tripSettings.unlocked'),
                )
              }
            >
              <Icon name="unlock" size={18} /> {t('tripSettings.unlock')}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirm('lock')}>
              <Icon name="lock" size={18} /> {t('tripSettings.lock')}
            </button>
          )}
        </section>

        {isOwner && (
          <section className="card stack danger-zone">
            <h2 className="section-title">{t('tripSettings.dangerZone')}</h2>
            <button type="button" className="btn btn-danger" disabled={locked || busy !== null} onClick={() => setConfirm('delete')}>
              <Icon name="trash" size={18} /> {t('tripSettings.delete')}
            </button>
            {locked && <p className="muted small">{t('tripSettings.unlockToDelete')}</p>}
          </section>
        )}
      </main>

      {confirm === 'regenerate' && (
        <Modal
          title={t('tripSettings.regenerate')}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                {t('app.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setConfirm(null)
                  void run(
                    'regenerate',
                    async () => {
                      await regenerateInvite(trip.id)
                      await reload(['trip'])
                    },
                    t('tripSettings.regenerated'),
                  )
                }}
              >
                {t('app.confirm')}
              </button>
            </>
          }
        >
          <p>{t('tripSettings.regenerateConfirm')}</p>
        </Modal>
      )}

      {confirm === 'lock' && (
        <Modal
          title={t('tripSettings.lock')}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                {t('app.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setConfirm(null)
                  void run(
                    'lock',
                    async () => {
                      await setTripLocked(trip.id, true)
                      await reload(['trip'])
                    },
                    t('tripSettings.lockedDone'),
                  )
                }}
              >
                {t('tripSettings.lock')}
              </button>
            </>
          }
        >
          <p>{t('tripSettings.lockConfirm')}</p>
        </Modal>
      )}

      {confirm === 'delete' && (
        <Modal
          title={t('tripSettings.delete')}
          onClose={() => {
            setConfirm(null)
            setDeleteName('')
          }}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                {t('app.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deleteName !== trip.name || busy !== null}
                onClick={() =>
                  void run(
                    'delete',
                    async () => {
                      await deleteTrip(trip.id)
                      navigate('/trips', { replace: true })
                    },
                    t('tripSettings.deleted'),
                  )
                }
              >
                {t('app.delete')}
              </button>
            </>
          }
        >
          <div className="stack">
            <p>{t('tripSettings.deleteConfirm', { name: trip.name })}</p>
            <label className="field">
              <span>{t('tripSettings.typeName')}</span>
              <input value={deleteName} autoComplete="off" onChange={(e) => setDeleteName(e.target.value)} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  )
}
