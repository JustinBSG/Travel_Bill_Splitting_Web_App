import { createContext, useContext } from 'react'
import type { PageKey } from '../../lib/dates'
import type { RateTable } from '../../lib/fx'
import type { Nets, RateLookup } from '../../lib/settlement'
import type { Expense, ISODate, Settlement, Trip, TripDay, TripInvite, TripMember } from '../../lib/types'

export type ReloadScope = 'trip' | 'days' | 'members' | 'expenses' | 'settlements' | 'rates'

export interface TripData {
  trip: Trip
  invite: TripInvite | null
  days: TripDay[]
  dayByDate: Map<ISODate, TripDay>
  members: TripMember[]
  memberById: Map<string, TripMember>
  /** removed_at IS NULL — the default "To" list. */
  activeMembers: TripMember[]
  /** Non-deleted expenses with their server-computed participants. */
  expenses: Expense[]
  settlements: Settlement[]
  rates: RateTable
  rateFor: RateLookup
  nets: Nets
  me: TripMember | null
  isAdmin: boolean
  isOwner: boolean
  locked: boolean
  pages: PageKey[]
  tzForDate: (d: ISODate) => string
  currencyForDate: (d: ISODate) => string
  memberName: (id: string | null | undefined) => string
  reload: (scopes?: ReloadScope[]) => Promise<void>
}

export const TripDataContext = createContext<TripData | null>(null)

export function useTripData(): TripData {
  const v = useContext(TripDataContext)
  if (!v) throw new Error('useTripData outside TripDataProvider')
  return v
}
