import type { TFunction } from 'i18next'
import { diffDays, eachDate, isISODate } from '../../lib/dates'
import type { ISODate } from '../../lib/types'

/** "4 days, 3 nights" / "4日3夜". */
export function durationText(t: TFunction, start: ISODate, end: ISODate): string {
  const days = diffDays(start, end) + 1
  return t('trip.duration', {
    days: t('trip.days', { count: days }),
    nights: t('trip.nights', { count: Math.max(days - 1, 0) }),
  })
}

export const MAX_TRIP_DAYS = 90

export function tripDatesError(start: string, end: string): 'order' | 'length' | null {
  if (!isISODate(start) || !isISODate(end)) return null
  if (end < start) return 'order'
  if (eachDate(start, end).length > MAX_TRIP_DAYS) return 'length'
  return null
}
