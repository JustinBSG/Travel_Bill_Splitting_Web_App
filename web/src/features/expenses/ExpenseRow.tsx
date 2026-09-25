import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useFmt } from '../../app/useFmt'
import { Icon } from '../../app/ui/Icon'
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
  /** Timezone of the page; the time zone is only spelled out when a row differs. */
  pageTz: string
  /** Date used for the multi-day "(Day X of N)" label when pinned. */
  pinnedOn?: ISODate
  /** Scroll into view and flash once (opened from a notification). */
  highlighted?: boolean
}

/** One ledger line: time | title, who paid, what it means for me | amounts. */
export function ExpenseRow({ expense: e, page, pageCurrency, pageTz, pinnedOn, highlighted }: Props) {
  const { t } = useTranslation()
  const fmt = useFmt()
  const { trip, activeMembers, me, memberName, rateFor } = useTripData()
  const labels = usePageLabels()

  // All-day rows have no clock time, so no time zone to spell out either.
  const time = e.all_day ? t('expense.allDay') : utcToLocalParts(e.occurred_at, e.timezone).time
  const otherTz =
    !e.all_day && e.timezone !== pageTz ? t('expense.localTime', { city: labels.tzLabel(e.timezone, e.local_date) }) : null
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

  // Centre the row in its page's own vertical scroller. Not scrollIntoView: that
  // would also scroll the horizontal day swiper.
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const el = row.current
    const scroller = el?.closest<HTMLElement>('.swipe-page')
    if (!highlighted || !el || !scroller) return
    const r = el.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    scroller.scrollTo({ top: scroller.scrollTop + r.top - s.top - (s.height - r.height) / 2, behavior: 'instant' })
  }, [highlighted])

  return (
    <li ref={row} className={highlighted ? 'expense-flash' : undefined}>
      <Link
        to={`/trips/${trip.id}/expense/${e.id}?page=${encodeURIComponent(page)}`}
        className={`expense-row${pinnedOn ? ' expense-row-pinned' : ''}`}
      >
        {!pinnedOn && (
          <span className="expense-time">
            {time}
            {otherTz && <span className="expense-tz">{otherTz}</span>}
          </span>
        )}
        <span className="expense-main">
          <span className="expense-title">
            <span className="expense-icon">
              <Icon name={categoryIcon(e.category)} size={17} label={categoryLabel(t, e.category)} />
            </span>
            <span className="expense-title-text">{e.title}</span>
            {personal && <span className="badge badge-outline">{t('expense.personal')}</span>}
            {e.category === 'Loan' && <span className="badge badge-outline">{t('category.loan')}</span>}
            {e.photo_path && (
              <span className="expense-photo">
                <Icon name="camera" size={15} label={t('form.photo')} />
              </span>
            )}
          </span>
          {pos && e.end_date && (
            <span className="badge badge-multi">
              {t('expense.multiDay', {
                range: fmt.range(e.local_date, e.end_date),
                day: pos.index,
                total: pos.total,
              })}
            </span>
          )}
          <span className="expense-meta">
            {pinnedOn && `${time}${otherTz ? ` (${otherTz})` : ''} · `}
            {t('expense.paidBy', { name: memberName(e.paid_by) })}
            {!personal && (
              <>
                {' · '}
                {e.split_method === 'exact'
                  ? t('expense.splitExact', {
                      list: e.expense_participants
                        .map((p) => `${memberName(p.member_id)} ${fmt.money(p.share_amount, e.currency)}`)
                        .join(', '),
                    })
                  : everyone
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
        <span className="expense-amounts">
          <span className="expense-amount">{fmt.money(e.amount, e.currency)}</span>
          {e.currency !== HKD && e.amount_hkd !== null && <span className="expense-sub">{fmt.money(e.amount_hkd, HKD)}</span>}
          {e.amount_hkd === null && e.currency !== HKD && <span className="expense-sub">{t('fx.pending')}</span>}
          {localEquivalent && <span className="expense-sub">≈ {fmt.money(localEquivalent, pageCurrency)}</span>}
        </span>
      </Link>
    </li>
  )
}
