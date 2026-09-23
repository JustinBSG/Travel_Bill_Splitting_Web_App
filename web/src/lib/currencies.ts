import type { CurrencyRow } from './types'

// ISO 4217 minor units that are NOT 2. The server `currencies` table wins when
// loaded; this is only the fallback so the UI never guesses wrong for JPY/KRW.
const NON_TWO_DECIMALS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

const FALLBACK_SYMBOLS: Record<string, string> = {
  HKD: 'HK$', JPY: '¥', KRW: '₩', TWD: 'NT$', CNY: '¥', MOP: 'MOP$', USD: 'US$',
  EUR: '€', GBP: '£', THB: '฿', SGD: 'S$', MYR: 'RM', VND: '₫', PHP: '₱',
  AUD: 'A$', NZD: 'NZ$', CAD: 'C$', CHF: 'CHF', IDR: 'Rp', INR: '₹',
}

/** Currencies offered in the picker before/if the server table is unavailable. */
export const COMMON_CURRENCIES = [
  'HKD', 'JPY', 'KRW', 'TWD', 'CNY', 'MOP', 'THB', 'SGD', 'MYR', 'VND', 'PHP',
  'IDR', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'INR',
]

let registry = new Map<string, CurrencyRow>()

export function registerCurrencies(rows: CurrencyRow[]) {
  registry = new Map(rows.map((r) => [r.code.toUpperCase(), r]))
}

export function currencyDecimals(code: string): number {
  const c = code.toUpperCase()
  const row = registry.get(c)
  if (row && Number.isInteger(row.decimals)) return row.decimals
  return NON_TWO_DECIMALS[c] ?? 2
}

export function currencySymbol(code: string): string {
  const c = code.toUpperCase()
  return registry.get(c)?.symbol || FALLBACK_SYMBOLS[c] || c
}

export function knownCurrencies(): string[] {
  const codes = new Set<string>(COMMON_CURRENCIES)
  for (const c of registry.keys()) codes.add(c)
  return [...codes].sort((a, b) => (a === 'HKD' ? -1 : b === 'HKD' ? 1 : a.localeCompare(b)))
}

// Country (ISO 3166-1 alpha-2) -> local currency. Used when a trip day's city
// is picked from Open-Meteo geocoding (which returns country_code).
const COUNTRY_CURRENCY: Record<string, string> = {
  AD: 'EUR', AE: 'AED', AF: 'AFN', AG: 'XCD', AI: 'XCD', AL: 'ALL', AM: 'AMD',
  AO: 'AOA', AR: 'ARS', AS: 'USD', AT: 'EUR', AU: 'AUD', AW: 'AWG', AX: 'EUR',
  AZ: 'AZN', BA: 'BAM', BB: 'BBD', BD: 'BDT', BE: 'EUR', BF: 'XOF', BG: 'BGN',
  BH: 'BHD', BI: 'BIF', BJ: 'XOF', BL: 'EUR', BM: 'BMD', BN: 'BND', BO: 'BOB',
  BQ: 'USD', BR: 'BRL', BS: 'BSD', BT: 'BTN', BW: 'BWP', BY: 'BYN', BZ: 'BZD',
  CA: 'CAD', CD: 'CDF', CF: 'XAF', CG: 'XAF', CH: 'CHF', CI: 'XOF', CK: 'NZD',
  CL: 'CLP', CM: 'XAF', CN: 'CNY', CO: 'COP', CR: 'CRC', CU: 'CUP', CV: 'CVE',
  CW: 'ANG', CY: 'EUR', CZ: 'CZK', DE: 'EUR', DJ: 'DJF', DK: 'DKK', DM: 'XCD',
  DO: 'DOP', DZ: 'DZD', EC: 'USD', EE: 'EUR', EG: 'EGP', ER: 'ERN', ES: 'EUR',
  ET: 'ETB', FI: 'EUR', FJ: 'FJD', FK: 'FKP', FM: 'USD', FO: 'DKK', FR: 'EUR',
  GA: 'XAF', GB: 'GBP', GD: 'XCD', GE: 'GEL', GF: 'EUR', GG: 'GBP', GH: 'GHS',
  GI: 'GIP', GL: 'DKK', GM: 'GMD', GN: 'GNF', GP: 'EUR', GQ: 'XAF', GR: 'EUR',
  GT: 'GTQ', GU: 'USD', GW: 'XOF', GY: 'GYD', HK: 'HKD', HN: 'HNL', HR: 'EUR',
  HT: 'HTG', HU: 'HUF', ID: 'IDR', IE: 'EUR', IL: 'ILS', IM: 'GBP', IN: 'INR',
  IQ: 'IQD', IR: 'IRR', IS: 'ISK', IT: 'EUR', JE: 'GBP', JM: 'JMD', JO: 'JOD',
  JP: 'JPY', KE: 'KES', KG: 'KGS', KH: 'KHR', KI: 'AUD', KM: 'KMF', KN: 'XCD',
  KP: 'KPW', KR: 'KRW', KW: 'KWD', KY: 'KYD', KZ: 'KZT', LA: 'LAK', LB: 'LBP',
  LC: 'XCD', LI: 'CHF', LK: 'LKR', LR: 'LRD', LS: 'LSL', LT: 'EUR', LU: 'EUR',
  LV: 'EUR', LY: 'LYD', MA: 'MAD', MC: 'EUR', MD: 'MDL', ME: 'EUR', MF: 'EUR',
  MG: 'MGA', MH: 'USD', MK: 'MKD', ML: 'XOF', MM: 'MMK', MN: 'MNT', MO: 'MOP',
  MP: 'USD', MQ: 'EUR', MR: 'MRU', MS: 'XCD', MT: 'EUR', MU: 'MUR', MV: 'MVR',
  MW: 'MWK', MX: 'MXN', MY: 'MYR', MZ: 'MZN', NA: 'NAD', NC: 'XPF', NE: 'XOF',
  NG: 'NGN', NI: 'NIO', NL: 'EUR', NO: 'NOK', NP: 'NPR', NR: 'AUD', NU: 'NZD',
  NZ: 'NZD', OM: 'OMR', PA: 'PAB', PE: 'PEN', PF: 'XPF', PG: 'PGK', PH: 'PHP',
  PK: 'PKR', PL: 'PLN', PM: 'EUR', PR: 'USD', PS: 'ILS', PT: 'EUR', PW: 'USD',
  PY: 'PYG', QA: 'QAR', RE: 'EUR', RO: 'RON', RS: 'RSD', RU: 'RUB', RW: 'RWF',
  SA: 'SAR', SB: 'SBD', SC: 'SCR', SD: 'SDG', SE: 'SEK', SG: 'SGD', SH: 'SHP',
  SI: 'EUR', SK: 'EUR', SL: 'SLE', SM: 'EUR', SN: 'XOF', SO: 'SOS', SR: 'SRD',
  SS: 'SSP', ST: 'STN', SV: 'USD', SX: 'ANG', SY: 'SYP', SZ: 'SZL', TC: 'USD',
  TD: 'XAF', TG: 'XOF', TH: 'THB', TJ: 'TJS', TL: 'USD', TM: 'TMT', TN: 'TND',
  TO: 'TOP', TR: 'TRY', TT: 'TTD', TV: 'AUD', TW: 'TWD', TZ: 'TZS', UA: 'UAH',
  UG: 'UGX', US: 'USD', UY: 'UYU', UZ: 'UZS', VA: 'EUR', VC: 'XCD', VE: 'VES',
  VG: 'USD', VI: 'USD', VN: 'VND', VU: 'VUV', WF: 'XPF', WS: 'WST', XK: 'EUR',
  YE: 'YER', YT: 'EUR', ZA: 'ZAR', ZM: 'ZMW', ZW: 'ZWL',
}

export function currencyForCountry(countryCode: string | null | undefined): string {
  if (!countryCode) return 'HKD'
  return COUNTRY_CURRENCY[countryCode.toUpperCase()] ?? 'USD'
}
