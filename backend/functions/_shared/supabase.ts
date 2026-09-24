// Service-role client and caller verification for the Edge Functions.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the Supabase
// runtime; the service role never leaves the function.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

let admin: SupabaseClient | null = null

export function env(name: string): string | undefined {
  const v = Deno.env.get(name)
  return v && v.trim() ? v.trim() : undefined
}

export function requireEnv(name: string): string {
  const v = env(name)
  if (!v) throw new Error(`Missing environment variable ${name}`)
  return v
}

export function adminClient(): SupabaseClient {
  admin ??= createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return admin
}

/** The signed-in (non-anonymous) user behind the request's Bearer token, or null. */
export async function verifiedUserId(req: Request): Promise<string | null> {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '')
  if (!match) return null
  const { data, error } = await adminClient().auth.getUser(match[1])
  if (error || !data.user || data.user.is_anonymous) return null
  return data.user.id
}
