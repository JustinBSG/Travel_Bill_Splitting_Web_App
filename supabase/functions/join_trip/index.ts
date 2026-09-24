// POST /functions/v1/join_trip                       (verify_jwt = true)
//
// Body   { "code": "K7P2QX" } | { "token": "<long>" }
//        optional "claim_placeholder_id": "<trip_members.id>"
//        optional "preview": true   -> trip + open placeholders, joins nothing
// 200    { trip_id, member_id, claimed }
//        preview: { trip_id, trip: {id,name,start_date,end_date},
//                   placeholders: [{id, display_name}], already_member, joining_enabled }
// Errors { error: { code, message } }
//        401 unauthenticated · 403 joining_disabled | trip_locked · 404 invite_invalid
//        422 validation_error · 429 rate_limited
//
// Everything after JWT verification happens in ONE database transaction
// (public.join_trip_as): rate limit, invite lookup, idempotent membership,
// placeholder claim on the same trip_members.id, activity log, notifications.
import { apiError, corsHeaders, json, parseAllowedOrigins, readJsonObject, UUID_RE } from '../_shared/http.ts'
import { adminClient, env, verifiedUserId } from '../_shared/supabase.ts'

const allowedOrigins = parseAllowedOrigins(env('ALLOWED_ORIGINS'))

function intEnv(name: string, fallback: number): number {
  const n = Number(env(name))
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** HMAC of the client IP: rate limiting per network without storing raw IPs. */
async function clientHash(req: Request): Promise<string | null> {
  const ip =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip')
  if (!ip) return null
  const secret = env('JOIN_RATE_LIMIT_SALT') ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? 'join_trip'
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip)))
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req, allowedOrigins)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return apiError('validation_error', 'Use POST', 405, cors)

  try {
    const userId = await verifiedUserId(req)
    if (!userId) return apiError('unauthenticated', 'Sign in first', 401, cors)

    const body = await readJsonObject(req)
    const code = typeof body?.code === 'string' && body.code.trim() ? body.code : null
    const token = typeof body?.token === 'string' && body.token.trim() ? body.token : null
    if (!body || (code === null) === (token === null) || (code?.length ?? 0) > 16 || (token?.length ?? 0) > 128) {
      return apiError('validation_error', 'Send either "code" or "token"', 422, cors)
    }
    const claim = body.claim_placeholder_id ?? null
    if (claim !== null && (typeof claim !== 'string' || !UUID_RE.test(claim))) {
      return apiError('validation_error', 'claim_placeholder_id must be a uuid', 422, cors)
    }

    const { data, error } = await adminClient().rpc('join_trip_as', {
      p_user_id: userId,
      p_code: code,
      p_token: token,
      p_claim_placeholder_id: claim,
      p_preview: body.preview === true,
      p_client_hash: await clientHash(req),
      p_max_user_failures: intEnv('JOIN_RATE_LIMIT_MAX_FAILURES', 10),
      p_max_client_failures: intEnv('JOIN_RATE_LIMIT_MAX_FAILURES_PER_IP', 30),
      p_window_minutes: intEnv('JOIN_RATE_LIMIT_WINDOW_MINUTES', 15),
    })
    if (error) throw new Error(`join_trip_as: ${error.code} ${error.message}`)

    const { ok, status, code: errorCode, message, ...result } = (data ?? {}) as Record<string, unknown>
    if (ok !== true) {
      return apiError(String(errorCode ?? 'internal_error'), String(message ?? 'Join failed'), Number(status) || 500, cors)
    }
    return json(result, 200, cors)
  } catch (e) {
    console.error('join_trip failed:', e instanceof Error ? e.message : String(e))
    return apiError('internal_error', 'Something went wrong. Please try again.', 500, cors)
  }
})
