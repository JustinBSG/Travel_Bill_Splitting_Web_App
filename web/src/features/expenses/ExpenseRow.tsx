import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useFmt } from '../../app/useFmt'
import { multiDayPosition, utcToLocalParts, type ExpensePageKey } from '../../lib/dates'
import { HKD, fromHkdCents, toMinor } from '../../lib/money'
import type { Expense, ISODate } from '../../lib/types'
import { useTripData } from '../trips/TripDataContext'
import { usePageLabels } from '../trips/usePageLabels'
import { categoryIcon, categoryLabel } from './categories'
import { meaningForMe } from './meaning'

interface Props {
  expense: Expense
  page: ExpensePageKey
  /** Local currency of the page's date (HKD for pre/post). */
  pageCurrency: string
  /** Date used for the multi-day "(Day X of N)" label when pinned. */
  pinnedOn?: ISODate
}

export function ExpenseRow({ expense: e, page, pageCurrency, pinnedOn }: Props) {
  const { t } = useTranslation()
  const fmt = useFmt()
  const { trip, activeMembers, me, memberName, rateFor } = useTripData()
  const labels = usePageLabels()

  const local = utcToLocalParts(e.occurred_at, e.timezone)
  const city = labels.tzLabel(e.timezone, e.local_date)
  const personal = e.expense_participants.length === 0
  const participantIds = e.expense_participants.map((p) => p.member_id)
  const everyone =
    !personal &&
    activeMembers.length > 0 &&
    activeMembers.every((m) => participantIds.includes(m.id)) &&
    participantIds.length === activeMembers.length

  // Local-currency equivalent when paid in another currency (e.g. HKD in Japan).
  const localRate = pageCurrency !== e.currency && pageCurrency !== HKD ? rateFor(pageCurrency) : null
  const localEquivalent =
    localRate && e.amount_hkd !== null ? fromHkdCents(toMinor(e.amount_hkd), pageCurrency, localRate) : null

  const meaning = meaningForMe(e, me?.id ?? null)
  const withHkd = (amount: ReturnType<typeof toMinor>, hkd: ReturnType<typeof toMinor> | null) =>
    e.currency === HKD || !hkd ? fmt.money(amount, e.currency) : `${fmt.money(amount, e.currency)} (${fmt.money(hkd, HKD)})`

  const pos = pinnedOn ? multiDayPosition(e, pinnedOn) : null

  return (
    <li>
      <Link to={`/trips/${trip.id}/expense/${e.id}?page=${encodeURIComponent(page)}`} className="expense-row">
        <span className="expense-icon" aria-hidden>
          {categoryIcon(e.category)}
        </span>
        <span className="expense-main">
          {pos && e.end_date && (
            <span className="badge badge-multi">
              {t('expense.multiDay', {
                range: fmt.range(e.local_date, e.end_date),
                day: pos.index,
                total: pos.total,
              })}
            </span>
          )}
          <span className="expense-title">
            {e.title}
            {personal && <span className="badge badge-personal">{t('expense.personal')}</span>}
            {e.photo_path && (
              <span className="muted" aria-label={t('form.photo')}>
                {' '}
                📷
              </span>
            )}
          </span>
          <span className="muted small">
            {categoryLabel(t, e.category)} · {local.time} ({t('expense.localTime', { city })})
          </span>
          <span className="expense-amount">
            {fmt.money(e.amount, e.currency)}
            {e.currency !== HKD && e.amount_hkd !== null && <> ({fmt.money(e.amount_hkd, HKD)})</>}
            {e.amount_hkd === null && e.currency !== HKD && <span className="muted small"> · {t('fx.pending')}</span>}
            {localEquivalent && <span className="muted small"> ≈ {fmt.money(localEquivalent, pageCurrency)}</span>}
          </span>
          <span className="small">
            {t('expense.paidBy', { name: memberName(e.paid_by) })}
            {!personal && (
              <>
                {' · '}
                {everyone
                  ? t('expense.splitEveryone')
                  : t('expense.splitBetween', { names: participantIds.map(memberName).join(', ') })}
              </>
            )}
          </span>
          <span className={`meaning meaning-${meaning.kind}`}>
            {meaning.kind === 'personalMine' && t('meaning.personalMine')}
            {meaning.kind === 'personalOther' && t('meaning.personalOther')}
            {meaning.kind === 'notInvolved' && t('meaning.notInvolved')}
            {meaning.kind === 'onlyMe' && t('meaning.onlyMe')}
            {meaning.kind === 'owed' && t('meaning.owed', { amount: withHkd(meaning.amount, meaning.amountHkd) })}
            {meaning.kind === 'owe' &&
              t('meaning.owe', { name: memberName(meaning.to), amount: withHkd(meaning.amount, meaning.amountHkd) })}
          </span>
        </span>
      </Link>
    </li>
  )
}
