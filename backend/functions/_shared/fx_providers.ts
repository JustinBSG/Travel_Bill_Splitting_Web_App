// Mid-market FX vendors for fetch_fx_rates. Each adapter returns the vendor's
// base currency and its rates as DECIMAL STRINGS taken verbatim from the
// response text; the database does all conversion / inversion in numeric.
// Runtime-neutral (env and fetch are injected) so it is unit-testable on Node.

export interface FxSnapshot {
  /** 1 base = rates[CODE] CODE */
  base: string
  rates: Record<string, string>
  source: string
}

export interface FxProvider {
  name: string
  latest(): Promise<FxSnapshot>
  /** Rates for a past date, when the vendor/plan supports it. */
  historical?(date: string): Promise<FxSnapshot>
}

type Env = (name: string) => string | undefined

/**
 * JSON.parse that keeps numbers as their exact source text (V8's JSON.parse
 * source-text access). Falls back to the shortest round-trip form, which
 * equals the source for the ≤17-significant-digit values vendors send.
 */
export function parseRatesJson(text: string): Record<string, unknown> {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? (context?.source ?? String(value)) : value
  return JSON.parse(text, reviver as (this: unknown, key: string, value: unknown) => unknown)
}

function rateMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') throw new Error('FX response has no rates object')
  const out: Record<string, string> = {}
  for (const [code, rate] of Object.entries(value as Record<string, unknown>)) {
    if (/^[A-Z]{3}$/.test(code) && typeof rate === 'string' && /^[0-9.eE+-]+$/.test(rate)) out[code] = rate
  }
  return out
}

/** Runtime fetch errors quote the URL, and two vendors put the key in it. */
function redact(message: string, secret: string | undefined): string {
  if (!secret) return message
  return message.split(secret).join('***').split(encodeURIComponent(secret)).join('***')
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  label: string,
  secret?: string,
): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  } catch (e) {
    throw new Error(`${label} request failed: ${redact(e instanceof Error ? e.message : String(e), secret)}`)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`${label} responded HTTP ${res.status}`)
  return parseRatesJson(text)
}

export function providerFromEnv(env: Env, fetchImpl: typeof fetch = fetch): FxProvider {
  const configured = env('FX_PROVIDER')?.toLowerCase()
  const baseUrl = env('FX_API_BASE')?.replace(/\/+$/, '')
  const key = env('FX_API_KEY')
  const host = baseUrl ? new URL(baseUrl).hostname : ''
  const name =
    configured ??
    (host.includes('openexchangerates')
      ? 'openexchangerates'
      : host.includes('exchangerate-api')
        ? 'exchangerate-api'
        : host.includes('frankfurter')
          ? 'frankfurter'
          : undefined)

  const needKey = () => {
    if (!key) throw new Error(`FX_API_KEY is required for ${name}`)
    return key
  }

  switch (name) {
    case 'openexchangerates': {
      // Free plan: USD base, latest + historical/{date}.json
      const base = baseUrl ?? 'https://openexchangerates.org/api'
      const snap = (body: Record<string, unknown>): FxSnapshot => ({
        base: String(body.base ?? 'USD').toUpperCase(),
        rates: rateMap(body.rates),
        source: 'openexchangerates',
      })
      return {
        name,
        latest: async () =>
          snap(await getJson(fetchImpl, `${base}/latest.json?app_id=${encodeURIComponent(needKey())}`, name, key)),
        historical: async (date) =>
          snap(await getJson(fetchImpl, `${base}/historical/${date}.json?app_id=${encodeURIComponent(needKey())}`, name, key)),
      }
    }
    case 'exchangerate-api': {
      // v6: HKD base; history endpoints need a paid plan
      const base = baseUrl ?? 'https://v6.exchangerate-api.com/v6'
      const snap = (body: Record<string, unknown>): FxSnapshot => {
        if (body.result !== 'success') throw new Error(`exchangerate-api error: ${String(body['error-type'] ?? 'unknown')}`)
        return { base: String(body.base_code ?? 'HKD').toUpperCase(), rates: rateMap(body.conversion_rates), source: 'exchangerate-api' }
      }
      return {
        name,
        latest: async () => snap(await getJson(fetchImpl, `${base}/${encodeURIComponent(needKey())}/latest/HKD`, name, key)),
        historical: async (date) => {
          const [y, m, d] = date.split('-').map(Number)
          return snap(await getJson(fetchImpl, `${base}/${encodeURIComponent(needKey())}/history/HKD/${y}/${m}/${d}`, name, key))
        },
      }
    }
    case 'frankfurter': {
      // ECB data, no key, limited currency coverage (reported as "missing")
      const base = baseUrl ?? 'https://api.frankfurter.dev/v1'
      const snap = (body: Record<string, unknown>): FxSnapshot => ({
        base: String(body.base ?? 'HKD').toUpperCase(),
        rates: rateMap(body.rates),
        source: 'frankfurter',
      })
      return {
        name,
        latest: async () => snap(await getJson(fetchImpl, `${base}/latest?base=HKD`, name)),
        historical: async (date) => snap(await getJson(fetchImpl, `${base}/${date}?base=HKD`, name)),
      }
    }
    default:
      throw new Error('FX provider not configured: set FX_PROVIDER (openexchangerates | exchangerate-api | frankfurter) or FX_API_BASE')
  }
}

/** Today's date in Asia/Hong_Kong as YYYY-MM-DD (rates are stored per HK date). */
export function hongKongDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
