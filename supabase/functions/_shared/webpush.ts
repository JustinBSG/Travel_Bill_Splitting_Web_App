// Web Push sender on WebCrypto only (no third-party crypto):
//   RFC 8291  message encryption (aes128gcm, RFC 8188 single record)
//   RFC 8292  VAPID (ES256 JWT, "vapid t=..., k=..." Authorization)
// Runtime-neutral: works on Deno (Edge Functions) and Node (unit tests,
// verified against the RFC 8291 Appendix A test vector).

const enc = new TextEncoder()

/** Bytes backed by a plain ArrayBuffer (what WebCrypto and fetch accept). */
type Bytes = Uint8Array<ArrayBuffer>

export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface VapidKeys {
  /** base64url uncompressed P-256 public key (65 bytes), as from `web-push generate-vapid-keys` */
  publicKey: string
  /** base64url 32-byte private scalar */
  privateKey: string
  /** mailto: or https: contact, required by push services */
  subject: string
}

export function b64urlDecode(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8)
  return new Uint8Array(bits)
}

/** Import a raw P-256 private scalar (with its public point) for ECDH or ECDSA. */
export function importP256PrivateKey(publicRaw: Bytes, privateRaw: Bytes, alg: 'ECDH' | 'ECDSA') {
  if (publicRaw.length !== 65 || publicRaw[0] !== 4 || privateRaw.length !== 32) {
    throw new Error('Expected a 65-byte uncompressed P-256 public key and a 32-byte private key')
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(privateRaw),
    x: b64urlEncode(publicRaw.slice(1, 33)),
    y: b64urlEncode(publicRaw.slice(33, 65)),
    ext: true,
  }
  return crypto.subtle.importKey('jwk', jwk, { name: alg, namedCurve: 'P-256' }, false, [
    alg === 'ECDH' ? 'deriveBits' : 'sign',
  ])
}

export interface EncryptOptions {
  /** Fixed salt / sender key pair: only for reproducing test vectors. */
  salt?: Bytes
  sender?: { privateKey: CryptoKey; publicKey: Bytes }
  recordSize?: number
}

/** RFC 8291 §3.4: encrypt one push message into an aes128gcm body. */
export async function encryptPayload(
  plaintext: Bytes,
  uaPublic: Bytes,
  authSecret: Bytes,
  opts: EncryptOptions = {},
): Promise<Bytes> {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes')
  const recordSize = opts.recordSize ?? 4096
  if (plaintext.length + 17 > recordSize) throw new Error('Push payload is too large')

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
  let sender = opts.sender
  if (!sender) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair
    sender = {
      privateKey: pair.privateKey,
      publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    }
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sender.privateKey, 256),
  )
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, sender.publicKey)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const padded = concat(plaintext, new Uint8Array([2])) // last-record delimiter
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded))

  // header: salt(16) | record size(4, BE) | idlen(1) | keyid = sender public key
  const header = new Uint8Array(21 + sender.publicKey.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, recordSize)
  header[20] = sender.publicKey.length
  header.set(sender.publicKey, 21)
  return concat(header, ciphertext)
}

/** RFC 8292: `Authorization: vapid t=<ES256 JWT>, k=<public key>` for this endpoint's origin. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(
    enc.encode(
      JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject }),
    ),
  )
  const key = await importP256PrivateKey(b64urlDecode(vapid.publicKey), b64urlDecode(vapid.privateKey), 'ECDSA')
  // WebCrypto ECDSA signatures are already raw r||s, the JWS ES256 format
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)),
  )
  return `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${vapid.publicKey}`
}

export interface PushResult {
  status: number
  ok: boolean
  /** The subscription no longer exists (404/410): delete it. */
  gone: boolean
}

export async function sendWebPush(
  subscription: PushSubscriptionJson,
  payload: string,
  vapid: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
  const body = await encryptPayload(
    enc.encode(payload),
    b64urlDecode(subscription.keys.p256dh),
    b64urlDecode(subscription.keys.auth),
  )
  const res = await (opts.fetchImpl ?? fetch)(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttlSeconds ?? 86400),
      Urgency: opts.urgency ?? 'normal',
    },
    body,
  })
  await res.body?.cancel()
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410 }
}
