// Money helpers. ALL money arithmetic goes through decimal.js on integer minor
// units (HKD cents, whole JPY, whole KRW). Never use JS number math for money.
import DecimalBase from 'decimal.js'
import { currencyDecimals } from './currencies'
import type { MinorRaw, NumericRaw } from './types'

export const Dec = DecimalBase.clone({ precision: 50, rounding: DecimalBase.ROUND_HALF_UP })
export type Decimal = InstanceType<typeof Dec>

export const ZERO: Decimal = new Dec(0)
export const HKD = 'HKD'

function pow10(n: number): Decimal {
  return new Dec(10).pow(n)
}

/** Parse an API integer (minor units) into a Decimal. null/undefined -> 0. */
export function toMinor(raw: MinorRaw | Decimal | null | undefined): Decimal {
  if (raw === null || raw === undefined || raw === '') return ZERO
  const d = raw instanceof Dec ? raw : new Dec(String(raw))
  if (!d.isInteger()) throw new Error(`Money value is not an integer minor unit: ${String(raw)}`)
  return d
}

/** Parse an FX rate (Postgres numeric). */
export function toRate(raw: NumericRaw | Decimal): Decimal {
  return raw instanceof Dec ? raw : new Dec(String(raw))
}

export function sumMinor(values: Iterable<Decimal>): Decimal {
  let s = ZERO
  for (const v of values) s = s.plus(v)
  return s
}

/** Serialise minor units for an insert/update payload (string, not float). */
export function minorToApi(m: Decimal): string {
  return m.toFixed(0)
}

export type ParseResult =
  | { ok: true; minor: Decimal }
  | { ok: false; error: 'empty' | 'invalid' | 'decimals' | 'zero' }

/**
 * User-typed major amount ("1,234.5") -> integer minor units, respecting the
 * currency's decimals (HKD 2, JPY 0, KRW 0). Rejects extra decimals instead of
 * silently rounding.
 */
export function parseMajorInput(text: string, currency: string): ParseResult {
  const cleaned = text.replace(/[,\s]/g, '')
  if (cleaned === '') return { ok: false, error: 'empty' }
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(cleaned)) return { ok: false, error: 'invalid' }
  const decimals = currencyDecimals(currency)
  const frac = cleaned.includes('.') ? cleaned.split('.')[1] : ''
  if (frac.replace(/0+$/, '').length > decimals) return { ok: false, error: 'decimals' }
  const minor = new Dec(cleaned.endsWith('.') ? cleaned.slice(0, -1) : cleaned).times(pow10(decimals))
  if (minor.isZero()) return { ok: false, error: 'zero' }
  return { ok: true, minor: minor.toDecimalPlaces(0) }
}

/** Minor units -> plain major string for an <input>, e.g. 15780 HKD -> "157.80". */
export function minorToMajorString(minor: Decimal, currency: string): string {
  const decimals = currencyDecimals(currency)
  return minor.div(pow10(decimals)).toFixed(decimals)
}

/** Locale-aware grouping of a minor amount without currency, e.g. "3,000" or "157.80". */
export function formatNumber(minor: Decimal, currency: string, locale: string): string {
  const decimals = currencyDecimals(currency)
  const major = minor.abs().div(pow10(decimals)).toFixed(decimals)
  const nf = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true,
  })
  // String input keeps exact decimal formatting (Intl.NumberFormat v3).
  return nf.format(major as `${number}`)
}

/** Whole-dollar HKD for tight chart labels, e.g. 952000 cents -> "9,520". */
export function formatHkdWhole(cents: Decimal, locale: string): string {
  const whole = cents.abs().div(100).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0)
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: true }).format(whole as `${number}`)
}

/**
 * "3,000 JPY", "HK$ 157.80", "-HK$ 5.00". HKD uses the HK$ prefix as in the
 * spec examples; other currencies show the ISO code suffix.
 */
export function formatMoney(minor: MinorRaw | Decimal, currency: string, locale: string): string {
  const m = toMinor(minor)
  const sign = m.isNegative() && !m.isZero() ? '-' : ''
  const n = formatNumber(m, currency, locale)
  return currency === HKD ? `${sign}HK$ ${n}` : `${sign}${n} ${currency}`
}

/** Balance style: "+HK$ 10.00" (is owed) / "-HK$ 10.00" (owes). */
export function formatSigned(minor: Decimal, currency: string, locale: string): string {
  if (minor.isZero()) return formatMoney(minor, currency, locale)
  return (minor.isPositive() ? '+' : '') + formatMoney(minor, currency, locale)
}

/** Exact (unrounded) HKD cents for `minor` of `currency` at `rateToHkd` (HKD per 1 major unit). */
export function toHkdCentsExact(minor: Decimal, currency: string, rateToHkd: Decimal): Decimal {
  if (currency === HKD) return minor
  return minor.div(pow10(currencyDecimals(currency))).times(rateToHkd).times(100)
}

/** HKD cents, rounded half-up to an integer. */
export function toHkdCents(minor: Decimal, currency: string, rateToHkd: Decimal): Decimal {
  return toHkdCentsExact(minor, currency, rateToHkd).toDecimalPlaces(0, Dec.ROUND_HALF_UP)
}

/** HKD cents -> integer minor units of `currency`, rounded half-up. */
export function fromHkdCents(hkdCents: Decimal, currency: string, rateToHkd: Decimal): Decimal {
  if (currency === HKD) return hkdCents
  return hkdCents
    .div(100)
    .div(rateToHkd)
    .times(pow10(currencyDecimals(currency)))
    .toDecimalPlaces(0, Dec.ROUND_HALF_UP)
}

/**
 * Stable id order used for remainder distribution (spec §12.2): by
 * trip_members.id ascending. UUIDs compare lexicographically (same as
 * Postgres); purely numeric ids compare numerically.
 */
export function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a)
    const y = BigInt(b)
    return x < y ? -1 : x > y ? 1 : 0
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * PREVIEW ONLY equal split (server rows are the truth). q = amount / n,
 * r = amount % n; the first r members by id ascending get q + 1.
 */
export function splitEqualPreview(amount: Decimal, memberIds: string[]): Map<string, Decimal> {
  const ids = [...new Set(memberIds)].sort(compareIds)
  const out = new Map<string, Decimal>()
  if (ids.length === 0) return out
  const n = new Dec(ids.length)
  const q = amount.divToInt(n)
  const r = amount.minus(q.times(n))
  ids.forEach((id, i) => out.set(id, r.gt(i) ? q.plus(1) : q))
  return out
}

/**
 * Split an integer `total` proportionally to integer `weights`, largest
 * remainder method, ties by id ascending. Result sums exactly to `total`.
 * Used to express server shares in locked HKD (amount_hkd) for display/stats.
 */
export function allocateProportional(total: Decimal, weights: Map<string, Decimal>): Map<string, Decimal> {
  const out = new Map<string, Decimal>()
  const ids = [...weights.keys()].sort(compareIds)
  const wSum = sumMinor(weights.values())
  if (ids.length === 0) return out
  if (wSum.isZero()) {
    ids.forEach((id) => out.set(id, ZERO))
    return out
  }
  const parts = ids.map((id) => {
    const exact = total.times(weights.get(id)!).div(wSum)
    const floor = exact.floor()
    return { id, floor, frac: exact.minus(floor) }
  })
  let leftover = total.minus(sumMinor(parts.map((p) => p.floor)))
  const order = [...parts].sort((a, b) => b.frac.comparedTo(a.frac) || compareIds(a.id, b.id))
  for (const p of order) {
    if (leftover.lte(0)) break
    p.floor = p.floor.plus(1)
    leftover = leftover.minus(1)
  }
  parts.forEach((p) => out.set(p.id, p.floor))
  return out
}
