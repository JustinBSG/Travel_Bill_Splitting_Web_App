// FX helpers over the `fx_rates` table (rate_date, base_currency, quote_currency, rate).
// Semantics: a row means 1 <base> = <rate> <quote>. We don't assume which base
// the backend stores (HKD, USD, ...): rates are resolved to "HKD per 1 unit"
// through any chain of rows on the same date.
import { currencyDecimals } from './currencies'
import { Dec, HKD, toHkdCents, toRate, type Decimal } from './money'
import type { FxRateRow, ISODate } from './types'

export interface RateTable {
  date: ISODate | null
  /** HKD per 1 major unit of the currency. */
  toHkd: Map<string, Decimal>
}

export const EMPTY_RATES: RateTable = { date: null, toHkd: new Map([[HKD, new Dec(1)]]) }

/** Keep only rows from the most recent rate_date. */
export function latestRows(rows: FxRateRow[]): FxRateRow[] {
  let max: string | null = null
  for (const r of rows) if (max === null || r.rate_date > max) max = r.rate_date
  return rows.filter((r) => r.rate_date === max)
}

export function buildRateTable(rows: FxRateRow[]): RateTable {
  const latest = latestRows(rows)
  // edges[X] = list of [Y, r] meaning 1 X = r Y
  const edges = new Map<string, Array<[string, Decimal]>>()
  const add = (x: string, y: string, r: Decimal) => {
    if (!edges.has(x)) edges.set(x, [])
    edges.get(x)!.push([y, r])
  }
  for (const row of latest) {
    const r = toRate(row.rate)
    if (r.lte(0)) continue
    const b = row.base_currency.toUpperCase()
    const q = row.quote_currency.toUpperCase()
    add(b, q, r)
    add(q, b, new Dec(1).div(r))
  }
  // Reverse adjacency so we can walk outward from HKD.
  const into = new Map<string, Array<[string, Decimal]>>()
  for (const [x, list] of edges) {
    for (const [y, r] of list) {
      if (!into.has(y)) into.set(y, [])
      into.get(y)!.push([x, r])
    }
  }
  const toHkd = new Map<string, Decimal>([[HKD, new Dec(1)]])
  const queue = [HKD]
  while (queue.length) {
    const y = queue.shift()!
    for (const [x, r] of into.get(y) ?? []) {
      if (toHkd.has(x)) continue
      toHkd.set(x, r.times(toHkd.get(y)!))
      queue.push(x)
    }
  }
  return { date: latest[0]?.rate_date ?? null, toHkd }
}

export function rateToHkd(table: RateTable, currency: string): Decimal | null {
  return table.toHkd.get(currency.toUpperCase()) ?? null
}

/**
 * For the Overview "current FX" line: pick a round quantity of the currency
 * worth at least HK$ 1 so the rate is readable, e.g. 100 JPY -> HK$ 5.26,
 * 1,000 KRW -> HK$ 5.80, 1 EUR -> HK$ 8.45.
 */
export function readableRate(currency: string, rate: Decimal): { unitsMinor: Decimal; hkdCents: Decimal } {
  const scale = new Dec(10).pow(currencyDecimals(currency))
  let units = new Dec(1)
  for (let i = 0; i < 8; i++) {
    if (units.times(rate).gte(1)) break
    units = units.times(10)
  }
  const unitsMinor = units.times(scale)
  return { unitsMinor, hkdCents: toHkdCents(unitsMinor, currency, rate) }
}
