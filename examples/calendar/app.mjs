// Beispiel: geteilter, Ende-zu-Ende-verschlüsselter Kalender — Monats-,
// Wochen- und Tagesansicht, Termine anlegen/bearbeiten/löschen, Einladung
// zum Kalender-Space UND (getrennt davon) zu einzelnen Terminen, RSVP,
// Push-Benachrichtigungen bei Änderungen. Die eigentliche Logik lebt in
// src/modules/calendar.js (Kern-Modul, kein Beispiel-Code, siehe dort für
// das Datenmodell/die Verschlüsselung/die Outsider-Einladung) — diese
// Datei ist nur die dünne UI-Schicht darüber, im selben Stil wie
// examples/forum/app.mjs (Zeit-Sharding-Board) bzw. examples/chat/app.mjs
// (Push-Registrierung).
//
// Alle Zeiten werden bewusst konsequent in UTC eingegeben/gerechnet/
// angezeigt (Datum- und Zeit-Felder getrennt statt eines lokalzeit-
// interpretierenden <input type="datetime-local">) — das passt exakt zu
// calendar.js's eigenem "YYYY-MM"-Bucket-Schema (ebenfalls UTC) und macht
// Monats-/Wochengrenzen für diese Demo eindeutig, ohne dass eine
// Zeitzonen-Umrechnung zwischen Anzeige und Speicherung nötig wäre. Eine
// echte App würde stattdessen die Zeitzone der Nutzerin anzeigen, aber
// weiterhin intern in epoch-ms gegen calendar.js arbeiten.
//
// Terminrechte sind bewusst per Klartext-Fingerprint erteilt (kein
// <qu-people-search>-Picker wie bei Chat) — derselbe minimale
// "Fingerprint einfügen"-Fluss wie examples/todo-lib.mjs's
// grantWriteAccess(), um diese Demo ohne ein Verzeichnis/Kontaktbuch
// lauffähig zu halten.

import {
  createWebSocketChannel, createNetworkPlugin, createSpacesPlugin, createCalendarPlugin,
  createCalendarSpace, createEvent, updateEvent, deleteEvent, onEventsChange,
  inviteToEvent, removeFromEvent, setRSVP, setOutsiderRSVP, getRSVPs, onRSVPChange,
  addCalendarMember, removeCalendarMember,
  calendarBucketOf,
  isValidFingerprint,
  buildPath, parsePathSegments,
} from '../../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';

const IDENTITY_KEY = 'qu-calendar-identity-keys';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const pushToggleBtn = el('push-toggle-btn');
const pushStatusEl = el('push-status');
const viewRoot = el('view-root');
const navMonthBtn = el('nav-month');
const navWeekBtn = el('nav-week');
const navDayBtn = el('nav-day');
const navSettingsBtn = el('nav-settings');

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

async function main() {
  const qu = (await loadOrCreateIdentity(IDENTITY_KEY))
    .use(createNetworkPlugin()).use(createSpacesPlugin()).use(createCalendarPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  let [calendarId, view = 'month', param, extra] = parsePathSegments(location.hash);

  const repl = await qu.connect(channel, { pushTopics: [''] });
  statusEl.textContent = 'Synchronisiere …';
  await qu.publishProfile();
  await repl.sync({ topic: qu.userSpaceId });

  if (!calendarId) {
    // First visit, no calendar in the URL yet — bootstrap a fresh one and
    // keep going with it directly (view/param below), rather than relying
    // on the hashchange listener registered further down: `location.hash =`
    // does update the URL for bookmarking/sharing, but by the time that
    // event could fire, execution has moved well past the listener's
    // registration point (several `await`s below) — waiting for it here
    // would either race or silently never re-render.
    const room = createCalendarSpace(qu, []);
    await room.ready;
    calendarId = room.id;
    view = 'month';
    param = calendarBucketOf(Date.now());
    location.hash = buildPath(calendarId, view, param);
  }
  await repl.sync({ topic: calendarId });
  statusEl.textContent = 'Verbunden';

  // --- Alias-Cache: viele Termine/RSVPs teilen sich dieselben Fingerprints, ein Alias-Lookup pro Fingerprint reicht ---
  const aliasCache = new Map();
  async function alias(fp) {
    if (aliasCache.has(fp)) return aliasCache.get(fp);
    const p = await qu.readProfile(fp).catch(() => ({ alias: fp }));
    const name = p.alias && p.alias !== fp ? p.alias : `${fp.slice(0, 8)}…`;
    aliasCache.set(fp, name);
    return name;
  }
  async function isCalendarWriter() {
    const m = await qu.get(calendarId);
    return !!m?.value?.writers?.includes(qu.fingerprint);
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
    unsubs.push(onEventsChange(qu, calendarId, (q) => {
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
    for (const [btn, v] of [[navMonthBtn, 'month'], [navWeekBtn, 'week'], [navDayBtn, 'day'], [navSettingsBtn, 'settings']]) {
      btn.classList.toggle('active', v === activeView);
    }
  }

  navMonthBtn.addEventListener('click', () => navTo('month', calendarBucketOf(Date.now())));
  navWeekBtn.addEventListener('click', () => navTo('week', ymd(Date.now())));
  navDayBtn.addEventListener('click', () => navTo('day', ymd(Date.now())));
  navSettingsBtn.addEventListener('click', () => navTo('settings'));

  // --- Monatsansicht ---
  async function renderMonth(bucket) {
    clearBucketSubs();
    const monthStart = parseYm(bucket);
    const [year, monthIndex] = [new Date(monthStart).getUTCFullYear(), new Date(monthStart).getUTCMonth()];
    const days = daysInMonthUTC(year, monthIndex);
    const monthEnd = Date.UTC(year, monthIndex + 1, 1);

    async function draw() {
      const cells = [];
      for (let day = 1; day <= days; day++) {
        const dayStart = Date.UTC(year, monthIndex, day);
        const dayEnd = dayStart + 86400000;
        const evs = visibleEvents(dayStart, dayEnd);
        const dow = new Date(dayStart).getUTCDay();
        const colStart = day === 1 ? (dow === 0 ? 7 : dow) : '';
        cells.push(`<div class="day-cell" style="${colStart ? `grid-column-start:${colStart}` : ''}" data-date="${ymd(dayStart)}">
          <div class="day-num">${day}</div>
          ${evs.map((q) => `<div class="day-event" data-event="${esc(q.id)}">${esc(q.value.title)}</div>`).join('')}
        </div>`);
      }
      viewRoot.innerHTML = `
        <div class="month-bar"><button type="button" id="prev-month">&larr;</button><strong>${bucket}</strong><button type="button" id="next-month">&rarr;</button></div>
        <div class="grid-scroll">
          <div class="weekday-row">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => `<div>${d}</div>`).join('')}</div>
          <div class="month-grid">${cells.join('')}</div>
        </div>`;
      el('prev-month').addEventListener('click', () => { const d = new Date(monthStart); d.setUTCMonth(d.getUTCMonth() - 1); navTo('month', calendarBucketOf(d.getTime())); });
      el('next-month').addEventListener('click', () => { const d = new Date(monthStart); d.setUTCMonth(d.getUTCMonth() + 1); navTo('month', calendarBucketOf(d.getTime())); });
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

    async function draw() {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dayStart = weekStart + i * 86400000;
        const dayEnd = dayStart + 86400000;
        const evs = visibleEvents(dayStart, dayEnd);
        days.push(`<div class="week-day" data-date="${ymd(dayStart)}">
          <div class="week-day-head">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'][i]} ${new Date(dayStart).getUTCDate()}.</div>
          ${evs.map((q) => `<div class="day-event" data-event="${esc(q.id)}">${hm(q.value.start)} ${esc(q.value.title)}</div>`).join('')}
        </div>`);
      }
      viewRoot.innerHTML = `
        <div class="month-bar"><button type="button" id="prev-week">&larr;</button><strong>${ymd(weekStart)} – ${ymd(weekStart + 6 * 86400000)}</strong><button type="button" id="next-week">&rarr;</button></div>
        <div class="grid-scroll"><div class="week-grid">${days.join('')}</div></div>`;
      el('prev-week').addEventListener('click', () => navTo('week', ymd(weekStart - 7 * 86400000)));
      el('next-week').addEventListener('click', () => navTo('week', ymd(weekStart + 7 * 86400000)));
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

    async function draw() {
      const evs = visibleEvents(dayStart, dayEnd);
      viewRoot.innerHTML = `
        <div class="month-bar"><button type="button" id="prev-day">&larr;</button><strong>${dateStr} (UTC)</strong><button type="button" id="next-day">&rarr;</button></div>
        <p id="empty-notice" ${evs.length ? 'hidden' : ''}>Noch keine Termine an diesem Tag.</p>
        <ul id="day-events">${evs.map((q) => `<li data-event="${esc(q.id)}">
          <span class="ev-time">${q.value.allDay ? 'ganztägig' : `${hm(q.value.start)}–${hm(q.value.end)}`}</span>
          <span class="ev-title">${esc(q.value.title)}</span>
          ${q.value.location ? `<span class="ev-loc">📍 ${esc(q.value.location)}</span>` : ''}
        </li>`).join('')}</ul>
        <button type="button" id="add-event-btn">+ Neuer Termin</button>`;
      el('prev-day').addEventListener('click', () => navTo('day', ymd(dayStart - 86400000)));
      el('next-day').addEventListener('click', () => navTo('day', ymd(dayStart + 86400000)));
      el('add-event-btn').addEventListener('click', () => navTo('event', 'new', dateStr));
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
        <h2>Neuer Termin</h2>
        <form id="event-form">
          <label>Titel <input type="text" id="ev-title" required /></label>
          <label>Beschreibung <textarea id="ev-desc"></textarea></label>
          <label>Ort <input type="text" id="ev-loc" /></label>
          <label class="row"><input type="checkbox" id="ev-allday" /> Ganztägig</label>
          <div id="time-fields">
            <label>Start <input type="date" id="ev-start-date" value="${d}" required /> <input type="time" id="ev-start-time" value="09:00" /> (UTC)</label>
            <label>Ende <input type="date" id="ev-end-date" value="${d}" required /> <input type="time" id="ev-end-time" value="10:00" /> (UTC)</label>
          </div>
          <button type="submit">Anlegen</button>
        </form>`;
      el('back-btn').addEventListener('click', () => history.back());
      el('ev-allday').addEventListener('change', (ev) => { el('time-fields').classList.toggle('hidden', ev.target.checked); });
      el('event-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const allDay = el('ev-allday').checked;
        const startDate = el('ev-start-date').value, endDate = el('ev-end-date').value;
        const start = allDay ? parseYmd(startDate) : parseYmd(startDate) + hmToMs(el('ev-start-time').value);
        const end = allDay ? parseYmd(endDate) + 86400000 : parseYmd(endDate) + hmToMs(el('ev-end-time').value);
        const { qubit } = await createEvent(qu, calendarId, {
          title: el('ev-title').value.trim(), description: el('ev-desc').value.trim() || null,
          location: el('ev-loc').value.trim() || null, start, end, allDay,
        });
        navTo('event', qubit.id);
      });
      return;
    }

    const eventId = eventIdOrNew;
    const q = await qu.get(eventId);
    if (!q?.value) { viewRoot.innerHTML = '<p>Dieser Termin existiert nicht oder du hast keinen Zugriff darauf.</p>'; return; }
    const v = q.value;
    const rsvps = await getRSVPs(qu, eventId);
    const rsvpRows = await Promise.all(Object.entries(rsvps).map(async ([fp, status]) => `<li>${esc(await alias(fp))}: ${esc(status)}</li>`));
    const myStatus = rsvps[qu.fingerprint] ?? '–';

    viewRoot.innerHTML = `
      <button type="button" class="back-link" id="back-btn">&larr; Zurück</button>
      <h2>${esc(v.title)}</h2>
      <p class="ev-meta">${v.allDay ? 'Ganztägig' : `${new Date(v.start).toISOString().replace('T', ' ').slice(0, 16)} – ${new Date(v.end).toISOString().replace('T', ' ').slice(0, 16)} (UTC)`}</p>
      ${v.location ? `<p>📍 ${esc(v.location)}</p>` : ''}
      ${v.description ? `<p class="ev-desc">${esc(v.description)}</p>` : ''}
      <p class="ev-meta">Erstellt von ${esc(await alias(v.createdBy))} · zuletzt geändert von ${esc(await alias(q.writer))}</p>

      <div class="box"><h3>Deine Rückmeldung (${esc(myStatus)})</h3>
        <div class="row"><button type="button" data-rsvp="going">Zusage</button><button type="button" data-rsvp="maybe">Vielleicht</button><button type="button" data-rsvp="declined">Absage</button></div>
      </div>
      <div class="box"><h3>Rückmeldungen</h3><ul>${rsvpRows.join('') || '<li>Noch keine.</li>'}</ul></div>

      ${iAmWriter ? `
      <div class="box"><h3>Termin bearbeiten</h3>
        <form id="edit-form">
          <label>Titel <input type="text" id="edit-title" value="${esc(v.title)}" required /></label>
          <label>Beschreibung <textarea id="edit-desc">${esc(v.description ?? '')}</textarea></label>
          <label>Ort <input type="text" id="edit-loc" value="${esc(v.location ?? '')}" /></label>
          <button type="submit">Speichern</button>
        </form>
        <button type="button" id="delete-btn" class="danger">Termin löschen</button>
      </div>
      <div class="box"><h3>Zu diesem Termin einladen (getrennt von der Kalender-Mitgliedschaft)</h3>
        <form id="invite-event-form" class="row">
          <input type="text" id="invite-event-fp" placeholder="Fingerprint der eingeladenen Person" />
          <button type="submit">Einladen</button>
        </form>
      </div>` : `
      <div class="box"><h3>RSVP als Eingeladene:r</h3><p>Du bist zu diesem einen Termin eingeladen, aber kein Mitglied des Kalenders — deine Rückmeldung wird unter deiner eigenen Identität gespeichert.</p></div>`}
    `;

    el('back-btn').addEventListener('click', () => history.back());
    viewRoot.querySelectorAll('[data-rsvp]').forEach((btn) => btn.addEventListener('click', async () => {
      if (iAmWriter) await setRSVP(qu, eventId, btn.dataset.rsvp);
      else await setOutsiderRSVP(qu, eventId, btn.dataset.rsvp);
      await renderEvent(eventId);
    }));
    if (iAmWriter) {
      el('edit-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await updateEvent(qu, eventId, { title: el('edit-title').value.trim(), description: el('edit-desc').value.trim() || null, location: el('edit-loc').value.trim() || null });
        await renderEvent(eventId);
      });
      el('delete-btn').addEventListener('click', async () => {
        if (!confirm('Diesen Termin wirklich löschen?')) return;
        await deleteEvent(qu, eventId);
        navTo('day', ymd(startOfDayUTC(v.start)));
      });
      el('invite-event-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fp = el('invite-event-fp').value.trim();
        if (!isValidFingerprint(fp)) { alert('Ungültiger Fingerprint.'); return; }
        await inviteToEvent(qu, eventId, fp);
        el('invite-event-fp').value = '';
        alert('Eingeladen — die Person wurde per Push benachrichtigt, falls registriert.');
      });
    }
  }
  function hmToMs(hhmm) { const [h, m] = hhmm.split(':').map(Number); return (h * 60 + m) * 60000; }

  // --- Kalender-Einstellungen: Mitgliederverwaltung, Teilen-Link ---
  async function renderSettings() {
    clearBucketSubs();
    const manifest = await qu.get(calendarId);
    const members = manifest?.value?.writers ?? [];
    const memberRows = await Promise.all(members.map(async (fp) => `<li>${esc(await alias(fp))} ${fp === qu.fingerprint ? '(du)' : `<button type="button" data-remove="${esc(fp)}">Entfernen</button>`}</li>`));
    const shareLink = `${location.origin}${location.pathname}${buildPath(calendarId, 'month', calendarBucketOf(Date.now()))}`;
    viewRoot.innerHTML = `
      <h2>Kalender-Einstellungen</h2>
      <div class="box"><h3>Kalender teilen</h3><p>Diesen Link weitergeben — nur Mitglieder unten dürfen Termine anlegen/bearbeiten.</p>
        <input type="text" readonly value="${esc(shareLink)}" onclick="this.select()" style="width:100%" /></div>
      <div class="box"><h3>Mitglieder</h3><ul id="member-list">${memberRows.join('')}</ul>
        <form id="add-member-form" class="row">
          <input type="text" id="add-member-fp" placeholder="Fingerprint" />
          <button type="submit">Zum Kalender einladen</button>
        </form>
      </div>`;
    el('add-member-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fp = el('add-member-fp').value.trim();
      if (!isValidFingerprint(fp)) { alert('Ungültiger Fingerprint.'); return; }
      await addCalendarMember(qu, calendarId, members, fp, {});
      await renderSettings();
    });
    viewRoot.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', async () => {
      await removeCalendarMember(qu, calendarId, members, btn.dataset.remove);
      await renderSettings();
    }));
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

  // --- Push-Benachrichtigungen (Anlegen/Ändern/Löschen/Einladen) — dieselbe Registrierung wie examples/chat/app.mjs, generischer Titel/Text (relay.mjs's calendar-Hooks) ---
  let swRegistration = null;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  let vapidPublicKey;
  function urlBase64ToUint8Array(base64url) {
    const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }
  async function refreshPushUI(overrideStatus) {
    if (!pushSupported) { pushToggleBtn.disabled = true; pushToggleBtn.textContent = 'Nicht unterstützt'; pushStatusEl.textContent = overrideStatus ?? 'Dieser Browser unterstützt keine Web-Push-Benachrichtigungen.'; return; }
    if (Notification.permission === 'denied') { pushToggleBtn.disabled = true; pushToggleBtn.textContent = 'Blockiert'; pushStatusEl.textContent = overrideStatus ?? 'Benachrichtigungen sind blockiert.'; return; }
    const sub = swRegistration ? await swRegistration.pushManager.getSubscription() : null;
    pushToggleBtn.disabled = false;
    pushToggleBtn.textContent = sub ? 'Deaktivieren' : 'Aktivieren';
    pushStatusEl.textContent = overrideStatus ?? (sub ? 'Aktiv.' : 'Aus.');
  }
  async function publishPushSubscription(subscription) {
    await qu.session.publish(`push-subscription/${qu.fingerprint}`, subscription);
    await repl.sync({ topic: `push-subscription/${qu.fingerprint}` }).catch(() => {});
  }
  if (pushSupported) {
    try { swRegistration = await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.error('[calendar] service worker registration failed:', e); }
    if (swRegistration && Notification.permission === 'granted') {
      const sub = await swRegistration.pushManager.getSubscription();
      if (sub) publishPushSubscription(sub.toJSON()).catch(() => {});
    }
  }
  await refreshPushUI();
  pushToggleBtn.addEventListener('click', async () => {
    pushToggleBtn.disabled = true;
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
      pushToggleBtn.disabled = false;
    }
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
