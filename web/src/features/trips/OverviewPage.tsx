import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { copyText, shareOrCopy } from '../../app/share'
import { useFmt } from '../../app/useFmt'
import { useToast } from '../../app/ui/toast'
import { Banner } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { eachDate, tripProgress } from '../../lib/dates'
import { readableRate } from '../../lib/fx'
import { HKD, ZERO } from '../../lib/money'
import { hkdNets } from '../../lib/settlement'
import { computeStats } from '../settlement/stats'
import { useTripData } from './TripDataContext'
import { WeatherBadge } from './WeatherBadge'
import { durationText } from './tripText'
import { useTripWeather } from './useTripWeather'

export function OverviewPage() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const toast = useToast()
  const data = useTripData()
  const { trip, days, dayByDate, members, me, invite, isAdmin, locked, expenses, nets, rateFor, tzForDate } = data
  const weather = useTripWeather(days)

  const progress = tripProgress(trip, tzForDate)
  const stats = useMemo(() => computeStats(expenses, members.map((m) => m.id), trip), [expenses, members, trip])
  const balances = useMemo(() => hkdNets(nets, rateFor), [nets, rateFor])
  const myStats = me ? stats.perMember.get(me.id) : undefined
  const myBalance = me ? (balances.balances.get(me.id) ?? ZERO) : null

  const inviteUrl = invite?.invite_token ? `${window.location.origin}/join/${invite.invite_token}` : null

  async function share() {
    if (!inviteUrl) return
    const res = await shareOrCopy({
      title: trip.name,
      text: t('overview.inviteText', { trip: trip.name, code: invite?.invite_code ?? '' }),
      url: inviteUrl,
    })
    if (res === 'copied') toast.show(t('app.copied'))
  }

  async function copy(text: string) {
    toast.show((await copyText(text)) ? t('app.copied') : t('app.copyFailed'))
  }

  return (
    <div className="page-inner">
      <section className="card hero">
        <h2>{trip.name}</h2>
        <p className="muted">
          {fmt.range(trip.start_date, trip.end_date)} · {durationText(t, trip.start_date, trip.end_date)}
        </p>
        <p className="progress">
          {progress.kind === 'before' && t('overview.startsIn', { count: progress.daysUntil })}
          {progress.kind === 'during' && t('overview.dayOf', { day: progress.day, total: progress.total })}
          {progress.kind === 'after' && t('overview.ended')}
        </p>
      </section>

      {locked && (
        <Banner tone="lock">
          <Icon name="lock" size={16} /> {t('lock.banner')}
        </Banner>
      )}

      <section className="tiles">
        <div className="tile">
          <span className="tile-label">{t('overview.tripSpending')}</span>
          <strong>{fmt.money(stats.totalSpendingHkd, HKD)}</strong>
        </div>
        <div className="tile">
          <span className="tile-label">{t('overview.myShare')}</span>
          <strong>{myStats ? fmt.money(myStats.spendingShareHkd, HKD) : '—'}</strong>
        </div>
        <div className="tile">
          <span className="tile-label">{t('overview.myBalance')}</span>
          <strong className={myBalance && !myBalance.isZero() ? (myBalance.isPositive() ? 'pos' : 'neg') : ''}>
            {myBalance && !balances.missingRates.length ? fmt.signed(myBalance, HKD) : '—'}
          </strong>
        </div>
      </section>
      {stats.missingHkd > 0 && <p className="muted small">{t('stats.missingHkd', { count: stats.missingHkd })}</p>}

      <section>
        <h3 className="section-title">{t('overview.days')}</h3>
        <ul className="list">
          {eachDate(trip.start_date, trip.end_date).map((date, i) => {
            const day = dayByDate.get(date)
            const cur = day?.currency ?? HKD
            const rate = rateFor(cur)
            const rr = rate && cur !== HKD ? readableRate(cur, rate) : null
            return (
              <li key={date} className="list-row">
                <div className="list-main">
                  <Link to={`/trips/${trip.id}/${date}`} className="strong-link">
                    {t('pages.day', { n: i + 1 })} · {fmt.weekday(date)} {fmt.dayMonth(date)}
                  </Link>
                  <span>
                    📍 {day?.location_name ?? t('location.notSet')}
                  </span>
                  <WeatherBadge weather={weather?.get(date)} />
                  <span className="muted small">
                    {cur}
                    {rr && ` · ${fmt.money(rr.unitsMinor, cur)} ≈ ${fmt.money(rr.hkdCents, HKD)}`}
                    {!rate && cur !== HKD && ` · ${t('fx.noRate')}`}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
        {data.rates.date && <p className="muted small">{t('fx.asOf', { date: fmt.dayMonth(data.rates.date) })}</p>}
      </section>

      <section>
        <div className="row-between">
          <h3 className="section-title">{t('overview.members', { count: members.filter((m) => !m.removed_at).length })}</h3>
          <Link to={`/trips/${trip.id}/members`} className="btn-link">
            {t('app.manage')}
          </Link>
        </div>
        <ul className="member-chips">
          {members
            .filter((m) => !m.removed_at)
            .map((m) => (
              <li key={m.id} className="chip">
                {m.display_name}
                {m.id === me?.id && ` (${t('app.you')})`}
                {!m.user_id && <span className="badge badge-muted">{t('members.placeholder')}</span>}
              </li>
            ))}
        </ul>
      </section>

      <section className="card">
        <h3 className="section-title">{t('overview.invite')}</h3>
        {!trip.joining_enabled && <p className="muted">{t('overview.joiningOff')}</p>}
        {isAdmin && inviteUrl ? (
          <div className="stack">
            <div className="invite-code" aria-label={t('join.code')}>
              {invite?.invite_code}
            </div>
            <div className="row-gap">
              <button type="button" className="btn btn-primary grow" onClick={() => void share()}>
                <Icon name="share" size={18} /> {t('app.share')}
              </button>
              <button type="button" className="btn grow" onClick={() => void copy(inviteUrl)}>
                <Icon name="copy" size={18} /> {t('overview.copyLink')}
              </button>
              {invite?.invite_code && (
                <button type="button" className="btn grow" onClick={() => void copy(invite.invite_code!)}>
                  {t('overview.copyCode')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="muted">{t('overview.askAdmin')}</p>
        )}
      </section>
    </div>
  )
}
