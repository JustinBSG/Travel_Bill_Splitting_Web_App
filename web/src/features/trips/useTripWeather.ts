import { useEffect, useMemo, useState } from 'react'
import type { ISODate, TripDay } from '../../lib/types'
import { fetchTripWeather, type Weather } from './openMeteo'

/** Weather per trip date; re-fetches only when locations/dates change. */
export function useTripWeather(days: TripDay[]): Map<ISODate, Weather> | null {
  const key = useMemo(
    () => days.map((d) => `${d.date}:${d.latitude}:${d.longitude}:${d.timezone}`).join('|'),
    [days],
  )
  const [result, setResult] = useState<{ key: string; map: Map<ISODate, Weather> } | null>(null)

  useEffect(() => {
    let alive = true
    fetchTripWeather(days).then((map) => alive && setResult({ key, map }))
    return () => {
      alive = false
    }
    // `key` captures everything in `days` that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return result && result.key === key ? result.map : null
}
