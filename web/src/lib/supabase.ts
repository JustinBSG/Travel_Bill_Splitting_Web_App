import { createClient, type PostgrestError } from '@supabase/supabase-js'
import i18n from 'i18next'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** False when web/.env.local is missing; the app then shows a setup screen. */
export const supabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'missing-anon-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // OAuth (Google/Apple) PKCE return
    flowType: 'pkce',
    storageKey: 'tbs-auth',
  },
})

/** Private bucket; photos are only ever shown via signed URLs. Path: {trip_id}/{expense_id}/{uuid}.jpg */
export const PHOTO_BUCKET = 'trip-photos'

export const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) || ''

/**
 * Backend error codes (backend/README.md "Errors"). RPCs return them as the
 * PostgREST error `code`; Edge Functions as `{ error: { code, message } }`.
 * validation_error keeps the server's message, which names the field.
 */
const LOCALIZED_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'trip_locked',
  'joining_disabled',
  'conflict_updated_at',
  'share_sum_mismatch',
  'fx_rate_missing',
  'invite_invalid',
  'rate_limited',
] as const
type LocalizedCode = (typeof LOCALIZED_CODES)[number]

function localizedMessage(code: string | undefined, fallback: string): string {
  if (code && (LOCALIZED_CODES as readonly string[]).includes(code) && i18n.isInitialized) {
    return i18n.t(`apiErrors.${code as LocalizedCode}`)
  }
  return fallback
}

export class ApiError extends Error {
  code?: string
  /** conflict_updated_at: the current row as JSON text. */
  details?: string
  constructor(message: string, code?: string, details?: string) {
    super(localizedMessage(code, message))
    this.code = code
    this.details = details
  }
}

/** Throw on a PostgREST error so callers can use try/catch. */
export function unwrap<T>(res: { data: T; error: PostgrestError | null }): T {
  if (res.error) throw new ApiError(res.error.message, res.error.code, res.error.details ?? undefined)
  return res.data
}

/** POST /rest/v1/rpc/<fn>; throws ApiError with the backend's error code. */
export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  return unwrap(await supabase.rpc(fn, args)) as T
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof ApiError && e.code === '23505'
}

/** Readable error from an Edge Function call ({ error: { code, message } } body). */
export async function functionErrorMessage(
  error: unknown,
): Promise<{ message: string; status?: number; code?: string }> {
  const ctx = (error as { context?: unknown })?.context
  if (ctx instanceof Response) {
    const status = ctx.status
    try {
      const body = await ctx.clone().json()
      const err = body?.error
      if (err && typeof err === 'object' && typeof err.message === 'string') {
        const code = typeof err.code === 'string' ? err.code : undefined
        return { message: localizedMessage(code, err.message), status, code }
      }
      const msg = err ?? body?.message
      if (typeof msg === 'string') return { message: msg, status }
    } catch {
      /* not JSON */
    }
    return { message: ctx.statusText || `HTTP ${status}`, status }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}
