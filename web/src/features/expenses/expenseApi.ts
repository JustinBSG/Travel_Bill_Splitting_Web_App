// Expense writes. FX lock, amount_hkd, activity log and notifications are
// computed by the backend. Shares: for AA ('equal') the server splits; for AB
// ('exact') the client sends each member's share_amount.
//
// GAP: there is no atomic "save expense + participants" RPC in the contract,
// so participants are written in a second request. Everything is isolated here
// so switching to an RPC later is a one-file change.
import { minorToApi, type Decimal } from '../../lib/money'
import { ApiError, PHOTO_BUCKET, supabase, unwrap } from '../../lib/supabase'
import type { Category, Expense, ISODate, SplitMethod } from '../../lib/types'
import { EXPENSE_COLUMNS } from '../trips/tripApi'

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
  occurred_at: string
  timezone: string
  local_date: ISODate
  end_date: ISODate | null
  location_text: string | null
  latitude: number | null
  longitude: number | null
  photo_path: string | null
  note: string | null
  currency_manually_set: boolean
  split_method: SplitMethod
}

function toRow(input: ExpenseInput) {
  return { ...input, amount: minorToApi(input.amount) }
}

export async function fetchExpense(id: string): Promise<Expense | null> {
  return unwrap(await supabase.from('expenses').select(EXPENSE_COLUMNS).eq('id', id).maybeSingle()) as unknown as Expense | null
}

async function syncParticipants(expenseId: string, next: ParticipantInput[], previous: string[]) {
  const nextIds = next.map((p) => p.member_id)
  const remove = previous.filter((id) => !nextIds.includes(id))
  if (remove.length) {
    unwrap(await supabase.from('expense_participants').delete().eq('expense_id', expenseId).in('member_id', remove))
  }
  const exact = next.some((p) => p.share_amount !== undefined)
  if (exact) {
    // AB: every row carries its typed share (also updates members kept from before).
    if (next.length) {
      unwrap(
        await supabase.from('expense_participants').upsert(
          next.map((p) => ({ expense_id: expenseId, member_id: p.member_id, share_amount: minorToApi(p.share_amount!) })),
          { onConflict: 'expense_id,member_id' },
        ),
      )
    }
    return
  }
  const add = nextIds.filter((id) => !previous.includes(id))
  if (add.length) {
    // AA: share_amount is filled by the server trigger (remainder rule by member id).
    unwrap(await supabase.from('expense_participants').insert(add.map((member_id) => ({ expense_id: expenseId, member_id }))))
  }
}

export async function createExpense(tripId: string, input: ExpenseInput, participants: ParticipantInput[]): Promise<Expense> {
  const created = unwrap(
    await supabase
      .from('expenses')
      .insert({ ...toRow(input), trip_id: tripId })
      .select('id')
      .single(),
  ) as { id: string }
  await syncParticipants(created.id, participants, [])
  const saved = await fetchExpense(created.id)
  if (!saved) throw new ApiError('Saved expense could not be read back')
  return saved
}

export type UpdateResult = { ok: true; expense: Expense } | { ok: false; conflict: true }

/** Optimistic lock: only updates if updated_at still matches what we loaded. */
export async function updateExpense(
  existing: Expense,
  input: ExpenseInput,
  participants: ParticipantInput[],
): Promise<UpdateResult> {
  const updated = unwrap(
    await supabase
      .from('expenses')
      .update(toRow(input))
      .eq('id', existing.id)
      .eq('updated_at', existing.updated_at)
      .select('id')
      .maybeSingle(),
  )
  if (!updated) return { ok: false, conflict: true }
  await syncParticipants(
    existing.id,
    participants,
    existing.expense_participants.map((p) => p.member_id),
  )
  const saved = await fetchExpense(existing.id)
  if (!saved) throw new ApiError('Saved expense could not be read back')
  return { ok: true, expense: saved }
}

/** Soft delete only (restorable from the activity log). */
export async function softDeleteExpense(existing: Expense): Promise<'ok' | 'conflict'> {
  const row = unwrap(
    await supabase
      .from('expenses')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('updated_at', existing.updated_at)
      .select('id')
      .maybeSingle(),
  )
  return row ? 'ok' : 'conflict'
}

export async function restoreExpense(id: string): Promise<void> {
  unwrap(await supabase.from('expenses').update({ deleted_at: null }).eq('id', id))
}

export async function uploadPhoto(tripId: string, blob: Blob): Promise<string> {
  const ext = blob.type === 'image/jpeg' ? 'jpg' : (blob.type.split('/')[1] ?? 'bin')
  const path = `${tripId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false,
  })
  if (error) throw new ApiError(error.message)
  return path
}

export async function signedPhotoUrl(path: string, expiresIn = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, expiresIn)
  return error ? null : data.signedUrl
}
