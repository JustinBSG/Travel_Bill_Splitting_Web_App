/* Web Push handlers, imported into the Workbox-generated service worker
 * via workbox.importScripts (see vite.config.ts).
 * The send_push Edge Function is expected to send JSON:
 *   { "title": "...", "body": "...", "url": "/trips/<id>" }
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Travel Bill Split'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      data: { url: data.url || '/notifications' },
    }),
  )
})

// Older send_push builds linked expense notices to the edit form
// (/trips/<trip>/expense/<id>); open the trip at that expense instead. The app
// finds its day and highlights it.
function pushTarget(url) {
  const m = /^\/trips\/([^/?#]+)\/expense\/([^/?#]+)$/.exec(url)
  return m && m[2] !== 'new' ? `/trips/${m[1]}/overview?expense=${m[2]}` : url
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = pushTarget((event.notification.data && event.notification.data.url) || '/')
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(url)
          return w.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
