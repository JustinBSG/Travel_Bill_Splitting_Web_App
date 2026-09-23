import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { Banner } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { expensesForPage, type ExpensePageKey } from '../../lib/dates'
import { HKD } from '../../lib/money'
import { pageTotalHkd } from '../settlement/stats'
import { useTripData } from '../trips/TripDataContext'
import { usePageLabels } from '../trips/usePageLabels'
import { WeatherBadge } from '../trips/WeatherBadge'
import type { Weather } from '../trips/openMeteo'
import { ExpenseRow } from './ExpenseRow'

/** Pre-trip, each Day, Post-trip. */
export function ExpensePage({ page, weather }: { page: ExpensePageKey; weather?: Weather | null }) {
  const { t } = useTranslation()
  const fmt = useFmt()
  const labels = usePageLabels()
  const { trip, expenses, dayByDate, locked, currencyForDate } = useTripData()

  const isDay = page !== 'pre' && page !== 'post'
  const day = isDay ? dayByDate.get(page) : undefined
  const pageCurrency = isDay ? currencyForDate(page) : HKD
  const { pinned, single, counted } = useMemo(() => expensesForPage(expenses, page, trip), [expenses, page, trip])
  const total = pageTotalHkd(counted)

  return (
    <div className="page-inner">
      <section className="card page-head">
        <div className="row-between">
          <div>
            <h2>
              {isDay ? `${t('pages.day', { n: labels.dayNumber(page) })} · ${fmt.weekday(page)} ${fmt.dayMonth(page)}` : labels.short(page)}
            </h2>
            {isDay && (
              <p className="muted">
                📍 {day?.location_name ?? t('location.notSet')} · {pageCurrency}
              </p>
            )}
            {page === 'pre' && <p className="muted small">{t('expense.preHint', { date: fmt.dayMonth(trip.start_date) })}</p>}
            {page === 'post' && <p className="muted small">{t('expense.postHint', { date: fmt.dayMonth(trip.end_date) })}</p>}
            {isDay && <WeatherBadge weather={weather} />}
          </div>
          <div className="page-total">
            <span className="tile-label">{t('expense.pageTotal')}</span>
            <strong>{fmt.money(total.total, HKD)}</strong>
          </div>
        </div>
        <p className="muted small">{t('expense.pageTotalNote')}</p>
      </section>

      {locked && (
        <Banner tone="lock">
          <Icon name="lock" size={16} /> {t('lock.banner')}
        </Banner>
      )}

      {pinned.length > 0 && (
        <section>
          <h3 className="section-title">{t('expense.pinned')}</h3>
          <ul className="expense-list">
            {pinned.map((e) => (
              <ExpenseRow key={e.id} expense={e} page={page} pageCurrency={pageCurrency} pinnedOn={isDay ? page : e.local_date} />
            ))}
          </ul>
        </section>
      )}

      {single.length > 0 ? (
        <ul className="expense-list">
          {single.map((e) => (
            <ExpenseRow key={e.id} expense={e} page={page} pageCurrency={pageCurrency} />
          ))}
        </ul>
      ) : (
        pinned.length === 0 && <p className="empty">{locked ? t('expense.emptyLocked') : t('expense.empty')}</p>
      )}
    </div>
  )
}
