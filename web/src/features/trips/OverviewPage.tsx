import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { copyText, shareOrCopy } from '../../app/share'
import { useFmt } from '../../app/useFmt'
import { useToast } from '../../app/ui/toast'
import { Avatar, Banner } from '../../app/ui/common'
import { Icon } from '../../app/ui/Icon'
import { eachDate, todayIn, tripProgress } from '../../lib/dates'
import { readableRate } from '../../lib/fx'
import { HKD, ZERO } from '../../lib/money'
import { hkdNets } from '../../lib/settlement'
import { computeStats } from '../settlement/stats'
import { useTripData } from './TripDataContext'
import { WeatherBadge } from './WeatherBadge'
import { durationText } from './tripText'
import { useTripWeather } from './useTripWeather'

/** Above this many days the day-by-day segments get too thin: show one bar. */
const MAX_SEGMENTS = 21

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
  const myBalance = me && !balances.missingRates.length ? (balances.balances.get(me.id) ?? ZERO) : null
  const dates = eachDate(trip.start_date, trip.end_date)
  const currentDay = progress.kind === 'during' ? progress.day : progress.kind === 'after' ? dates.length + 1 : 0

  // One rate line per foreign currency on the trip.
  const currencies = [...new Set(dates.map((d) => dayByDate.get(d)?.currency ?? HKD))].filter((c) => c !== HKD)

  const inviteUrl = invite?.invite_token ? `${window.location.origin}/join/${invite.invite_token}` : null
  const activeMembers = members.map((m, i) => ({ m, i })).filter(({ m }) => !m.removed_at)

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
    <div className="page-inner overview">
      <section className="hero">
        <p className="eyebrow">
          {fmt.range(trip.start_date, trip.end_date)} · {durationText(t, trip.start_date, trip.end_date)}
        </p>
        <h2 className="hero-title">{trip.name}</h2>
        <div className="progress-row">
          {dates.length <= MAX_SEGMENTS ? (
            <span className="progress-segments" aria-hidden style={{ gridTemplateColumns: `repeat(${dates.length}, minmax(0, 1fr))` }}>
              {dates.map((d, i) => (
                <span key={d} className={i + 1 < currentDay ? 'done' : i + 1 === currentDay ? 'now' : ''} />
              ))}
            </span>
          ) : (
            <span className="progress-bar" aria-hidden>
              <span style={{ width: `${Math.min(100, (Math.max(0, currentDay - 1) / dates.length) * 100)}%` }} />
            </span>
          )}
          <span className="progress-text">
            {progress.kind === 'before' && t('overview.startsIn', { count: progress.daysUntil })}
            {progress.kind === 'during' && t('overview.dayOf', { day: progress.day, total: progress.total })}
            {progress.kind === 'after' && t('overview.ended')}
          </span>
        </div>
      </section>

      {locked && (
        <Banner tone="lock">
          <Icon name="lock" size={16} /> {t('lock.banner')}
        </Banner>
      )}

      <section className="card totals" aria-label={t('overview.myBalance')}>
        <div className="row-between">
          <span className="muted small-strong">{t('overview.myBalance')}</span>
          <Link to={`/trips/${trip.id}/conclusion`} className="text-link">
            {t('pages.conclusion')}
            <Icon name="chevronRight" size={18} />
          </Link>
        </div>
        {myBalance === null ? (
          <p className="balance-big">—</p>
        ) : myBalance.isZero() ? (
          <p className="balance-big">{t('balance.settled')}</p>
        ) : (
          <div className={myBalance.isPositive() ? 'pos' : 'neg'}>
            <p className="balance-words">{myBalance.isPositive() ? t('overview.youAreOwedLabel') : t('overview.youOweLabel')}</p>
            <p className="balance-big">{fmt.money(myBalance.abs(), HKD)}</p>
          </div>
        )}
        <div className="totals-grid">
          <div>
            <span className="muted small">{t('overview.tripSpending')}</span>
            <strong>{fmt.money(stats.totalSpendingHkd, HKD)}</strong>
          </div>
          <div>
            <span className="muted small">{t('overview.myShare')}</span>
            <strong>{myStats ? fmt.money(myStats.spendingShareHkd, HKD) : '—'}</strong>
          </div>
        </div>
        {stats.missingHkd > 0 && <p className="muted small">{t('stats.missingHkd', { count: stats.missingHkd })}</p>}
      </section>

      <section>
        <h3 className="section-title list-heading">{t('overview.days')}</h3>
        <ul className="itinerary">
          {dates.map((date, i) => {
            const day = dayByDate.get(date)
            const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
            const isToday = todayIn(tzForDate(date)) === date
            return (
              <li key={date}>
                <Link to={`/trips/${trip.id}/${date}`} className="itinerary-row">
                  <span className="date-block" aria-label={`${t('pages.day', { n: i + 1 })}, ${fmt.weekday(date)} ${fmt.dayMonth(date)}`}>
                    <span className={`tab-wd${wd === 6 ? ' wd-sat' : wd === 0 ? ' wd-sun' : ''}`} aria-hidden>
                      {fmt.weekday(date)}
                    </span>
                    <span className="date-num" aria-hidden>
                      {Number(date.slice(8))}
                    </span>
                  </span>
                  <span className="itinerary-place">
                    <span className="itinerary-city">
                      {day?.location_name ?? t('location.notSet')}
                      {isToday && <span className="badge badge-accent">{t('expense.today')}</span>}
                    </span>
                    <span className="muted small">{day?.currency ?? HKD}</span>
                  </span>
                  <WeatherBadge weather={weather?.get(date)} layout="stack" />
                  <span className="chev">
                    <Icon name="chevronRight" size={18} />
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
        <p className="muted small rate-line">
          {currencies.map((cur) => {
            const rate = rateFor(cur)
            const rr = rate ? readableRate(cur, rate) : null
            return (
              <span key={cur}>
                {rr ? `${fmt.money(rr.unitsMinor, cur)} ≈ ${fmt.money(rr.hkdCents, HKD)}` : `${cur} · ${t('fx.noRate')}`}
                {' · '}
              </span>
            )
          })}
          {data.rates.date && t('fx.asOf', { date: fmt.dayMonth(data.rates.date) })}
        </p>
      </section>

      <section>
        <div className="row-between">
          <h3 className="section-title">{t('overview.members', { count: activeMembers.length })}</h3>
          <Link to={`/trips/${trip.id}/members`} className="text-link">
            {t('app.manage')}
          </Link>
        </div>
        <ul className="member-chips">
          {activeMembers.map(({ m, i }) => (
            <li key={m.id} className={`member-chip${m.user_id ? '' : ' placeholder'}`}>
              <Avatar name={m.display_name} index={i} placeholder={!m.user_id} />
              <span className="member-chip-name">{m.display_name}</span>
              {m.id === me?.id && <span className="muted small">{t('app.you')}</span>}
              {!m.user_id && <span className="muted small">{t('members.placeholder')}</span>}
              {m.user_id && m.role === 'owner' && m.id !== me?.id && (
                <span className="muted small">{t('members.roles.owner')}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="card invite">
        <h3 className="card-title">{t('overview.invite')}</h3>
        {!trip.joining_enabled && <p className="muted">{t('overview.joiningOff')}</p>}
        {isAdmin && inviteUrl ? (
          <div className="stack">
            {invite?.invite_code && (
              <div className="invite-code-box">
                <span className="eyebrow">{t('join.code')}</span>
                <span className="invite-code">{invite.invite_code}</span>
              </div>
            )}
            <button type="button" className="btn btn-primary btn-block" onClick={() => void share()}>
              <Icon name="share" size={20} /> {t('app.share')}
            </button>
            <div className="two-col">
              <button type="button" className="btn" onClick={() => void copy(inviteUrl)}>
                <Icon name="copy" size={18} /> {t('overview.copyLink')}
              </button>
              {invite?.invite_code && (
                <button type="button" className="btn" onClick={() => void copy(invite.invite_code!)}>
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
