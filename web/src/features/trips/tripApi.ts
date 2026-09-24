// Supabase reads/writes for trips, days and members.
import { rateToHkd, type RateTable } from '../../lib/fx'
import { ZERO, type Decimal } from '../../lib/money'
import { computeNets, hkdNets, type NetExpense, type NetSettlement } from '../../lib/settlement'
import { functionErrorMessage, rpc, supabase, unwrap } from '../../lib/supabase'
import type {
  Expense,
  ISODate,
  Settlement,
  Trip,
  TripDay,
  TripInvite,
  TripMember,
} from '../../lib/types'

// Explicit column lists keep payloads small and stable. Invite secrets are not
// on `trips` at all (backend table trip_invites, admin-only via get_trip_invite).
export const TRIP_COLUMNS =
  'id, name, start_date, end_date, base_currency, home_timezone, joining_enabled, is_locked, created_by, created_at, updated_at'
export const DAY_COLUMNS = 'trip_id, date, location_name, country_code, latitude, longitude, timezone, currency'
export const MEMBER_COLUMNS = 'id, trip_id, user_id, display_name, role, joined_at, removed_at'
export const EXPENSE_COLUMNS =
  'id, trip_id, title, category, amount, currency, paid_by, occurred_at, timezone, local_date, end_date, ' +
  'location_text, latitude, longitude, photo_path, note, fx_rate_to_hkd, fx_rate_date, amount_hkd, ' +
  'currency_manually_set, split_method, created_by, created_at, updated_at, deleted_at, ' +
  'expense_participants(member_id, share_amount)'
export const SETTLEMENT_COLUMNS =
  'id, trip_id, from_member, to_member, debt_currency, debt_amount, paid_currency, paid_amount, fx_rate, paid_at, created_by, idempotency_key'

export async function fetchTrip(tripId: string): Promise<Trip | null> {
  return unwrap(await supabase.from('trips').select(TRIP_COLUMNS).eq('id', tripId).maybeSingle()) as Trip | null
}

export async function fetchDays(tripId: string): Promise<TripDay[]> {
  return unwrap(await supabase.from('trip_days').select(DAY_COLUMNS).eq('trip_id', tripId).order('date')) as TripDay[]
}

export async function fetchMembers(tripId: string): Promise<TripMember[]> {
  return unwrap(
    await supabase.from('trip_members').select(MEMBER_COLUMNS).eq('trip_id', tripId).order('joined_at'),
  ) as TripMember[]
}

export async function fetchExpenses(tripId: string): Promise<Expense[]> {
  return unwrap(
    await supabase.from('expenses').select(EXPENSE_COLUMNS).eq('trip_id', tripId).is('deleted_at', null),
  ) as unknown as Expense[]
}

export async function fetchSettlements(tripId: string): Promise<Settlement[]> {
  return unwrap(
    await supabase.from('settlements').select(SETTLEMENT_COLUMNS).eq('trip_id', tripId).order('paid_at'),
  ) as Settlement[]
}

/** Admins only (POST /rpc/get_trip_invite); null for everyone else or on error. */
export async function fetchInvite(tripId: string): Promise<TripInvite | null> {
  const { data, error } = await supabase.rpc('get_trip_invite', { trip_id: tripId })
  if (error || !data) return null
  return data as TripInvite
}

// ---- My Trips ----------------------------------------------------------------

export interface MyTripSummary {
  trip: Trip
  me: TripMember
  /** My net in HKD cents at today's rate; null if it can't be computed honestly. */
  balanceHkd: Decimal | null
}

export async function fetchMyTrips(userId: string, rates: RateTable): Promise<MyTripSummary[]> {
  const memberships = unwrap(
    await supabase.from('trip_members').select(MEMBER_COLUMNS).eq('user_id', userId).is('removed_at', null),
  ) as TripMember[]
  if (memberships.length === 0) return []
  const ids = memberships.map((m) => m.trip_id)
  const [trips, expenses, settlements] = await Promise.all([
    supabase.from('trips').select(TRIP_COLUMNS).in('id', ids),
    supabase
      .from('expenses')
      .select('id, trip_id, paid_by, amount, currency, expense_participants(member_id, share_amount)')
      .in('trip_id', ids)
      .is('deleted_at', null),
    supabase.from('settlements').select('trip_id, from_member, to_member, debt_currency, debt_amount').in('trip_id', ids),
  ])
  const tripRows = unwrap(trips) as Trip[]
  const exp = (expenses.error ? null : expenses.data) as unknown as Array<NetExpense & { trip_id: string }> | null
  const set = (settlements.error ? null : settlements.data) as Array<NetSettlement & { trip_id: string }> | null
  const rateFor = (c: string) => rateToHkd(rates, c)

  return tripRows
    .map((trip) => {
      const me = memberships.find((m) => m.trip_id === trip.id)!
      let balanceHkd: Decimal | null = null
      if (exp && set) {
        const nets = computeNets(
          exp.filter((e) => e.trip_id === trip.id),
          set.filter((s) => s.trip_id === trip.id),
        )
        const res = hkdNets(nets, rateFor)
        balanceHkd = res.missingRates.length ? null : (res.balances.get(me.id) ?? ZERO)
      }
      return { trip, me, balanceHkd }
    })
    .sort((a, b) => b.trip.start_date.localeCompare(a.trip.start_date))
}

// ---- Create / settings ----------------------------------------------------------

export interface DayLocation {
  location_name: string
  country_code: string | null
  latitude: number | null
  longitude: number | null
  timezone: string
  currency: string
}

function dayRows(dates: ISODate[], days: Map<ISODate, DayLocation>) {
  return dates.map((date) => {
    const d = days.get(date)!
    return {
      date,
      location_name: d.location_name,
      country_code: d.country_code,
      latitude: d.latitude,
      longitude: d.longitude,
      timezone: d.timezone,
      currency: d.currency,
    }
  })
}

interface TripDetailsInput {
  name: string
  start_date: ISODate
  end_date: ISODate
  dates: ISODate[]
  days: Map<ISODate, DayLocation>
}

/**
 * One transaction on the server: trip, one trip_days row per date, the caller
 * as owner, and the invite. Returns the new trip id.
 */
export async function createTrip(input: TripDetailsInput): Promise<string> {
  const trip = await rpc<{ id: string }>('create_trip', {
    name: input.name,
    start_date: input.start_date,
    end_date: input.end_date,
    days: dayRows(input.dates, input.days),
  })
  return trip.id
}

/** Admin. The server makes trip_days match the new range; expenses keep their dates and rates. */
export async function saveTripSettings(tripId: string, input: TripDetailsInput): Promise<void> {
  await rpc('update_trip', {
    trip_id: tripId,
    name: input.name,
    start_date: input.start_date,
    end_date: input.end_date,
    days: dayRows(input.dates, input.days),
  })
}

export async function setJoiningEnabled(tripId: string, enabled: boolean) {
  unwrap(await supabase.from('trips').update({ joining_enabled: enabled }).eq('id', tripId))
}

/** Admin. Lock / unlock go through RPCs so the server can log and notify. */
export async function setTripLocked(tripId: string, locked: boolean) {
  await rpc(locked ? 'lock_trip' : 'unlock_trip', { trip_id: tripId })
}

/** Owner, trip unlocked. Also deletes the trip's photos. */
export async function deleteTrip(tripId: string) {
  await rpc('delete_trip', { trip_id: tripId })
}

export async function regenerateInvite(tripId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('regenerate_invite', { body: { trip_id: tripId } })
  if (error) throw new Error((await functionErrorMessage(error)).message)
}

// ---- Members ----------------------------------------------------------------------

export async function addPlaceholder(tripId: string, displayName: string) {
  unwrap(
    await supabase.from('trip_members').insert({ trip_id: tripId, user_id: null, display_name: displayName, role: 'member' }),
  )
}

export async function promoteToAdmin(memberId: string) {
  await rpc('set_member_role', { member_id: memberId, role: 'admin' })
}

/** Soft removal: their expenses and settlements stay; they show as "left the trip". */
export async function removeMember(memberId: string) {
  await rpc('remove_member', { member_id: memberId })
}
