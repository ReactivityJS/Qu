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

export function createPortalRoutes({ root }) {
  return CATEGORIES.map((category) => ({
    match: (p) => p === `/${category}` || p === `/${category}/`,
    handle: async (_req, res) => {
      const data = await fs.readFile(path.join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    },
  }));
}
