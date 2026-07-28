import fs from 'node:fs/promises';
import path from 'node:path';

// The Qu dev portal (dev/index.html) is a client-side hash router over
// three categories — Services (real, usable apps), Examples (developer-
// facing demo modules), Documentation (README, API, Whitepaper,
// interactive Lab, …) — see dev/portal.mjs. Its INITIAL category (before
// any `#/...` hash exists yet) is chosen from `location.pathname`
// (portal.mjs's categoryFromPathname()), so visiting /dev/services,
// /dev/examples, or /dev/documentation DIRECTLY — no hash, e.g. a bookmark
// or a link from elsewhere — must still actually serve dev/index.html's
// content. None of these three exist as a real file/directory on disk
// (`examples/` does, but has no `index.html` of its own — every real
// example lives one level deeper, e.g. `examples/chat/index.html`,
// entirely undisturbed by this), so without this they'd 404 — exactly the
// escape hatch static-server.mjs's `routes` option exists for (checked
// before static-file serving, see its own doc comment).
//
// This portal lives under `/dev/`, not `/` — root index.js's
// createRootContentRoutes() decides what "/" itself serves (the QUniverse
// shell by default, this same dev portal as a fallback when QUniverse
// serving is disabled).
const CATEGORIES = ['examples', 'services', 'documentation'];

/**
 * `registry` (server/service-registry.mjs) is the single source of truth
 * for which services exist and whether each is currently enabled — this
 * used to be a hardcoded `SERVICE_APPS` object here, duplicated a second
 * time (independently) in portal.mjs, both replaced by the registry so
 * there is exactly one place a service is declared.
 *
 * Two things this route module still owns, deliberately not delegated to
 * the registry: the category-shell routes below (serving index.html for
 * /services etc., unrelated to which services exist), and the
 * `/relay/services` JSON endpoint — the ONE place a client (portal.mjs, a
 * future admin UI) fetches the current catalog from instead of any HTML
 * being hardcoded per service.
 */
export function createPortalRoutes({ root, registry }) {
  const categoryRoutes = CATEGORIES.map((category) => ({
    match: (p) => p === `/dev/${category}` || p === `/dev/${category}/`,
    handle: async (_req, res) => {
      const data = await fs.readFile(path.join(root, 'dev', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    },
  }));

  // Stable, memorable entry points for a "service"-category entry that has
  // an `entry` target — `/services/chat`, `/services/people`, … — a plain
  // 302 straight to the actual page. Deliberately a server-side redirect,
  // not a client-side route that merges the app into the portal shell:
  // each app keeps its own PWA/service-worker scope untouched, and there
  // is zero added client JS overhead — the browser gets one extra round
  // trip, nothing else. See portal.mjs's renderRoute() for the matching
  // `#/services/chat` hash equivalent (same target, for when someone is
  // already on the portal page and navigates via hash instead of a fresh
  // path load).
  //
  // ONE route, matching `/services/<anything>` and looking the id up in
  // the registry PER REQUEST — not one route object built per known id at
  // startup — specifically so a service added later at runtime (see
  // service-registry.mjs's attachStore(), a plain signed QuStore write)
  // gets a working redirect immediately, without a restart. 404 both for
  // an unknown id and for one the registry currently has disabled —
  // `registry.isEnabled()`/`registry.get()` are re-read fresh every
  // request, same live-toggle mechanism registry.routes() itself relies on.
  const serviceRoute = {
    match: (p) => /^\/services\/[^/]+\/?$/.test(p),
    handle: (req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const id = pathname.replace(/^\/services\//, '').replace(/\/$/, '');
      const def = registry.get(id);
      if (!def || def.category !== 'service' || !def.entry || !registry.isEnabled(id)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Not found: /services/${id}`);
        return;
      }
      res.writeHead(302, { Location: def.entry });
      res.end();
    },
  };

  const catalogRoute = {
    match: (p) => p === '/relay/services',
    handle: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(registry.toJSON()));
    },
  };

  return [serviceRoute, ...categoryRoutes, catalogRoute];
}
