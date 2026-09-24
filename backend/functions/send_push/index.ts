// POST /functions/v1/send_push                       (verify_jwt = false)
//
// Not called by the browser. The notifications INSERT trigger posts
// { type: 'INSERT', table: 'notifications', record: <row> } via pg_net with
// header x-webhook-secret: PUSH_WEBHOOK_SECRET (checked here, constant time).
//
// Sends { title, body, url } (the shape web/public/push-sw.js reads) to every
// push subscription of record.user_id, if that notification type is enabled,
// in the user's profile language. Dead subscriptions (404/410) are deleted.
// 200  { sent, removed, failed } | { sent: 0, skipped }
import { apiError, json, readJsonObject, safeEqual } from '../_shared/http.ts'
import { buildPushMessage, type NotificationRecord } from '../_shared/push_messages.ts'
import { adminClient, env, requireEnv } from '../_shared/supabase.ts'
import { sendWebPush, type PushSubscriptionJson, type VapidKeys } from '../_shared/webpush.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return apiError('validation_error', 'Use POST', 405)
  if (!safeEqual(req.headers.get('x-webhook-secret'), env('PUSH_WEBHOOK_SECRET'))) {
    return apiError('unauthenticated', 'Webhook secret required', 401)
  }

  const body = await readJsonObject(req)
  const record = body?.record as NotificationRecord | undefined
  if (!record || typeof record.user_id !== 'string' || typeof record.type !== 'string') {
    return apiError('validation_error', 'Expected { record: <notifications row> }', 422)
  }

  try {
    const db = adminClient()
    const { data: setting } = await db
      .from('notification_settings')
      .select('enabled')
      .eq('user_id', record.user_id)
      .eq('type', record.type)
      .maybeSingle()
    if (setting?.enabled === false) return json({ sent: 0, skipped: 'type disabled' })

    const { data: subs, error } = await db.from('push_subscriptions').select('id, endpoint, keys').eq('user_id', record.user_id)
    if (error) throw new Error(`push_subscriptions lookup failed: ${error.message}`)
    if (!subs?.length) return json({ sent: 0, skipped: 'no subscriptions' })

    const { data: profile } = await db.from('profiles').select('language').eq('id', record.user_id).maybeSingle()
    const payload = JSON.stringify(buildPushMessage(record, profile?.language))
    const vapid: VapidKeys = {
      publicKey: requireEnv('VAPID_PUBLIC_KEY'),
      privateKey: requireEnv('VAPID_PRIVATE_KEY'),
      subject: requireEnv('VAPID_SUBJECT'),
    }

    const outcomes = await Promise.all(
      subs.map(async (s: { id: string } & PushSubscriptionJson) => {
        try {
          return { id: s.id, ...(await sendWebPush({ endpoint: s.endpoint, keys: s.keys }, payload, vapid)) }
        } catch (e) {
          // endpoints are capability URLs: never log them
          console.warn('push send failed:', e instanceof Error ? e.name : 'error')
          return { id: s.id, status: 0, ok: false, gone: false }
        }
      }),
    )
    const gone = outcomes.filter((o) => o.gone).map((o) => o.id)
    if (gone.length) await db.from('push_subscriptions').delete().in('id', gone)

    return json({
      sent: outcomes.filter((o) => o.ok).length,
      removed: gone.length,
      failed: outcomes.filter((o) => !o.ok && !o.gone).length,
    })
  } catch (e) {
    console.error('send_push failed:', e instanceof Error ? e.message : String(e))
    return apiError('internal_error', 'Push delivery failed', 500)
  }
})
