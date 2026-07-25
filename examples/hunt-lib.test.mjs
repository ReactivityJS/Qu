import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import {
  haversineMeters, createGame, getConfig, getStatus, isHunted, isHunter,
  pingLocation, listPings, onPing, lastPing, declareCaught, endGame, predictNextRadius,
} from './hunt-lib.mjs';

test('haversineMeters: known distance between two coordinates (~1km, within 1%)', () => {
  // Zwei Punkte ca. 1000m auseinander auf demselben Breitengrad (Berlin-Bereich).
  const a = { lat: 52.5200, lon: 13.4050 };
  const b = { lat: 52.5290, lon: 13.4050 };
  const d = haversineMeters(a, b);
  assert.ok(Math.abs(d - 1000) < 10, `expected ~1000m, got ${d}`);
});

test('createGame: both teams become writers, only the hunted team may ping', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const hunted = await Qu.create({ runtime: runner.runtime });
  const hunter = await Qu.create({ runtime: runner.runtime });

  const gameId = await createGame(runner, { huntedTeam: [hunted.fingerprint], hunterTeam: [hunter.fingerprint] });

  assert.equal(await isHunted(hunted, gameId), true);
  assert.equal(await isHunted(hunter, gameId), false);
  assert.equal(await isHunter(hunter, gameId), true);

  await assert.rejects(() => pingLocation(hunter, gameId, { lat: 1, lon: 1 }), /Nur das gejagte Team/);
  await pingLocation(hunted, gameId, { lat: 1, lon: 1 }); // must not throw

  const config = await getConfig(hunter, gameId);
  assert.deepEqual(config.huntedTeam, [hunted.fingerprint]);
  assert.equal((await getStatus(hunter, gameId)).state, 'active');
});

test('pings: ordered oldest-first, foreign writers filtered out, live updates via onPing', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const hunted = await Qu.create({ runtime: runner.runtime });
  const hunter = await Qu.create({ runtime: runner.runtime });
  const gameId = await createGame(runner, { huntedTeam: [hunted.fingerprint], hunterTeam: [hunter.fingerprint] });

  const seen = [];
  onPing(hunter, gameId, (q) => seen.push(q.value));

  await pingLocation(hunted, gameId, { lat: 1, lon: 1 });
  await pingLocation(hunted, gameId, { lat: 2, lon: 2 });
  // Ein Fremdschreiber (hier: das Fänger-Team, direkt unter demselben Pfad
  // geschrieben, um den Filter zu testen) darf im Ergebnis nicht auftauchen.
  await hunter.get(`${gameId}/pings`).set({ lat: 99, lon: 99 });
  await new Promise((r) => setTimeout(r, 10));

  const pings = await listPings(hunter, gameId);
  assert.equal(pings.length, 2);
  assert.equal(pings[0].value.lat, 1);
  assert.equal(pings[1].value.lat, 2);
  assert.equal(seen.length, 2, 'the foreign write must not reach onPing callbacks either');

  const last = await lastPing(hunter, gameId);
  assert.equal(last.value.lat, 2);
});

test('declareCaught/endGame update status', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const gameId = await createGame(runner);
  await declareCaught(runner, gameId);
  assert.equal((await getStatus(runner, gameId)).state, 'caught');
  await endGame(runner, gameId);
  assert.equal((await getStatus(runner, gameId)).state, 'ended');
});

test('predictNextRadius: no pings yet -> null', () => {
  assert.equal(predictNextRadius([], { assumedSpeedMps: 1.4 }), null);
});

test('predictNextRadius: single ping falls back to assumedSpeedMps', () => {
  const now = 100_000;
  const pings = [{ ts: 0, value: { lat: 0, lon: 0, accuracy: 5 } }];
  const result = predictNextRadius(pings, { assumedSpeedMps: 2 }, now);
  assert.equal(result.speedMps, 2);
  assert.equal(result.elapsedS, 100);
  assert.equal(result.radiusMeters, 2 * 100 + 5);
});

test('predictNextRadius: two pings -> observed speed from actual distance/time, not the assumed fallback', () => {
  const a = { lat: 52.5200, lon: 13.4050 };
  const b = { lat: 52.5290, lon: 13.4050 }; // ~1000m north, see haversineMeters test above
  const pings = [
    { ts: 0, value: { lat: a.lat, lon: a.lon, accuracy: 0 } },
    { ts: 100_000, value: { lat: b.lat, lon: b.lon, accuracy: 0 } }, // 100s later
  ];
  const now = 150_000; // 50s after the last ping
  const result = predictNextRadius(pings, { assumedSpeedMps: 1.4 }, now);
  assert.ok(Math.abs(result.speedMps - 10) < 0.2, `expected ~10 m/s observed speed, got ${result.speedMps}`);
  assert.equal(result.elapsedS, 50);
  assert.ok(Math.abs(result.radiusMeters - 500) < 10, `expected ~500m radius, got ${result.radiusMeters}`);
});

test('predictNextRadius: an explicit per-ping speedMps (e.g. Geolocation coords.speed) overrides the assumed fallback for a single ping', () => {
  const pings = [{ ts: 0, value: { lat: 0, lon: 0, accuracy: 0, speedMps: 5 } }];
  const result = predictNextRadius(pings, { assumedSpeedMps: 1.4 }, 10_000);
  assert.equal(result.speedMps, 5);
});
