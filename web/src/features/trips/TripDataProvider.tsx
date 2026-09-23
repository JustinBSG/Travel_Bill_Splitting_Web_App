import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useParams } from 'react-router'
import { useToast } from '../../app/ui/toast'
import { ErrorBox, FullPageSpinner } from '../../app/ui/common'
import { HOME_TZ, tripPageKeys } from '../../lib/dates'
import { rateToHkd, type RateTable } from '../../lib/fx'
import { HKD } from '../../lib/money'
import { computeNets } from '../../lib/settlement'
import { supabase } from '../../lib/supabase'
import type { Expense, Settlement, Trip, TripDay, TripInvite, TripMember } from '../../lib/types'
import { useUser } from '../auth/AuthContext'
import { fetchLatestRates } from './ratesApi'
import { TripDataContext, type ReloadScope, type TripData } from './TripDataContext'
import { fetchDays, fetchExpenses, fetchInvite, fetchMembers, fetchSettlements, fetchTrip } from './tripApi'

interface Raw {
  trip: Trip
  invite: TripInvite | null
  days: TripDay[]
  members: TripMember[]
  expenses: Expense[]
  settlements: Settlement[]
  rates: RateTable
}

type Parts = { [K in keyof Raw]?: Raw[K] } & { tripMissing?: boolean }

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'notfound' } | { status: 'ready'; raw: Raw }

const ALL: ReloadScope[] = ['trip', 'days', 'members', 'expenses', 'settlements', 'rates']

function isAdminOf(members: TripMember[], userId: string) {
  const me = members.find((m) => m.user_id === userId && !m.removed_at)
  return me?.role === 'owner' || me?.role === 'admin'
}

/** Fetch the requested tables in parallel (one round trip each). */
async function fetchParts(tripId: string, userId: string, scopes: ReloadScope[]): Promise<Parts> {
  const want = new Set(scopes)
  if (want.has('trip')) want.add('members') // needed to decide whether invite secrets are readable
  const [trip, days, members, expenses, settlements, rates] = await Promise.all([
    want.has('trip') ? fetchTrip(tripId) : undefined,
    want.has('days') ? fetchDays(tripId) : undefined,
    want.has('members') ? fetchMembers(tripId) : undefined,
    want.has('expenses') ? fetchExpenses(tripId) : undefined,
    want.has('settlements') ? fetchSettlements(tripId) : undefined,
    want.has('rates') ? fetchLatestRates(scopes !== ALL) : undefined,
  ])
  if (trip === null) return { tripMissing: true }
  const parts: Parts = { days, members, expenses, settlements, rates }
  if (trip) parts.trip = trip
  if (members) parts.invite = isAdminOf(members, userId) ? await fetchInvite(tripId) : null
  return parts
}

function merge(prev: State, parts: Parts): State {
  if (parts.tripMissing) return { status: 'notfound' }
  const defined = Object.fromEntries(Object.entries(parts).filter(([, v]) => v !== undefined)) as Parts
  if (prev.status === 'ready') return { status: 'ready', raw: { ...prev.raw, ...defined } }
  const { trip, days, members, expenses, settlements, rates } = defined
  if (trip && days && members && expenses && settlements && rates) {
    return { status: 'ready', raw: { trip, days, members, expenses, settlements, rates, invite: defined.invite ?? null } }
  }
  return prev
}

/** Route element for /trips/:tripId/*. Remounted per trip (see App routes). */
export function TripDataProvider() {
  const { tripId = '' } = useParams()
  const user = useUser()
  const { t } = useTranslation()
  const toast = useToast()
  const [state, setState] = useState<State>({ status: 'loading' })
  const raw = state.status === 'ready' ? state.raw : null

  const reload = useCallback(
    async (scopes: ReloadScope[] = ALL) => {
      try {
        const parts = await fetchParts(tripId, user.id, scopes)
        setState((prev) => merge(prev, parts))
      } catch {
        toast.show(t('trip.refreshFailed'), { tone: 'error' })
      }
    },
    [tripId, user.id, toast, t],
  )

  const retry = useCallback(() => {
    setState({ status: 'loading' })
    fetchParts(tripId, user.id, ALL).then(
      (parts) => setState((prev) => merge(prev, parts)),
      (e) => setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
  }, [tripId, user.id])

  // Initial load.
  useEffect(() => {
    let alive = true
    fetchParts(tripId, user.id, ALL).then(
      (parts) => alive && setState((prev) => merge(prev, parts)),
      (e) => alive && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      alive = false
    }
  }, [tripId, user.id])

  // Known expense ids, for filtering expense_participants realtime events.
  const expenseIds = useRef(new Set<string>())
  useEffect(() => {
    expenseIds.current = new Set(raw?.expenses.map((e) => e.id) ?? [])
  }, [raw])

  // Realtime: debounce bursts of change events into one scoped reload.
  const pending = useRef(new Set<ReloadScope>())
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const schedule = (scope: ReloadScope) => {
      pending.current.add(scope)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        const scopes = [...pending.current]
        pending.current.clear()
        void reload(scopes)
      }, 300)
    }
    const byTrip = `trip_id=eq.${tripId}`
    const channel = supabase
      .channel(`trip-${tripId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: byTrip }, (payload) => {
        // Soft delete arrives as UPDATE deleted_at: drop it from the list at once.
        const row = payload.new as Partial<Expense> | undefined
        if (payload.eventType === 'UPDATE' && row?.deleted_at) {
          setState((prev) =>
            prev.status === 'ready'
              ? { status: 'ready', raw: { ...prev.raw, expenses: prev.raw.expenses.filter((e) => e.id !== row.id) } }
              : prev,
          )
        }
        schedule('expenses')
      })
      // expense_participants has no trip_id; RLS limits what we receive.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expense_participants' }, (payload) => {
        const row = (payload.new ?? payload.old) as { expense_id?: string } | undefined
        if (!row?.expense_id || expenseIds.current.has(row.expense_id)) schedule('expenses')
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements', filter: byTrip }, () =>
        schedule('settlements'),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_members', filter: byTrip }, () =>
        schedule('members'),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trip_days', filter: byTrip }, () =>
        schedule('days'),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trips', filter: `id=eq.${tripId}` }, () => {
        schedule('trip')
        schedule('expenses') // date changes re-bucket expenses server-side
      })
      .subscribe()

    const onVisible = () => document.visibilityState === 'visible' && schedule('expenses')
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [tripId, reload])

  const data = useMemo<TripData | null>(() => {
    if (!raw) return null
    const dayByDate = new Map(raw.days.map((d) => [d.date, d]))
    const memberById = new Map(raw.members.map((m) => [m.id, m]))
    const me = raw.members.find((m) => m.user_id === user.id && !m.removed_at) ?? null
    const isOwner = me?.role === 'owner'
    return {
      ...raw,
      dayByDate,
      memberById,
      activeMembers: raw.members.filter((m) => !m.removed_at),
      rateFor: (c: string) => rateToHkd(raw.rates, c),
      nets: computeNets(raw.expenses, raw.settlements),
      me,
      isOwner,
      isAdmin: isOwner || me?.role === 'admin',
      locked: raw.trip.is_locked,
      pages: tripPageKeys(raw.trip),
      tzForDate: (d) => dayByDate.get(d)?.timezone || HOME_TZ,
      currencyForDate: (d) =>
        d >= raw.trip.start_date && d <= raw.trip.end_date ? dayByDate.get(d)?.currency || HKD : HKD,
      memberName: (id) => (id ? (memberById.get(id)?.display_name ?? '?') : '?'),
      reload,
    }
  }, [raw, user.id, reload])

  if (state.status === 'loading') return <FullPageSpinner />
  if (state.status === 'notfound') {
    return (
      <div className="full-page-center stack">
        <p>{t('trip.notFound')}</p>
        <Link className="btn" to="/trips">
          {t('app.goHome')}
        </Link>
      </div>
    )
  }
  if (state.status === 'error' || !data) {
    return (
      <div className="full-page-center stack">
        <ErrorBox message={state.status === 'error' ? state.message : t('app.error')} onRetry={retry} />
        <Link className="btn" to="/trips">
          {t('app.goHome')}
        </Link>
      </div>
    )
  }
  return (
    <TripDataContext.Provider value={data}>
      <Outlet />
    </TripDataContext.Provider>
  )
}
