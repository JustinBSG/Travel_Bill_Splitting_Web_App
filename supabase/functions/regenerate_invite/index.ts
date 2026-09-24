// POST /functions/v1/regenerate_invite               (verify_jwt = true)
//
// Body   { "trip_id": "<uuid>" }      caller must be a trip admin
// 200    { invite_token, invite_code, join_path }
// Errors { error: { code, message } }  401 · 403 forbidden · 422 · 423 trip_locked
//
// Token and code rotate in one transaction; the old link and code stop
// working the moment it commits. The activity log records the rotation
// without either secret.
import { apiError, corsHeaders, json, parseAllowedOrigins, readJsonObject, STATUS_BY_CODE, UUID_RE } from '../_shared/http.ts'
import { adminClient, env, verifiedUserId } from '../_shared/supabase.ts'

const allowedOrigins = parseAllowedOrigins(env('ALLOWED_ORIGINS'))

Deno.serve(async (req) => {
  const cors = corsHeaders(req, allowedOrigins)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return apiError('validation_error', 'Use POST', 405, cors)

  try {
    const userId = await verifiedUserId(req)
    if (!userId) return apiError('unauthenticated', 'Sign in first', 401, cors)

    const body = await readJsonObject(req)
    const tripId = body?.trip_id
    if (typeof tripId !== 'string' || !UUID_RE.test(tripId)) {
      return apiError('validation_error', 'trip_id must be a uuid', 422, cors)
    }

    const { data, error } = await adminClient().rpc('regenerate_invite_as', { p_user_id: userId, p_trip_id: tripId })
    if (error) {
      const status = STATUS_BY_CODE[error.code]
      if (status) return apiError(error.code, error.message, status, cors)
      throw new Error(`regenerate_invite_as: ${error.code} ${error.message}`)
    }
    return json(data, 200, cors)
  } catch (e) {
    console.error('regenerate_invite failed:', e instanceof Error ? e.message : String(e))
    return apiError('internal_error', 'Something went wrong. Please try again.', 500, cors)
  }
})
