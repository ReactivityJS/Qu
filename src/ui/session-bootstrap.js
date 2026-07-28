// Browser-only ecosystem bootstrap: load-or-create an identity + figure out
// this deployment's own Relay URL — the two pieces of boilerplate that used
// to be repeated (independently, with divergent storage-key choices) at the
// top of nearly every examples/<app>/app.mjs. Same charter as this
// directory's other browser-only files (components.js, hash-router.js):
// DOM-dependent, not importable from Node.
//
// Promoted out of examples/space-app-browser.js (which now just re-exports
// these two) specifically so a NEW app being built against this repo's own
// conventions imports from `src/ui/`, not from `examples/` — a module under
// `src/` should never need to depend on example code, and a real app
// shouldn't either.
//
// Identity persistence goes through `runtime.ingest()` (Qu's core write
// pipeline — verify/ACL/dispatch, same path every other QuBit takes), not a
// bare adapter `.put()` call — a prior version of this file bypassed the
// pipeline entirely, which meant nothing could ever `.on()`-subscribe to
// "the identity changed" (e.g. a future incognito-alias switcher). Reusing
// the pipeline costs nothing extra and keeps this file honest to Qu's own
// core principle: a QuBit is the one shape everything is, no exceptions for
// bootstrap code.

import { Qu, QuStore, MemoryAdapter, LocalStorageAdapter, SessionStorageAdapter, NullAdapter, QuIdentity, createSpacesPlugin } from '../index.js';

/**
 * The one shared identity every example in this repo now converges on
 * (chat/people/hunt/relay-admin already used this literal value
 * organically; forum/cms previously had their own `qu-forum-identity-keys`/
 * `qu-cms-identity-keys`, see loadOrCreateIdentity()'s `migrateFrom` below)
 * — the whole point of an "ecosystem" is ONE fingerprint across every app
 * on it, not a separate account per app. A genuinely standalone tool that
 * wants isolation from the rest can still pass its own `storageKey`
 * explicitly; this is a default, not a hard requirement.
 */
export const ECOSYSTEM_IDENTITY_KEY = 'qu-identity';

// Device-local ONLY, never replicated (see `replicate: false` on the mount
// below) — the raw private-key JWK material must never leave this device,
// encrypted or not (unlike an incognito alias, which — once that module
// exists — deliberately DOES replicate, but only ever encrypted-to-self
// under the main identity's own Space; this fixed prefix is upstream of
// that, the main identity itself, before any Space/network exists at all).
// A fixed prefix rather than the storage key itself, since several distinct
// storage keys (e.g. one per `tier`, or an app's own isolated key) can share
// the same mount.
const BOOTSTRAP_PREFIX = 'local-identity-bootstrap/';

/**
 * Which Web Storage object (if any) a tier's adapter is backed by — used
 * ONLY for the corrupted-vs-absent pre-check below, mirroring exactly which
 * raw object `WebStorageAdapter` (this tier's adapter) itself wraps
 * internally. `'memory'`/`'none'` have no addressable raw storage to peek
 * (nothing survives a reload either way), so corruption detection simply
 * doesn't apply to them — falling through to "absent" is the correct,
 * only-possible answer for those two.
 */
const TIER_RAW_STORAGE = {
  durable: () => localStorage,
  session: () => sessionStorage,
};

const TIER_ADAPTERS = {
  durable: () => new LocalStorageAdapter({ namespace: '' }),
  session: () => new SessionStorageAdapter({ namespace: '' }),
  memory: () => new MemoryAdapter(),
  none: () => new NullAdapter(),
};

/**
 * Identität laden, oder beim allerersten Aufruf neu erzeugen und dort
 * ablegen. `storageKey` defaultet auf `ECOSYSTEM_IDENTITY_KEY` (s. o.),
 * weiterhin überschreibbar für eine bewusst isolierte App.
 *
 * `tier` wählt den Adapter, der die Identität tatsächlich trägt:
 *   - `'durable'` (Default) — `LocalStorageAdapter`, übersteht Reload/Neustart.
 *   - `'session'` — `SessionStorageAdapter`, übersteht nur einen Reload
 *     innerhalb desselben Tabs, weg nach Tab-Schließen.
 *   - `'memory'` — `MemoryAdapter`, weg nach jedem Reload.
 *   - `'none'` — `NullAdapter`, wird nie persistiert; jeder erneute Aufruf
 *     erzeugt eine komplett neue Identität, es sei denn der Aufrufer hält
 *     die zurückgegebene `Qu`-Instanz selbst in einem Closure fest.
 * Ein flüchtigerer Tier ist der naheliegende Baustein für einen späteren
 * Incognito-Alias, der bewusst nicht auf dem Hauptgerät verweilen soll —
 * dieses Modul selbst kennt "Incognito" aber nicht, es bietet nur die
 * Tier-Wahl generisch an.
 *
 * `migrateFrom` (optional, ein oder mehrere ältere Storage-Keys): falls
 * unter `storageKey` NOCH NICHTS liegt, aber einer dieser älteren Keys eine
 * Identität trägt, wird sie EINMALIG übernommen (nicht verschoben — der
 * alte Key bleibt unangetastet, falls noch etwas anderes ihn liest) statt
 * eine komplett neue Identität anzulegen. Historisch waren ältere Keys
 * immer `localStorage`-basiert (jede App hatte bislang ihren eigenen,
 * dauerhaften Key) — die Migrationsprüfung geht deshalb bewusst immer
 * gegen `localStorage`, unabhängig vom gewählten `tier` der NEUEN Identität.
 */
export async function loadOrCreateIdentity(storageKey = ECOSYSTEM_IDENTITY_KEY, { migrateFrom = [], tier = 'durable' } = {}) {
  const idAdapter = (TIER_ADAPTERS[tier] ?? TIER_ADAPTERS.durable)();
  const bootstrapId = `${BOOTSTRAP_PREFIX}${storageKey}`;
  const store = new QuStore([
    { prefix: BOOTSTRAP_PREFIX, adapter: idAdapter, replicate: false },
    { prefix: '', adapter: new MemoryAdapter() }, // everything else this Qu instance ever writes — unrelated to identity bootstrap, same default as before
  ]);

  // Ein beschädigter Wert (nicht valides JSON — z. B. ein Rest aus der Zeit
  // vor diesem Adapter) behandelt der Adapter selbst wie "nicht vorhanden"
  // (WebStorageAdapter's eigene Doku) — für JEDEN anderen Key genau richtig,
  // aber hier die eine Stelle, an der das katastrophal wäre: ein
  // `saved == null` würde sonst kommentarlos eine KOMPLETT NEUE Identität
  // erzeugen und die alte für immer unauffindbar machen. Deshalb der rohe
  // Vorab-Check gegen das jeweilige Tier's eigenes Speicherobjekt (nur für
  // `durable`/`session` überhaupt möglich, s. o.), der "wirklich leer" von
  // "vorhanden, aber kaputt" unterscheidet, bevor überhaupt erwogen wird,
  // eine neue Identität anzulegen.
  const rawStorage = TIER_RAW_STORAGE[tier]?.();
  const rawPresent = rawStorage ? rawStorage.getItem(bootstrapId) !== null : undefined;

  if (rawPresent) {
    const q = await store.get(bootstrapId);
    if (q?.value) return Qu.create({ identity: q.value, store });
    throw new Error(`Deine gespeicherte Identität unter "${storageKey}" ist beschädigt (kein gültiges JSON) — um Datenverlust zu vermeiden, wird KEINE neue Identität angelegt. Bitte Browser-Konsole/Speicher prüfen, bevor dieser Eintrag gelöscht wird.`);
  }
  if (rawPresent === undefined) {
    // 'memory'/'none': kein roher Vorab-Check möglich — trotzdem den Store
    // selbst fragen (deckt z. B. eine bereits in DIESEM Seitenaufruf zuvor
    // erzeugte 'memory'-Identität ab, falls derselbe Store wiederverwendet wird).
    const q = await store.get(bootstrapId);
    if (q?.value) return Qu.create({ identity: q.value, store });
  }

  let identity;
  for (const legacyKey of Array.isArray(migrateFrom) ? migrateFrom : [migrateFrom]) {
    if (!legacyKey || localStorage.getItem(legacyKey) === null) continue;
    let legacy;
    try { legacy = JSON.parse(localStorage.getItem(legacyKey)); } catch { continue; }
    if (!legacy) continue;
    identity = legacy;
    break;
  }

  const qu = await Qu.create({ identity, store }); // identity undefined -> Qu.create() generates a fresh one, exactly like before
  identity = await qu.exportKeys();

  // Schreibt reaktiv über die normale ingest()-Pipeline statt eines rohen
  // adapter.put() — genau der Punkt dieser Überarbeitung. `bootstrapId` liegt
  // NICHT unter `~<fp>` (der Fingerprint ist ja erst NACH dem Lesen dieses
  // Blobs bekannt, ein späterer Seitenaufruf kennt ihn noch nicht) und
  // braucht deshalb eine eigene Schreib-Freigabe — createSpacesPlugin()s
  // ohnehin bestehende Bootstrap-Regel ("kein Manifest = jeder darf
  // schreiben", modules/spaces.js) übernimmt das, ohne einen eigenen
  // Custom-ACL-Zweig nur für diesen einen Pfad zu brauchen. Harmlos auch für
  // einen Aufrufer, der `createSpacesPlugin()` selbst noch einmal
  // installiert (macht nur den bereits identischen ACL-Resolver erneut,
  // redundant aber ungefährlich).
  qu.use(createSpacesPlugin());
  await qu.runtime.publish(bootstrapId, identity);

  return qu;
}

/** Der Relay dieses Deployments — `ws(s)://<host>/relay`, passend zu index.js' `bridgeWebSocketServer(server, relayApi, { path: '/relay' })`. */
export function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/relay`;
}

// Fester, eigener Key — bewusst NICHT derselbe Mechanismus wie die
// Identität selbst (kein QuBit, kein `runtime.ingest()`): eine Geräte-Id
// ist reine, unsignierte, lokale Korrelations-Information ("welches
// Browser-Profil ist das"), kein geheimes Schlüsselmaterial und kein Inhalt,
// der je repliziert werden soll — deshalb genügt ein einfacher
// `localStorage`-Wert, ganz ohne Store/ACL-Maschinerie.
const DEVICE_ID_KEY = 'qu-device-id';

/**
 * Stabile, geräte-lokale Id — einmal beim ersten Aufruf per
 * `crypto.randomUUID()` erzeugt, danach aus `localStorage` gelesen, damit
 * wiederholte Aufrufe von DEMSELBEN Browser/Gerät denselben Wert liefern
 * (Voraussetzung für `modules/devices.js`s `registerDevice(qu, deviceId,
 * …)`, damit ein Reload den bestehenden Geräte-Eintrag aktualisiert statt
 * einen neuen anzulegen). Kein Bezug zu einer Identität — dieselbe Geräte-Id
 * bleibt gültig, auch wenn die aktive Identität (Haupt oder ein
 * Incognito-Alias) wechselt.
 */
export function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
