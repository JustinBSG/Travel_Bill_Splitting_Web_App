import { registerCurrencies } from '../../lib/currencies'
import { EMPTY_RATES, buildRateTable, type RateTable } from '../../lib/fx'
import { supabase } from '../../lib/supabase'
import type { CurrencyRow, FxRateRow } from '../../lib/types'

const TTL_MS = 30 * 60_000
let cache: { at: number; table: RateTable } | null = null
let inflight: Promise<RateTable> | null = null

/** Latest-day mid-market rates (fx_rates is filled daily by pg_cron). */
export function fetchLatestRates(force = false): Promise<RateTable> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.table)
  if (inflight) return inflight
  inflight = (async () => {
    const latest = await supabase
      .from('fx_rates')
      .select('rate_date')
      .order('rate_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latest.error || !latest.data) return cache?.table ?? EMPTY_RATES
    const rows = await supabase
      .from('fx_rates')
      .select('rate_date, base_currency, quote_currency, rate')
      .eq('rate_date', (latest.data as { rate_date: string }).rate_date)
    if (rows.error) return cache?.table ?? EMPTY_RATES
    const table = buildRateTable((rows.data ?? []) as FxRateRow[])
    cache = { at: Date.now(), table }
    return table
  })().finally(() => {
    inflight = null
  })
  return inflight
}

let currenciesLoaded = false

/** Load the `currencies` reference table once (decimals + symbols). */
export async function loadCurrencies(): Promise<void> {
  if (currenciesLoaded) return
  const { data, error } = await supabase.from('currencies').select('code, decimals, symbol')
  if (!error && data) {
    registerCurrencies(data as CurrencyRow[])
    currenciesLoaded = true
  }
}
