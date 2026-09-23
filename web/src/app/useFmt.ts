import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateRange, formatDayMonth, formatFullDate, formatTimestamp, formatWeekday } from '../lib/dates'
import { intlLocale } from '../lib/i18n'
import { formatMoney, formatSigned, type Decimal } from '../lib/money'
import type { ISODate, MinorRaw } from '../lib/types'

/** Locale-bound formatters so components never hand-format money or dates. */
export function useFmt() {
  const { i18n } = useTranslation()
  const locale = intlLocale(i18n.language)
  return useMemo(
    () => ({
      locale,
      money: (m: MinorRaw | Decimal, currency: string) => formatMoney(m, currency, locale),
      signed: (m: Decimal, currency: string) => formatSigned(m, currency, locale),
      dayMonth: (d: ISODate) => formatDayMonth(d, locale),
      weekday: (d: ISODate) => formatWeekday(d, locale),
      fullDate: (d: ISODate) => formatFullDate(d, locale),
      range: (a: ISODate, b: ISODate) => formatDateRange(a, b, locale),
      timestamp: (iso: string) => formatTimestamp(iso, locale),
    }),
    [locale],
  )
}
