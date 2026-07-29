// Hello World — the App-Template's own minimal, REAL, running reference
// example (services/README.md points here for anyone building a new
// service). Shows, end to end:
//   - How an app is built HTML-side out of Qu-Components
//     (src/ui/components.js's <qu-view>/<qu-bind>) instead of manual
//     imperative get()/on()/put() plumbing wherever a component already
//     fits — see hello-world-lib.mjs's own doc for the THREE data shapes
//     demonstrated (a per-user setting, a per-user counter, a global
//     admin-only setting) and why `<qu-bind>` alone is enough to edit
//     BOTH the per-user AND the admin-only setting (the write ACL is the
//     RELAY's concern, never the UI's — the same "not a security
//     boundary" stance this whole codebase already takes elsewhere).
//   - A per-user settings area (Einstellungen) and a global admin-only
//     settings area (Admin) — both reachable from INSIDE the app's own
//     nav below, and both also reachable directly from
//     services/app-directory via this app's own "⚙️"/"🛠️" shortcuts.
//   - In-app sub-navigation via the mount contract's own documented
//     `segments` field (see qu-app-shell.mjs's `_mountApp()` doc) — a
//     bare `#/hello-world` and `#/hello-world/home` both resolve to the
//     Home screen; `#/hello-world/settings` and `#/hello-world/admin`
//     are the other two. Every mount call fully re-mounts (no partial
//     update — same shell-wide contract every other service already
//     follows), so switching screens is just a normal hash navigation.
//
// Deliberately no `<name>-lib.test.mjs`-adjacent app-level tests here —
// this file is DOM-only UI wiring (see identity-screen.mjs's own doc for
// why that class of file has no `node --test` coverage of its own); the
// logic worth testing already lives in, and is tested by,
// hello-world-lib.mjs/hello-world-lib.test.mjs.

import '../../src/ui/components.js'; // Seiteneffekt: registriert <qu-view>/<qu-bind>
import { recordVisit, onOwnVisitCountChange } from './hello-world-lib.mjs';

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function renderNav(container, active, isAdmin) {
  const nav = document.createElement('nav');
  nav.className = 'qu-hello-world-nav';
  const tabs = [['home', 'Home'], ['settings', 'Einstellungen'], ...(isAdmin ? [['admin', 'Admin']] : [])];
  for (const [id, label] of tabs) {
    const a = document.createElement('a');
    a.href = `#/hello-world/${id}`;
    a.textContent = label;
    a.className = id === active ? 'active' : '';
    nav.appendChild(a);
  }
  container.appendChild(nav);
}

function renderHome(screen, qu) {
  const heading = document.createElement('h2');
  heading.textContent = '👋 Hello World';
  screen.appendChild(heading);

  // Read-only, live-bound displays — <qu-view> alone does everything: no
  // manual .on()/.put() plumbing, no imperative re-render function.
  const greetingP = document.createElement('p');
  greetingP.textContent = 'Ansage des Betreibers: ';
  const greetingView = document.createElement('qu-view');
  greetingView.setAttribute('path', 'relay-config/hello-world-greeting');
  greetingView.className = 'qu-hello-world-global-greeting';
  greetingP.appendChild(greetingView);
  screen.appendChild(greetingP);

  const nameP = document.createElement('p');
  nameP.textContent = 'Dein Name: ';
  const nameView = document.createElement('qu-view');
  nameView.setAttribute('path', `~${qu.fingerprint}/apps/hello-world/greeting-name`);
  nameP.appendChild(nameView);
  screen.appendChild(nameP);

  const visitsP = document.createElement('p');
  visitsP.className = 'qu-hello-world-visits';
  visitsP.textContent = 'Besuche wird gezählt …';
  screen.appendChild(visitsP);
  recordVisit(qu).catch((e) => console.error('[hello-world] recordVisit failed:', e));
  // Live count, not a one-shot read — see onOwnVisitCountChange()'s own doc
  // for why this may render `Besuche: 0` for an instant right after a
  // reload before correcting itself upwards once the still-in-flight sync
  // catches up, rather than trusting a possibly-empty local snapshot.
  return onOwnVisitCountChange(qu, (count) => { visitsP.textContent = `Besuche: ${count}`; });
}

function renderSettings(screen, qu) {
  const heading = document.createElement('h2');
  heading.textContent = 'Einstellungen';
  screen.appendChild(heading);
  const hint = document.createElement('p');
  hint.className = 'qu-hello-world-hint';
  hint.textContent = 'Nur für dich — dein eigener Name, gespeichert in deinem eigenen Space.';
  screen.appendChild(hint);

  const label = document.createElement('label');
  label.textContent = 'Dein Name ';
  const bind = document.createElement('qu-bind');
  bind.setAttribute('path', `~${qu.fingerprint}/apps/hello-world/greeting-name`);
  bind.setAttribute('attr', 'value');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'z. B. Ada';
  bind.appendChild(input);
  label.appendChild(bind);
  screen.appendChild(label);
}

function renderAdmin(screen, qu, isAdmin) {
  const heading = document.createElement('h2');
  heading.textContent = 'Admin';
  screen.appendChild(heading);

  if (!isAdmin) {
    const denied = document.createElement('p');
    denied.className = 'qu-hello-world-hint';
    denied.textContent = 'Nur für QU_RELAY_ADMINS-Fingerprints. Deine Identität ist keine davon.';
    screen.appendChild(denied);
    return;
  }

  const hint = document.createElement('p');
  hint.className = 'qu-hello-world-hint';
  hint.textContent = 'Diese Ansage sehen ALLE Nutzer:innen auf der Home-Seite. Ein plain signierter Write auf relay-config/* — die eigentliche Berechtigungsprüfung übernimmt das Relay, nicht diese Oberfläche (siehe qu-bind selbst kennt keine Admin-Logik).';
  screen.appendChild(hint);

  const label = document.createElement('label');
  label.textContent = 'Globale Ansage ';
  const bind = document.createElement('qu-bind');
  bind.setAttribute('path', 'relay-config/hello-world-greeting');
  bind.setAttribute('attr', 'value');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'z. B. Willkommen!';
  bind.appendChild(input);
  label.appendChild(bind);
  screen.appendChild(label);

  const status = document.createElement('p');
  status.className = 'qu-hello-world-hint';
  status.textContent = 'Änderungen speichern automatisch beim Verlassen des Felds.';
  screen.appendChild(status);
}

export async function mount(container, { qu, segments }) {
  const sub = segments[1] ?? 'home'; // segments[0] is this app's OWN id ('hello-world') for a fixed (non-Space) app — see this file's own top doc

  let isAdmin = false;
  try {
    const info = await fetchJSON('/relay/info');
    isAdmin = info.fingerprint && (info.admins ?? []).includes(qu.fingerprint);
  } catch (e) {
    console.error('[hello-world] failed to load /relay/info:', e);
  }

  container.className = 'qu-hello-world';
  renderNav(container, sub, isAdmin);
  const screen = document.createElement('div');
  screen.className = 'qu-hello-world-screen';
  container.appendChild(screen);

  if (sub === 'settings') { renderSettings(screen, qu); return undefined; }
  if (sub === 'admin') { renderAdmin(screen, qu, isAdmin); return undefined; }
  // Every <qu-view>/<qu-bind> above unsubscribes itself in its own
  // disconnectedCallback() once the shell's next route change removes this
  // subtree from the DOM (see src/ui/components.js's QuViewElement._unmount()),
  // same "self-cleaning Custom Elements, no manual teardown needed" case
  // services/directory/app.mjs's own doc already documents for
  // <qu-people-search> — but renderHome()'s own visit-count subscription is
  // a plain `.map()` callback (not a Custom Element), so ITS unsubscribe
  // function is what this mount() must actually return as its `stopFn`.
  return renderHome(screen, qu);
}
