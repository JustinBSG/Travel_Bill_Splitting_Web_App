// Expense writes, each ONE server transaction (backend RPCs):
//   save_expense         expense + participants; the server derives local_date,
//                        locks the FX rate, computes amount_hkd, splits AA
//                        shares (remainder by member id) and checks AB sums
//   soft_delete_expense  optimistic lock on updated_at
//   restore_expense
// Activity log and notifications are written by the server.
import { minorToApi, type Decimal } from '../../lib/money'
import { ApiError, PHOTO_BUCKET, rpc, supabase } from '../../lib/supabase'
import type { Category, Expense, ISODate, SplitMethod } from '../../lib/types'

/** share_amount only for AB ('exact'); AA rows are split by the server. */
export interface ParticipantInput {
  member_id: string
  share_amount?: Decimal
}

export interface ExpenseInput {
  title: string
  category: Category
  amount: Decimal
  currency: string
  paid_by: string
  /** ISO instant with offset; the server derives local_date from it + timezone. */
  occurred_at: string
  timezone: string
  end_date: ISODate | null
  location_text: string | null
  latitude: number | null
  longitude: number | null
  photo_path: string | null
  note: string | null
  currency_manually_set: boolean
  split_method: SplitMethod
}

function saveBody(tripId: string, input: ExpenseInput, participants: ParticipantInput[], existing: Expense | null) {
  return {
    ...input,
    id: existing?.id ?? null,
    trip_id: tripId,
    amount: minorToApi(input.amount),
    // Exactly as the API returned it (microseconds): it is the optimistic-lock token.
    expected_updated_at: existing?.updated_at ?? null,
    participants: participants.map((p) => ({
      member_id: p.member_id,
      share_amount: input.split_method === 'exact' && p.share_amount ? minorToApi(p.share_amount) : null,
    })),
  }
}

const isConflict = (e: unknown) => e instanceof ApiError && e.code === 'conflict_updated_at'

export async function createExpense(tripId: string, input: ExpenseInput, participants: ParticipantInput[]): Promise<Expense> {
  return rpc<Expense>('save_expense', saveBody(tripId, input, participants, null))
}

export type UpdateResult = { ok: true; expense: Expense } | { ok: false; conflict: true }

/** Optimistic lock: the server only updates if updated_at still matches what we loaded. */
export async function updateExpense(
  existing: Expense,
  input: ExpenseInput,
  participants: ParticipantInput[],
): Promise<UpdateResult> {
  let expense: Expense
  try {
    expense = await rpc<Expense>('save_expense', saveBody(existing.trip_id, input, participants, existing))
  } catch (e) {
    if (isConflict(e)) return { ok: false, conflict: true }
    throw e
  }
  // The old photo was replaced or removed: delete it (best effort).
  if (existing.photo_path && existing.photo_path !== expense.photo_path) void removePhoto(existing.photo_path)
  return { ok: true, expense }
}

/** Soft delete only (restorable from the activity log). */
export async function softDeleteExpense(existing: Expense): Promise<'ok' | 'conflict'> {
  try {
    await rpc('soft_delete_expense', { expense_id: existing.id, expected_updated_at: existing.updated_at })
    return 'ok'
  } catch (e) {
    if (isConflict(e)) return 'conflict'
    throw e
  }
}

export async function restoreExpense(id: string): Promise<void> {
  await rpc('restore_expense', { expense_id: id })
}

const PHOTO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

/**
 * Uploads to {trip_id}/{expense_id}/{uuid}.{ext}. A new expense has no id yet,
 * so its photo goes to {trip_id}/{uuid}.{ext} (the backend accepts both).
 */
export async function uploadPhoto(tripId: string, blob: Blob, expenseId?: string): Promise<string> {
  const ext = PHOTO_EXT[blob.type] ?? 'jpg'
  const name = `${crypto.randomUUID()}.${ext}`
  const path = expenseId ? `${tripId}/${expenseId}/${name}` : `${tripId}/${name}`
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, {
    contentType: blob.type || 'image/jpeg',
    upsert: false,
  })
  if (error) throw new ApiError(error.message)
  return path
}

async function removePhoto(path: string): Promise<void> {
  await supabase.storage.from(PHOTO_BUCKET).remove([path])
}

export async function signedPhotoUrl(path: string, expiresIn = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, expiresIn)
  return error ? null : data.signedUrl
}
