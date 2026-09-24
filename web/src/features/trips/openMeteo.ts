// Open-Meteo (free, no key), called directly from the client.
//   Geocoding: city search -> coordinates, country, timezone
//   Forecast:  ~16 days ahead (also serves the recent past)
//   Archive:   older past dates
import type { IconName } from '../../app/ui/Icon'
import { addDays, todayIn } from '../../lib/dates'
import type { ISODate, TripDay } from '../../lib/types'

export interface GeoResult {
  id: number
  name: string
  admin1?: string
  country?: string
  country_code?: string
  latitude: number
  longitude: number
  timezone?: string
}

export async function searchCities(query: string, lang: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const params = new URLSearchParams({
    name: q,
    count: '8',
    language: lang === 'zh-Hant' ? 'zh' : 'en',
    format: 'json',
  })
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal })
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`)
  const body = (await res.json()) as { results?: GeoResult[] }
  return body.results ?? []
}

// ---- Weather ------------------------------------------------------------------

export type Weather =
  | {
      kind: 'ok'
      code: number
      max: number
      min: number
      /** Forecast only. */
      precipProbability: number | null
      /** Archive only (mm). */
      precipSum: number | null
    }
  | { kind: 'later'; availableFrom: ISODate }
  | { kind: 'unavailable' }

const FORECAST_DAYS_AHEAD = 15
/** The archive lags a few days; the forecast API covers the recent past. */
const FORECAST_DAYS_BACK = 60
const CACHE_PREFIX = 'tbs-wx:'
const FORECAST_TTL_MS = 3 * 3600_000

interface CacheEntry {
  at: number
  w: Weather
  final: boolean
}

function cacheKey(day: TripDay) {
  return `${CACHE_PREFIX}${day.latitude},${day.longitude},${day.date}`
}

function readCache(day: TripDay): Weather | null {
  try {
    const raw = localStorage.getItem(cacheKey(day))
    if (!raw) return null
    const e = JSON.parse(raw) as CacheEntry
    if (e.final || Date.now() - e.at < FORECAST_TTL_MS) return e.w
  } catch {
    /* storage unavailable */
  }
  return null
}

function writeCache(day: TripDay, w: Weather, final: boolean) {
  try {
    localStorage.setItem(cacheKey(day), JSON.stringify({ at: Date.now(), w, final } satisfies CacheEntry))
  } catch {
    /* quota / private mode */
  }
}

interface DailyResponse {
  daily?: {
    time: string[]
    weather_code?: (number | null)[]
    temperature_2m_max?: (number | null)[]
    temperature_2m_min?: (number | null)[]
    precipitation_probability_max?: (number | null)[]
    precipitation_sum?: (number | null)[]
  }
}

async function fetchRange(kind: 'forecast' | 'archive', day: TripDay, start: ISODate, end: ISODate) {
  const params = new URLSearchParams({
    latitude: String(day.latitude),
    longitude: String(day.longitude),
    timezone: day.timezone || 'auto',
    start_date: start,
    end_date: end,
    daily:
      kind === 'forecast'
        ? 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
        : 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
  })
  const host = kind === 'forecast' ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive'
  const res = await fetch(`${host}?${params}`)
  if (!res.ok) throw new Error(`Weather failed (${res.status})`)
  return (await res.json()) as DailyResponse
}

/** Weather for every trip day (cached per trip_day in localStorage). */
export async function fetchTripWeather(days: TripDay[]): Promise<Map<ISODate, Weather>> {
  const out = new Map<ISODate, Weather>()
  const groups = new Map<string, { kind: 'forecast' | 'archive'; days: TripDay[] }>()

  for (const day of days) {
    if (day.latitude === null || day.longitude === null) {
      out.set(day.date, { kind: 'unavailable' })
      continue
    }
    const today = todayIn(day.timezone || 'UTC')
    if (day.date > addDays(today, FORECAST_DAYS_AHEAD)) {
      out.set(day.date, { kind: 'later', availableFrom: addDays(day.date, -FORECAST_DAYS_AHEAD) })
      continue
    }
    const cached = readCache(day)
    if (cached) {
      out.set(day.date, cached)
      continue
    }
    const kind = day.date >= addDays(today, -FORECAST_DAYS_BACK) ? 'forecast' : 'archive'
    const key = `${kind}|${day.latitude}|${day.longitude}|${day.timezone}`
    if (!groups.has(key)) groups.set(key, { kind, days: [] })
    groups.get(key)!.days.push(day)
  }

  await Promise.all(
    [...groups.values()].map(async ({ kind, days: group }) => {
      const dates = group.map((d) => d.date).sort()
      try {
        const body = await fetchRange(kind, group[0], dates[0], dates[dates.length - 1])
        const daily = body.daily
        for (const day of group) {
          const i = daily?.time.indexOf(day.date) ?? -1
          const code = i >= 0 ? daily?.weather_code?.[i] : null
          const max = i >= 0 ? daily?.temperature_2m_max?.[i] : null
          const min = i >= 0 ? daily?.temperature_2m_min?.[i] : null
          if (code === null || code === undefined || max === null || max === undefined || min === null || min === undefined) {
            out.set(day.date, { kind: 'unavailable' })
            continue
          }
          const w: Weather = {
            kind: 'ok',
            code,
            max,
            min,
            precipProbability: daily?.precipitation_probability_max?.[i] ?? null,
            precipSum: daily?.precipitation_sum?.[i] ?? null,
          }
          out.set(day.date, w)
          const isPast = day.date < todayIn(day.timezone || 'UTC')
          writeCache(day, w, kind === 'archive' || isPast)
        }
      } catch {
        for (const day of group) out.set(day.date, { kind: 'unavailable' })
      }
    }),
  )
  return out
}

/** WMO weather code -> line icon + i18n key. */
export function weatherIcon(code: number): { icon: IconName; key: WeatherKey } {
  if (code === 0) return { icon: 'sun', key: 'clear' }
  if (code <= 2) return { icon: 'partlyCloudy', key: 'partlyCloudy' }
  if (code === 3) return { icon: 'cloud', key: 'cloudy' }
  if (code === 45 || code === 48) return { icon: 'fog', key: 'fog' }
  if (code >= 51 && code <= 57) return { icon: 'drizzle', key: 'drizzle' }
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: 'rain', key: 'rain' }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: 'snow', key: 'snow' }
  if (code >= 95) return { icon: 'thunder', key: 'thunder' }
  return { icon: 'thermometer', key: 'unknown' }
}

export type WeatherKey = 'clear' | 'partlyCloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'thunder' | 'unknown'
