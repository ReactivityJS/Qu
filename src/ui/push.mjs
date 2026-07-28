// One shared Web Push client toolkit — generalizes the pattern
// `examples/chat/app.mjs` grew locally (registerServiceWorker()/initPush()/
// publishPushSubscription()/the subscribe-button click handler) into
// importable primitives, so a future app/mount module doesn't reinvent the
// same VAPID-key/subscribe/publish dance. Browser-only (touches
// `navigator`/`window`/`Notification`), same charter as this directory's
// other browser-only files.
//
// A push SUBSCRIPTION is registered the exact same way relay/relay.mjs and
// every existing example already do it — an ordinary signed
// `qu.session.publish('push-subscription/<fp>', subscription)`, ACL-gated
// to `writers: [fp]` only (see relay.mjs's own doc on that prefix). This
// module doesn't invent a new protocol, only wraps the sequence of browser
// API calls a caller needs around that one write.
//
// WHICH server-side event actually triggers a push to a given fingerprint
// is entirely relay.mjs's `pushRules` concern (see modules/notifications.js's
// createNotificationPushRule() — the "any app hooks in just by calling
// qu.notifyUser()" mechanism this module's subscription plumbing serves).
// This file has no opinion on that; it only gets a subscription registered
// and lets a caller un-register it again.

const PUSH_SUBSCRIPTION_PREFIX = 'push-subscription/';

/** Whether this browser can support Web Push at all — feature-detect once, e.g. to decide whether to even render an "enable notifications" toggle. */
export function isPushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window
    && typeof Notification !== 'undefined';
}

/** `PushManager.subscribe()`'s `applicationServerKey` wants raw bytes, not the base64url string `/push/vapid-public-key` serves — the one non-obvious conversion every Push API consumer needs. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/** Thin wrapper around `navigator.serviceWorker.register()` — `null` (not a throw) if this browser has no Service Worker support at all, matching `isPushSupported()`'s own "degrade, don't crash" stance. */
export async function registerServiceWorker(swUrl, opts) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register(swUrl, opts);
}

/** This identity's currently registered subscription on `swRegistration`, or `null` if none. */
export async function getExistingSubscription(swRegistration) {
  return (await swRegistration?.pushManager?.getSubscription()) ?? null;
}

/**
 * Publishes (or clears, `subscription: null`) this identity's push
 * subscription. `repl` is the object `qu.connect()` itself returns (needs
 * `.sync()` to make sure the write actually lands at the relay before this
 * resolves — a bare `publish()` alone only guarantees the LOCAL write, see
 * examples/chat/app.mjs's own `publishPushSubscription()` for the same
 * two-step shape this generalizes).
 */
export async function publishPushSubscription(qu, repl, subscription) {
  const id = `${PUSH_SUBSCRIPTION_PREFIX}${qu.fingerprint}`;
  await qu.session.publish(id, subscription);
  await repl.sync({ topic: id }).catch((e) => console.error('[push] subscription sync failed:', e));
}

/**
 * The full "turn push ON" sequence: asks the browser's OS-level permission
 * prompt (`Notification.requestPermission()` — a caller should only invoke
 * this from a real user gesture, e.g. a button click, never on page load —
 * unsolicited permission prompts get browsers to auto-deny/distrust an
 * origin), then subscribes `swRegistration`'s `PushManager` with
 * `vapidPublicKey` (from this deployment's `/push/vapid-public-key`, `null`
 * meaning push isn't configured server-side at all), then publishes the
 * resulting subscription. Throws (does not swallow) if permission is
 * denied or `vapidPublicKey` is falsy — a caller decides how to surface
 * that, this function only performs the sequence.
 */
export async function subscribeToPush(qu, repl, swRegistration, vapidPublicKey) {
  if (!vapidPublicKey) throw new Error('[push] no VAPID public key — this deployment has push disabled server-side');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(`[push] Notification permission was "${permission}", not granted`);
  const subscription = await swRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  await publishPushSubscription(qu, repl, subscription.toJSON());
  return subscription;
}

/** The "turn push OFF" sequence: unsubscribes the browser-level PushManager subscription (if any) AND clears the published one — either side missing/already-gone is a harmless no-op, not an error. */
export async function unsubscribeFromPush(qu, repl, swRegistration) {
  const existing = await getExistingSubscription(swRegistration);
  if (existing) await existing.unsubscribe();
  await publishPushSubscription(qu, repl, null);
}
