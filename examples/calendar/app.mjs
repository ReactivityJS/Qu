// Beispiel: geteilter, Ende-zu-Ende-verschlüsselter Kalender — Monats-,
// Wochen- und Tagesansicht, Termine anlegen/bearbeiten/löschen, Einladung
// zum Kalender-Space UND (getrennt davon) zu einzelnen Terminen (per
// Fingerprint ODER per Alias-Suche im öffentlichen Verzeichnis), RSVP,
// Push-Benachrichtigungen bei Änderungen, optional inkognito über eine
// Zweit-Identität. Die eigentliche Logik lebt in src/modules/calendar.js
// (Kern-Modul, kein Beispiel-Code, siehe dort für das Datenmodell/die
// Verschlüsselung/die Outsider-Einladung) — diese Datei ist nur die dünne
// UI-Schicht darüber, im selben Stil wie examples/forum/app.mjs
// (Zeit-Sharding-Board) bzw. examples/chat/app.mjs (Push-Registrierung,
// <qu-people-search>-Einladung).
//
// Alle Zeiten werden bewusst konsequent in UTC eingegeben/gerechnet/
// angezeigt (Datum- und Zeit-Felder getrennt statt eines lokalzeit-
// interpretierenden <input type="datetime-local">) — das passt exakt zu
// calendar.js's eigenem "YYYY-MM"-Bucket-Schema (ebenfalls UTC) und macht
// Monats-/Wochengrenzen für diese Demo eindeutig, ohne dass eine
// Zeitzonen-Umrechnung zwischen Anzeige und Speicherung nötig wäre.
//
// --- Identität: Haupt- vs. Inkognito-Identität pro Kalender ---
// `qu` (die Haupt-Identität, aus loadOrCreateIdentity()) ist IMMER die
// Identität, die diese App lädt/verwaltet und mit der das öffentliche
// Verzeichnis durchsucht wird (Lesen ist unkritisch, egal welche Identität
// gerade im Kalender aktiv ist — siehe modules/incognito-identity.js's
// eigenes Grenzen-Kapitel: die Relay-Verbindung verrät ohnehin, welche
// Identität wann online ist, unabhängig davon, WAS sie liest). `calQu` ist
// die Identität, die tatsächlich für DIESEN Kalender schreibt/liest
// (Termine, RSVP, Mitgliederverwaltung) — standardmäßig dieselbe wie `qu`,
// aber pro Kalender-Id auf einen gespeicherten Inkognito-Alias umstellbar
// (Einstellungen → Identität, src/modules/incognito-identity.js). Ein
// Wechsel öffnet eine ZWEITE Relay-Verbindung (enterIncognito() öffnet
// bewusst keine von selbst, siehe dessen Doku) und lädt die Seite neu,
// statt Subscriptions mitten in der Sitzung zurückzubauen.

import {
  createWebSocketChannel, createNetworkPlugin, createSpacesPlugin, createCalendarPlugin, createProfilesPlugin,
  createCalendarSpace, createEvent, updateEvent, deleteEvent, onEventsChange,
  inviteToEvent, removeFromEvent, setRSVP, setOutsiderRSVP, getRSVPs, onRSVPChange,
  addCalendarMember, removeCalendarMember,
  calendarBucketOf,
  isValidFingerprint,
  buildPath, parsePathSegments,
  createIncognitoIdentity, listIncognitoIdentities, deleteIncognitoIdentity, enterIncognito,
  DIRECTORY_ID, setDirectoryVisible,
} from '../../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import '../../src/ui/people-search-components.js'; // Seiteneffekt: registriert <qu-people-search>/<qu-profile-card>

const IDENTITY_KEY = 'qu-calendar-identity-keys';
const INCOGNITO_STORE_KEY = 'qu-calendar-incognito-store';
const IDENTITY_MAP_KEY = 'qu-calendar-identity-map';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const identityChipEl = el('identity-chip');
const toolbarEl = el('gcal-toolbar');
const rangeTitleEl = el('range-title');
const viewRoot = el('view-root');
const todayBtn = el('today-btn');
const prevBtn = el('prev-btn');
const nextBtn = el('next-btn');
const createBtn = el('create-btn');
const navMonthBtn = el('nav-month');
const navWeekBtn = el('nav-week');
const navDayBtn = el('nav-day');
const navSettingsBtn = el('nav-settings');

// --- Kleine, reine Hilfsfunktionen (Datum/Escape/Farbe) ---

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function hm(ms) { const d = new Date(ms); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }
function startOfDayUTC(ms) { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
function parseYmd(str) { const [y, m, d] = str.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function parseYm(str) { const [y, m] = str.split('-').map(Number); return Date.UTC(y, m - 1, 1); }
function startOfWeekUTC(ms) {
  const dow = new Date(startOfDayUTC(ms)).getUTCDay(); // 0=Sonntag
  return startOfDayUTC(ms) + (dow === 0 ? -6 : 1 - dow) * 86400000;
}
function daysInMonthUTC(year, monthIndex) { return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate(); }
function hmToMs(hhmm) { const [h, m] = hhmm.split(':').map(Number); return (h * 60 + m) * 60000; }

const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WEEKDAY_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

// Google-Kalender-artige, feste Palette — deterministisch aus der
// Ersteller-Fingerprint gewählt (derselbe Hash liefert immer dieselbe
// Farbe), damit Termine verschiedener Mitglieder auf einen Blick
// unterscheidbar sind, ohne dass jede App-Instanz sich eine Zuordnung
// merken müsste.
const EVENT_PALETTE = ['#1a73e8', '#33b679', '#8e24aa', '#e67c73', '#f4511e', '#039be5', '#616161', '#3f51b5', '#0b8043', '#c0ca33'];
function colorForFp(fp) {
  let hash = 0;
  for (let i = 0; i < fp.length; i++) hash = (hash * 31 + fp.charCodeAt(i)) >>> 0;
  return EVENT_PALETTE[hash % EVENT_PALETTE.length];
}

// --- Lokale Persistenz: Inkognito-Aliase + welcher Alias pro Kalender aktiv ist ---

function loadIncognitoStore() {
  try { return JSON.parse(localStorage.getItem(INCOGNITO_STORE_KEY) || '{}'); } catch { return {}; }
}
function saveIncognitoStore(store) { localStorage.setItem(INCOGNITO_STORE_KEY, JSON.stringify(store)); }
function loadIdentityMap() {
  try { return JSON.parse(localStorage.getItem(IDENTITY_MAP_KEY) || '{}'); } catch { return {}; }
}
function saveIdentityMap(map) { localStorage.setItem(IDENTITY_MAP_KEY, JSON.stringify(map)); }

/** Die Plugins, die JEDE für den Kalender genutzte Qu-Instanz braucht (Haupt- wie Inkognito) — die Haupt-Instanz bekommt sie über denselben .use()-Aufbau wie todo-lib.mjs/forum-lib.mjs (kein `plugins`-Array an Qu.create()), weshalb eine Inkognito-Instanz sie NICHT automatisch erbt (qu.js's defaultPlugins-Mechanismus greift nur, wenn die ERSTE Qu.create() sie per Option bekam) — enterIncognito()'s eigener `plugins`-Parameter füllt genau diese Lücke. */
function calendarPlugins() {
  return [createNetworkPlugin(), createSpacesPlugin(), createCalendarPlugin()];
}

// --- Öffentliche Adress-Suche (Straße/Ort) über OpenStreetMap Nominatim ---
//
// Ein rein clientseitiger, bewusst zurückhaltender Aufruf (500ms Debounce,
// mindestens 3 Zeichen, vorherige Anfrage wird abgebrochen) — kein Server
// dieser App ist beteiligt, die Anfrage geht direkt aus dem Browser der
// Nutzerin an einen öffentlichen, kostenlosen Geocoding-Dienst. Schlägt sie
// fehl (kein Netz, Dienst nicht erreichbar, CORS blockiert) verschwindet
// nur die Vorschlagsliste — das Ort-Feld bleibt ein ganz normales Textfeld,
// nie eine Voraussetzung zum Anlegen eines Termins.
async function fetchLocationSuggestions(query, signal) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&accept-language=de&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Geocoding-Anfrage fehlgeschlagen (${res.status})`);
  return res.json();
}
function formatSuggestion(item) {
  const a = item.address || {};
  const street = [a.road, a.house_number].filter(Boolean).join(' ');
  const cityName = a.city || a.town || a.village || a.municipality || '';
  const city = a.postcode ? `${a.postcode} ${cityName}`.trim() : cityName;
  const parts = [street, city, a.country].filter(Boolean);
  return parts.length ? parts.join(', ') : item.display_name;
}
function attachLocationAutocomplete(inputEl, listEl) {
  let debounceTimer = null;
  let controller = null;
  inputEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = inputEl.value.trim();
    if (query.length < 3) { listEl.hidden = true; listEl.textContent = ''; return; }
    debounceTimer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const results = await fetchLocationSuggestions(query, controller.signal);
        listEl.innerHTML = results.map((r) => `<li data-value="${esc(formatSuggestion(r))}">${esc(formatSuggestion(r))}</li>`).join('');
        listEl.hidden = results.length === 0;
      } catch (e) {
        if (e.name !== 'AbortError') { listEl.hidden = true; listEl.textContent = ''; }
      }
    }, 500);
  });
  listEl.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-value]');
    if (!li) return;
    inputEl.value = li.dataset.value;
    listEl.hidden = true;
    listEl.textContent = '';
  });
  document.addEventListener('click', (ev) => {
    if (ev.target !== inputEl && !listEl.contains(ev.target)) listEl.hidden = true;
  });
}
function locationFieldHtml(inputId, listId, value = '') {
  return `<div class="loc-field"><input type="text" id="${inputId}" value="${esc(value)}" autocomplete="off" />
    <ul class="loc-suggestions" id="${listId}" hidden></ul></div>`;
}

/** Verzeichnis-Suchergebnisse (<qu-people-search>) zeigen standardmäßig nur den Alias — für eine Einladung muss die FP daneben sichtbar sein, sonst lässt sich ein Alias nicht von einer Verwechslung/einem gleichnamigen Zweiteintrag unterscheiden. Liest die `fp`-Attribute, die <qu-profile-card> ohnehin schon trägt, statt die geteilte Komponente selbst zu verändern. */
function annotateFpBadges(searchEl) {
  searchEl.addEventListener('qu-people-search-results', () => {
    searchEl.querySelectorAll('qu-profile-card').forEach((card) => {
      const root = card.querySelector('.qu-profile-card');
      if (!root || root.querySelector('.fp-badge')) return;
      const fp = card.getAttribute('fp');
      const badge = document.createElement('span');
      badge.className = 'fp-badge';
      badge.textContent = fp;
      root.appendChild(badge);
    });
  });
}

async function main() {
  // createProfilesPlugin() is required for <qu-people-search> (qu.listDirectory()/
  // qu.onDirectoryChange(), see src/ui/people-search-components.js) — without it,
  // the search widget throws immediately on mount.
  const qu = (await loadOrCreateIdentity(IDENTITY_KEY)).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createCalendarPlugin()).use(createProfilesPlugin());

  const mainChannel = createWebSocketChannel(relayUrl());
  await mainChannel.connect();
  const repl = await qu.connect(mainChannel, { pushTopics: [''] });
  statusEl.textContent = 'Synchronisiere …';
  await qu.publishProfile();
  await repl.sync({ topic: qu.userSpaceId });

  let [calendarId, view = 'month', param, extra] = parsePathSegments(location.hash);

  if (!calendarId) {
    // Erster Besuch, noch kein Kalender in der URL — einen neuen anlegen und
    // direkt damit weitermachen (view/param unten), statt uns auf den
    // hashchange-Listener weiter unten zu verlassen: `location.hash =`
    // aktualisiert zwar die URL (zum Teilen/Merken), aber bis dieses Event
    // feuern könnte, ist die Ausführung schon an dessen Registrierung
    // vorbeigelaufen (mehrere `await`s weiter unten).
    const room = createCalendarSpace(qu, []);
    await room.ready;
    calendarId = room.id;
    view = 'month';
    param = calendarBucketOf(Date.now());
    location.hash = buildPath(calendarId, view, param);
  }
  await repl.sync({ topic: calendarId });

  // --- Identität, mit der DIESER Kalender tatsächlich agiert (siehe Datei-Doku) ---
  let calQu = qu;
  let calRepl = repl;
  const actingAliasName = loadIdentityMap()[calendarId] ?? null;
  const incognitoStoreAtStart = loadIncognitoStore();
  if (actingAliasName && incognitoStoreAtStart[actingAliasName]) {
    statusEl.textContent = `Wechsle zu Inkognito-Alias „${actingAliasName}“ …`;
    calQu = await enterIncognito(qu, incognitoStoreAtStart[actingAliasName], { plugins: calendarPlugins() });
    const calChannel = createWebSocketChannel(relayUrl());
    await calChannel.connect();
    calRepl = await calQu.connect(calChannel, { pushTopics: [''] });
    await calRepl.sync({ topic: calendarId });
  }
  statusEl.textContent = 'Verbunden';
  if (actingAliasName) {
    identityChipEl.textContent = `🕶 ${actingAliasName}`;
    identityChipEl.title = `Inkognito-Alias „${actingAliasName}“ (${calQu.fingerprint}) — andere Mitglieder sehen nur diese Fingerprint, nie deine Haupt-Identität.`;
  } else {
    identityChipEl.textContent = `${calQu.fingerprint.slice(0, 10)}…`;
    identityChipEl.title = `Haupt-Identität: ${calQu.fingerprint}`;
  }

  // --- Alias-Cache: viele Termine/RSVPs teilen sich dieselben Fingerprints, ein Alias-Lookup pro Fingerprint reicht ---
  // `qu.readProfile(fp)` liest NUR lokal (kein Netzwerk-Request, siehe
  // core/space-handle.js's `await node` vs. `.on()`/`.map()`) — nach einem
  // frischen Seitenaufruf hat die Haupt-Identität den Profil-Space einer
  // ANDEREN Identität (egal ob "echt" oder Inkognito) noch nie gesehen,
  // solange sie ihn nie synchronisiert hat. Ein einmaliges `repl.sync()`
  // pro Fingerprint (danach genauso gecacht wie das Ergebnis selbst) holt
  // genau das nach, BEVOR gelesen wird — sonst bliebe jeder fremde Alias
  // dauerhaft bei der rohen Fingerprint hängen, nicht nur beim allerersten
  // Rendern.
  const aliasCache = new Map();
  const syncedProfiles = new Set();
  async function alias(fp) {
    if (aliasCache.has(fp)) return aliasCache.get(fp);
    if (!syncedProfiles.has(fp)) {
      syncedProfiles.add(fp);
      await repl.sync({ topic: `~${fp}` }).catch(() => {});
    }
    const p = await qu.readProfile(fp).catch(() => ({ alias: fp }));
    const name = p.alias && p.alias !== fp ? p.alias : `${fp.slice(0, 8)}…`;
    aliasCache.set(fp, name);
    return name;
  }
  async function isCalendarWriter() {
    const m = await calQu.get(calendarId);
    return !!m?.value?.writers?.includes(calQu.fingerprint);
  }

  // --- Live-Termin-Cache: EIN Bucket kann von mehreren Ansichten gleichzeitig gebraucht werden (Wochenansicht an einer Monatsgrenze) ---
  let eventsById = new Map();
  let unsubs = [];
  function clearBucketSubs() {
    unsubs.forEach((u) => u());
    unsubs = [];
    eventsById = new Map();
  }
  function subscribeBucket(bucket, onChange) {
    unsubs.push(onEventsChange(calQu, calendarId, (q) => {
      if (q.value === undefined) return; // nicht adressiert — für diese Person unsichtbar, kein Fehler
      eventsById.set(q.id, q);
      onChange();
    }, { bucket }));
  }
  function visibleEvents(fromMs, toMs) {
    return [...eventsById.values()]
      .filter((q) => q.value && !q.value.deleted && q.value.start < toMs && q.value.end > fromMs)
      .sort((a, b) => a.value.start - b.value.start);
  }

  function navTo(nextView, nextParam, nextExtra) {
    location.hash = buildPath(calendarId, nextView, nextParam ?? '', ...(nextExtra ? [nextExtra] : []));
  }
  function setActiveNav(activeView) {
    for (const [btn, v] of [[navMonthBtn, 'month'], [navWeekBtn, 'week'], [navDayBtn, 'day']]) {
      btn.classList.toggle('active', v === activeView);
    }
    toolbarEl.hidden = activeView === 'event' || activeView === 'settings';
  }
  /** Ein repräsentatives Datum für die aktuelle Route — was "Heute"/"‹"/"›" als Bezugspunkt nehmen. */
  function currentAnchorMs() {
    if (view === 'week' || view === 'day') return parseYmd(param || ymd(Date.now()));
    return parseYm(param || calendarBucketOf(Date.now()));
  }

  todayBtn.addEventListener('click', () => {
    if (view === 'week') navTo('week', ymd(Date.now()));
    else if (view === 'day') navTo('day', ymd(Date.now()));
    else navTo('month', calendarBucketOf(Date.now()));
  });
  prevBtn.addEventListener('click', () => {
    const anchor = currentAnchorMs();
    if (view === 'week') navTo('week', ymd(anchor - 7 * 86400000));
    else if (view === 'day') navTo('day', ymd(anchor - 86400000));
    else { const d = new Date(anchor); d.setUTCMonth(d.getUTCMonth() - 1); navTo('month', calendarBucketOf(d.getTime())); }
  });
  nextBtn.addEventListener('click', () => {
    const anchor = currentAnchorMs();
    if (view === 'week') navTo('week', ymd(anchor + 7 * 86400000));
    else if (view === 'day') navTo('day', ymd(anchor + 86400000));
    else { const d = new Date(anchor); d.setUTCMonth(d.getUTCMonth() + 1); navTo('month', calendarBucketOf(d.getTime())); }
  });
  createBtn.addEventListener('click', () => navTo('event', 'new', ymd(currentAnchorMs())));
  navMonthBtn.addEventListener('click', () => navTo('month', calendarBucketOf(currentAnchorMs())));
  navWeekBtn.addEventListener('click', () => navTo('week', ymd(currentAnchorMs())));
  navDayBtn.addEventListener('click', () => navTo('day', ymd(currentAnchorMs())));
  navSettingsBtn.addEventListener('click', () => navTo('settings'));

  // --- Monatsansicht ---
  async function renderMonth(bucket) {
    clearBucketSubs();
    const monthStart = parseYm(bucket);
    const [year, monthIndex] = [new Date(monthStart).getUTCFullYear(), new Date(monthStart).getUTCMonth()];
    const days = daysInMonthUTC(year, monthIndex);
    const monthEnd = Date.UTC(year, monthIndex + 1, 1);
    rangeTitleEl.textContent = `${MONTH_NAMES[monthIndex]} ${year}`;

    async function draw() {
      const todayStr = ymd(Date.now());
      const cells = [];
      for (let day = 1; day <= days; day++) {
        const dayStart = Date.UTC(year, monthIndex, day);
        const dayEnd = dayStart + 86400000;
        const evs = visibleEvents(dayStart, dayEnd);
        const dow = new Date(dayStart).getUTCDay();
        const colStart = day === 1 ? (dow === 0 ? 7 : dow) : '';
        const dateStr = ymd(dayStart);
        cells.push(`<div class="day-cell${dateStr === todayStr ? ' today' : ''}" style="${colStart ? `grid-column-start:${colStart}` : ''}" data-date="${dateStr}">
          <div class="day-num">${day}</div>
          ${evs.map((q) => `<div class="day-event" data-event="${esc(q.id)}" style="background:${colorForFp(q.writer)}"><span class="dot"></span>${esc(q.value.title)}</div>`).join('')}
        </div>`);
      }
      viewRoot.innerHTML = `
        <div class="grid-scroll">
          <div class="weekday-row">${WEEKDAY_SHORT.map((d) => `<div>${d}</div>`).join('')}</div>
          <div class="month-grid">${cells.join('')}</div>
        </div>`;
      viewRoot.querySelectorAll('.day-cell').forEach((cellEl) => cellEl.addEventListener('click', (ev) => {
        if (ev.target.closest('.day-event')) return;
        navTo('event', 'new', cellEl.dataset.date);
      }));
      viewRoot.querySelectorAll('.day-event').forEach((evEl) => evEl.addEventListener('click', (ev) => { ev.stopPropagation(); navTo('event', evEl.dataset.event); }));
    }
    subscribeBucket(bucket, draw);
    if (bucket !== calendarBucketOf(monthEnd - 1)) subscribeBucket(calendarBucketOf(monthEnd - 1), draw); // Randfall: nie relevant hier (ein Monat ist genau EIN Bucket), nur zur Symmetrie mit Woche/Tag
    await draw();
  }

  // --- Wochenansicht ---
  async function renderWeek(dateStr) {
    clearBucketSubs();
    const weekStart = startOfWeekUTC(parseYmd(dateStr));
    const bucketA = calendarBucketOf(weekStart);
    const bucketB = calendarBucketOf(weekStart + 6 * 86400000);
    rangeTitleEl.textContent = `${ymd(weekStart)} – ${ymd(weekStart + 6 * 86400000)}`;

    async function draw() {
      const todayStr = ymd(Date.now());
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dayStart = weekStart + i * 86400000;
        const dayEnd = dayStart + 86400000;
        const evs = visibleEvents(dayStart, dayEnd);
        const dateStr2 = ymd(dayStart);
        days.push(`<div class="week-day${dateStr2 === todayStr ? ' today' : ''}" data-date="${dateStr2}">
          <div class="week-day-head">${WEEKDAY_SHORT[i]} ${new Date(dayStart).getUTCDate()}.</div>
          ${evs.map((q) => `<div class="day-event" data-event="${esc(q.id)}" style="background:${colorForFp(q.writer)}"><span class="dot"></span>${hm(q.value.start)} ${esc(q.value.title)}</div>`).join('')}
        </div>`);
      }
      viewRoot.innerHTML = `<div class="grid-scroll"><div class="week-grid">${days.join('')}</div></div>`;
      viewRoot.querySelectorAll('.week-day').forEach((cellEl) => cellEl.addEventListener('click', (ev) => {
        if (ev.target.closest('.day-event')) return;
        navTo('event', 'new', cellEl.dataset.date);
      }));
      viewRoot.querySelectorAll('.day-event').forEach((evEl) => evEl.addEventListener('click', (ev) => { ev.stopPropagation(); navTo('event', evEl.dataset.event); }));
    }
    subscribeBucket(bucketA, draw);
    if (bucketB !== bucketA) subscribeBucket(bucketB, draw);
    await draw();
  }

  // --- Tagesansicht ---
  async function renderDay(dateStr) {
    clearBucketSubs();
    const dayStart = parseYmd(dateStr);
    const dayEnd = dayStart + 86400000;
    const bucket = calendarBucketOf(dayStart);
    const dow = new Date(dayStart).getUTCDay();
    rangeTitleEl.textContent = `${WEEKDAY_LONG[dow === 0 ? 6 : dow - 1]}, ${new Date(dayStart).getUTCDate()}. ${MONTH_NAMES[new Date(dayStart).getUTCMonth()]} ${new Date(dayStart).getUTCFullYear()}`;

    async function draw() {
      const evs = visibleEvents(dayStart, dayEnd);
      viewRoot.innerHTML = `
        <p id="empty-notice" ${evs.length ? 'hidden' : ''}>Noch keine Termine an diesem Tag.</p>
        <ul id="day-events">${evs.map((q) => `<li data-event="${esc(q.id)}" style="border-left-color:${colorForFp(q.writer)}">
          <span class="ev-time">${q.value.allDay ? 'ganztägig' : `${hm(q.value.start)}–${hm(q.value.end)}`}</span>
          <span class="ev-title">${esc(q.value.title)}</span>
          ${q.value.location ? `<span class="ev-meta">📍 ${esc(q.value.location)}</span>` : ''}
        </li>`).join('')}</ul>`;
      viewRoot.querySelectorAll('#day-events li').forEach((li) => li.addEventListener('click', () => navTo('event', li.dataset.event)));
    }
    subscribeBucket(bucket, draw);
    await draw();
  }

  // --- Termin: Anlegen/Bearbeiten/Löschen/Einladen/RSVP ---
  async function renderEvent(eventIdOrNew, prefillDateStr) {
    clearBucketSubs();
    const iAmWriter = await isCalendarWriter();

    if (eventIdOrNew === 'new') {
      if (!iAmWriter) { viewRoot.innerHTML = '<p>Du bist kein Mitglied dieses Kalenders und kannst keine Termine anlegen.</p>'; return; }
      const d = prefillDateStr || ymd(Date.now());
      viewRoot.innerHTML = `
        <button type="button" class="back-link" id="back-btn">&larr; Zurück</button>
        <div class="gcal-card">
        <h3>Neuer Termin</h3>
        <form id="event-form">
          <label>Titel <input type="text" id="ev-title" required /></label>
          <label>Beschreibung <textarea id="ev-desc"></textarea></label>
          <label>Ort ${locationFieldHtml('ev-loc', 'ev-loc-suggestions')}</label>
          <label class="row"><input type="checkbox" id="ev-allday" style="width:auto;" /> Ganztägig</label>
          <div id="time-fields">
            <label>Start <input type="date" id="ev-start-date" value="${d}" required /> <input type="time" id="ev-start-time" value="09:00" /> (UTC)</label>
            <label>Ende <input type="date" id="ev-end-date" value="${d}" required /> <input type="time" id="ev-end-time" value="10:00" /> (UTC)</label>
          </div>
          <button type="submit" class="gcal-btn gcal-btn-primary">Anlegen</button>
        </form>
        </div>`;
      el('back-btn').addEventListener('click', () => history.back());
      el('ev-allday').addEventListener('change', (ev) => { el('time-fields').classList.toggle('hidden', ev.target.checked); });
      attachLocationAutocomplete(el('ev-loc'), el('ev-loc-suggestions'));
      el('event-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const allDay = el('ev-allday').checked;
        const startDate = el('ev-start-date').value, endDate = el('ev-end-date').value;
        const start = allDay ? parseYmd(startDate) : parseYmd(startDate) + hmToMs(el('ev-start-time').value);
        const end = allDay ? parseYmd(endDate) + 86400000 : parseYmd(endDate) + hmToMs(el('ev-end-time').value);
        const { qubit } = await createEvent(calQu, calendarId, {
          title: el('ev-title').value.trim(), description: el('ev-desc').value.trim() || null,
          location: el('ev-loc').value.trim() || null, start, end, allDay,
        });
        navTo('event', qubit.id);
      });
      return;
    }

    const eventId = eventIdOrNew;
    const q = await calQu.get(eventId);
    if (!q?.value) { viewRoot.innerHTML = '<p>Dieser Termin existiert nicht oder du hast keinen Zugriff darauf.</p>'; return; }
    const v = q.value;
    const rsvps = await getRSVPs(calQu, eventId);
    const rsvpRows = await Promise.all(Object.entries(rsvps).map(async ([fp, status]) => `<li>${esc(await alias(fp))}: ${esc(status)}</li>`));
    const myStatus = rsvps[calQu.fingerprint] ?? '–';

    viewRoot.innerHTML = `
      <button type="button" class="back-link" id="back-btn">&larr; Zurück</button>
      <div class="gcal-card">
      <h3 style="font-size:1.15rem;">${esc(v.title)}</h3>
      <p class="ev-meta">${v.allDay ? 'Ganztägig' : `${new Date(v.start).toISOString().replace('T', ' ').slice(0, 16)} – ${new Date(v.end).toISOString().replace('T', ' ').slice(0, 16)} (UTC)`}</p>
      ${v.location ? `<p>📍 ${esc(v.location)}</p>` : ''}
      ${v.description ? `<p class="ev-desc">${esc(v.description)}</p>` : ''}
      <p class="ev-meta">Erstellt von ${esc(await alias(v.createdBy))} · zuletzt geändert von ${esc(await alias(q.writer))}</p>
      </div>

      <div class="gcal-card"><h3>Deine Rückmeldung (${esc(myStatus)})</h3>
        <div class="row"><button type="button" class="gcal-btn" data-rsvp="going">Zusage</button><button type="button" class="gcal-btn" data-rsvp="maybe">Vielleicht</button><button type="button" class="gcal-btn" data-rsvp="declined">Absage</button></div>
      </div>
      <div class="gcal-card"><h3>Rückmeldungen</h3><ul>${rsvpRows.join('') || '<li>Noch keine.</li>'}</ul></div>

      ${iAmWriter ? `
      <div class="gcal-card"><h3>Termin bearbeiten</h3>
        <form id="edit-form">
          <label>Titel <input type="text" id="edit-title" value="${esc(v.title)}" required /></label>
          <label>Beschreibung <textarea id="edit-desc">${esc(v.description ?? '')}</textarea></label>
          <label>Ort ${locationFieldHtml('edit-loc', 'edit-loc-suggestions', v.location ?? '')}</label>
          <button type="submit" class="gcal-btn gcal-btn-primary">Speichern</button>
        </form>
        <button type="button" id="delete-btn" class="gcal-btn gcal-btn-danger" style="margin-top:0.6rem;">Termin löschen</button>
      </div>
      <div class="gcal-card"><h3>Zu diesem Termin einladen</h3>
        <p class="hint">Getrennt von der Kalender-Mitgliedschaft — die eingeladene Person sieht nur diesen einen Termin, nicht den restlichen Kalender.</p>
        <qu-people-search mode="search" fields="alias,fingerprint" placeholder="Nach Alias oder Fingerprint suchen …"></qu-people-search>
        <form id="invite-event-form" class="row">
          <input type="text" id="invite-event-fp" placeholder="Fingerprint der eingeladenen Person" />
          <button type="submit" class="gcal-btn gcal-btn-primary">Einladen</button>
        </form>
      </div>` : `
      <div class="gcal-card"><h3>RSVP als Eingeladene:r</h3><p class="hint">Du bist zu diesem einen Termin eingeladen, aber kein Mitglied des Kalenders — deine Rückmeldung wird unter deiner eigenen Identität gespeichert.</p></div>`}
    `;

    el('back-btn').addEventListener('click', () => history.back());
    viewRoot.querySelectorAll('[data-rsvp]').forEach((btn) => btn.addEventListener('click', async () => {
      if (iAmWriter) await setRSVP(calQu, eventId, btn.dataset.rsvp);
      else await setOutsiderRSVP(calQu, eventId, btn.dataset.rsvp);
      await renderEvent(eventId);
    }));
    if (iAmWriter) {
      attachLocationAutocomplete(el('edit-loc'), el('edit-loc-suggestions'));
      el('edit-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await updateEvent(calQu, eventId, { title: el('edit-title').value.trim(), description: el('edit-desc').value.trim() || null, location: el('edit-loc').value.trim() || null });
        await renderEvent(eventId);
      });
      el('delete-btn').addEventListener('click', async () => {
        if (!confirm('Diesen Termin wirklich löschen?')) return;
        await deleteEvent(calQu, eventId);
        navTo('day', ymd(startOfDayUTC(v.start)));
      });
      const eventInviteSearch = viewRoot.querySelector('qu-people-search');
      eventInviteSearch.qu = qu;
      annotateFpBadges(eventInviteSearch);
      eventInviteSearch.addEventListener('qu-profile-open', (ev) => { el('invite-event-fp').value = ev.detail.fingerprint; });
      el('invite-event-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fp = el('invite-event-fp').value.trim();
        if (!isValidFingerprint(fp)) { alert('Ungültiger Fingerprint.'); return; }
        await inviteToEvent(calQu, eventId, fp);
        el('invite-event-fp').value = '';
        alert('Eingeladen — die Person wurde per Push benachrichtigt, falls registriert.');
      });
    }
  }

  // --- Push-Benachrichtigungen — Zustand unabhängig von der DOM (nur in
  // den Einstellungen sichtbar), UI-Elemente werden bei jedem Rendern der
  // Einstellungen frisch gesucht/verdrahtet (siehe renderSettings()). ---
  let swRegistration = null;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  let vapidPublicKey;
  function urlBase64ToUint8Array(base64url) {
    const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }
  async function refreshPushUI(overrideStatus) {
    const btn = el('push-toggle-btn'); const statusEl2 = el('push-status');
    if (!btn || !statusEl2) return; // Einstellungen gerade nicht sichtbar
    if (!pushSupported) { btn.disabled = true; btn.textContent = 'Nicht unterstützt'; statusEl2.textContent = overrideStatus ?? 'Dieser Browser unterstützt keine Web-Push-Benachrichtigungen.'; return; }
    if (Notification.permission === 'denied') { btn.disabled = true; btn.textContent = 'Blockiert'; statusEl2.textContent = overrideStatus ?? 'Benachrichtigungen sind blockiert.'; return; }
    const sub = swRegistration ? await swRegistration.pushManager.getSubscription() : null;
    btn.disabled = false;
    btn.textContent = sub ? 'Deaktivieren' : 'Aktivieren';
    statusEl2.textContent = overrideStatus ?? (sub ? 'Aktiv.' : 'Aus.');
  }
  async function publishPushSubscription(subscription) {
    await calQu.session.publish(`push-subscription/${calQu.fingerprint}`, subscription);
    await calRepl.sync({ topic: `push-subscription/${calQu.fingerprint}` }).catch(() => {});
  }
  async function onPushToggleClick() {
    const btn = el('push-toggle-btn');
    btn.disabled = true;
    let errorStatus;
    try {
      const existing = swRegistration ? await swRegistration.pushManager.getSubscription() : null;
      if (existing) { await existing.unsubscribe(); await publishPushSubscription(null).catch(() => {}); return; }
      if (vapidPublicKey === undefined) vapidPublicKey = await fetch('/push/vapid-public-key').then((r) => r.json()).then((r) => r.publicKey).catch(() => null);
      if (!vapidPublicKey) { errorStatus = 'Push ist auf diesem Server nicht konfiguriert.'; return; }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const sub = await swRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
      await publishPushSubscription(sub.toJSON());
    } catch (e) {
      errorStatus = `Fehler: ${e.message}`;
    } finally {
      await refreshPushUI(errorStatus);
    }
  }
  if (pushSupported) {
    try { swRegistration = await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.error('[calendar] service worker registration failed:', e); }
    if (swRegistration && Notification.permission === 'granted') {
      const sub = await swRegistration.pushManager.getSubscription();
      if (sub) publishPushSubscription(sub.toJSON()).catch(() => {});
    }
  }

  // --- Kalender-Einstellungen: Teilen, Mitgliederverwaltung, Benachrichtigungen, Identität ---
  async function renderSettings() {
    clearBucketSubs();
    rangeTitleEl.textContent = '';
    const manifest = await calQu.get(calendarId);
    const members = manifest?.value?.writers ?? [];
    const memberRows = await Promise.all(members.map(async (fp) => `<li><span>${esc(await alias(fp))}</span> ${fp === calQu.fingerprint ? '<span class="hint">(du)</span>' : `<button type="button" data-remove="${esc(fp)}" class="gcal-btn">Entfernen</button>`}</li>`));
    const shareLink = `${location.origin}${location.pathname}${buildPath(calendarId, 'month', calendarBucketOf(Date.now()))}`;

    const dirEntryQ = await qu.get(`${DIRECTORY_ID}/entries/${qu.fingerprint}`);
    const isDirectoryVisible = !!dirEntryQ?.value?.visible;

    const incognitoIdentities = listIncognitoIdentities(loadIncognitoStore()); // { alias, fingerprint, createdAt }[] — never exposes `keys`, see incognito-identity.js
    const identityMap = loadIdentityMap();
    const currentAliasName = identityMap[calendarId] ?? '';
    const identityOptions = [`<option value="" ${!currentAliasName ? 'selected' : ''}>Hauptidentität (${qu.fingerprint.slice(0, 10)}…)</option>`]
      .concat(incognitoIdentities.map(({ alias: name, fingerprint }) => `<option value="${esc(name)}" ${currentAliasName === name ? 'selected' : ''}>${esc(name)} (${fingerprint.slice(0, 10)}…)</option>`));
    const identityListRows = incognitoIdentities.map(({ alias: name, fingerprint }) => `<li><span>${esc(name)}<span class="fp-badge">${fingerprint}</span></span><button type="button" data-delete-identity="${esc(name)}" class="gcal-btn gcal-btn-danger">Löschen</button></li>`);

    viewRoot.innerHTML = `
      <button type="button" class="back-link" id="back-btn">&larr; Zurück zum Kalender</button>
      <h2 style="font-weight:500; font-size:1.3rem;">Einstellungen</h2>

      <div class="gcal-card gcal-settings-section">
        <h3>Kalender teilen</h3>
        <p class="hint">Diesen Link weitergeben — nur Mitglieder unten dürfen Termine anlegen/bearbeiten. Wie bei Google/Outlook: der Link allein reicht nicht, Schreibrecht kommt separat über die Mitgliederliste.</p>
        <input type="text" readonly value="${esc(shareLink)}" onclick="this.select()" style="width:100%; background:var(--gcal-surface); border:1px solid var(--gcal-border); border-radius:6px; padding:0.5rem 0.7rem; font-size:0.82rem;" />
      </div>

      <div class="gcal-card gcal-settings-section">
        <h3>Deine Auffindbarkeit</h3>
        <div class="toggle-row">
          <span class="label">Im öffentlichen Namensverzeichnis sichtbar sein<span class="sub">Gilt für deine Haupt-Identität, App-übergreifend — nicht nur diesen Kalender. Nur so kann dich jemand per Alias statt per Fingerprint finden.</span></span>
          <input type="checkbox" id="directory-visible-toggle" ${isDirectoryVisible ? 'checked' : ''} style="width:1.2rem; height:1.2rem;" />
        </div>
      </div>

      <div class="gcal-card gcal-settings-section">
        <h3>Mitglieder</h3>
        <ul id="member-list">${memberRows.join('')}</ul>
        <p class="hint">Per Alias im öffentlichen Verzeichnis suchen (Fingerprint wird zur Kontrolle mit angezeigt) oder direkt einfügen:</p>
        <qu-people-search mode="search" fields="alias,fingerprint" placeholder="Nach Alias oder Fingerprint suchen …"></qu-people-search>
        <form id="add-member-form" class="row">
          <input type="text" id="add-member-fp" placeholder="Fingerprint" />
          <button type="submit" class="gcal-btn gcal-btn-primary">Einladen</button>
        </form>
      </div>

      <div class="gcal-card gcal-settings-section">
        <h3>Benachrichtigungen</h3>
        <div class="toggle-row">
          <span class="label">Push-Benachrichtigungen<span class="sub" id="push-status">…</span></span>
          <button type="button" class="gcal-btn" id="push-toggle-btn">…</button>
        </div>
        <p class="hint">Du wirst benachrichtigt, wenn sich ein Termin in diesem Kalender ändert oder du zu einem Termin eingeladen wirst — der Inhalt wird dabei nie mitgeschickt, nur dass sich etwas geändert hat.</p>
      </div>

      <div class="gcal-card gcal-settings-section">
        <h3>Identität</h3>
        <p class="hint">Statt deiner Haupt-Identität kannst du für DIESEN Kalender einen Inkognito-Alias verwenden — andere Mitglieder sehen dann nur den Alias, nie deine echte Fingerprint. Ein neuer Alias muss zuerst (als Mitglied oben) eingeladen werden, bevor er hier ausgewählt werden kann. Ein Wechsel lädt die Seite neu.</p>
        <div class="row">
          <select class="gcal-select" id="identity-select" style="flex:1;">${identityOptions.join('')}</select>
        </div>
        <p class="hint" style="margin-top:0.7rem;">Gespeicherte Inkognito-Aliase (nur auf diesem Gerät):</p>
        <ul id="identity-list">${identityListRows.join('') || '<li class="hint">Noch keine.</li>'}</ul>
        <button type="button" class="gcal-btn" id="new-identity-btn" style="margin-top:0.6rem;">+ Neuen Inkognito-Alias erstellen</button>
      </div>
    `;

    el('back-btn').addEventListener('click', () => navTo('month', calendarBucketOf(Date.now())));

    el('directory-visible-toggle').addEventListener('change', async (ev) => {
      await setDirectoryVisible(qu, ev.target.checked);
    });

    const memberSearch = viewRoot.querySelector('qu-people-search');
    memberSearch.qu = qu;
    annotateFpBadges(memberSearch);
    memberSearch.addEventListener('qu-profile-open', (ev) => { el('add-member-fp').value = ev.detail.fingerprint; });

    el('add-member-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fp = el('add-member-fp').value.trim();
      if (!isValidFingerprint(fp)) { alert('Ungültiger Fingerprint.'); return; }
      await addCalendarMember(calQu, calendarId, members, fp, {});
      await renderSettings();
    });
    viewRoot.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
      await removeCalendarMember(calQu, calendarId, members, btn.dataset.remove);
      await renderSettings();
    }));

    el('identity-select').addEventListener('change', (ev) => {
      const map = loadIdentityMap();
      if (ev.target.value) map[calendarId] = ev.target.value; else delete map[calendarId];
      saveIdentityMap(map);
      location.reload();
    });
    el('new-identity-btn').addEventListener('click', async () => {
      const name = (prompt('Anzeigename für den neuen Inkognito-Alias (nur lokal auf diesem Gerät sichtbar):') || '').trim();
      if (!name) return;
      const store0 = loadIncognitoStore();
      if (store0[name]) { alert('Dieser Aliasname wird bereits verwendet.'); return; }
      const entry = await createIncognitoIdentity(name);
      const store = { ...store0, [name]: { fingerprint: entry.fingerprint, keys: entry.keys, createdAt: entry.createdAt } };
      saveIncognitoStore(store);
      // Veröffentlicht einen freundlichen Anzeigenamen für diese Persona, damit
      // andere Mitglieder (und die Verzeichnis-Suche oben) einen Namen statt
      // nur einer rohen Fingerprint sehen — kurz verbinden, veröffentlichen,
      // wieder trennen (diese Identität ist noch nirgendwo aktiv genutzt).
      try {
        const tempQu = await enterIncognito(qu, store[name], { plugins: [createNetworkPlugin()] });
        const tempChannel = createWebSocketChannel(relayUrl());
        await tempChannel.connect();
        const tempRepl = await tempQu.connect(tempChannel, { pushTopics: [''] });
        await tempQu.publishProfile({ alias: name });
        await tempRepl.sync({ topic: tempQu.userSpaceId });
        tempRepl.close();
        await tempChannel.close();
      } catch (e) { console.error('[calendar] publishing incognito profile failed:', e); }
      await renderSettings();
    });
    viewRoot.querySelectorAll('[data-delete-identity]').forEach((btn) => btn.addEventListener('click', () => {
      const name = btn.dataset.deleteIdentity;
      if (!confirm(`Inkognito-Alias „${name}“ wirklich löschen? Bereits erteilte Kalender-Mitgliedschaften dieser Identität bleiben davon unberührt.`)) return;
      saveIncognitoStore(deleteIncognitoIdentity(loadIncognitoStore(), name));
      const map = loadIdentityMap();
      if (map[calendarId] === name) { delete map[calendarId]; saveIdentityMap(map); }
      renderSettings();
    }));

    el('push-toggle-btn').addEventListener('click', onPushToggleClick);
    await refreshPushUI();
  }

  async function render() {
    setActiveNav(view);
    if (view === 'month') await renderMonth(param || calendarBucketOf(Date.now()));
    else if (view === 'week') await renderWeek(param || ymd(Date.now()));
    else if (view === 'day') await renderDay(param || ymd(Date.now()));
    else if (view === 'event') await renderEvent(param, extra);
    else if (view === 'settings') await renderSettings();
    else await renderMonth(calendarBucketOf(Date.now()));
  }

  window.addEventListener('hashchange', async () => {
    [, view = 'month', param, extra] = parsePathSegments(location.hash);
    await render();
  });
  await render();
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
