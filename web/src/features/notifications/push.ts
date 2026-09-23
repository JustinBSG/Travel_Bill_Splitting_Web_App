// Web Push subscribe (UI -> push_subscriptions insert). Sending is server-side.
// Android: any time. iOS: 16.4+ AND installed to Home Screen only.
import { isIOS, isStandalone } from '../../app/install'
import { VAPID_PUBLIC_KEY, supabase } from '../../lib/supabase'

export type PushSupport = 'supported' | 'needs-install' | 'unsupported' | 'not-configured'

export function pushSupport(): PushSupport {
  if (!VAPID_PUBLIC_KEY) return 'not-configured'
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (isIOS() && !isStandalone()) return 'needs-install'
  return hasApis ? 'supported' : 'unsupported'
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** Must be called from a user gesture (button tap). */
export async function enablePush(userId: string): Promise<'granted' | 'denied'> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  const reg = await navigator.serviceWorker.ready
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    }))
  const json = sub.toJSON()
  const { error } = await supabase
    .from('push_subscriptions')
    .insert({ user_id: userId, endpoint: json.endpoint, keys: json.keys })
  if (error && error.code !== '23505') throw new Error(error.message)
  return 'granted'
}

export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}
