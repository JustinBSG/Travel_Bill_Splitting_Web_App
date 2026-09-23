// join_trip Edge Function client.
//
// Contract used by the UI (GAP: confirm with backend):
//   join_trip({ token | code, preview: true })
//     -> { trip: {id,name,start_date,end_date}, placeholders: [{id, display_name}],
//          already_member: boolean, joining_enabled: boolean }
//        (must NOT join; lets the user choose "new member" vs "claim")
//   join_trip({ token | code, claim_placeholder_id? })
//     -> { trip_id }
import { functionErrorMessage, supabase } from '../../lib/supabase'

/** 6 chars, no 0/O/1/I. */
export const JOIN_CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/

export function normalizeJoinCode(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)
}

export type JoinTarget = { token: string } | { code: string }

export interface JoinPreview {
  trip: { id: string; name: string; start_date: string; end_date: string } | null
  placeholders: { id: string; display_name: string }[]
  alreadyMember: boolean
  joiningEnabled: boolean
}

export class JoinError extends Error {
  kind: 'invalid' | 'disabled' | 'rate_limited' | 'other'
  constructor(kind: JoinError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('join_trip', { body })
  if (error) {
    const { message, status } = await functionErrorMessage(error)
    const kind = status === 404 ? 'invalid' : status === 403 ? 'disabled' : status === 429 ? 'rate_limited' : 'other'
    throw new JoinError(kind, message)
  }
  return (data ?? {}) as Record<string, unknown>
}

export async function previewJoin(target: JoinTarget): Promise<JoinPreview> {
  const d = await call({ ...target, preview: true })
  const trip = (d.trip ?? null) as JoinPreview['trip']
  return {
    trip,
    placeholders: Array.isArray(d.placeholders) ? (d.placeholders as JoinPreview['placeholders']) : [],
    alreadyMember: Boolean(d.already_member ?? d.alreadyMember),
    joiningEnabled: d.joining_enabled === undefined ? true : Boolean(d.joining_enabled),
  }
}

/** Returns the trip id the user now belongs to. */
export async function joinTrip(target: JoinTarget, claimPlaceholderId?: string): Promise<string> {
  const d = await call(claimPlaceholderId ? { ...target, claim_placeholder_id: claimPlaceholderId } : { ...target })
  const tripId = (d.trip_id ?? (d.trip as { id?: string } | undefined)?.id ?? d.tripId) as string | undefined
  if (!tripId) throw new JoinError('other', 'join_trip returned no trip_id')
  return tripId
}
