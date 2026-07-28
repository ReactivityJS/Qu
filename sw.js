// Service Worker — the one piece of this ecosystem that MUST run outside
// the page's own module graph (a push event can wake this even while no
// tab is open at all). Registered at the ORIGIN ROOT (`/sw.js`, see
// shell/qu-app-shell.mjs's registerServiceWorker() call) so its default
// scope covers the WHOLE ecosystem, not one app's own subdirectory — this
// is what makes push/installability a platform-level feature every
// mounted/entry app shares, rather than something each app registers its
// own separate worker for (qu-core's examples still do the latter, scoped
// to their own directory, since each is independently installable there).
//
// Deliberately tiny and app-agnostic: it knows nothing about QU, Spaces,
// or fingerprints beyond the fields relay.mjs's push payload actually
// sends (`title`/`body`, plus `fp` — the notifying identity's fingerprint,
// for deep-linking back, see relay.mjs's push hook in qu-core) — the
// payload never carries decrypted content (modules/notifications.js's own
// createNotificationPushRule() doc explains why), so there is nothing
// sensitive for this file to mishandle.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Plain pass-through — no caching/offline mode (only "installable" was
// asked, not "works without a network"). A registered Service Worker WITH
// a fetch handler is still one of the installability criteria some
// browsers check explicitly — without this listener, the install prompt
// might not appear at all even with an otherwise-complete manifest+worker.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON — ignore, fall back to defaults below */ }
  const title = data.title || 'QUniverse';
  const options = {
    body: data.body || 'Du hast eine neue Benachrichtigung erhalten',
    tag: data.fp || 'quniverse', // same sender -> replaces the previous notification instead of stacking
    renotify: true,
    data: { fp: data.fp || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking the notification focuses an already-open tab, navigated to the
// notifying identity's profile (QUniverse's own space-first `#/~<fp>`
// route, see src/ui/router.js in qu-core) — or opens a fresh tab if none
// is open. No deeper link than that: this file has no idea which app/
// content the notification was actually about (see the module doc above),
// only who it was from.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const fp = event.notification.data?.fp;
  const targetUrl = new URL(fp ? `./#/~${fp}` : './', self.registration.scope).href;
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
