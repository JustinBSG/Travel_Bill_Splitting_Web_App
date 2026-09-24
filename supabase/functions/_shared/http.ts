// HTTP helpers shared by the Edge Functions: CORS for the Pages origins and
// the §8 error envelope { "error": { "code", "message" } }.
// Runtime-neutral (no Deno globals) so the unit tests can run it on Node.

const ALLOWED_HEADERS = 'authorization, apikey, x-client-info, content-type, x-retry-count'
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

/**
 * ALLOWED_ORIGINS is a comma-separated list of exact origins and/or
 * wildcard origins. A `*` matches letters, digits and hyphens inside ONE
 * host label (never a dot), e.g.
 *   https://*.example.workers.dev                      any single subdomain
 *   https://*-my-worker.example.workers.dev            this Worker's previews
 * Unset -> local Vite dev origins only.
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  const list = (value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  return list.length ? list : DEV_ORIGINS
}

function wildcardToRegExp(rule: string): RegExp {
  const escaped = rule.replace(/[.+?^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')
  return new RegExp(`^${escaped}$`, 'i')
}

export function originAllowed(origin: string, allowed: string[]): boolean {
  for (const rule of allowed) {
    if (rule === origin) return true
    if (rule.includes('*') && wildcardToRegExp(rule).test(origin)) return true
  }
  return false
}

export function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  const origin = req.headers.get('Origin')
  if (origin && originAllowed(origin, allowed)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function apiError(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, headers)
}

/** Parse a JSON object body; null when the body is not a JSON object. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** HTTP status for each §8 error code raised by the database. */
export const STATUS_BY_CODE: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  trip_locked: 423,
  joining_disabled: 403,
  conflict_updated_at: 409,
  share_sum_mismatch: 422,
  fx_rate_missing: 422,
  invite_invalid: 404,
  rate_limited: 429,
  validation_error: 422,
}
