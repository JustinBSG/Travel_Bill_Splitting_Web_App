import { minorToApi, type Decimal } from '../../lib/money'
import { ApiError, isUniqueViolation, supabase, unwrap } from '../../lib/supabase'

export interface SettlementInput {
  from_member: string
  to_member: string
  debt_currency: string
  debt_amount: Decimal
  paid_currency: string
  paid_amount: Decimal
  /** paid_currency per 1 unit of debt_currency (major units); 1 when the same. */
  fx_rate: Decimal
  /** Required; generated once when the dialog opens so a double tap can't double-pay. */
  idempotency_key: string
}

/** Inserts all rows in ONE request (single statement, all-or-nothing). */
export async function recordSettlements(tripId: string, rows: SettlementInput[]): Promise<'ok' | 'duplicate'> {
  const paid_at = new Date().toISOString()
  try {
    unwrap(
      await supabase.from('settlements').insert(
        rows.map((r) => ({
          trip_id: tripId,
          from_member: r.from_member,
          to_member: r.to_member,
          debt_currency: r.debt_currency,
          debt_amount: minorToApi(r.debt_amount),
          paid_currency: r.paid_currency,
          paid_amount: minorToApi(r.paid_amount),
          fx_rate: r.fx_rate.toString(),
          paid_at,
          idempotency_key: r.idempotency_key,
        })),
      ),
    )
    return 'ok'
  } catch (e) {
    if (isUniqueViolation(e)) return 'duplicate' // already recorded by an earlier tap
    throw e instanceof ApiError ? e : new ApiError(String(e))
  }
}
