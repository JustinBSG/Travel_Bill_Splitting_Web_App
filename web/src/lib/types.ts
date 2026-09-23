// Row shapes the UI reads/writes. Mirrors docs/frontend-agent-brief.txt §4.
// Integer money columns arrive from PostgREST as JSON numbers (or strings for
// bigint); they are only ever touched through lib/money.ts (decimal.js).

export type Id = string
/** Integer minor units as delivered by the API. Never do arithmetic on it directly. */
export type MinorRaw = number | string
/** Postgres numeric (FX rates) as delivered by the API. */
export type NumericRaw = number | string
/** 'YYYY-MM-DD' */
export type ISODate = string

export type Role = 'owner' | 'admin' | 'member'
export type Language = 'en' | 'zh-Hant'

export const CATEGORIES = [
  'Food & Drink',
  'Transport',
  'Accommodation',
  'Activities & Tickets',
  'Shopping',
  'Groceries',
  'Loan',
  'Other',
] as const
export type Category = (typeof CATEGORIES)[number]

export interface Profile {
  id: Id
  display_name: string | null
  language: Language | null
}

export interface Trip {
  id: Id
  name: string
  start_date: ISODate
  end_date: ISODate
  base_currency: string
  home_timezone: string
  joining_enabled: boolean
  is_locked: boolean
  created_by: Id | null
  created_at?: string
  updated_at?: string
}

/** Invite secrets are fetched separately; may be withheld from non-admins. */
export interface TripInvite {
  invite_token: string | null
  invite_code: string | null
}

export interface TripDay {
  trip_id: Id
  date: ISODate
  location_name: string | null
  country_code: string | null
  latitude: number | null
  longitude: number | null
  timezone: string | null
  currency: string | null
}

export interface TripMember {
  id: Id
  trip_id: Id
  user_id: Id | null
  display_name: string
  role: Role
  joined_at: string | null
  removed_at: string | null
}

export interface ExpenseParticipant {
  expense_id?: Id
  member_id: Id
  share_amount: MinorRaw
}

export interface Expense {
  id: Id
  trip_id: Id
  title: string
  category: Category
  amount: MinorRaw
  currency: string
  paid_by: Id
  occurred_at: string
  timezone: string
  local_date: ISODate
  end_date: ISODate | null
  location_text: string | null
  latitude: number | null
  longitude: number | null
  photo_path: string | null
  note: string | null
  fx_rate_to_hkd: NumericRaw | null
  fx_rate_date: ISODate | null
  amount_hkd: MinorRaw | null
  currency_manually_set: boolean
  created_by: Id | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  expense_participants: ExpenseParticipant[]
}

export interface Settlement {
  id: Id
  trip_id: Id
  from_member: Id
  to_member: Id
  debt_currency: string
  debt_amount: MinorRaw
  paid_currency: string
  paid_amount: MinorRaw
  fx_rate: NumericRaw | null
  paid_at: string
  created_by: Id | null
  idempotency_key: string
}

export interface ActivityLogRow {
  id: Id
  trip_id: Id
  actor_member: Id | null
  action: string
  entity_type: string
  entity_id: Id | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  created_at: string
}

export interface NotificationRow {
  id: Id
  user_id: Id
  trip_id: Id | null
  type: string
  payload: Record<string, unknown> | null
  read_at: string | null
  created_at: string
}

export interface NotificationSetting {
  user_id: Id
  type: string
  enabled: boolean
}

export interface FxRateRow {
  rate_date: ISODate
  base_currency: string
  quote_currency: string
  rate: NumericRaw
}

export interface CurrencyRow {
  code: string
  decimals: number
  symbol: string | null
}
