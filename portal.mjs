// The landing page's own tiny router — three categories (Services,
// Examples, Documentation), switched via `#/<category>` using the exact
// same generic hash-path scheme every app in this repo already uses
// (src/ui/hash-router.js), not a bespoke one-off. Reuses `location.hash`
// as the single source of truth for "which category is shown", same
// reactive principle as examples/chat's/examples/people's own routers —
// just with one segment and no history-normalization complexity, since
// there's nothing here to navigate INTO (every card is a real link to
// its own page, not a nested screen of this one).
//
// Reachable two ways, deliberately both real:
//   #/services | #/examples | #/documentation   (a click on a tab, or a
//     shared/bookmarked link with the hash already set)
//   /services  | /examples  | /documentation     (typed/linked directly,
//     no hash at all — server/portal-routes.mjs serves this same page for
//     each; categoryFromPathname() below picks the matching category as
//     the initial view before any hash exists)
//
// The card CONTENT per category (which services/examples/docs exist, and
// whether each is currently enabled) comes from GET /relay/services
// (server/portal-routes.mjs, backed by server/service-registry.mjs) — a
// single fetch at load, not hardcoded HTML. This replaces what used to be
// two independently hand-maintained `SERVICE_APPS` objects (one here, one
// in server/portal-routes.mjs, the latter's own comment literally saying
// "kept in sync manually") with one server-side source of truth every
// client reads.

import { buildPath, parsePathSegments } from './src/ui/hash-router.js';
import { QuIdentity } from './src/index.js';

// 'admin' is a real, navigable category (renderRoute()/showCategory()
// both need to know about it) even though its TAB starts `hidden` in the
// markup — see revealAdminTabIfLocalIdentityIsAdmin() below for when it
// gets shown. Someone who already knows `#/admin` (or `/examples/
// relay-admin/index.html` directly) can always reach it regardless — the
// hidden tab is a discoverability nicety, never the actual boundary (see
// index.html's own comment on this same point).
const CATEGORIES = ['services', 'examples', 'documentation', 'admin'];
const DEFAULT_CATEGORY = 'services';

// Every localStorage key an identity might be persisted under in this
// repo's example apps — checked read-only (never created here) so a
// casual portal visitor who has never opened any Qu app gets no
// side effect and no admin tab; someone who already visited
// examples/chat, examples/people, or examples/relay-admin at least once
// gets checked against the relay's admin list without having to visit
// relay-admin FIRST just to find out whether they qualify.
const IDENTITY_STORAGE_KEYS = ['qu-identity', 'qu-relay-admin-identity'];

/** Reads (never creates) a locally persisted identity's fingerprint — `null` if the key is absent or its value isn't a valid exported keypair (space-app-browser.js's loadOrCreateIdentity() is the writer; this only ever reads). */
async function fingerprintFromStorageKey(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const keys = JSON.parse(raw);
    const identity = await QuIdentity.importKeys(keys.signPriv, keys.signPub, keys.encPriv, keys.encPub);
    return identity.fingerprint;
  } catch (e) {
    console.warn(`[Portal] localStorage["${key}"] isn't a valid exported identity, ignoring for the admin-tab check:`, e.message);
    return null;
  }
}

/**
 * Purely a UI convenience, NOT a security check (see index.html's/
 * server/relay-info-routes.mjs's doc comments on this same point,
 * repeated intentionally since it matters): reveals the Admin tab only if
 * one of this browser's already-persisted local identities happens to be
 * on the relay's QU_RELAY_ADMINS list (GET /relay/info). A real
 * unauthorized write attempt still fails at the relay's ACL either way —
 * this only saves an actual admin the trouble of remembering/bookmarking
 * `/examples/relay-admin/index.html`.
 */
async function revealAdminTabIfLocalIdentityIsAdmin() {
  let admins;
  try {
    admins = (await (await fetch('/relay/info')).json()).admins ?? [];
  } catch (e) {
    console.error('[Portal] failed to load /relay/info — admin tab stays hidden:', e);
    return;
  }
  if (!admins.length) return;
  const fingerprints = (await Promise.all(IDENTITY_STORAGE_KEYS.map(fingerprintFromStorageKey))).filter(Boolean);
  if (!fingerprints.some((fp) => admins.includes(fp))) return;
  const adminTab = document.querySelector('.category-tab[data-category="admin"]');
  if (adminTab) adminTab.hidden = false;
}

const tabs = document.querySelectorAll('.category-tab');
const sections = document.querySelectorAll('.cards-section');

// Populated from the fetched catalog below — `serviceEntries[id]` is the
// `entry` target for a 'service'-category item with one, used by
// renderRoute()'s `#/services/<id>` hash shortcut (the client-side
// equivalent of server/portal-routes.mjs's server-side 302, for when
// someone is already on the portal page rather than loading it fresh).
let serviceEntries = {};

function categoryFromPathname() {
  const segment = location.pathname.replace(/^\/|\/$/g, '');
  return CATEGORIES.includes(segment) ? segment : null;
}

function showCategory(category) {
  const active = CATEGORIES.includes(category) ? category : DEFAULT_CATEGORY;
  for (const tab of tabs) tab.classList.toggle('active', tab.dataset.category === active);
  for (const section of sections) section.hidden = section.dataset.category !== active;
}

function renderRoute() {
  const [first, second] = parsePathSegments(location.hash);
  if (first === 'services' && second && serviceEntries[second]) {
    location.href = serviceEntries[second];
    return;
  }
  showCategory(first ?? categoryFromPathname() ?? DEFAULT_CATEGORY);
}

function cardHref(item) {
  if (item.entry) return item.entry;
  if (item.category === 'service') return `/services/${item.id}`;
  return '#';
}

/** Renders one category's card list from the fetched catalog — a disabled entry is left out entirely, not shown greyed-out (matching the server route's own 404-for-disabled behaviour: nothing here promises a link that wouldn't actually work). */
function renderCategory(category, items) {
  const section = document.querySelector(`.cards-section[data-category="${category}"] .cards`);
  if (!section) return;
  section.textContent = '';
  for (const item of items) {
    if (!item.enabled) continue;
    const a = document.createElement('a');
    a.className = 'card';
    a.href = cardHref(item);
    const h2 = document.createElement('h2');
    h2.textContent = item.label;
    a.appendChild(h2);
    if (item.description) {
      const p = document.createElement('p');
      p.textContent = item.description;
      a.appendChild(p);
    }
    section.appendChild(a);
  }
}

async function loadCatalog() {
  let items = [];
  try {
    items = await (await fetch('/relay/services')).json();
  } catch (e) {
    console.error('[Portal] failed to load /relay/services — category cards stay empty:', e);
  }
  serviceEntries = Object.fromEntries(
    items.filter((i) => i.category === 'service' && i.entry).map((i) => [i.id, i.entry]),
  );
  // Registry category ('service'/'example'/'documentation'/'admin'/'custom',
  // server/service-registry.mjs) vs. this page's `data-category` sections
  // ('services'/'examples'/'documentation') don't all follow the same
  // pluralization rule — 'documentation' stays singular, unlike
  // 'service'/'example' — so an explicit map, not a naive `${category}s`
  // suffix (which silently produced "documentations", matching NO
  // section on the page and leaving the entire Documentation tab empty —
  // a real bug this exact map is here to prevent from recurring).
  const SECTION_FOR_CATEGORY = { service: 'services', example: 'examples', documentation: 'documentation', admin: 'admin' };
  for (const [category, section] of Object.entries(SECTION_FOR_CATEGORY)) {
    renderCategory(section, items.filter((i) => i.category === category));
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => { location.hash = buildPath(tab.dataset.category); });
}
window.addEventListener('hashchange', renderRoute);
loadCatalog().then(renderRoute); // not top-level await — no existing script in this repo relies on it, keep this one consistent
revealAdminTabIfLocalIdentityIsAdmin();
