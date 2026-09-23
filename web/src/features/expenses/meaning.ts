// "What it means for me" for one expense, from the SERVER share rows.
import { ZERO, sumMinor, toMinor, type Decimal } from '../../lib/money'
import type { Expense } from '../../lib/types'
import { hkdShares } from '../settlement/stats'

export type Meaning =
  | { kind: 'personalMine' }
  | { kind: 'personalOther' }
  | { kind: 'notInvolved' }
  | { kind: 'onlyMe' }
  | { kind: 'owed'; amount: Decimal; amountHkd: Decimal | null }
  | { kind: 'owe'; to: string; amount: Decimal; amountHkd: Decimal | null }

export function meaningForMe(e: Expense, meId: string | null): Meaning {
  const parts = e.expense_participants
  if (parts.length === 0) return e.paid_by === meId ? { kind: 'personalMine' } : { kind: 'personalOther' }
  if (!meId) return { kind: 'notInvolved' }
  const hkd = hkdShares(e)
  if (e.paid_by === meId) {
    const others = parts.filter((p) => p.member_id !== meId)
    if (others.length === 0) return { kind: 'onlyMe' }
    return {
      kind: 'owed',
      amount: sumMinor(others.map((p) => toMinor(p.share_amount))),
      amountHkd: hkd ? sumMinor(others.map((p) => hkd.get(p.member_id) ?? ZERO)) : null,
    }
  }
  const mine = parts.find((p) => p.member_id === meId)
  if (!mine) return { kind: 'notInvolved' }
  return { kind: 'owe', to: e.paid_by, amount: toMinor(mine.share_amount), amountHkd: hkd?.get(meId) ?? null }
}
