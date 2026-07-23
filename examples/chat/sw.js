// Service Worker — the one piece of this demo that MUST run outside the
// page's own module graph (a push event can wake this even while no tab
// is open at all). Deliberately tiny: it knows nothing about QU, rooms,
// or fingerprints beyond the two fields relay.mjs's push payload actually
// sends (`title`/`body`, plus `fp` for deep-linking back) — the payload
// never carries message content (see relay.mjs's push hook), so there is
// nothing sensitive for this file to mishandle.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Reiner Pass-through, kein Caching/Offline-Modus (bewusst NICHT Teil
// dieser Änderung — nur "installierbar" war gefragt, nicht "funktioniert
// ohne Netz"). Ein registrierter Service Worker MIT fetch-Handler ist
// trotzdem eines der Installierbarkeits-Kriterien mancher Browser (u. a.
// ältere Chrome-Versionen prüfen das explizit) — ohne diesen Listener
// würde der PWA-Installations-Prompt auf solchen Browsern gar nicht erst
// erscheinen, obwohl Manifest + Service Worker sonst vollständig da sind.
self.addEventListener('fetch', (event) => { event.respondWith(fetch(event.request)); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON — ignore, fall back to defaults below */ }
  const title = data.title || 'QU Chat';
  const options = {
    body: data.body || 'Du hast eine neue Nachricht erhalten',
    tag: data.fp || 'qu-chat', // same sender -> replaces the previous notification instead of stacking
    renotify: true,
    data: { fp: data.fp || null },
    // Ein Anruf-Weckruf (relay.mjs's call-invite push hook) soll nicht
    // von selbst verschwinden, bevor jemand ihn überhaupt gesehen hat —
    // eine normale Nachricht darf das schon (kein requireInteraction).
    requireInteraction: !!data.call,
    vibrate: data.call ? [300, 150, 300, 150, 300] : undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification focuses an already-open tab (navigating it to
// the chat via chat-lib.mjs's `#<fingerprint>` route, see app.mjs) or
// opens a fresh one if none is open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const fp = event.notification.data?.fp;
  const targetUrl = new URL(fp ? `./#${fp}` : './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
