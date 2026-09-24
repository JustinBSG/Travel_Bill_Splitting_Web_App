// Shared setup for the live end-to-end tests (real Supabase over HTTP).
// Settings come from the environment or supabase/node-tests/.env.live
// (git-ignored; copy .env.live.example).
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const envFile = fileURLToPath(new URL('../.env.live', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

const env = (name) => process.env[name]?.trim() || undefined

export const cfg = {
  url: env('SUPABASE_URL')?.replace(/\/+$/, ''),
  anonKey: env('SUPABASE_ANON_KEY'),
  serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  cronSecret: env('CRON_SECRET'),
  pushSecret: env('PUSH_WEBHOOK_SECRET'),
  allowedOrigin: env('LIVE_ALLOWED_ORIGIN'),
  runFx: env('LIVE_RUN_FX') === '1',
  allowRemote: env('LIVE_ALLOW_REMOTE') === '1',
  emailDomain: env('LIVE_EMAIL_DOMAIN') ?? 'example.com',
  joinMaxFailures: Number(env('LIVE_JOIN_MAX_FAILURES') ?? 10),
}

const isLocal = !!cfg.url && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.url)
const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !env(k))

/** Why the live suite can't run here, or false. It writes users and trips, so remote targets need opt-in. */
export const skipReason = missing.length
  ? `live tests need ${missing.join(', ')} (see supabase/DEPLOY.md)`
  : !isLocal && !cfg.allowRemote
    ? `${cfg.url} is not local: set LIVE_ALLOW_REMOTE=1 to run against a staging project (never production)`
    : false

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export const admin = skipReason ? null : createClient(cfg.url, cfg.serviceKey, clientOptions)
export const anonClient = () => createClient(cfg.url, cfg.anonKey, clientOptions)

export const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * A real signed-in user without sending email: the admin API creates the user
 * and mints an email OTP, which is then verified exactly like the 6-digit
 * code the app asks for.
 */
export async function newUser(label, displayName = label) {
  const email = `e2e-${runId}-${label}@${cfg.emailDomain}`
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  })
  if (created.error) throw created.error
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (link.error) throw link.error
  const client = anonClient()
  const session = await client.auth.verifyOtp({ email, token: link.data.properties.email_otp, type: 'email' })
  if (session.error) throw session.error
  await client.realtime.setAuth(session.data.session.access_token)
  return { id: created.data.user.id, email, client, token: session.data.session.access_token }
}

/** POST /functions/v1/<name>; returns status, parsed JSON body and headers. */
export async function callFunction(name, { token, body, method = 'POST', headers = {} } = {}) {
  const res = await fetch(`${cfg.url}/functions/v1/${name}`, {
    method,
    headers: {
      apikey: cfg.anonKey,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* empty or non-JSON body */
  }
  return { status: res.status, body: json, headers: res.headers }
}

/** Today's date in Asia/Hong_Kong plus n days, as YYYY-MM-DD. */
export function hkDate(plusDays = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date())
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + plusDays)
  return d.toISOString().slice(0, 10)
}
