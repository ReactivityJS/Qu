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

import { Qu, LocalStorageAdapter } from '../index.js';

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

// Empty namespace: LocalStorageAdapter would otherwise prefix every key
// with `qu:` (its own default) — this predates the adapter, and every
// caller already chooses a full, self-contained key name, so an empty
// namespace here keeps every existing localStorage key exactly as it
// already is instead of silently orphaning already-stored data.
const storage = new LocalStorageAdapter({ namespace: '' });

/**
 * Identität aus `localStorage` laden, oder beim allerersten Aufruf neu
 * erzeugen und dort ablegen. `storageKey` defaultet auf
 * `ECOSYSTEM_IDENTITY_KEY` (siehe deren Doku) — weiterhin überschreibbar für
 * eine bewusst isolierte App.
 *
 * `migrateFrom` (optional, ein oder mehrere ältere Storage-Keys): falls
 * unter `storageKey` NOCH NICHTS liegt, aber einer dieser älteren Keys eine
 * Identität trägt, wird sie EINMALIG dorthin kopiert (nicht verschoben — der
 * alte Key bleibt unangetastet, falls noch etwas anderes ihn liest) statt
 * eine komplett neue Identität anzulegen. Das ist die konkrete Antwort auf
 * "wie migriert eine App mit einem alten, App-eigenen Key auf den
 * gemeinsamen `ECOSYSTEM_IDENTITY_KEY`, ohne bestehende Nutzer:innen ihre
 * bisherige Identität (und damit ihre bekannten Kontakte/Räume) verlieren
 * zu lassen": examples/forum und examples/cms rufen dies mit ihrem
 * jeweiligen alten Key als `migrateFrom` auf.
 *
 * Goes through Qu's own StorageAdapter (LocalStorageAdapter) instead of
 * calling `localStorage` directly — this is the one place identity has to
 * exist BEFORE any Qu instance does (you need it to create the instance in
 * the first place), which is exactly why LocalStorageAdapter is built to
 * work standalone: it has no dependency on a Runtime/QuStore, just a plain
 * namespaced get/put over Web Storage, usable at any point — including
 * this one, the earliest possible.
 */
export async function loadOrCreateIdentity(storageKey = ECOSYSTEM_IDENTITY_KEY, { migrateFrom = [] } = {}) {
  // Ein beschädigter Wert (nicht valides JSON) behandelt storage.get() wie
  // "nicht vorhanden" — für JEDEN anderen Key genau richtig, aber hier die
  // eine Stelle, an der das katastrophal wäre: ein `saved == null` würde
  // sonst kommentarlos eine KOMPLETT NEUE Identität erzeugen und die alte
  // (samt Fingerprint, damit samt Kontakten/Räumen anderer Nutzer) für immer
  // unauffindbar machen. Deshalb hier die einzige bewusste Ausnahme von
  // "immer über den Adapter, nie direkt localStorage": ein roher
  // Vorab-Check, der "wirklich leer" von "vorhanden, aber kaputt"
  // unterscheidet, bevor überhaupt erwogen wird, eine neue Identität
  // anzulegen.
  if (localStorage.getItem(storageKey) !== null) {
    const saved = await storage.get(storageKey);
    if (saved) return Qu.create({ identity: saved });
    throw new Error(`Deine gespeicherte Identität unter "${storageKey}" ist beschädigt (kein gültiges JSON) — um Datenverlust zu vermeiden, wird KEINE neue Identität angelegt. Bitte Browser-Konsole/localStorage prüfen, bevor dieser Eintrag gelöscht wird.`);
  }

  for (const legacyKey of Array.isArray(migrateFrom) ? migrateFrom : [migrateFrom]) {
    if (!legacyKey || localStorage.getItem(legacyKey) === null) continue;
    const legacy = await storage.get(legacyKey);
    if (!legacy) continue; // corrupt legacy entry — fall through to a fresh identity rather than propagate the corruption
    await storage.put(storageKey, legacy);
    return Qu.create({ identity: legacy });
  }

  const qu = await Qu.create();
  await storage.put(storageKey, await qu.exportKeys());
  return qu;
}

/** Der Relay dieses Deployments — `ws(s)://<host>/relay`, passend zu index.js' `bridgeWebSocketServer(server, relayApi, { path: '/relay' })`. */
export function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/relay`;
}
