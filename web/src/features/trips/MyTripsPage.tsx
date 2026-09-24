import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { InstallPrompt } from '../../app/InstallPrompt'
import { useFmt } from '../../app/useFmt'
import { ErrorBox, PageHeader, Spinner } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { HOME_TZ, tripProgress, type TripProgress } from '../../lib/dates'
import { HKD } from '../../lib/money'
import { useUser } from '../auth/AuthContext'
import { BellButton } from '../notifications/BellButton'
import { JoinCodeDialog } from './JoinCodeDialog'
import { fetchLatestRates, loadCurrencies } from './ratesApi'
import { fetchMyTrips, type MyTripSummary } from './tripApi'
import { durationText } from './tripText'

type GroupKey = 'onTheRoad' | 'upcoming' | 'past'

/** On the road first, then upcoming (soonest first), then past (latest first). */
function groups(trips: MyTripSummary[]): { key: GroupKey; trips: { summary: MyTripSummary; progress: TripProgress }[] }[] {
  const out: Record<GroupKey, { summary: MyTripSummary; progress: TripProgress }[]> = { onTheRoad: [], upcoming: [], past: [] }
  for (const summary of trips) {
    const progress = tripProgress(summary.trip, () => HOME_TZ)
    const key: GroupKey = progress.kind === 'during' ? 'onTheRoad' : progress.kind === 'before' ? 'upcoming' : 'past'
    out[key].push({ summary, progress })
  }
  out.upcoming.sort((a, b) => a.summary.trip.start_date.localeCompare(b.summary.trip.start_date))
  out.past.sort((a, b) => b.summary.trip.end_date.localeCompare(a.summary.trip.end_date))
  return (['onTheRoad', 'upcoming', 'past'] as const).map((key) => ({ key, trips: out[key] }))
}

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; trips: MyTripSummary[] }

async function loadMyTrips(userId: string): Promise<MyTripSummary[]> {
  await loadCurrencies()
  return fetchMyTrips(userId, await fetchLatestRates())
}

export function MyTripsPage() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const user = useUser()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [joinOpen, setJoinOpen] = useState(false)

  const [attempt, setAttempt] = useState(0)
  const load = () => {
    setState({ status: 'loading' })
    setAttempt((a) => a + 1)
  }

  useEffect(() => {
    let alive = true
    loadMyTrips(user.id).then(
      (trips) => alive && setState({ status: 'ready', trips }),
      (e) => alive && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      alive = false
    }
  }, [user.id, attempt])

  return (
    <div className="screen">
      <PageHeader
        large
        title={t('trips.title')}
        actions={
          <>
            <BellButton />
            <Link to="/settings" className="icon-btn" aria-label={t('settings.title')}>
              <Icon name="settings" />
            </Link>
          </>
        }
      />
      <main className="content">
        <InstallPrompt />
        <div className="two-col">
          <Link to="/trips/new" className="btn btn-primary">
            <Icon name="plus" size={20} stroke={2} /> {t('trips.create')}
          </Link>
          <button type="button" className="btn" onClick={() => setJoinOpen(true)}>
            {t('trips.joinWithCode')}
          </button>
        </div>

        {state.status === 'loading' && <Spinner />}
        {state.status === 'error' && <ErrorBox message={state.message} onRetry={load} />}
        {state.status === 'ready' && state.trips.length === 0 && <p className="empty">{t('trips.empty')}</p>}
        {state.status === 'ready' &&
          state.trips.length > 0 &&
          groups(state.trips).map(
            (g) =>
              g.trips.length > 0 && (
                <section key={g.key} className="stack-s">
                  <h2 className="section-title">{t(`trips.${g.key}`)}</h2>
                  <ul className="trip-list">
                    {g.trips.map(({ summary: { trip, balanceHkd }, progress }) => (
                      <li key={trip.id}>
                        <Link to={`/trips/${trip.id}/overview`} className="card trip-card">
                          <span className="row-between">
                            <strong className="trip-name">{trip.name}</strong>
                            {trip.is_locked ? (
                              <span className="trip-status muted">
                                <Icon name="lock" size={15} /> {t('lock.locked')}
                              </span>
                            ) : progress.kind === 'during' ? (
                              <span className="trip-status">
                                <span className="eyebrow-dot" aria-hidden />
                                {t('overview.dayOf', { day: progress.day, total: progress.total })}
                              </span>
                            ) : progress.kind === 'before' ? (
                              <span className="trip-status muted">{t('overview.startsIn', { count: progress.daysUntil })}</span>
                            ) : null}
                          </span>
                          <span className="muted small">
                            {fmt.range(trip.start_date, trip.end_date)} · {durationText(t, trip.start_date, trip.end_date)}
                          </span>
                          {balanceHkd && (
                            <span className="trip-balance">
                              <span
                                className={balanceHkd.isZero() ? 'muted' : balanceHkd.isPositive() ? 'pos strong' : 'neg strong'}
                              >
                                {balanceHkd.isZero()
                                  ? t('balance.settled')
                                  : balanceHkd.isPositive()
                                    ? t('balance.youAreOwed', { amount: fmt.money(balanceHkd, HKD) })
                                    : t('balance.youOwe', { amount: fmt.money(balanceHkd.abs(), HKD) })}
                              </span>
                              {trip.is_locked && balanceHkd.isZero() && (
                                <span className="stamp stamp-rect" aria-hidden>
                                  {t('balance.settled')}
                                </span>
                              )}
                              <Icon name="chevronRight" size={18} />
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
          )}
      </main>
      {joinOpen && <JoinCodeDialog onClose={() => setJoinOpen(false)} />}
    </div>
  )
}
