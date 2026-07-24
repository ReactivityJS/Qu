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

import { buildPath, parsePathSegments } from './src/ui/hash-router.js';

const CATEGORIES = ['services', 'examples', 'documentation'];
const DEFAULT_CATEGORY = 'services';
// Same targets as server/portal-routes.mjs's SERVICE_APPS — kept in sync
// manually (two tiny static maps, one server-side one client-side; not
// worth a shared module for two entries). Covers the case where someone
// is ALREADY on the portal page and follows a `#/services/chat` link
// (e.g. pasted, or set programmatically) rather than a fresh page load —
// the server-side redirect alone only fires on the initial HTTP request.
const SERVICE_APPS = { chat: '/examples/chat/index.html', people: '/examples/people/index.html' };

const tabs = document.querySelectorAll('.category-tab');
const sections = document.querySelectorAll('.cards-section');

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
  if (first === 'services' && second && SERVICE_APPS[second]) {
    location.href = SERVICE_APPS[second];
    return;
  }
  showCategory(first ?? categoryFromPathname() ?? DEFAULT_CATEGORY);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => { location.hash = buildPath(tab.dataset.category); });
}
window.addEventListener('hashchange', renderRoute);
renderRoute();
