import fs from 'node:fs/promises';
import path from 'node:path';

// The landing page (index.html) is a client-side hash router over three
// categories — Services (real, usable apps: examples/chat, examples/people),
// Examples (developer-facing demo modules), Documentation (README, API,
// Whitepaper, interactive Lab, …) — see portal.mjs. Its INITIAL category
// (before any `#/...` hash exists yet) is chosen from `location.pathname`
// (portal.mjs's categoryFromPathname()), so visiting /services, /examples,
// or /documentation DIRECTLY — no hash, e.g. a bookmark or a link from
// elsewhere — must still actually serve index.html's content. None of
// these three exist as a real file/directory on disk (`examples/` does,
// but has no `index.html` of its own — every real example lives one level
// deeper, e.g. `examples/chat/index.html`, entirely undisturbed by this),
// so without this they'd 404 — exactly the escape hatch static-server.mjs's
// `routes` option exists for (checked before static-file serving, see its
// own doc comment).
const CATEGORIES = ['examples', 'services', 'documentation'];

// Stable, memorable entry points for the two real apps under Services —
// `/services/chat`, `/services/people` — a plain 302 straight to the
// actual page (`examples/chat/index.html`, `examples/people/index.html`).
// Deliberately a server-side redirect, not a client-side route that
// merges the app into the portal shell: each app keeps its own PWA/
// service-worker scope untouched, and there is zero added client JS
// overhead — the browser gets one extra round trip, nothing else. See
// portal.mjs's renderRoute() for the matching `#/services/chat` hash
// equivalent (same target, for when someone is already on the portal
// page and navigates via hash instead of a fresh path load).
const SERVICE_APPS = { chat: '/examples/chat/index.html', people: '/examples/people/index.html' };

export function createPortalRoutes({ root }) {
  const categoryRoutes = CATEGORIES.map((category) => ({
    match: (p) => p === `/${category}` || p === `/${category}/`,
    handle: async (_req, res) => {
      const data = await fs.readFile(path.join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    },
  }));
  const serviceRoutes = Object.entries(SERVICE_APPS).map(([name, target]) => ({
    match: (p) => p === `/services/${name}` || p === `/services/${name}/`,
    handle: (_req, res) => {
      res.writeHead(302, { Location: target });
      res.end();
    },
  }));
  return [...serviceRoutes, ...categoryRoutes];
}
