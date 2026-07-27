// Service Worker — nur für Installierbarkeit gebraucht (siehe
// examples/chat/sw.js für dieselbe Begründung: manche Browser prüfen einen
// registrierten Service Worker MIT fetch-Handler explizit, bevor sie den
// PWA-Installations-Prompt überhaupt anbieten). Kein Caching/Offline-Modus,
// kein Push — dieses Beispiel braucht beides nicht, ein Spiel ohne
// Netzwerkverbindung zum Relay kann ohnehin weder Pings senden noch
// empfangen.

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => { event.respondWith(fetch(event.request)); });
