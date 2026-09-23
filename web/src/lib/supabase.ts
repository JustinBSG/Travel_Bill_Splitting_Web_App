import { createClient, type PostgrestError } from '@supabase/supabase-js'

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

/** Private bucket; photos are only ever shown via signed URLs. */
export const PHOTO_BUCKET = 'expense-photos'

export const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) || ''

export class ApiError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

/** Throw on a PostgREST error so callers can use try/catch. */
export function unwrap<T>(res: { data: T; error: PostgrestError | null }): T {
  if (res.error) throw new ApiError(res.error.message, res.error.code)
  return res.data
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof ApiError && e.code === '23505'
}

/** Best-effort readable message from an Edge Function error. */
export async function functionErrorMessage(error: unknown): Promise<{ message: string; status?: number }> {
  const ctx = (error as { context?: unknown })?.context
  if (ctx instanceof Response) {
    const status = ctx.status
    try {
      const body = await ctx.clone().json()
      const msg = body?.error ?? body?.message
      if (typeof msg === 'string') return { message: msg, status }
    } catch {
      /* not JSON */
    }
    return { message: ctx.statusText || `HTTP ${status}`, status }
  }
  return { message: error instanceof Error ? error.message : String(error) }
}
