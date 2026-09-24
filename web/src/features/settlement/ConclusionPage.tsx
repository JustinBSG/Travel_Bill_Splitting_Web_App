import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { Avatar, Banner } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { HKD, ZERO, toHkdCents, type Decimal } from '../../lib/money'
import {
  activeCurrencies,
  netOf,
  shareIntegrityIssues,
  suggestAllInHkd,
  suggestByCurrency,
  type Transfer,
} from '../../lib/settlement'
import { CATEGORIES } from '../../lib/types'
import { categoryIcon, categoryLabel } from '../expenses/categories'
import { useTripData } from '../trips/TripDataContext'
import { usePageLabels } from '../trips/usePageLabels'
import { MarkPaidDialog } from './MarkPaidDialog'
import { computeStats } from './stats'

/** Presentation only: a width in % of `max` (never used for money math). */
function pct(v: Decimal, max: Decimal): number {
  return max.isZero() ? 0 : v.abs().div(max).times(100).toNumber()
}

function BarList({ items, format }: { items: { key: string; label: ReactNode; value: Decimal }[]; format: (v: Decimal) => string }) {
  const max = items.reduce((m, i) => (i.value.gt(m) ? i.value : m), ZERO)
  if (items.length === 0) return null
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.key} className="bar-row">
          <span className="bar-label">{i.label}</span>
          <span className="bar-value">{format(i.value)}</span>
          <span className="bar-track" aria-hidden>
            <span className="bar-fill" style={{ width: `${pct(i.value, max)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Up to this many pages the "by day" chart uses columns; longer trips get bars. */
const MAX_COLUMNS = 10

export function ConclusionPage() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const labels = usePageLabels()
  const { trip, members, expenses, settlements, nets, rateFor, memberName, locked, me, pages, rates } = useTripData()
  const [view, setView] = useState<'hkd' | 'currency'>('hkd')
  const [paying, setPaying] = useState<Transfer | null>(null)

  const stats = useMemo(() => computeStats(expenses, members.map((m) => m.id), trip), [expenses, members, trip])
  // Derived every render from nets; suggestions are never stored.
  const hkd = useMemo(() => suggestAllInHkd(nets, rateFor), [nets, rateFor])
  const byCurrency = useMemo(() => suggestByCurrency(nets), [nets])
  const currencies = useMemo(() => activeCurrencies(nets), [nets])
  const integrity = useMemo(() => shareIntegrityIssues(expenses), [expenses])
  const transfers = view === 'hkd' ? hkd.transfers : byCurrency
  const mine = transfers.filter((tr) => tr.from === me?.id)
  const others = transfers.filter((tr) => tr.from !== me?.id)
  const money = (v: Decimal) => fmt.money(v, HKD)
  const canPay = !locked && !!me

  const indexOf = (id: string) => Math.max(0, members.findIndex((m) => m.id === id))
  const isPlaceholder = (id: string) => !members.find((m) => m.id === id)?.user_id
  const name = (id: string) => (id === me?.id ? `${memberName(id)} (${t('app.you')})` : memberName(id))
  const person = (id: string, size = 26) => (
    <span className="person">
      <Avatar name={memberName(id)} index={indexOf(id)} placeholder={isPlaceholder(id)} size={size} />
      <span>{name(id)}</span>
    </span>
  )

  const amountOf = (tr: Transfer) => {
    const rate = tr.currency !== HKD ? rateFor(tr.currency) : null
    return (
      <>
        <strong className="transfer-amount">{fmt.money(tr.amount, tr.currency)}</strong>
        {rate && (
          <span className="muted small">
            {t('conclusion.about', { amount: fmt.money(toHkdCents(tr.amount, tr.currency, rate), HKD) })}
          </span>
        )}
      </>
    )
  }

  const hkdMax = members.reduce((m, x) => {
    const v = (hkd.balances.get(x.id) ?? ZERO).abs()
    return v.gt(m) ? v : m
  }, ZERO)

  const expensePages = pages.filter((p) => p !== 'overview' && p !== 'conclusion')
  const dayValues = expensePages.map((p) => ({ key: p, value: stats.byPage.get(p) ?? ZERO }))
  const dayMax = dayValues.reduce((m, d) => (d.value.gt(m) ? d.value : m), ZERO)
  const shortDay = (p: string) => (p === 'pre' || p === 'post' ? labels.short(p) : String(Number(p.slice(8))))

  return (
    <div className="page-inner">
      {locked && (
        <Banner tone="lock">
          <Icon name="lock" size={16} /> {t('lock.conclusionFinal')}
        </Banner>
      )}

      <section className="stack">
        <h2 className="page-title">{t('pages.conclusion')}</h2>
        <div className="segmented" role="group" aria-label={t('conclusion.view')}>
          <button type="button" className={view === 'hkd' ? 'active' : ''} aria-pressed={view === 'hkd'} onClick={() => setView('hkd')}>
            {t('conclusion.allInHkd')}
          </button>
          <button
            type="button"
            className={view === 'currency' ? 'active' : ''}
            aria-pressed={view === 'currency'}
            onClick={() => setView('currency')}
          >
            {t('conclusion.byCurrencyView')}
          </button>
        </div>
      </section>

      {integrity.length > 0 && <Banner tone="error">{t('conclusion.integrity', { count: integrity.length })}</Banner>}
      {view === 'hkd' && hkd.missingRates.length > 0 && (
        <Banner tone="warn">{t('conclusion.missingRates', { currencies: hkd.missingRates.join(', ') })}</Banner>
      )}

      {/* Who pays whom: the thing people come here for, so it goes first. */}
      <section className="stack">
        <div className="row-between baseline">
          <h3 className="section-title">{t('conclusion.whoPaysWhom')}</h3>
          {transfers.length > 0 && <span className="muted small">{t('conclusion.paymentsCount', { count: transfers.length })}</span>}
        </div>
        {transfers.length === 0 ? (
          <div className="settled-empty">
            <span className="stamp stamp-rect" aria-hidden>
              {t('balance.settled')}
            </span>
            <p>{t('conclusion.allSettled')}</p>
          </div>
        ) : (
          <>
            {mine.map((tr) => (
              <button
                key={`${tr.currency}:${tr.from}:${tr.to}`}
                type="button"
                className="card pay-card"
                disabled={!canPay}
                onClick={() => setPaying(tr)}
              >
                <span className="eyebrow">{t('conclusion.yourPayment')}</span>
                <span className="sr-only">{t('conclusion.pays', { from: name(tr.from), to: name(tr.to) })}</span>
                <span className="pay-people" aria-hidden>
                  {person(tr.from, 30)}
                  <Icon name="arrowRight" size={18} />
                  {person(tr.to, 30)}
                </span>
                <span className="row-between">
                  <span className="pay-amount">{amountOf(tr)}</span>
                  {canPay && <span className="btn btn-primary pseudo-btn">{t('markPaid.button')}</span>}
                </span>
              </button>
            ))}
            {others.length > 0 && (
              <ul className="ledger">
                {others.map((tr) => (
                  <li key={`${tr.currency}:${tr.from}:${tr.to}`}>
                    <button type="button" className="transfer-row" disabled={!canPay} onClick={() => setPaying(tr)}>
                      <span className="transfer-main">
                        <span className="sr-only">{t('conclusion.pays', { from: name(tr.from), to: name(tr.to) })}</span>
                        <span className="pay-people small-people" aria-hidden>
                          {person(tr.from)}
                          <Icon name="arrowRight" size={15} />
                          {person(tr.to)}
                        </span>
                        <span className="transfer-sum">{amountOf(tr)}</span>
                      </span>
                      {canPay && <span className="btn pseudo-btn">{t('markPaid.button')}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {view === 'hkd' && hkd.dustDropped > 0 && <p className="muted small">{t('conclusion.dust')}</p>}
        {view === 'hkd' && rates.date && <p className="muted small">{t('conclusion.ratesAsOf', { date: fmt.dayMonth(rates.date) })}</p>}
        <p className="muted small">{t('conclusion.suggestedNote')}</p>
      </section>

      <section>
        <div className="row-between baseline">
          <h3 className="section-title">{t('conclusion.balances')}</h3>
          <span className="muted small">{t('conclusion.balancesHint')}</span>
        </div>
        <ul className="ledger balances">
          {members.map((m) => {
            if (view === 'hkd') {
              const v = hkd.balances.get(m.id) ?? ZERO
              return (
                <li key={m.id} className="balance-row">
                  <span className="row-between baseline">
                    <span className={m.id === me?.id ? 'strong' : ''}>
                      {name(m.id)}
                      {m.removed_at && <span className="badge badge-muted">{t('members.left')}</span>}
                    </span>
                    <strong className={v.isZero() ? '' : v.isPositive() ? 'pos' : 'neg'}>{fmt.signed(v, HKD)}</strong>
                  </span>
                  <span className="diverge" aria-hidden>
                    <span className="diverge-axis" />
                    {!v.isZero() && (
                      <span
                        className={`diverge-bar ${v.isPositive() ? 'right' : 'left'}`}
                        style={{ width: `${pct(v, hkdMax) / 2}%` }}
                      />
                    )}
                  </span>
                </li>
              )
            }
            const parts = currencies.map((c) => ({ c, v: netOf(nets, m.id, c) })).filter((x) => !x.v.isZero())
            return (
              <li key={m.id} className="balance-row row-between">
                <span className={m.id === me?.id ? 'strong' : ''}>{name(m.id)}</span>
                <span className="balance-stack">
                  {parts.length === 0 ? (
                    <strong>{fmt.money(ZERO, HKD)}</strong>
                  ) : (
                    parts.map(({ c, v }) => (
                      <strong key={c} className={v.isPositive() ? 'pos' : 'neg'}>
                        {fmt.signed(v, c)}
                      </strong>
                    ))
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      {settlements.length > 0 && (
        <section>
          <h3 className="section-title list-heading">{t('conclusion.recorded')}</h3>
          <ul className="ledger">
            {[...settlements]
              .sort((a, b) => b.paid_at.localeCompare(a.paid_at))
              .map((s) => (
                <li key={s.id} className="repayment-row">
                  <span className="stamp stamp-round" aria-hidden>
                    {t('conclusion.stampPaid')}
                  </span>
                  <span className="list-main">
                    <span>
                      {t('conclusion.paidLine', {
                        from: memberName(s.from_member),
                        to: memberName(s.to_member),
                        amount: fmt.money(s.debt_amount, s.debt_currency),
                      })}
                    </span>
                    <span className="muted small">
                      {s.paid_currency !== s.debt_currency && `${t('conclusion.paidAs', { amount: fmt.money(s.paid_amount, s.paid_currency) })} · `}
                      {fmt.timestamp(s.paid_at)}
                    </span>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="card stats">
        <div className="stack-xs">
          <h3 className="section-title">{t('conclusion.stats')}</h3>
          <span className="muted small">{t('overview.tripSpending')}</span>
          <strong className="stat-big">{money(stats.totalSpendingHkd)}</strong>
          <span className="muted small">{t('conclusion.spendingNote')}</span>
          {stats.missingHkd > 0 && <span className="muted small">{t('stats.missingHkd', { count: stats.missingHkd })}</span>}
        </div>

        <div className="stack-s">
          <h4 className="stat-title">{t('conclusion.byCategory')}</h4>
          <BarList
            format={money}
            items={CATEGORIES.filter((c) => stats.byCategory.get(c)?.gt(0)).map((c) => ({
              key: c,
              label: (
                <span className="with-icon">
                  <Icon name={categoryIcon(c)} size={16} />
                  {categoryLabel(t, c)}
                </span>
              ),
              value: stats.byCategory.get(c)!,
            }))}
          />
        </div>

        {dayMax.gt(0) && (
          <div className="stack-s">
            <h4 className="stat-title">
              {t('conclusion.byDay')} <span className="muted">· HK$</span>
            </h4>
            {dayValues.length <= MAX_COLUMNS ? (
              <ol className="day-columns" style={{ gridTemplateColumns: `repeat(${dayValues.length}, minmax(0, 1fr))` }}>
                {dayValues.map((d) => (
                  <li key={d.key} aria-label={`${labels.short(d.key)}: ${money(d.value)}`}>
                    <span className={`day-col-value${d.value.isZero() ? ' muted' : ''}`} aria-hidden>
                      {fmt.hkdWhole(d.value)}
                    </span>
                    <span className="day-col-track" aria-hidden>
                      {d.value.gt(0) && <span className="day-col-fill" style={{ height: `${pct(d.value, dayMax)}%` }} />}
                    </span>
                    <span className="day-col-label" aria-hidden>
                      {shortDay(d.key)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <BarList
                format={money}
                items={dayValues.filter((d) => d.value.gt(0)).map((d) => ({ key: d.key, label: labels.short(d.key), value: d.value }))}
              />
            )}
          </div>
        )}

        <div className="stack-s">
          <h4 className="stat-title">{t('conclusion.byCurrency')}</h4>
          <ul className="ledger compact">
            {[...stats.byCurrency].map(([cur, v]) => (
              <li key={cur} className="row-between">
                <span>{fmt.money(v.amount, cur)}</span>
                <span className="muted">{money(v.hkd)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="stack-s">
          <h4 className="stat-title">
            {t('conclusion.perPerson')} <span className="muted">· HK$</span>
          </h4>
          <table className="stat-table">
            <thead>
              <tr>
                <th scope="col">{t('conclusion.member')}</th>
                <th scope="col">{t('conclusion.paid')}</th>
                <th scope="col">{t('conclusion.share')}</th>
                <th scope="col">{t('conclusion.personal')}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const s = stats.perMember.get(m.id)
                return (
                  <tr key={m.id}>
                    <th scope="row" className={m.id === me?.id ? 'strong' : ''}>
                      {name(m.id)}
                    </th>
                    <td>{fmt.number(s?.paidHkd ?? ZERO, HKD)}</td>
                    <td>{fmt.number(s?.shareHkd ?? ZERO, HKD)}</td>
                    <td>{fmt.number(s?.personalSpendingHkd ?? ZERO, HKD)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="muted small">{t('conclusion.perPersonNote')}</p>
        </div>
      </section>

      {paying && <MarkPaidDialog transfer={paying} view={view} onClose={() => setPaying(null)} />}
    </div>
  )
}
