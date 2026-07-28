// A listing of "which devices does this identity currently use" — a
// smoother multi-device experience (a settings screen showing "PC",
// "Phone"), not an access-control mechanism. Same encrypted-to-self shape
// as modules/contacts.js/incognito-identity.js's persisted alias list (one
// QuBit per device, keyed by `deviceId`, `encryptFor: [qu.fingerprint]`) —
// a device label is personal-enough account metadata that it shouldn't be
// visible to anyone but the owner, even though it carries no secret keys.
//
// --- Deliberately NOT provided here: per-device revocation ---
// Every device sharing one identity today holds a verbatim copy of the same
// keypair (QuIdentity#exportKeys()/importKeys(), see identity-transfer.js) —
// there is no per-device sub-key. That means "sign this one device out"
// cannot actually be enforced: rotating the keypair to lock out a
// compromised device would change the fingerprint and break every existing
// relationship (Space memberships, contacts, directory visibility) for
// EVERY device, not just the one being removed. Real per-device revocation
// needs a per-device sub-key model (cross-signed by the main identity,
// Signal/Matrix-style) — a substantial, separate identity-model change.
// `removeDevice()` below only forgets the LOCAL bookkeeping entry (it stops
// showing up in a "my devices" list); it does not and cannot revoke that
// device's ability to keep using the identity it already has a full copy
// of. State this limitation to the end user, not just in code.
const DEVICES_PREFIX = 'devices';

/**
 * Registers (or updates) one device — `deviceId` is a caller-chosen,
 * stable-per-device identifier (a random UUID minted once and kept in that
 * device's own local storage, NOT a second keypair) so repeat calls from
 * the same device update the SAME entry (bumping `lastSeen`) instead of
 * creating a new one. `label` is an optional, purely local, user-editable
 * name ("Mein iPhone") — never validated/required, same stance
 * `createIncognitoIdentity()`'s `alias` takes for its own local label.
 * `firstSeen` is set only once (preserved across repeat calls); `lastSeen`
 * is refreshed on every call.
 */
export async function registerDevice(qu, deviceId, { label } = {}) {
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error('[Devices] registerDevice() requires a non-empty deviceId string.');
  }
  const existing = await qu.own.get(DEVICES_PREFIX).get(deviceId);
  const firstSeen = existing?.value?.firstSeen ?? Date.now();
  return qu.own.get(DEVICES_PREFIX).get(deviceId).put({ deviceId, label, firstSeen, lastSeen: Date.now() }, { encryptFor: [qu.fingerprint] });
}

/** Tombstones one device entry (`put(null)`) — see file doc above: this only forgets the LOCAL listing, it does not revoke that device's access. Removing an unknown deviceId is a harmless no-op, same "no special-cased absence" stance as `modules/spaces.js`'s `removeFromRole()`. */
export async function removeDevice(qu, deviceId) {
  return qu.own.get(DEVICES_PREFIX).get(deviceId).put(null);
}

/** One-shot read of every currently-registered (non-tombstoned) device, as `{deviceId, label, firstSeen, lastSeen}[]`. Filters by verified `q.writer`, same defense-in-depth stance as `listContacts()`/`loadIncognitoStore()`. */
export async function listDevices(qu) {
  const prefix = `${qu.own.id}/${DEVICES_PREFIX}/`;
  const rows = await qu.session.query(`${prefix}**`);
  const devices = [];
  for (const q of rows) {
    if (q.writer !== qu.fingerprint) continue;
    if (q.value == null) continue; // tombstoned
    devices.push(q.value);
  }
  return devices;
}

/** Live subscription to the device list — `callback(q)` fires with the raw QuBit for every current AND future register/update/remove (`q.value === null` for a removal), same convention as `onContactsChange()`/`onIncognitoIdentitiesChange()`. */
export function onDevicesChange(qu, callback, opts) {
  return qu.own.get(DEVICES_PREFIX).map(callback, opts);
}

/** `qu.use(createDevicesPlugin())` — attaches `qu.registerDevice()`/`qu.removeDevice()`/`qu.listDevices()`/`qu.onDevicesChange()` sugar, mirroring every other `create*Plugin()` in this directory. */
export function createDevicesPlugin() {
  return {
    install(qu) {
      qu.registerDevice = (deviceId, opts) => registerDevice(qu, deviceId, opts);
      qu.removeDevice = (deviceId) => removeDevice(qu, deviceId);
      qu.listDevices = () => listDevices(qu);
      qu.onDevicesChange = (callback, opts) => onDevicesChange(qu, callback, opts);
    },
  };
}

