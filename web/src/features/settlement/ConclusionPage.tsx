import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { Banner } from '../../app/ui/common'
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

function BarList({ items, format }: { items: { key: string; label: ReactNode; value: Decimal }[]; format: (v: Decimal) => string }) {
  const max = items.reduce((m, i) => (i.value.gt(m) ? i.value : m), ZERO)
  if (items.length === 0) return null
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.key} className="bar-row">
          <span className="bar-label">{i.label}</span>
          <span className="bar-track" aria-hidden>
            {/* width is presentation only, not money math */}
            <span className="bar-fill" style={{ width: `${max.isZero() ? 0 : i.value.div(max).times(100).toNumber()}%` }} />
          </span>
          <span className="bar-value">{format(i.value)}</span>
        </li>
      ))}
    </ul>
  )
}

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
  const money = (v: Decimal) => fmt.money(v, HKD)

  const name = (id: string) => (id === me?.id ? `${memberName(id)} (${t('app.you')})` : memberName(id))

  return (
    <div className="page-inner">
      {locked && (
        <Banner tone="lock">
          <Icon name="lock" size={16} /> {t('lock.conclusionFinal')}
        </Banner>
      )}

      {/* 1. Stats */}
      <section className="card">
        <h2>{t('conclusion.stats')}</h2>
        <div className="tile tile-wide">
          <span className="tile-label">{t('overview.tripSpending')}</span>
          <strong className="big">{money(stats.totalSpendingHkd)}</strong>
          <span className="muted small">{t('conclusion.spendingNote')}</span>
        </div>
        {stats.missingHkd > 0 && <p className="muted small">{t('stats.missingHkd', { count: stats.missingHkd })}</p>}

        <h3 className="section-title">{t('conclusion.byCategory')}</h3>
        <BarList
          format={money}
          items={CATEGORIES.filter((c) => stats.byCategory.get(c)?.gt(0)).map((c) => ({
            key: c,
            label: `${categoryIcon(c)} ${categoryLabel(t, c)}`,
            value: stats.byCategory.get(c)!,
          }))}
        />

        <h3 className="section-title">{t('conclusion.byDay')}</h3>
        <BarList
          format={money}
          items={pages
            .filter((p) => p !== 'overview' && p !== 'conclusion' && stats.byPage.get(p)?.gt(0))
            .map((p) => ({ key: p, label: labels.short(p), value: stats.byPage.get(p)! }))}
        />

        <h3 className="section-title">{t('conclusion.byCurrency')}</h3>
        <ul className="list compact">
          {[...stats.byCurrency].map(([cur, v]) => (
            <li key={cur} className="list-row">
              <span>{fmt.money(v.amount, cur)}</span>
              <span className="muted">{money(v.hkd)}</span>
            </li>
          ))}
        </ul>

        <h3 className="section-title">{t('conclusion.perPerson')}</h3>
        <ul className="list compact">
          {members.map((m) => {
            const s = stats.perMember.get(m.id)
            const bal = hkd.balances.get(m.id) ?? ZERO
            return (
              <li key={m.id} className="list-row">
                <span className="list-main">
                  <span>
                    {name(m.id)}
                    {m.removed_at && <span className="badge badge-muted">{t('members.left')}</span>}
                  </span>
                  <span className="muted small">
                    {t('conclusion.paid')} {money(s?.paidHkd ?? ZERO)} · {t('conclusion.share')} {money(s?.shareHkd ?? ZERO)}
                  </span>
                </span>
                <strong className={bal.isZero() ? '' : bal.isPositive() ? 'pos' : 'neg'}>{fmt.signed(bal, HKD)}</strong>
              </li>
            )
          })}
        </ul>
        <p className="muted small">{t('conclusion.perPersonNote')}</p>

        <h3 className="section-title">{t('conclusion.personalSpending')}</h3>
        <BarList
          format={money}
          items={members
            .filter((m) => stats.perMember.get(m.id)?.personalSpendingHkd.gt(0))
            .map((m) => ({ key: m.id, label: name(m.id), value: stats.perMember.get(m.id)!.personalSpendingHkd }))}
        />
      </section>

      {/* 2 + 3. Balances and who pays whom */}
      <section className="card">
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

        {integrity.length > 0 && <Banner tone="error">{t('conclusion.integrity', { count: integrity.length })}</Banner>}
        {view === 'hkd' && hkd.missingRates.length > 0 && (
          <Banner tone="warn">{t('conclusion.missingRates', { currencies: hkd.missingRates.join(', ') })}</Banner>
        )}

        <h2>{t('conclusion.balances')}</h2>
        <p className="muted small">{t('conclusion.balancesHint')}</p>
        <ul className="list">
          {members.map((m) => {
            if (view === 'hkd') {
              const v = hkd.balances.get(m.id) ?? ZERO
              return (
                <li key={m.id} className="list-row">
                  <span>{name(m.id)}</span>
                  <strong className={v.isZero() ? '' : v.isPositive() ? 'pos' : 'neg'}>{fmt.signed(v, HKD)}</strong>
                </li>
              )
            }
            const parts = currencies.map((c) => ({ c, v: netOf(nets, m.id, c) })).filter((x) => !x.v.isZero())
            return (
              <li key={m.id} className="list-row">
                <span>{name(m.id)}</span>
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
        {view === 'hkd' && rates.date && (
          <p className="muted small">{t('conclusion.ratesAsOf', { date: fmt.dayMonth(rates.date) })}</p>
        )}

        <h2>{t('conclusion.whoPaysWhom')}</h2>
        {transfers.length === 0 ? (
          <p className="empty">{t('conclusion.allSettled')}</p>
        ) : (
          <ul className="list">
            {transfers.map((tr) => {
              const rate = tr.currency !== HKD ? rateFor(tr.currency) : null
              return (
                <li key={`${tr.currency}:${tr.from}:${tr.to}`}>
                  <button
                    type="button"
                    className="list-row list-button transfer"
                    disabled={locked || !me}
                    onClick={() => setPaying(tr)}
                  >
                    <span className="list-main">
                      <span>{t('conclusion.pays', { from: name(tr.from), to: name(tr.to) })}</span>
                      <strong>
                        {fmt.money(tr.amount, tr.currency)}
                        {rate && (
                          <span className="muted small">
                            {' '}
                            {t('conclusion.about', { amount: fmt.money(toHkdCents(tr.amount, tr.currency, rate), HKD) })}
                          </span>
                        )}
                      </strong>
                    </span>
                    {!locked && <span className="btn btn-small">{t('markPaid.button')}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {view === 'hkd' && hkd.dustDropped > 0 && <p className="muted small">{t('conclusion.dust')}</p>}
        <p className="muted small">{t('conclusion.suggestedNote')}</p>
      </section>

      {settlements.length > 0 && (
        <section className="card">
          <h2>{t('conclusion.recorded')}</h2>
          <ul className="list compact">
            {[...settlements]
              .sort((a, b) => b.paid_at.localeCompare(a.paid_at))
              .map((s) => (
                <li key={s.id} className="list-row">
                  <span className="list-main">
                    <span>
                      {t('conclusion.paidLine', {
                        from: memberName(s.from_member),
                        to: memberName(s.to_member),
                        amount: fmt.money(s.debt_amount, s.debt_currency),
                      })}
                    </span>
                    {s.paid_currency !== s.debt_currency && (
                      <span className="muted small">
                        {t('conclusion.paidAs', { amount: fmt.money(s.paid_amount, s.paid_currency) })}
                      </span>
                    )}
                  </span>
                  <span className="muted small">{fmt.timestamp(s.paid_at)}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {paying && <MarkPaidDialog transfer={paying} view={view} onClose={() => setPaying(null)} />}
    </div>
  )
}
