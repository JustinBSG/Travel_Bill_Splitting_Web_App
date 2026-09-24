// Unit tests for the runtime-neutral Edge Function modules (run on Node,
// which strips the TypeScript types on import).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addDays, hongKongDate, parseRatesJson, providerFromEnv } from '../../functions/_shared/fx_providers.ts'
import { corsHeaders, originAllowed, parseAllowedOrigins, safeEqual } from '../../functions/_shared/http.ts'
import { buildPushMessage } from '../../functions/_shared/push_messages.ts'
import {
  b64urlDecode,
  b64urlEncode,
  encryptPayload,
  importP256PrivateKey,
  sendWebPush,
  vapidAuthorization,
} from '../../functions/_shared/webpush.ts'

const enc = new TextEncoder()

// RFC 8291 §5 / Appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

/** Receiver side of RFC 8291 (for round-trip tests with random keys). */
async function decrypt(body, uaPublic, uaPrivateKey, authSecret) {
  const salt = body.slice(0, 16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivateKey, 256))
  const hkdf = async (s, ikm, info, len) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, len * 8))
  }
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic])
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext))
  assert.equal(padded.at(-1), 2)
  return new TextDecoder().decode(padded.slice(0, -1))
}

test('webpush: encryption matches the RFC 8291 test vector byte for byte', async () => {
  const asPublic = b64urlDecode(RFC.asPublic)
  const sender = { privateKey: await importP256PrivateKey(asPublic, b64urlDecode(RFC.asPrivate), 'ECDH'), publicKey: asPublic }
  const body = await encryptPayload(enc.encode(RFC.plaintext), b64urlDecode(RFC.uaPublic), b64urlDecode(RFC.auth), {
    salt: b64urlDecode(RFC.salt),
    sender,
  })
  assert.equal(b64urlEncode(body), RFC.message)
})

test('webpush: random-key messages decrypt on the receiver side', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const text = JSON.stringify({ title: '大阪', body: 'Alex 新增了「拉麵」· 3,000 JPY', url: '/trips/x' })
  const body = await encryptPayload(enc.encode(text), uaPublic, auth)
  assert.equal(await decrypt(body, uaPublic, ua.privateKey, auth), text)
  await assert.rejects(encryptPayload(new Uint8Array(5000), uaPublic, auth), /too large/)
})

test('webpush: VAPID header is a valid ES256 JWT for the endpoint origin', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const vapid = { publicKey: b64urlEncode(publicRaw), privateKey: jwk.d, subject: 'mailto:ops@example.com' }

  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 1_700_000_000_000)
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
  assert.ok(m)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(m[1]))), { typ: 'JWT', alg: 'ES256' })
  assert.deepEqual(JSON.parse(new TextDecoder().decode(b64urlDecode(m[2]))), {
    aud: 'https://fcm.googleapis.com',
    exp: 1_700_000_000 + 12 * 3600,
    sub: 'mailto:ops@example.com',
  })
  assert.equal(m[4], vapid.publicKey)
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    b64urlDecode(m[3]),
    enc.encode(`${m[1]}.${m[2]}`),
  )
  assert.equal(ok, true)
})

test('webpush: sendWebPush posts an aes128gcm body and flags gone subscriptions', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const signer = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const vapid = {
    publicKey: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', signer.publicKey))),
    privateKey: (await crypto.subtle.exportKey('jwk', signer.privateKey)).d,
    subject: 'mailto:ops@example.com',
  }
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return new Response(null, { status: 410 })
  }
  const sub = { endpoint: 'https://push.example.net/abc', keys: { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(auth) } }
  const res = await sendWebPush(sub, '{"title":"t","body":"b","url":"/"}', vapid, { fetchImpl })
  assert.deepEqual(res, { status: 410, ok: false, gone: true })
  assert.equal(seen.url, sub.endpoint)
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm')
  assert.equal(seen.init.headers.TTL, '86400')
  assert.match(seen.init.headers.Authorization, /^vapid t=/)
  assert.equal(await decrypt(seen.init.body, uaPublic, ua.privateKey, auth), '{"title":"t","body":"b","url":"/"}')
})

test('push messages: language, fields and deep links', () => {
  const base = { user_id: 'u', trip_id: 't1', payload: { trip_name: 'Osaka', actor_name: 'Alex', title: 'Ramen', amount_display: '3,000 JPY', expense_id: 'e1' } }
  assert.deepEqual(buildPushMessage({ ...base, type: 'expense_added' }, 'en'), {
    title: 'Osaka',
    body: 'Alex added “Ramen” · 3,000 JPY',
    url: '/trips/t1/expense/e1',
  })
  assert.deepEqual(buildPushMessage({ ...base, type: 'expense_deleted' }, 'zh-Hant'), {
    title: 'Osaka',
    body: 'Alex 刪除了「Ramen」',
    url: '/trips/t1/activity',
  })
  const claimed = buildPushMessage(
    { user_id: 'u', trip_id: 't1', type: 'placeholder_claimed', payload: { member_name: 'Mary', placeholder_name: 'Grandma' } },
    null,
  )
  assert.equal(claimed.body, 'Mary joined as “Grandma”')
  assert.equal(claimed.title, 'Travel Bill Split')
  assert.equal(buildPushMessage({ user_id: 'u', trip_id: null, type: 'trip_locked', payload: {} }, 'zh-Hant').body, '有人 已鎖定行程，結算已定案。')
})

test('fx: numbers keep their exact source text; providers map vendor payloads', async () => {
  assert.deepEqual(parseRatesJson('{"rates":{"KRW":1350.123456789012345678,"HKD":7.78}}'), {
    rates: { KRW: '1350.123456789012345678', HKD: '7.78' },
  })

  const calls = []
  const fake = (payload) => async (url) => {
    calls.push(url)
    return new Response(payload, { status: 200 })
  }
  const oxr = providerFromEnv(
    (k) => ({ FX_API_BASE: 'https://openexchangerates.org/api', FX_API_KEY: 'k&y' })[k],
    fake('{"base":"USD","rates":{"HKD":7.7812,"JPY":149.5,"bad":1}}'),
  )
  assert.equal(oxr.name, 'openexchangerates')
  assert.deepEqual(await oxr.latest(), { base: 'USD', rates: { HKD: '7.7812', JPY: '149.5' }, source: 'openexchangerates' })
  await oxr.historical('2026-09-23')
  assert.deepEqual(calls, [
    'https://openexchangerates.org/api/latest.json?app_id=k%26y',
    'https://openexchangerates.org/api/historical/2026-09-23.json?app_id=k%26y',
  ])

  const era = providerFromEnv(
    (k) => ({ FX_PROVIDER: 'exchangerate-api', FX_API_KEY: 'abc' })[k],
    fake('{"result":"success","base_code":"HKD","conversion_rates":{"HKD":1,"JPY":19.2}}'),
  )
  assert.deepEqual(await era.latest(), { base: 'HKD', rates: { HKD: '1', JPY: '19.2' }, source: 'exchangerate-api' })

  const fr = providerFromEnv((k) => ({ FX_PROVIDER: 'frankfurter' })[k], fake('{"base":"HKD","rates":{"EUR":0.1146}}'))
  assert.deepEqual((await fr.latest()).rates, { EUR: '0.1146' })

  assert.throws(() => providerFromEnv(() => undefined), /not configured/)
  await assert.rejects(providerFromEnv((k) => ({ FX_PROVIDER: 'openexchangerates' })[k]).latest(), /FX_API_KEY/)

  // the key never leaks through a network error message
  const failing = providerFromEnv(
    (k) => ({ FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'sekret' })[k],
    async (url) => {
      throw new TypeError(`error sending request for url (${url})`)
    },
  )
  await assert.rejects(failing.latest(), (e) => !e.message.includes('sekret') && e.message.includes('***'))
})

test('fx: dates are Hong Kong dates', () => {
  assert.equal(hongKongDate(new Date('2026-09-23T16:30:00Z')), '2026-09-24')
  assert.equal(hongKongDate(new Date('2026-09-23T15:30:00Z')), '2026-09-23')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('http: CORS allows only configured origins (incl. preview wildcards); safeEqual', () => {
  const allowed = parseAllowedOrigins('https://tbs.pages.dev, https://*.tbs.pages.dev ,https://trip.example.com/')
  assert.ok(originAllowed('https://tbs.pages.dev', allowed))
  assert.ok(originAllowed('https://abc123.tbs.pages.dev', allowed))
  assert.ok(originAllowed('https://trip.example.com', allowed))
  assert.ok(!originAllowed('https://evil.dev', allowed))
  assert.ok(!originAllowed('https://a.b.tbs.pages.dev', allowed))
  assert.ok(!originAllowed('http://abc.tbs.pages.dev', allowed))
  const preview = parseAllowedOrigins('http://localhost:5173,https://*-travel-bill-splitting-web-app.justin610810.workers.dev')
  assert.ok(originAllowed('https://uat-travel-bill-splitting-web-app.justin610810.workers.dev', preview))
  assert.ok(originAllowed('https://1a2b3c4d-travel-bill-splitting-web-app.justin610810.workers.dev', preview))
  assert.ok(!originAllowed('https://travel-bill-splitting-web-app.justin610810.workers.dev', preview))
  assert.ok(!originAllowed('https://uat-other-worker.justin610810.workers.dev', preview))
  assert.ok(!originAllowed('https://evil.com/x-travel-bill-splitting-web-app.justin610810.workers.dev', preview))
  assert.ok(!originAllowed('https://a.b-travel-bill-splitting-web-app.justin610810.workers.dev', preview))
  assert.deepEqual(parseAllowedOrigins(undefined), ['http://localhost:5173', 'http://127.0.0.1:5173'])

  const req = (origin) => new Request('https://x.supabase.co/functions/v1/join_trip', { headers: { Origin: origin } })
  assert.equal(corsHeaders(req('https://tbs.pages.dev'), allowed)['Access-Control-Allow-Origin'], 'https://tbs.pages.dev')
  assert.equal(corsHeaders(req('https://evil.dev'), allowed)['Access-Control-Allow-Origin'], undefined)
  assert.match(corsHeaders(req('https://evil.dev'), allowed)['Access-Control-Allow-Headers'], /x-retry-count/)

  assert.ok(safeEqual('abc', 'abc'))
  assert.ok(!safeEqual('abc', 'abd'))
  assert.ok(!safeEqual('abc', 'abcd'))
  assert.ok(!safeEqual(undefined, undefined))
  assert.ok(!safeEqual('', ''))
})
