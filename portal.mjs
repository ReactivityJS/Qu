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

const CATEGORIES = ['services', 'examples', 'documentation'];
const DEFAULT_CATEGORY = 'services';

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
  for (const category of ['service', 'example', 'documentation']) {
    // Registry category is singular ('service'), portal section is plural ('services') — see service-registry.mjs's `category` field.
    renderCategory(category === 'service' ? 'services' : `${category}s`, items.filter((i) => i.category === category));
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => { location.hash = buildPath(tab.dataset.category); });
}
window.addEventListener('hashchange', renderRoute);
loadCatalog().then(renderRoute); // not top-level await — no existing script in this repo relies on it, keep this one consistent
