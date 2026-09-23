import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFmt } from '../../app/useFmt'
import { HOME_TZ, diffDays, tzCity, type PageKey } from '../../lib/dates'
import { useTripData } from './TripDataContext'

export function usePageLabels() {
  const { t } = useTranslation()
  const fmt = useFmt()
  const { trip, dayByDate } = useTripData()
  return useMemo(() => {
    const short = (key: PageKey): string => {
      switch (key) {
        case 'overview':
          return t('pages.overview')
        case 'pre':
          return t('pages.pre')
        case 'post':
          return t('pages.post')
        case 'conclusion':
          return t('pages.conclusion')
        default:
          return fmt.dayMonth(key)
      }
    }
    const dayNumber = (key: PageKey) => diffDays(trip.start_date, key) + 1
    /** "14 Oct (Osaka)" for day pages, plain label otherwise. */
    const withPlace = (key: PageKey): string => {
      const place = dayByDate.get(key)?.location_name
      return place ? `${short(key)} (${place})` : short(key)
    }
    /** City for "23:10 (Tokyo time)": the day's place if it uses that timezone, else a localised fallback. */
    const tzLabel = (tz: string, localDate?: string): string => {
      const day = localDate ? dayByDate.get(localDate) : undefined
      if (day?.timezone === tz && day.location_name) return day.location_name
      if (tz === HOME_TZ) return t('location.hongKong')
      return tzCity(tz)
    }
    return { short, dayNumber, withPlace, tzLabel }
  }, [t, fmt, trip.start_date, dayByDate])
}
