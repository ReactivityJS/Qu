// Service Worker — mirrors examples/chat/sw.js almost verbatim (see that
// file's doc comment for the full reasoning). Deliberately tiny: it knows
// nothing about calendars/events/fingerprints beyond the two fields
// relay.mjs's calendar push hooks actually send (`title`/`body`, plus `fp`
// for deep-linking back) — the payload never carries event content (see
// relay.mjs's calendar push hooks), so there is nothing sensitive for this
// file to mishandle.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Plain pass-through — no offline caching, only "installable" was asked
// for, not "works without a network". A registered Service Worker WITH a
// fetch handler is nonetheless one of the installability criteria some
// browsers check explicitly.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON — ignore, fall back to defaults below */ }
  const title = data.title || 'QU Kalender';
  const options = {
    body: data.body || 'Es gibt eine Änderung in einem deiner Kalender.',
    tag: data.fp || 'qu-calendar', // same sender -> replaces the previous notification instead of stacking
    renotify: true,
    data: { fp: data.fp || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification focuses an already-open tab, or opens a fresh
// one — deep-links to the app's root (unlike chat's `#<fp>` DM route, a
// calendar push carries no space/event id the client could safely act on
// without first re-decrypting, so this just opens the app; the app's own
// live subscriptions show the actual change once it's open).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL('./', self.registration.scope).href;
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
