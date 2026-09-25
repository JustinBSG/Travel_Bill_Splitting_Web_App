import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { Banner } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { HOME_TZ, diffDays, expensesForPage, todayIn, type ExpensePageKey } from '../../lib/dates'
import { HKD } from '../../lib/money'
import { pageTotalHkd } from '../settlement/stats'
import { useTripData } from '../trips/TripDataContext'
import { usePageLabels } from '../trips/usePageLabels'
import { WeatherBadge } from '../trips/WeatherBadge'
import type { Weather } from '../trips/openMeteo'
import { ExpenseRow } from './ExpenseRow'

/** Pre-trip, each Day, Post-trip: a ledger for one page. */
export function ExpensePage({
  page,
  weather,
  highlight,
}: {
  page: ExpensePageKey
  weather?: Weather | null
  /** Expense id to scroll to and flash (from a notification link). */
  highlight?: string
}) {
  const { t } = useTranslation()
  const fmt = useFmt()
  const labels = usePageLabels()
  const { trip, expenses, dayByDate, locked, currencyForDate, tzForDate } = useTripData()

  const isDay = page !== 'pre' && page !== 'post'
  const day = isDay ? dayByDate.get(page) : undefined
  const pageCurrency = isDay ? currencyForDate(page) : HKD
  const pageTz = isDay ? tzForDate(page) : HOME_TZ
  const city = labels.tzLabel(pageTz, isDay ? page : undefined)
  const isToday = isDay && todayIn(pageTz) === page
  const totalDays = diffDays(trip.start_date, trip.end_date) + 1
  const { pinned, single, counted } = useMemo(() => expensesForPage(expenses, page, trip), [expenses, page, trip])
  const total = pageTotalHkd(counted)

  return (
    <div className="page-inner">
      <section className="page-head">
        {isDay && (
          <p className="eyebrow">
            {isToday && <span className="eyebrow-dot" aria-hidden />}
            {isToday && `${t('expense.today')} · `}
            {t('overview.dayOf', { day: labels.dayNumber(page), total: totalDays })}
          </p>
        )}
        <h2 className="page-title">{isDay ? fmt.longDate(page) : labels.short(page)}</h2>
        {isDay ? (
          <div className="page-meta">
            <span className="with-icon">
              <Icon name="pin" size={18} />
              {day?.location_name ?? t('location.notSet')} · {pageCurrency}
            </span>
            <WeatherBadge weather={weather} />
          </div>
        ) : (
          <p className="muted">
            {page === 'pre'
              ? t('expense.preHint', { date: fmt.dayMonth(trip.start_date) })
              : t('expense.postHint', { date: fmt.dayMonth(trip.end_date) })}
          </p>
        )}
      </section>

      <section className="ledger-total" aria-label={isDay ? t('expense.dayTotal') : t('expense.pageTotal')}>
        <div className="row-between baseline">
          <span className="ledger-total-label">{isDay ? t('expense.dayTotal') : t('expense.pageTotal')}</span>
          <strong className="ledger-total-amount">{fmt.money(total.total, HKD)}</strong>
        </div>
        <p className="muted small">{t('expense.pageTotalNote')}</p>
      </section>

      {locked && (
        <Banner tone="lock">
          <Icon name="lock" size={16} /> {t('lock.banner')}
        </Banner>
      )}

      {pinned.length > 0 && (
        <section className="stack-s">
          <h3 className="section-title">
            <Icon name="calendarRange" size={15} stroke={2} /> {t('expense.pinned')}
          </h3>
          <ul className="expense-list sheet-list">
            {pinned.map((e) => (
              <ExpenseRow
                key={e.id}
                expense={e}
                page={page}
                pageCurrency={pageCurrency}
                pageTz={pageTz}
                pinnedOn={isDay ? page : e.local_date}
                highlighted={e.id === highlight}
              />
            ))}
          </ul>
          <p className="muted small">{t('expense.pinnedNote')}</p>
        </section>
      )}

      {single.length > 0 ? (
        <section>
          <h3 className="section-title list-heading">
            {t('expense.listTitle')} · {t('expense.localTime', { city })}
          </h3>
          <ul className="expense-list ledger">
            {single.map((e) => (
              <ExpenseRow
                key={e.id}
                expense={e}
                page={page}
                pageCurrency={pageCurrency}
                pageTz={pageTz}
                highlighted={e.id === highlight}
              />
            ))}
          </ul>
        </section>
      ) : (
        pinned.length === 0 && <p className="empty">{locked ? t('expense.emptyLocked') : t('expense.empty')}</p>
      )}
    </div>
  )
}
