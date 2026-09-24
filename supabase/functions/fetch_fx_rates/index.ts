// POST /functions/v1/fetch_fx_rates                  (verify_jwt = false)
//
// Not a user API. Called daily by pg_cron (header x-cron-secret: CRON_SECRET)
// or by an operator with the service role key as Bearer token.
//
// Body (optional)
//   {}                        store today's rates (Asia/Hong_Kong date) unless
//                             already stored; backfill yesterday if missing
//   { "force": true }         refetch today even if stored
//   { "date": "YYYY-MM-DD" }  backfill one past date (vendor historical API)
// 200  { provider, results: [{ rate_date, currencies_stored, missing[] } | { rate_date, skipped | error }] }
//
// Vendor: FX_PROVIDER / FX_API_BASE / FX_API_KEY (see _shared/fx_providers.ts).
// Conversion to HKD and inversion happen in Postgres numeric (upsert_fx_rates).
import { addDays, hongKongDate, providerFromEnv, type FxSnapshot } from '../_shared/fx_providers.ts'
import { apiError, json, readJsonObject, safeEqual } from '../_shared/http.ts'
import { adminClient, env } from '../_shared/supabase.ts'

function authorized(req: Request): boolean {
  if (safeEqual(req.headers.get('x-cron-secret'), env('CRON_SECRET'))) return true
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '')?.[1]
  return safeEqual(bearer, env('SUPABASE_SERVICE_ROLE_KEY'))
}

async function hasRates(date: string): Promise<boolean> {
  const { count, error } = await adminClient()
    .from('fx_rates')
    .select('base_currency', { count: 'exact', head: true })
    .eq('rate_date', date)
    .eq('quote_currency', 'HKD')
  if (error) throw new Error(`fx_rates lookup failed: ${error.message}`)
  return (count ?? 0) > 0
}

async function store(date: string, snap: FxSnapshot): Promise<Record<string, unknown>> {
  const { data, error } = await adminClient().rpc('upsert_fx_rates', {
    p_rate_date: date,
    p_vendor_base: snap.base,
    p_rates: snap.rates,
    p_source: snap.source,
  })
  if (error) throw new Error(`upsert_fx_rates(${date}) failed: ${error.message}`)
  const result = data as { rate_date: string; missing?: string[] }
  if (result.missing?.length) console.warn(`fx ${date}: vendor has no rate for ${result.missing.join(', ')}`)
  return result
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return apiError('validation_error', 'Use POST', 405)
  if (!authorized(req)) return apiError('unauthenticated', 'Cron secret or service role required', 401)

  const body = (await readJsonObject(req)) ?? {}
  try {
    const provider = providerFromEnv(env)
    const today = hongKongDate(new Date())
    const results: Record<string, unknown>[] = []

    if (body.date !== undefined) {
      const date = body.date
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
        return apiError('validation_error', 'date must be YYYY-MM-DD and not in the future', 422)
      }
      if (date === today) {
        results.push(await store(date, await provider.latest()))
      } else if (provider.historical) {
        results.push(await store(date, await provider.historical(date)))
      } else {
        return apiError('validation_error', `${provider.name} has no historical rates`, 422)
      }
    } else {
      if (body.force === true || !(await hasRates(today))) {
        results.push(await store(today, await provider.latest()))
      } else {
        results.push({ rate_date: today, skipped: 'already stored' })
      }
      const yesterday = addDays(today, -1)
      if (provider.historical && !(await hasRates(yesterday))) {
        try {
          results.push(await store(yesterday, await provider.historical(yesterday)))
        } catch (e) {
          results.push({ rate_date: yesterday, error: e instanceof Error ? e.message : String(e) })
        }
      }
    }
    return json({ provider: provider.name, results })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('fetch_fx_rates failed:', message)
    return apiError('internal_error', message, 500)
  }
})
