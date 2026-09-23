// Dates, timezones and page assignment.
// Page assignment ALWAYS uses the stored local_date / end_date (spec §12.3),
// never the viewer's phone calendar.
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import type { ISODate } from './types'

export const HOME_TZ = 'Asia/Hong_Kong'

export type ExpensePageKey = 'pre' | 'post' | ISODate
export type PageKey = 'overview' | 'conclusion' | ExpensePageKey

export interface TripRange {
  start_date: ISODate
  end_date: ISODate
}

export function isISODate(s: string | null | undefined): s is ISODate {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function parseUtc(d: ISODate): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}

function toISO(dt: Date): ISODate {
  return dt.toISOString().slice(0, 10)
}

export function addDays(d: ISODate, n: number): ISODate {
  const dt = parseUtc(d)
  dt.setUTCDate(dt.getUTCDate() + n)
  return toISO(dt)
}

/** Whole days from a to b (b - a). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseUtc(b).getTime() - parseUtc(a).getTime()) / 86_400_000)
}

export function eachDate(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = []
  if (!isISODate(start) || !isISODate(end) || end < start) return out
  for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

export function pageForLocalDate(localDate: ISODate, trip: TripRange): ExpensePageKey {
  if (localDate < trip.start_date) return 'pre'
  if (localDate > trip.end_date) return 'post'
  return localDate
}

export interface DatedExpense {
  local_date: ISODate
  end_date: ISODate | null
  occurred_at: string
}

export function isMultiDay(e: DatedExpense): boolean {
  return !!e.end_date && e.end_date > e.local_date
}

/** Multi-day visible on every date D where local_date <= D <= end_date. */
export function coversDate(e: DatedExpense, d: ISODate): boolean {
  if (!isMultiDay(e)) return e.local_date === d
  return e.local_date <= d && d <= e.end_date!
}

/** "(Day 2 of 4)" position of date d inside a multi-day expense. */
export function multiDayPosition(e: DatedExpense, d: ISODate): { index: number; total: number } {
  const total = diffDays(e.local_date, e.end_date ?? e.local_date) + 1
  const index = Math.min(Math.max(diffDays(e.local_date, d) + 1, 1), total)
  return { index, total }
}

export interface PageExpenses<E> {
  /** Multi-day expenses covering this page, pinned at the top. */
  pinned: E[]
  /** Single-day expenses of this page sorted by time. */
  single: E[]
  /**
   * Expenses counted in THIS page's total: those whose local_date belongs to
   * the page. A multi-day expense therefore counts once, on its start page.
   */
  counted: E[]
}

export function expensesForPage<E extends DatedExpense>(
  expenses: E[],
  page: ExpensePageKey,
  trip: TripRange,
): PageExpenses<E> {
  const byTime = (a: E, b: E) => a.occurred_at.localeCompare(b.occurred_at)
  if (page === 'pre' || page === 'post') {
    const own = expenses.filter((e) => pageForLocalDate(e.local_date, trip) === page)
    return {
      pinned: own.filter(isMultiDay).sort(byTime),
      single: own.filter((e) => !isMultiDay(e)).sort(byTime),
      counted: own,
    }
  }
  return {
    pinned: expenses.filter((e) => isMultiDay(e) && coversDate(e, page)).sort(byTime),
    single: expenses.filter((e) => !isMultiDay(e) && e.local_date === page).sort(byTime),
    counted: expenses.filter((e) => e.local_date === page),
  }
}

/** All trip pages in order: Overview | Pre-trip | days... | Post-trip | Conclusion. */
export function tripPageKeys(trip: TripRange): PageKey[] {
  return ['overview', 'pre', ...eachDate(trip.start_date, trip.end_date), 'post', 'conclusion']
}

export function todayIn(tz: string, now: Date = new Date()): ISODate {
  return formatInTimeZone(now, tz, 'yyyy-MM-dd')
}

export function timeNowIn(tz: string, now: Date = new Date()): string {
  return formatInTimeZone(now, tz, 'HH:mm')
}

/** Wall-clock date + time in `tz` -> UTC ISO string. */
export function zonedToUtcIso(date: ISODate, time: string, tz: string): string {
  return fromZonedTime(`${date}T${time.length === 5 ? `${time}:00` : time}`, tz).toISOString()
}

export function utcToLocalParts(iso: string, tz: string): { date: ISODate; time: string } {
  return { date: formatInTimeZone(iso, tz, 'yyyy-MM-dd'), time: formatInTimeZone(iso, tz, 'HH:mm') }
}

/** 'Asia/Tokyo' -> 'Tokyo', 'America/New_York' -> 'New York'. */
export function tzCity(tz: string): string {
  const last = tz.split('/').pop() ?? tz
  return last.replace(/_/g, ' ')
}

export type TripProgress =
  | { kind: 'before'; daysUntil: number }
  | { kind: 'during'; day: number; total: number }
  | { kind: 'after' }

/**
 * Countdown / "Day X of N". Each trip date is checked against "today" in that
 * date's own timezone, so a traveller in Tokyo sees the Tokyo day.
 */
export function tripProgress(
  trip: TripRange,
  tzForDate: (d: ISODate) => string,
  now: Date = new Date(),
): TripProgress {
  const dates = eachDate(trip.start_date, trip.end_date)
  const i = dates.findIndex((d) => todayIn(tzForDate(d), now) === d)
  if (i >= 0) return { kind: 'during', day: i + 1, total: dates.length }
  const todayAtStart = todayIn(tzForDate(trip.start_date), now)
  if (todayAtStart < trip.start_date) return { kind: 'before', daysUntil: diffDays(todayAtStart, trip.start_date) }
  return { kind: 'after' }
}

/** Default date for a new expense on a page ("date defaults to current page"). */
export function defaultDateForPage(page: ExpensePageKey, trip: TripRange, now: Date = new Date()): ISODate {
  if (page !== 'pre' && page !== 'post') return page
  const today = todayIn(HOME_TZ, now)
  if (page === 'pre') return today < trip.start_date ? today : addDays(trip.start_date, -1)
  return today > trip.end_date ? today : addDays(trip.end_date, 1)
}

// ---- display ---------------------------------------------------------------

export function formatDayMonth(d: ISODate, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(parseUtc(d))
}

export function formatWeekday(d: ISODate, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(parseUtc(d))
}

export function formatFullDate(d: ISODate, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parseUtc(d))
}

/** "12–15 Oct" (or locale equivalent). */
export function formatDateRange(start: ISODate, end: ISODate, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  if (start === end) return fmt.format(parseUtc(start))
  return fmt.formatRange(parseUtc(start), parseUtc(end))
}

/** Timestamp in the viewer's timezone, e.g. "13 Oct 21:04". */
export function formatTimestamp(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}
