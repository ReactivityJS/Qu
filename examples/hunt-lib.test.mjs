import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import {
  haversineMeters, createGame, getConfig, getStatus, watchStatus, isHunted, isHunter,
  hunterTeamOf, listHunterTeams, pingLocation, listPings, watchPings, lastPing,
  pingHunterLocation, watchHunterPings, nearestHunterDistance,
  declareCaught, endGame, predictNextRadius,
} from './hunt-lib.mjs';

test('haversineMeters: known distance between two coordinates (~1km, within 1%)', () => {
  // Zwei Punkte ca. 1000m auseinander auf demselben Breitengrad (Berlin-Bereich).
  const a = { lat: 52.5200, lon: 13.4050 };
  const b = { lat: 52.5290, lon: 13.4050 };
  const d = haversineMeters(a, b);
  assert.ok(Math.abs(d - 1000) < 10, `expected ~1000m, got ${d}`);
});

test('createGame: hunted team and hunter teams become writers, only the hunted team may ping', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const hunted = await Qu.create({ runtime: runner.runtime });
  const hunter = await Qu.create({ runtime: runner.runtime });

  const gameId = await createGame(runner, {
    huntedTeam: [hunted.fingerprint],
    hunterTeams: [{ label: 'Team Rot', members: [hunter.fingerprint] }],
  });

  assert.equal(await isHunted(hunted, gameId), true);
  assert.equal(await isHunted(hunter, gameId), false);
  assert.equal(await isHunter(hunter, gameId), true);

  await assert.rejects(() => pingLocation(hunter, gameId, { lat: 1, lon: 1 }), /Nur das gejagte Team/);
  await pingLocation(hunted, gameId, { lat: 1, lon: 1 }); // must not throw

  const config = await getConfig(hunter, gameId);
  assert.deepEqual(config.huntedTeam, [hunted.fingerprint]);
  assert.equal(config.hunterTeams.length, 1);
  assert.equal(config.hunterTeams[0].label, 'Team Rot');
  assert.ok(config.hunterTeams[0].id, 'each hunter team gets a generated id');
  assert.equal(await getStatus(hunter, gameId), 'active');
});

test('multiple hunter teams: each is independently a writer/hunter, hunterTeamOf() resolves the right one', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const red = await Qu.create({ runtime: runner.runtime });
  const blue = await Qu.create({ runtime: runner.runtime });

  const gameId = await createGame(runner, {
    hunterTeams: [
      { label: 'Team Rot', members: [red.fingerprint] },
      { label: 'Team Blau', members: [blue.fingerprint] },
    ],
  });

  assert.equal(await isHunter(red, gameId), true);
  assert.equal(await isHunter(blue, gameId), true);

  const config = await getConfig(runner, gameId);
  assert.equal(hunterTeamOf(config, red.fingerprint).label, 'Team Rot');
  assert.equal(hunterTeamOf(config, blue.fingerprint).label, 'Team Blau');
  assert.equal(hunterTeamOf(config, 'someone-else'), null);

  const teams = await listHunterTeams(runner, gameId);
  assert.equal(teams.length, 2);
});

test('pings: ordered oldest-first, foreign writers filtered out, live updates via watchPings (viewObject)', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const hunted = await Qu.create({ runtime: runner.runtime });
  const hunter = await Qu.create({ runtime: runner.runtime });
  const gameId = await createGame(runner, {
    huntedTeam: [hunted.fingerprint],
    hunterTeams: [{ label: 'Fänger', members: [hunter.fingerprint] }],
  });
  const config = await getConfig(hunter, gameId);

  const seen = [];
  watchPings(hunter, gameId, config, {
    createItem: (q) => q,
    render: (item, value) => seen.push(value),
  });

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
  assert.equal(seen.length, 2, 'the foreign write must not reach watchPings callbacks either');

  const last = await lastPing(hunter, gameId);
  assert.equal(last.value.lat, 2);
});

test('watchPings: an already-existing ping is delivered immediately, without a separate initial load (viewObject\'s initial:true)', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const gameId = await createGame(runner);
  await pingLocation(runner, gameId, { lat: 5, lon: 5 });

  const config = await getConfig(runner, gameId);
  const seen = [];
  watchPings(runner, gameId, config, { createItem: (q) => q, render: (item, value) => seen.push(value) });
  await new Promise((r) => setTimeout(r, 10)); // viewObject()'s initial catch-up runs asynchronously, not synchronously on the call

  assert.equal(seen.length, 1, 'the ping written before watchPings() was called must still be delivered');
  assert.equal(seen[0].lat, 5);
});

test('hunter pings: only hunter-team members may write, watchHunterPings filters everyone else, nearestHunterDistance finds the closest one', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const hunted = await Qu.create({ runtime: runner.runtime });
  const red = await Qu.create({ runtime: runner.runtime });
  const blue = await Qu.create({ runtime: runner.runtime });
  const gameId = await createGame(runner, {
    huntedTeam: [hunted.fingerprint],
    hunterTeams: [
      { label: 'Team Rot', members: [red.fingerprint] },
      { label: 'Team Blau', members: [blue.fingerprint] },
    ],
    hunterPingIntervalMs: 60_000,
  });
  const config = await getConfig(hunted, gameId);

  await assert.rejects(() => pingHunterLocation(hunted, gameId, { lat: 0, lon: 0 }), /Nur ein Mitglied eines Fänger-Teams/);

  const seen = [];
  watchHunterPings(hunted, gameId, config, { createItem: (q) => q, render: (item, value, q) => seen.push({ value, team: hunterTeamOf(config, q.writer)?.label }) });

  // Rot ist ~1000m nördlich von (0,0), Blau ist ~2000m nördlich — beide ca. auf demselben Breitengrad wie im haversineMeters()-Test oben.
  await pingHunterLocation(red, gameId, { lat: 0.009, lon: 0 });
  await pingHunterLocation(blue, gameId, { lat: 0.018, lon: 0 });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => s.team).sort(), ['Team Blau', 'Team Rot']);

  const hunterPings = seen.map((s) => ({ value: s.value }));
  const distance = nearestHunterDistance({ lat: 0, lon: 0 }, hunterPings);
  assert.ok(Math.abs(distance - 1000) < 10, `expected the nearest hunter (~1000m) to win, got ${distance}`);
});

test('watchHunterPings: key: (q) => q.writer collapses repeated pings from the same hunter into one updating item instead of one per ping', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const red = await Qu.create({ runtime: runner.runtime });
  const gameId = await createGame(runner, { hunterTeams: [{ label: 'Team Rot', members: [red.fingerprint] }], hunterPingIntervalMs: 60_000 });
  const config = await getConfig(runner, gameId);

  let createCount = 0;
  const positions = [];
  watchHunterPings(runner, gameId, config, {
    key: (q) => q.writer,
    createItem: (q) => { createCount += 1; return q.writer; },
    render: (item, value) => positions.push(value.lat),
  });

  await pingHunterLocation(red, gameId, { lat: 1, lon: 1 });
  await pingHunterLocation(red, gameId, { lat: 2, lon: 2 });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(createCount, 1, 'the same hunter must only create one item, not one per ping');
  assert.deepEqual(positions, [1, 2], 'but render() must still fire for every new ping (position update)');
});

test('nearestHunterDistance: null without a position or without any hunter pings', () => {
  assert.equal(nearestHunterDistance(null, [{ value: { lat: 0, lon: 0 } }]), null);
  assert.equal(nearestHunterDistance({ lat: 0, lon: 0 }, []), null);
});

test('declareCaught: rejected outside the catch radius, succeeds inside it, non-hunters are rejected outright', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const hunted = await Qu.create({ runtime: runner.runtime });
  const hunter = await Qu.create({ runtime: runner.runtime });
  const bystander = await Qu.create({ runtime: runner.runtime });
  const gameId = await createGame(runner, {
    huntedTeam: [hunted.fingerprint],
    hunterTeams: [{ label: 'Fänger', members: [hunter.fingerprint] }],
    catchRadiusMeters: 50,
  });
  await pingLocation(hunted, gameId, { lat: 52.5200, lon: 13.4050 });

  await assert.rejects(() => declareCaught(bystander, gameId, { lat: 52.5200, lon: 13.4050 }), /Nur ein Mitglied eines Fänger-Teams/);
  await assert.rejects(() => declareCaught(hunter, gameId), /Reichweite kann nicht geprüft werden/); // kein hunterPosition übergeben

  // ~1000m entfernt (siehe haversineMeters()-Test oben) — weit außerhalb von 50m.
  await assert.rejects(() => declareCaught(hunter, gameId, { lat: 52.5290, lon: 13.4050 }), /Zu weit entfernt/);
  assert.equal(await getStatus(runner, gameId), 'active', 'a rejected catch attempt must not change the game status');

  // Ein paar Meter entfernt — innerhalb von 50m.
  await declareCaught(hunter, gameId, { lat: 52.52001, lon: 13.4050 });
  assert.equal(await getStatus(runner, gameId), 'caught');
});

test('endGame updates status; watchStatus delivers the current state immediately, then live changes', async () => {
  const runner = (await Qu.create()).use(createSpacesPlugin());
  const gameId = await createGame(runner);

  const seen = [];
  watchStatus(runner, gameId, (state) => seen.push(state));
  await new Promise((r) => setTimeout(r, 10)); // viewKey()'s initial catch-up runs asynchronously, not synchronously on the call
  assert.deepEqual(seen, ['active'], 'watchStatus must deliver the already-existing state without a separate initial read');

  await endGame(runner, gameId);
  assert.equal(await getStatus(runner, gameId), 'ended');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['active', 'ended']);
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

test('predictNextRadius: a single slow LAST interval (e.g. a rest stop) does not collapse the estimate — the earlier, faster pace still counts', () => {
  const a = { lat: 52.5200, lon: 13.4050 };
  const b = { lat: 52.5290, lon: 13.4050 }; // ~1000m north
  const pings = [
    { ts: 0, value: { lat: a.lat, lon: a.lon, accuracy: 0 } },
    { ts: 100_000, value: { lat: b.lat, lon: b.lon, accuracy: 0 } }, // ~10 m/s over 100s
    { ts: 1_100_000, value: { lat: b.lat, lon: b.lon, accuracy: 0 } }, // stood still for 1000s — the last interval alone is ~0 m/s
  ];
  const result = predictNextRadius(pings, { assumedSpeedMps: 1.4 }, 1_100_000);
  // Naively taking only the LAST interval's speed would give ~0 m/s here — a
  // radius that barely grows even though the tracked person moved fast
  // earlier and could, in principle, be moving again right now. Picking
  // the larger of the whole-history average and the peak interval speed
  // (both computed over ALL pings, not just the last one) keeps the
  // estimate anchored to the fastest pace actually observed instead.
  assert.ok(result.speedMps > 5, `expected the earlier ~10 m/s pace to still dominate, got ${result.speedMps} m/s`);
});

test('predictNextRadius: a single fast interval buried in an otherwise slow history is not averaged away', () => {
  const start = { lat: 52.5200, lon: 13.4050 };
  const sprintEnd = { lat: 52.5290, lon: 13.4050 }; // ~1000m north
  const pings = [
    { ts: 0, value: { lat: start.lat, lon: start.lon, accuracy: 0 } },
    { ts: 1000 * 1000, value: { lat: start.lat, lon: start.lon, accuracy: 0 } }, // barely moved for 1000s (~0 m/s)
    { ts: 1010 * 1000, value: { lat: sprintEnd.lat, lon: sprintEnd.lon, accuracy: 0 } }, // then covered ~1000m in 10s (~100 m/s)
  ];
  const result = predictNextRadius(pings, { assumedSpeedMps: 1.4 }, 1010 * 1000);
  // A pure average over the whole history (~1000m / 1010s ≈ 1 m/s) would
  // wash out that one fast burst — the peak-interval speed is what should
  // win here, since the person just demonstrated they CAN move that fast.
  assert.ok(result.speedMps > 50, `expected the peak ~100 m/s burst to dominate, got ${result.speedMps} m/s`);
});
