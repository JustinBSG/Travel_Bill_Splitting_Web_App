import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { InstallPrompt } from '../../app/InstallPrompt'
import { useFmt } from '../../app/useFmt'
import { ErrorBox, PageHeader, Spinner } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { HKD } from '../../lib/money'
import { useUser } from '../auth/AuthContext'
import { BellButton } from '../notifications/BellButton'
import { JoinCodeDialog } from './JoinCodeDialog'
import { fetchLatestRates, loadCurrencies } from './ratesApi'
import { fetchMyTrips, type MyTripSummary } from './tripApi'
import { durationText } from './tripText'

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
        <div className="row-gap">
          <Link to="/trips/new" className="btn btn-primary grow">
            <Icon name="plus" size={18} /> {t('trips.create')}
          </Link>
          <button type="button" className="btn grow" onClick={() => setJoinOpen(true)}>
            {t('trips.joinWithCode')}
          </button>
        </div>

        {state.status === 'loading' && <Spinner />}
        {state.status === 'error' && <ErrorBox message={state.message} onRetry={load} />}
        {state.status === 'ready' && state.trips.length === 0 && <p className="empty">{t('trips.empty')}</p>}
        {state.status === 'ready' && state.trips.length > 0 && (
          <ul className="trip-list">
            {state.trips.map(({ trip, balanceHkd }) => (
              <li key={trip.id}>
                <Link to={`/trips/${trip.id}/overview`} className="card trip-card">
                  <div className="row-between">
                    <strong className="trip-name">{trip.name}</strong>
                    {trip.is_locked && (
                      <span className="badge" title={t('lock.locked')}>
                        <Icon name="lock" size={14} /> {t('lock.locked')}
                      </span>
                    )}
                  </div>
                  <div className="muted small">
                    {fmt.range(trip.start_date, trip.end_date)} · {durationText(t, trip.start_date, trip.end_date)}
                  </div>
                  {balanceHkd && (
                    <span
                      className={`chip-balance ${balanceHkd.isZero() ? 'zero' : balanceHkd.isPositive() ? 'pos' : 'neg'}`}
                    >
                      {balanceHkd.isZero()
                        ? t('balance.settled')
                        : balanceHkd.isPositive()
                          ? t('balance.youAreOwed', { amount: fmt.money(balanceHkd, HKD) })
                          : t('balance.youOwe', { amount: fmt.money(balanceHkd.abs(), HKD) })}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      {joinOpen && <JoinCodeDialog onClose={() => setJoinOpen(false)} />}
    </div>
  )
}
