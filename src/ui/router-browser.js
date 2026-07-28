// The real-window default for ui/router.js's `createRouter({getHash,
// onHashChange})` — kept in its own file (browser-only, like every other
// file in this directory) so router.js itself stays Node-safe/testable
// without ever touching `window`.

/** `{getHash, onHashChange}` wired to the real `window.location`/`hashchange` — the default a browser-side caller reaches for; router.js's own tests use a fake in-memory equivalent instead. */
export function createWindowHashSource() {
  return {
    getHash: () => window.location.hash,
    onHashChange(cb) {
      window.addEventListener('hashchange', cb);
      return () => window.removeEventListener('hashchange', cb);
    },
  };
}
