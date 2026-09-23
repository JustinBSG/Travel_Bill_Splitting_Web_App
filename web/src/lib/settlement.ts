// Balances and "who pays whom". Pure functions — see settlement.test.ts.
//
// Rules (brief §5):
//  - nets are kept per ORIGINAL currency in integer minor units:
//      payer +amount, each participant -share_amount (server rows),
//      settlement: from +debt_amount, to -debt_amount (in debt_currency)
//  - personal expenses (zero participants) have no balance effect
//  - loans DO count (category is irrelevant here)
//  - "All in HKD" converts each currency-net at the latest rate, then greedy.
//    It never sums locked amount_hkd.
//  - "By currency" greedy-matches each currency separately.
//  - Suggestions are derived only; nothing here is persisted.
import {
  Dec,
  HKD,
  ZERO,
  compareIds,
  fromHkdCents,
  sumMinor,
  toHkdCents,
  toHkdCentsExact,
  toMinor,
  type Decimal,
} from './money'
import type { MinorRaw } from './types'

export interface NetExpense {
  id?: string
  paid_by: string
  amount: MinorRaw
  currency: string
  expense_participants: { member_id: string; share_amount: MinorRaw }[]
}

export interface NetSettlement {
  from_member: string
  to_member: string
  debt_currency: string
  debt_amount: MinorRaw
}

/** nets.get(currency).get(memberId): + is owed, - owes (minor units of that currency). */
export type Nets = Map<string, Map<string, Decimal>>

export interface Transfer {
  from: string
  to: string
  currency: string
  amount: Decimal
}

export type RateLookup = (currency: string) => Decimal | null

function bump(nets: Nets, currency: string, member: string, delta: Decimal) {
  let m = nets.get(currency)
  if (!m) {
    m = new Map()
    nets.set(currency, m)
  }
  m.set(member, (m.get(member) ?? ZERO).plus(delta))
}

export function computeNets(expenses: NetExpense[], settlements: NetSettlement[]): Nets {
  const nets: Nets = new Map()
  for (const e of expenses) {
    if (e.expense_participants.length === 0) continue // personal
    const cur = e.currency.toUpperCase()
    bump(nets, cur, e.paid_by, toMinor(e.amount))
    for (const p of e.expense_participants) bump(nets, cur, p.member_id, toMinor(p.share_amount).neg())
  }
  for (const s of settlements) {
    const cur = s.debt_currency.toUpperCase()
    const amt = toMinor(s.debt_amount)
    bump(nets, cur, s.from_member, amt)
    bump(nets, cur, s.to_member, amt.neg())
  }
  return nets
}

export function netOf(nets: Nets, member: string, currency: string): Decimal {
  return nets.get(currency)?.get(member) ?? ZERO
}

/** Non-personal expenses whose server shares do not sum to the amount. */
export function shareIntegrityIssues(expenses: NetExpense[]): string[] {
  const bad: string[] = []
  for (const e of expenses) {
    if (e.expense_participants.length === 0) continue
    const s = sumMinor(e.expense_participants.map((p) => toMinor(p.share_amount)))
    if (!s.eq(toMinor(e.amount))) bad.push(e.id ?? '?')
  }
  return bad
}

/** Currencies with a non-zero net for anyone, HKD first then alphabetical. */
export function activeCurrencies(nets: Nets): string[] {
  const out: string[] = []
  for (const [cur, m] of nets) if ([...m.values()].some((v) => !v.isZero())) out.push(cur)
  return out.sort((a, b) => (a === HKD ? -1 : b === HKD ? 1 : a.localeCompare(b)))
}

/**
 * Greedy minimum payments: pair the largest debtor with the largest creditor,
 * settle the smaller of the two, repeat. At most (members - 1) transfers.
 * Ties break by member id so results are deterministic.
 */
export function greedyMatch(balances: Map<string, Decimal>, currency: string): Transfer[] {
  const cred = [...balances].filter(([, v]) => v.isPositive() && !v.isZero()).map(([id, v]) => ({ id, v }))
  const debt = [...balances].filter(([, v]) => v.isNegative() && !v.isZero()).map(([id, v]) => ({ id, v: v.neg() }))
  const out: Transfer[] = []
  const byAmount = (a: { id: string; v: Decimal }, b: { id: string; v: Decimal }) =>
    b.v.comparedTo(a.v) || compareIds(a.id, b.id)
  let guard = balances.size * 2 + 2
  while (cred.length && debt.length && guard-- > 0) {
    cred.sort(byAmount)
    debt.sort(byAmount)
    const c = cred[0]
    const d = debt[0]
    const amt = Dec.min(c.v, d.v)
    out.push({ from: d.id, to: c.id, currency, amount: amt })
    c.v = c.v.minus(amt)
    d.v = d.v.minus(amt)
    if (c.v.isZero()) cred.shift()
    if (d.v.isZero()) debt.shift()
  }
  return out
}

export function suggestByCurrency(nets: Nets): Transfer[] {
  return activeCurrencies(nets).flatMap((cur) => greedyMatch(nets.get(cur)!, cur))
}

export interface HkdNetsResult {
  /** Integer HKD cents per member; sums to exactly 0 when the data is consistent. */
  balances: Map<string, Decimal>
  /** Currencies with non-zero nets but no rate: excluded, the UI must warn. */
  missingRates: string[]
  /** True if any non-HKD currency contributed (conversion rounding possible). */
  converted: boolean
}

/**
 * Convert each member's per-currency nets to HKD at the latest rate and round
 * to cents with the largest-remainder method, so rounding never creates money.
 */
export function hkdNets(nets: Nets, rateFor: RateLookup): HkdNetsResult {
  const exact = new Map<string, Decimal>()
  const missingRates: string[] = []
  let converted = false
  for (const cur of activeCurrencies(nets)) {
    const rate = cur === HKD ? new Dec(1) : rateFor(cur)
    if (!rate) {
      missingRates.push(cur)
      continue
    }
    if (cur !== HKD) converted = true
    for (const [member, v] of nets.get(cur)!) {
      exact.set(member, (exact.get(member) ?? ZERO).plus(toHkdCentsExact(v, cur, rate)))
    }
  }
  // Make sure every member that appears anywhere has an entry.
  for (const m of nets.values()) for (const id of m.keys()) if (!exact.has(id)) exact.set(id, ZERO)

  const ids = [...exact.keys()].sort(compareIds)
  const parts = ids.map((id) => {
    const e = exact.get(id)!
    const floor = e.floor()
    return { id, floor, frac: e.minus(floor) }
  })
  const target = sumMinor(ids.map((id) => exact.get(id)!)).toDecimalPlaces(0, Dec.ROUND_HALF_UP)
  let leftover = target.minus(sumMinor(parts.map((p) => p.floor)))
  const order = [...parts].sort((a, b) => b.frac.comparedTo(a.frac) || compareIds(a.id, b.id))
  for (const p of order) {
    if (leftover.lte(0)) break
    p.floor = p.floor.plus(1)
    leftover = leftover.minus(1)
  }
  const balances = new Map<string, Decimal>()
  for (const p of parts) balances.set(p.id, p.floor)
  return { balances, missingRates, converted }
}

/** Smallest coin in HK (10¢). FX-rounding crumbs below this are not suggested. */
export const HKD_DUST_CENTS = new Dec(10)

export interface AllInHkdResult extends HkdNetsResult {
  transfers: Transfer[]
  /** Transfers dropped because they were FX-rounding dust. */
  dustDropped: number
}

export function suggestAllInHkd(nets: Nets, rateFor: RateLookup): AllInHkdResult {
  const res = hkdNets(nets, rateFor)
  const all = greedyMatch(res.balances, HKD)
  const transfers = res.converted ? all.filter((t) => t.amount.gte(HKD_DUST_CENTS)) : all
  return { ...res, transfers, dustDropped: all.length - transfers.length }
}

export interface SettlementPiece {
  debt_currency: string
  /** Minor units of debt_currency cleared. */
  debt_amount: Decimal
  /** HKD cents actually handed over for this piece. */
  paid_hkd: Decimal
  /** HKD per 1 major unit of debt_currency (1 for HKD). */
  fx_rate: Decimal
}

/**
 * "Mark as paid" for an All-in-HKD suggestion: `from` hands `to` hkdCents.
 * Clear matching currency debts between the two first (from owes in K and to
 * is owed in K), converted at today's rate; whatever is left is recorded as an
 * HKD debt. Sum of paid_hkd === hkdCents exactly.
 */
export function allocateHkdPayment(
  nets: Nets,
  from: string,
  to: string,
  hkdCents: Decimal,
  rateFor: RateLookup,
): SettlementPiece[] {
  const pieces: SettlementPiece[] = []
  let remaining = hkdCents
  const one = new Dec(1)

  const directHkd = Dec.min(netOf(nets, from, HKD).neg(), netOf(nets, to, HKD))
  let hkdPiece = ZERO
  if (directHkd.isPositive() && !directHkd.isZero()) {
    hkdPiece = Dec.min(directHkd, remaining)
    remaining = remaining.minus(hkdPiece)
  }

  const foreign = activeCurrencies(nets).filter((c) => c !== HKD)
  for (const cur of foreign) {
    if (remaining.lte(0)) break
    const rate = rateFor(cur)
    if (!rate) continue
    const cap = Dec.min(netOf(nets, from, cur).neg(), netOf(nets, to, cur))
    if (cap.lte(0)) continue
    const capHkd = toHkdCents(cap, cur, rate)
    if (capHkd.isZero()) continue
    if (capHkd.lte(remaining)) {
      pieces.push({ debt_currency: cur, debt_amount: cap, paid_hkd: capHkd, fx_rate: rate })
      remaining = remaining.minus(capHkd)
    } else {
      const q = Dec.min(fromHkdCents(remaining, cur, rate), cap)
      if (q.isPositive() && !q.isZero()) {
        pieces.push({ debt_currency: cur, debt_amount: q, paid_hkd: remaining, fx_rate: rate })
        remaining = ZERO
      }
    }
  }

  hkdPiece = hkdPiece.plus(remaining.isPositive() ? remaining : ZERO)
  if (hkdPiece.isPositive() && !hkdPiece.isZero()) {
    pieces.unshift({ debt_currency: HKD, debt_amount: hkdPiece, paid_hkd: hkdPiece, fx_rate: one })
  }
  return pieces
}
