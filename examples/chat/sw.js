// Service Worker — the one piece of this demo that MUST run outside the
// page's own module graph (a push event can wake this even while no tab
// is open at all). Deliberately tiny: it knows nothing about QU, rooms,
// or fingerprints beyond the two fields relay.mjs's push payload actually
// sends (`title`/`body`, plus `fp` for deep-linking back) — the payload
// never carries message content (see relay.mjs's push hook), so there is
// nothing sensitive for this file to mishandle.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// Ablagefach für geteilte Inhalte zwischen handleShareTarget() (schreibt)
// und app.mjs's showShareTargetScreen() (liest + löscht wieder) — ein
// eigener Cache statt IndexedDB, weil Cache Storage Blobs (die geteilten
// Dateien) nativ als Response-Body hält, ohne sie erst in Base64/ArrayBuffer
// umwandeln zu müssen.
const SHARE_CACHE_NAME = 'qu-chat-share-target';

// Reiner Pass-through für alles außer der Share-Target-POST unten (kein
// Caching/Offline-Modus — bewusst NICHT Teil dieser Änderung, nur
// "installierbar" war gefragt, nicht "funktioniert ohne Netz"). Ein
// registrierter Service Worker MIT fetch-Handler ist trotzdem eines der
// Installierbarkeits-Kriterien mancher Browser (u. a. ältere
// Chrome-Versionen prüfen das explizit) — ohne diesen Listener würde der
// PWA-Installations-Prompt auf solchen Browsern gar nicht erst erscheinen,
// obwohl Manifest + Service Worker sonst vollständig da sind.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // manifest.webmanifest's share_target.action — der Browser schickt
  // "Teilen an QU Chat" (aus der Galerie, einem anderen Browser, …) als
  // POST GENAU hierhin. Eine normale Seite/ein Server kann eine solche
  // POST-Navigation nicht sinnvoll entgegennehmen (kein Ort, an dem sie
  // multipart/form-data mit rohen Datei-Bytes verarbeiten könnte) — nur
  // ein Service Worker darf/kann das abfangen, bevor es überhaupt einen
  // Server erreicht.
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(req));
    return;
  }
  event.respondWith(fetch(req));
});

/**
 * Legt den geteilten Inhalt (Text/Link/Titel + Dateien) unter einer
 * Einweg-Id im SHARE_CACHE_NAME-Cache ab und leitet DANACH per Redirect
 * auf `#/share/<id>` um — die Spec verlangt für einen POST-Share-Target
 * zwingend eine Redirect-Response (kein direktes Rendern hier), der
 * Browser navigiert der Nutzerin also sichtbar in die normale App-UI,
 * deren Router (app.mjs's ROOT_ROUTES.share) diese Id danach ausliest.
 * Leere/fehlende Felder werden bewusst nicht ausgefiltert — text/url/title
 * einzeln optional, genau wie ein "Teilen"-Dialog sie liefert.
 *
 * Erste Prüfung: der Opt-out (Einstellungen → Privatsphäre → "Teilen an QU
 * Chat entgegennehmen", app.mjs's shareTargetEnabled()/setShareTargetEnabled()).
 * Android/iOS entfernen QU Chat dadurch NICHT aus ihrem System-Teilen-Dialog
 * (das steuert allein das installierte manifest.webmanifest) — dieser
 * Schalter sorgt aber dafür, dass ein trotzdem eingehender Share sofort mit
 * `#/share-blocked` beantwortet wird, OHNE `request.formData()` überhaupt
 * erst auszulesen: kein Byte des geteilten Inhalts landet dann in irgendeinem
 * Cache oder sonst wo.
 */
async function handleShareTarget(request) {
  const enabledRes = await (await caches.open(SHARE_CACHE_NAME)).match('/share-target-enabled');
  const enabled = !enabledRes || (await enabledRes.text()) !== '0'; // kein Eintrag (noch nie ein Tab geladen) -> Default AN, s. app.mjs's shareTargetEnabled()
  if (!enabled) return Response.redirect('./#/share-blocked', 303);

  const formData = await request.formData();
  const id = crypto.randomUUID();
  const files = formData.getAll('files').filter((f) => f instanceof File && f.size > 0);
  const meta = {
    text: formData.get('text') || '',
    url: formData.get('url') || '',
    title: formData.get('title') || '',
    fileCount: files.length,
    fileNames: files.map((f) => f.name),
    fileTypes: files.map((f) => f.type),
  };
  const cache = await caches.open(SHARE_CACHE_NAME);
  await cache.put(`/share-payload/${id}`, new Response(JSON.stringify(meta)));
  await Promise.all(files.map((f, i) => cache.put(
    `/share-file/${id}/${i}`,
    new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }),
  )));
  return Response.redirect(`./#/share/${id}`, 303);
}

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
