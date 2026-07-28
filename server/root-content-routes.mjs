import fs from 'node:fs/promises';
import path from 'node:path';

// Decides what "/" itself serves — the one piece of routing logic the
// three QU_SERVE_* toggles (index.js) actually need beyond "which registry
// definitions get added" (see index.js's own doc comment on that). Checked
// before static-server.mjs's own `reqPath === '/' -> '/index.html'`
// default, same escape-hatch mechanism portal-routes.mjs's category shims
// already use.
//
// Deliberately NOT a blanket file-level firewall for the disabled area's
// OTHER paths (/examples/*, /docs/*, /shell/* etc. stay directly fetchable
// regardless of these flags) — same "the real boundary is identity/ACL,
// not a hidden URL" stance dev/portal.mjs's own admin-tab-hidden reasoning
// already takes for this exact repo. A disabled area simply stops being
// ADVERTISED (missing from the registry, and — for QUniverse specifically —
// no longer served at "/"); its static files staying reachable by direct
// URL is the same non-guarantee an `enabled: false` service-registry entry
// already has today.
export function createRootContentRoutes({ root, serveQuniverse, serveDocs, serveExamples }) {
  return [{
    match: (p) => p === '/',
    handle: async (_req, res) => {
      const file = serveQuniverse
        ? 'index.html'
        : (serveDocs || serveExamples) ? path.join('dev', 'index.html')
        : null;

      if (!file) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>QU</title><p>Kein Inhaltsbereich aktiviert (QU_SERVE_QUNIVERSE/QU_SERVE_DOCS/QU_SERVE_EXAMPLES sind alle deaktiviert).</p>');
        return;
      }

      const data = await fs.readFile(path.join(root, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    },
  }];
}
