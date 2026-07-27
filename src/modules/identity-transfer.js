// Moving the SAME identity to a second device — not creating a new one.
// Exports the raw private keys (Qu#exportKeys(), the same shape every
// examples/*/space-app-browser.js's loadOrCreateIdentity() already
// persists to localStorage) as a single, copy-pasteable string, optionally
// password-protected. This is deliberately simple — a string you copy by
// hand between two devices — per the explicit request this started from:
// a QR code or some other no-hand-copying transfer is a LATER, separate
// step layered on top of this (it would just need a way to get this same
// string from one device to the other; the string itself doesn't change).
//
// Works in Node AND the browser — only WebCrypto (`crypto.subtle`,
// `crypto.getRandomValues`), no DOM/browser-only globals — same reasoning
// as core/identity.js itself, so this is fully unit-testable without a
// real browser (unlike e.g. adapters/indexeddb-file-storage.js).

import { toB64, fromB64 } from '../core/bytes.js';

const FORMAT_PREFIX = 'qu-identity-v1:';
// OWASP's 2023 minimum recommendation for PBKDF2-HMAC-SHA256 — a
// deliberate, real cost, not a token gesture: this is the ONLY thing
// standing between an exported string (if it leaks) and the identity's
// private keys once a password is guessed, so it should stay expensive to
// brute-force even on the leaking side.
const PBKDF2_ITERATIONS = 210_000;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey('raw', ENC.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * `qu`: any Qu instance holding the identity to export (`qu.exportKeys()`).
 * `password`, if given, encrypts the exported keys (PBKDF2 + AES-GCM, a
 * fresh random salt+iv every call — the SAME password never produces the
 * same string twice, so two exports can't be diffed to learn anything
 * about the password). Omitted, the result is PLAIN — decodable by anyone
 * who gets the string, exactly like an unencrypted private-key backup
 * anywhere else; only use this on a channel you already trust (a cable
 * between your own two devices, not a public paste site).
 *
 * Returns one flat, copy-pasteable string (a version prefix + base64
 * envelope) — never throws on the export side itself (no user input to
 * reject beyond `qu` already being a valid, non-guest identity, which
 * `exportKeys()` itself guarantees by simply requiring `qu.identity`).
 */
export async function exportIdentity(qu, { password } = {}) {
  const keys = await qu.exportKeys();
  let envelope;
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, ENC.encode(JSON.stringify(keys))));
    envelope = { v: 1, enc: true, salt: toB64(salt), iv: toB64(iv), data: toB64(ciphertext) };
  } else {
    envelope = { v: 1, enc: false, keys };
  }
  return FORMAT_PREFIX + toB64(ENC.encode(JSON.stringify(envelope)));
}

/**
 * Inverse of exportIdentity() — returns the keys object, ready to hand
 * straight to `Qu.create({ identity: keys })` (the same shape
 * loadOrCreateIdentity() already persists/reads). Throws (never returns a
 * garbage/partial result) if: the string isn't recognized as one of ours,
 * it's malformed/truncated, it's encrypted but no `password` was given, or
 * decryption fails (AES-GCM's own authentication catches both a wrong
 * password AND any tampering with the string — there's no way to tell
 * those two apart from the ciphertext alone, so the message doesn't try to).
 */
export async function importIdentity(exported, { password } = {}) {
  const trimmed = String(exported ?? '').trim();
  if (!trimmed.startsWith(FORMAT_PREFIX)) {
    throw new Error('[identity-transfer] Unbekanntes Format — kein gültiger Qu-Identitäts-Export.');
  }
  let envelope;
  try {
    envelope = JSON.parse(DEC.decode(fromB64(trimmed.slice(FORMAT_PREFIX.length))));
  } catch {
    throw new Error('[identity-transfer] Export ist beschädigt oder unvollständig.');
  }
  if (!envelope.enc) return envelope.keys;
  if (!password) throw new Error('[identity-transfer] Dieser Export ist passwortgeschützt — Passwort erforderlich.');
  // `envelope.salt`/`iv`/`data` are all attacker/user-controlled (a
  // hand-edited or truncated export string can still pass the FORMAT_PREFIX
  // + JSON.parse checks above) — fromB64() on a non-base64 value throws a
  // raw DOMException (atob()'s InvalidCharacterError), not the clean error
  // this function otherwise promises for "corrupted export". One try/catch
  // around the whole decrypt path (deriveKey included, not just
  // crypto.subtle.decrypt itself) catches all of it uniformly.
  let plaintext;
  try {
    const key = await deriveKey(password, fromB64(envelope.salt));
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.data));
  } catch {
    throw new Error('[identity-transfer] Falsches Passwort oder beschädigter Export.');
  }
  return JSON.parse(DEC.decode(plaintext));
}
