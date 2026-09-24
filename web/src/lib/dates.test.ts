import { describe, expect, it } from 'vitest'
import {
  addDays,
  allDayUtcIso,
  coversDate,
  defaultDateForPage,
  diffDays,
  eachDate,
  expensesForPage,
  multiDayPosition,
  pageForLocalDate,
  tripPageKeys,
  tripProgress,
  tzCity,
  utcToLocalParts,
  zonedToUtcIso,
} from './dates'

const trip = { start_date: '2026-10-12', end_date: '2026-10-15' }

function e(id: string, local_date: string, end_date: string | null = null, occurred_at = `${local_date}T03:00:00Z`) {
  return { id, local_date, end_date, occurred_at }
}

describe('date math', () => {
  it('adds and diffs days across months', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(diffDays('2026-10-12', '2026-10-15')).toBe(3)
    expect(eachDate('2026-10-12', '2026-10-15')).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'])
    expect(eachDate('2026-10-15', '2026-10-12')).toEqual([])
  })

  it('lists pages in the required order', () => {
    expect(tripPageKeys(trip)).toEqual([
      'overview',
      'pre',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      'post',
      'conclusion',
    ])
  })
})

describe('page assignment uses stored local_date', () => {
  it('buckets pre / day / post', () => {
    expect(pageForLocalDate('2026-10-11', trip)).toBe('pre')
    expect(pageForLocalDate('2026-10-12', trip)).toBe('2026-10-12')
    expect(pageForLocalDate('2026-10-15', trip)).toBe('2026-10-15')
    expect(pageForLocalDate('2026-10-16', trip)).toBe('post')
  })

  it('re-buckets when trip dates change', () => {
    const shorter = { start_date: '2026-10-13', end_date: '2026-10-14' }
    expect(pageForLocalDate('2026-10-12', shorter)).toBe('pre')
    expect(pageForLocalDate('2026-10-15', shorter)).toBe('post')
  })
})

describe('multi-day', () => {
  const hotel = e('hotel', '2026-10-12', '2026-10-15')
  const lunch = e('lunch', '2026-10-13')
  const early = e('early', '2026-10-13', null, '2026-10-12T20:00:00Z')

  it('is pinned on every covered date and counted once (start date)', () => {
    for (const d of eachDate('2026-10-12', '2026-10-15')) {
      expect(expensesForPage([hotel, lunch], d, trip).pinned.map((x) => x.id)).toEqual(['hotel'])
      expect(coversDate(hotel, d)).toBe(true)
    }
    expect(expensesForPage([hotel, lunch], '2026-10-12', trip).counted.map((x) => x.id)).toEqual(['hotel'])
    expect(expensesForPage([hotel, lunch], '2026-10-13', trip).counted.map((x) => x.id)).toEqual(['lunch'])
  })

  it('labels the position', () => {
    expect(multiDayPosition(hotel, '2026-10-13')).toEqual({ index: 2, total: 4 })
  })

  it('sorts single-day by time', () => {
    expect(expensesForPage([lunch, early], '2026-10-13', trip).single.map((x) => x.id)).toEqual(['early', 'lunch'])
  })

  it('puts all-day expenses before timed ones', () => {
    // 00:30 in Tokyo is an earlier instant than the start of 13 Oct in Hong Kong; all-day still leads
    const pass = { ...e('pass', '2026-10-13', null, '2026-10-12T16:00:00Z'), all_day: true }
    const night = e('night', '2026-10-13', null, '2026-10-12T15:30:00Z')
    expect(expensesForPage([lunch, night, pass], '2026-10-13', trip).single.map((x) => x.id)).toEqual(['pass', 'night', 'lunch'])
  })

  it('pre-trip page gets expenses before start', () => {
    const flight = e('flight', '2026-09-01')
    const p = expensesForPage([flight, hotel], 'pre', trip)
    expect(p.single.map((x) => x.id)).toEqual(['flight'])
    expect(p.pinned).toEqual([])
  })
})

describe('timezones', () => {
  it('interprets wall time in the location timezone', () => {
    expect(zonedToUtcIso('2026-10-13', '23:10', 'Asia/Tokyo')).toBe('2026-10-13T14:10:00.000Z')
    expect(utcToLocalParts('2026-10-13T14:10:00.000Z', 'Asia/Tokyo')).toEqual({ date: '2026-10-13', time: '23:10' })
    // Same instant is still 13 Oct in Hong Kong but would be a different wall time.
    expect(utcToLocalParts('2026-10-13T14:10:00.000Z', 'Asia/Hong_Kong')).toEqual({ date: '2026-10-13', time: '22:10' })
    expect(tzCity('America/New_York')).toBe('New York')
  })

  it('sends noon for all-day expenses, so a skipped midnight cannot move the date', () => {
    expect(allDayUtcIso('2026-10-13', 'Asia/Tokyo')).toBe('2026-10-13T03:00:00.000Z')
    // Santiago has no 00:00 on 6 Sep 2026 (clocks jump to 01:00)
    expect(utcToLocalParts(allDayUtcIso('2026-09-06', 'America/Santiago'), 'America/Santiago').date).toBe('2026-09-06')
  })

  it('computes countdown / day X of N in each day timezone', () => {
    const tz = () => 'Asia/Tokyo'
    expect(tripProgress(trip, tz, new Date('2026-10-01T00:00:00Z'))).toEqual({ kind: 'before', daysUntil: 11 })
    // 2026-10-12T16:00Z is 13 Oct 01:00 in Tokyo -> Day 2
    expect(tripProgress(trip, tz, new Date('2026-10-12T16:00:00Z'))).toEqual({ kind: 'during', day: 2, total: 4 })
    expect(tripProgress(trip, tz, new Date('2026-10-20T00:00:00Z'))).toEqual({ kind: 'after' })
  })

  it('defaults new expense dates to the current page', () => {
    const now = new Date('2026-10-01T00:00:00Z')
    expect(defaultDateForPage('2026-10-13', trip, now)).toBe('2026-10-13')
    expect(defaultDateForPage('pre', trip, now)).toBe('2026-10-01')
    expect(defaultDateForPage('post', trip, now)).toBe('2026-10-16')
    expect(defaultDateForPage('pre', trip, new Date('2026-10-13T00:00:00Z'))).toBe('2026-10-11')
  })
})
