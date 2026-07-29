export default {
  id: 'hello-world',
  category: 'service',
  label: 'Hello World',
  description: 'Minimales, echtes Referenz-Beispiel für eine eigene App: Qu-Components (<qu-view>/<qu-bind>), eigene Einstellungen, ein globales Admin-Setting, In-App-Navigation. Zum Kopieren für eigene Apps — siehe services/README.md.',
  mount: '/services/hello-world/app.mjs',
  icon: '👋',
  navOrder: 100,
  spaceMode: 'fixed',
  // Both optional, additive conventions services/app-directory/app.mjs
  // reads to offer direct shortcuts into this app's own sub-routes (see
  // that file's own doc) — declare these ONLY if the app actually mounts
  // something at `#/<id>/settings` / `#/<id>/admin` (this one does, see
  // app.mjs's renderNav()); `hasAdmin` shortcuts are shown only to an
  // actual QU_RELAY_ADMINS fingerprint regardless of this flag.
  hasSettings: true,
  hasAdmin: true,
};
