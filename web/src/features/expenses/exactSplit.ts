// AB split ("exact amounts"): each person's share is what they actually had.
// Pure; see exactSplit.test.ts.
import { ZERO, parseMajorInput, sumMinor, type Decimal } from '../../lib/money'

export interface ExactSplit {
  /** Valid, non-blank shares in integer minor units (blank = not in the split). */
  shares: Map<string, Decimal>
  /** Member ids whose text is not a valid positive amount for this currency. */
  invalid: string[]
  assigned: Decimal
  /** total - assigned; negative when the shares exceed the total. null without a valid total. */
  remaining: Decimal | null
}

export function evaluateExactSplit(
  total: Decimal | null,
  texts: Record<string, string>,
  memberIds: string[],
  currency: string,
): ExactSplit {
  const shares = new Map<string, Decimal>()
  const invalid: string[] = []
  for (const id of memberIds) {
    const text = texts[id]?.trim() ?? ''
    if (!text) continue
    const parsed = parseMajorInput(text, currency)
    if (parsed.ok) shares.set(id, parsed.minor)
    else invalid.push(id)
  }
  const assigned = shares.size ? sumMinor(shares.values()) : ZERO
  return { shares, invalid, assigned, remaining: total ? total.minus(assigned) : null }
}

/** Ready to save: valid total, at least one share, no bad input, sums exactly to the total. */
export function isExactSplitComplete(s: ExactSplit): boolean {
  return s.remaining !== null && s.remaining.isZero() && s.invalid.length === 0 && s.shares.size > 0
}
