// Conclusion / Overview statistics. Pure; uses the LOCKED amount_hkd of each
// expense (brief §5.8). Rules:
//  - "spending" = not a Loan and not personal (group spending)
//  - loans: excluded from spending, but included in per-member paid/share
//    because those columns explain the balance
//  - personal: only in the payer's personal spending
//  - multi-day: counted once (on its start page)
import { pageForLocalDate, type ExpensePageKey, type TripRange } from '../../lib/dates'
import { ZERO, allocateProportional, toMinor, type Decimal } from '../../lib/money'
import type { Category, Expense } from '../../lib/types'

export function isPersonal(e: Pick<Expense, 'expense_participants'>): boolean {
  return e.expense_participants.length === 0
}

export function isSpending(e: Pick<Expense, 'category' | 'expense_participants'>): boolean {
  return e.category !== 'Loan' && !isPersonal(e)
}

/** Each participant's share expressed in locked HKD cents; sums to amount_hkd. */
export function hkdShares(e: Expense): Map<string, Decimal> | null {
  if (e.amount_hkd === null || e.amount_hkd === undefined) return null
  const weights = new Map<string, Decimal>()
  for (const p of e.expense_participants) weights.set(p.member_id, toMinor(p.share_amount))
  return allocateProportional(toMinor(e.amount_hkd), weights)
}

export interface MemberStats {
  /** HKD paid for non-personal expenses (incl. loans). */
  paidHkd: Decimal
  /** HKD share of non-personal expenses (incl. loans). */
  shareHkd: Decimal
  /** Share of group spending (no loans, no personal). */
  spendingShareHkd: Decimal
  /** spendingShare + own personal expenses (no loans). */
  personalSpendingHkd: Decimal
}

export interface TripStats {
  totalSpendingHkd: Decimal
  byCategory: Map<Category, Decimal>
  byPage: Map<ExpensePageKey, Decimal>
  byCurrency: Map<string, { amount: Decimal; hkd: Decimal }>
  perMember: Map<string, MemberStats>
  /** Expenses the backend has not given an amount_hkd yet (excluded, UI warns). */
  missingHkd: number
}

function emptyMember(): MemberStats {
  return { paidHkd: ZERO, shareHkd: ZERO, spendingShareHkd: ZERO, personalSpendingHkd: ZERO }
}

function add<K>(m: Map<K, Decimal>, k: K, v: Decimal) {
  m.set(k, (m.get(k) ?? ZERO).plus(v))
}

export function computeStats(expenses: Expense[], memberIds: string[], trip: TripRange): TripStats {
  const perMember = new Map<string, MemberStats>(memberIds.map((id) => [id, emptyMember()]))
  const member = (id: string) => {
    if (!perMember.has(id)) perMember.set(id, emptyMember())
    return perMember.get(id)!
  }
  const stats: TripStats = {
    totalSpendingHkd: ZERO,
    byCategory: new Map(),
    byPage: new Map(),
    byCurrency: new Map(),
    perMember,
    missingHkd: 0,
  }

  for (const e of expenses) {
    if (e.amount_hkd === null || e.amount_hkd === undefined) {
      stats.missingHkd++
      continue
    }
    const hkd = toMinor(e.amount_hkd)
    const loan = e.category === 'Loan'

    if (isPersonal(e)) {
      if (!loan) {
        const m = member(e.paid_by)
        m.personalSpendingHkd = m.personalSpendingHkd.plus(hkd)
      }
      continue
    }

    const payer = member(e.paid_by)
    payer.paidHkd = payer.paidHkd.plus(hkd)
    for (const [id, share] of hkdShares(e) ?? []) {
      const m = member(id)
      m.shareHkd = m.shareHkd.plus(share)
      if (!loan) {
        m.spendingShareHkd = m.spendingShareHkd.plus(share)
        m.personalSpendingHkd = m.personalSpendingHkd.plus(share)
      }
    }

    if (loan) continue
    stats.totalSpendingHkd = stats.totalSpendingHkd.plus(hkd)
    add(stats.byCategory, e.category, hkd)
    add(stats.byPage, pageForLocalDate(e.local_date, trip), hkd)
    const cur = stats.byCurrency.get(e.currency) ?? { amount: ZERO, hkd: ZERO }
    stats.byCurrency.set(e.currency, { amount: cur.amount.plus(toMinor(e.amount)), hkd: cur.hkd.plus(hkd) })
  }
  return stats
}

/** Page total: spending (no loans, no personal) whose local_date is on this page. */
export function pageTotalHkd(counted: Expense[]): { total: Decimal; missing: number } {
  let total = ZERO
  let missing = 0
  for (const e of counted) {
    if (!isSpending(e)) continue
    if (e.amount_hkd === null || e.amount_hkd === undefined) missing++
    else total = total.plus(toMinor(e.amount_hkd))
  }
  return { total, missing }
}
