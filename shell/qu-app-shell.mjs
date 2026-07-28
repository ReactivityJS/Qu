// `<qu-app-shell>` — the ecosystem's own entry point. Unlike every other
// Qu-Component this repo composes (`<qu-profile-card>`, `<qu-people-search>`,
// …), which all expect an ANCESTOR to already have set `.qu`, this element
// is the FIRST one in the whole tree to establish it: it bootstraps the
// shared identity (qu-core/src/ui/session-bootstrap.js), installs the
// plugins the rest of the shell needs, connects to this deployment's own
// relay, and only THEN sets `this.qu` — every `<qu-profile-card>`/
// `<qu-people-search>` rendered inside it resolves `.qu` via the normal
// findQu() parent-walk with zero extra wiring, same as any other Qu app.
//
// Light DOM only, no attachShadow() — `qu-profile-open`/
// `qu-people-search-results` (fired by <qu-profile-card>/<qu-people-search>)
// are `bubbles:true` but explicitly NOT `composed:true`, so a shadow
// boundary anywhere in this element's render tree would silently swallow
// them before they ever reach the listeners this element attaches to
// itself below. This is the first place in the ecosystem that nests these
// existing bubbling-event components inside a NEW wrapping element, so
// it's worth stating as a real constraint, not an assumed default.
//
// A matched service's `mount` (server/service-registry.mjs's App Manifest
// field, see src/ui/router.js's own doc) is preferred over `entry` whenever
// both/either is present: `_mountApp()` below dynamically imports the
// module and calls its `mount(container, ctx) -> stopFn` export directly
// into the shell's OWN screen area — no full-page navigation, no separate
// origin/tab, everything stays reactive on the SAME `this.qu` instance
// (listeners, notifications, routing) the shell itself already runs. Only
// a service with `entry` and no `mount` still falls back to
// `location.href = entry` (a fully standalone page, e.g. anything not yet
// migrated to the mount contract). See `_mountApp()`'s own doc for the
// exact contract a mount module must implement.

import {
  createNetworkPlugin, createSpacesPlugin, createProfilesPlugin, createContactsPlugin, createWebSocketChannel,
  createRouter, buildPath, inboxId,
} from '../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../src/ui/session-bootstrap.js';
import { createWindowHashSource } from '../src/ui/router-browser.js';
import { applyTheme } from '../src/ui/theme.js';
import { registerServiceWorker } from '../src/ui/push.mjs';
import { renderIdentityView } from './identity-screen.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export class QuAppShellElement extends HTMLElement {
  connectedCallback() {
    this.textContent = '';
    const loading = document.createElement('p');
    loading.className = 'qu-shell-loading';
    loading.textContent = 'Lädt …';
    this.appendChild(loading);

    this._init().catch((e) => {
      console.error('[qu-app-shell] startup failed:', e);
      this.textContent = '';
      const err = document.createElement('p');
      err.className = 'qu-shell-error';
      err.textContent = `Start fehlgeschlagen: ${e.message}`;
      this.appendChild(err);
    });
  }

  disconnectedCallback() {
    this._stopRouter?.();
    this._stopTheme?.();
    this._stopMountedApp?.();
  }

  async _init() {
    const qu = (await loadOrCreateIdentity())
      .use(createNetworkPlugin())
      .use(createSpacesPlugin())
      .use(createProfilesPlugin())
      .use(createContactsPlugin());
    this.qu = qu; // MUST be set before any descendant <qu-*> element renders — see file doc above
    this._stopTheme = applyTheme(qu); // this deployment's relay-config/theme (qu-core's admin/relay-admin panel), live — see that file's own doc for the null/never-set behavior

    this._services = undefined; // populated once /relay/services resolves — see _renderGenericSpaceDefault()'s own use below
    this._routeGen = 0; // bumped on every _renderRoute() call, so a stale async space-manifest read can tell it's no longer current, see _renderGenericSpaceDefault()

    this._buildLayout();

    this.addEventListener('qu-profile-open', (e) => {
      location.hash = buildPath(`~${e.detail.fingerprint}`);
    });
    this.addEventListener('qu-app-select', (e) => {
      // A mount-capable app navigates IN-PAGE (a hash change the router
      // itself resolves back into a mount decision) — never a full-page
      // `location.href`, which would tear down `this.qu`/the whole shell
      // for no reason. `entry`-only (no `mount`) still leaves the shell
      // entirely via a real navigation, same as before this feature.
      if (e.detail.mount) {
        location.hash = buildPath(e.detail.id);
      } else {
        location.href = e.detail.entry;
      }
    });

    const router = createRouter({ ...createWindowHashSource(), services: undefined });
    router.onRoute((decision) => this._renderRoute(decision));
    this._stopRouter = router.start();

    this._connectWithRetry(qu).catch((e) => console.error('[qu-app-shell] connect failed permanently:', e));

    fetch('/relay/services')
      .then((res) => res.json())
      .then((services) => { this._services = services; router.setServices(services); })
      .catch((e) => { console.error('[qu-app-shell] failed to load /relay/services:', e); this._services = []; router.setServices([]); });

    this._revealAdminLinkIfAdmin(qu);

    // Registered at `/sw.js` (default scope `/`, the directory of the
    // script itself — see that file's own doc comment) — a platform-level
    // registration covering the whole ecosystem shell. Qu's own
    // `/examples/<app>/` demos each keep their OWN, more specifically
    // scoped service worker (`/examples/chat/sw.js` etc, scope
    // `/examples/chat/`) — a more specific scope always wins over this
    // root one for a matching request, so the two coexist without
    // conflict. Independent of push support (run regardless, same
    // "installability doesn't need push" reasoning examples/chat/app.mjs's
    // own registerServiceWorker() call documents).
    this._swRegistration = await registerServiceWorker('/sw.js').catch((e) => { console.error('[qu-app-shell] service worker registration failed:', e); return null; });
    this._reRenderIdentityIfCurrent(); // see that method's own doc — a page loaded directly on #/~<fp> rendered the push toggle before `_swRegistration` existed
    this._vapidPublicKey = await fetch('/push/vapid-public-key')
      .then((res) => res.json())
      .then((info) => info.publicKey)
      .catch((e) => { console.error('[qu-app-shell] failed to load /push/vapid-public-key:', e); return null; });
    this._reRenderIdentityIfCurrent(); // see that method's own doc — a page loaded directly on #/~<fp> rendered the push toggle before `_vapidPublicKey` existed (the actual bug this fixes: "auf diesem Relay deaktiviert" shown even though push IS enabled server-side)
  }

  /** Persistent header (nav dropdown + notification badge + own profile card) + the screen area the router swaps content into — built once, right after `.qu` is set. */
  _buildLayout() {
    this.textContent = '';

    const header = document.createElement('header');
    header.className = 'qu-shell-header';
    const brand = document.createElement('span');
    brand.className = 'qu-shell-brand';
    brand.textContent = 'QUniverse';
    const nav = document.createElement('qu-nav-dropdown');
    const notifications = document.createElement('qu-notification-badge');
    // Hidden until _revealAdminLinkIfAdmin() below confirms this identity is
    // actually on the relay's QU_RELAY_ADMINS list — nav-catalog.mjs's
    // visibleCatalogEntries() deliberately excludes category:'admin' from
    // qu-nav-dropdown ("a product nav, not a dev/ops catalog"), so an admin
    // otherwise has no visible link to relay-admin anywhere in this shell.
    this._adminLinkEl = document.createElement('a');
    this._adminLinkEl.className = 'qu-shell-admin-link';
    this._adminLinkEl.href = '/examples/relay-admin/index.html';
    this._adminLinkEl.textContent = '🛠️ Admin-Portal';
    this._adminLinkEl.hidden = true;
    const ownCard = document.createElement('qu-profile-card');
    ownCard.setAttribute('href', buildPath(`~${this.qu.fingerprint}`));
    header.append(brand, nav, notifications, this._adminLinkEl, ownCard);

    this._screenEl = document.createElement('main');
    this._screenEl.className = 'qu-shell-screen';

    this.append(header, this._screenEl);
  }

  async _connectWithRetry(qu) {
    for (let attempt = 0; ; attempt++) {
      try {
        const channel = createWebSocketChannel(relayUrl());
        await Promise.race([
          channel.connect(),
          wait(10000).then(() => { throw new Error('Zeitüberschreitung beim Verbindungsaufbau'); }),
        ]);
        const repl = await qu.connect(channel, { pushTopics: [''] });
        this._repl = repl; // exposed for identity-screen.mjs's push-toggle (subscribeToPush()/unsubscribeFromPush() both need the replication instance's own sync(), see qu-core/src/ui/push.mjs)
        this._reRenderIdentityIfCurrent(); // see that method's own doc — a page loaded directly on #/~<fp> rendered the push toggle before `repl` existed
        // `pushTopics` only pushes FUTURE writes from here on (network/
        // replication/default.js's own doc) — it never catches this session
        // up on data that already existed on the relay before this exact
        // connection (e.g. relay-config/theme, an admin-set theme from
        // before this page load). `sync({topic})` queries `${topic}/**`
        // PLUS the topic's own document (network/replication/default.js's
        // `qu.sync.request` handler) — there is no "sync literally
        // everything" topic (an empty topic builds the pattern `/**`,
        // which no real id — none start with a leading `/` — ever
        // matches), so this syncs the one known prefix a fresh shell
        // session actually needs to catch up on today. The synced qubits
        // go through the same runtime.ingest() a live push does, so an
        // already-registered `.on()` listener (applyTheme() included)
        // still fires normally for them, just once, right here, instead
        // of never.
        await repl.sync({ topic: 'relay-config', since: 0 }).catch((e) => console.error('[qu-app-shell] initial relay-config sync failed:', e));
        // Own inbox (`inbox-<fp>/notifications/*` + `inbox-<fp>/requests/*` —
        // qu-notification-badge.mjs's two merged feeds): syncing the whole
        // `inbox-<fp>` prefix catches up on both subtrees in one call
        // (`sync({topic})` queries `${topic}/**`, matching any depth under
        // it). `subscribe()` on top registers this prefix for LIVE pushes
        // too — genuinely necessary, not redundant with the badge's own
        // `.on()`/`.map()` calls: those trigger `qu.setSubscribeHandler()`'s
        // `subscribeDispatch` (network/index.js), which only fans out to
        // CURRENTLY connected replication instances at the moment `.map()`
        // is called — and the badge subscribes during `_buildLayout()`,
        // BEFORE this connection exists at all, so that fan-out had nothing
        // to reach. This explicit call is what actually makes the inbox
        // live, independent of ordering between mounting the badge and
        // connecting.
        const inboxTopic = inboxId(qu.fingerprint);
        await repl.sync({ topic: inboxTopic, since: 0 }).catch((e) => console.error('[qu-app-shell] initial inbox sync failed:', e));
        await repl.subscribe(inboxTopic).catch((e) => console.error('[qu-app-shell] inbox subscribe failed:', e));
        return;
      } catch (e) {
        console.error('[qu-app-shell] connect failed, retrying:', e);
        await wait(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
  }

  _renderRoute(decision) {
    const screen = this._screenEl;
    if (!screen) return; // not laid out yet (still bootstrapping) — the router's own first emission can race _buildLayout(), a later route change will re-render correctly once it's up
    this._lastDecision = decision; // see _reRenderIdentityIfCurrent()'s own doc — router.start() dispatches SYNCHRONOUSLY (src/ui/router.js), well before _swRegistration/_vapidPublicKey/_repl below have resolved
    const gen = ++this._routeGen; // see _renderGenericSpaceDefault()'s own use of this
    this._stopMountedApp?.(); // ANY route change tears down a previously mounted app first — no partial in-place updates yet, see _mountApp()'s own doc
    this._stopMountedApp = null;
    screen.textContent = '';

    if (decision.kind === 'home') {
      const welcome = document.createElement('p');
      welcome.className = 'qu-shell-welcome';
      welcome.textContent = `Willkommen, ${this.qu.fingerprint}.`;
      const search = document.createElement('qu-people-search');
      search.setAttribute('mode', 'browse');
      // A literal `{fp}` TEMPLATE, not buildPath('u', '{fp}') — buildPath()
      // URL-encodes every segment, which would turn the placeholder into
      // `%7Bfp%7D` and break <qu-profile-card>'s own literal
      // href.replace('{fp}', ...) templating. Matches buildPath()'s own
      // `#/u/<fp>` output shape, just written by hand since one segment
      // here is a placeholder, not a real value.
      search.setAttribute('href', '#/u/{fp}');
      screen.append(welcome, search);
      return;
    }

    // `space-default`: a Space-id was given (either a `~fp` User-Space or a
    // generic Space-UUID) but no second (appId) segment — decideRoute()
    // itself never reaches into a Space's manifest (pure, no I/O), so THIS
    // is where that default gets decided. A `~fp` always defaults to the
    // built-in identity screen (no manifest read needed — the identity IS
    // the space); a generic Space-UUID needs an actual (async) manifest
    // read for its own optional `appId` field (see spaces.js's buildManifest(),
    // which now preserves such caller-supplied extra fields verbatim).
    if (decision.kind === 'space-default') {
      if (decision.spaceId.startsWith('~')) {
        renderIdentityView(screen, {
          qu: this.qu, fingerprint: decision.spaceId.slice(1),
          repl: this._repl, swRegistration: this._swRegistration, vapidPublicKey: this._vapidPublicKey,
        });
      } else {
        this._renderGenericSpaceDefault(screen, decision.spaceId, gen);
      }
      return;
    }

    // `app` (legacy bare fixed-app bookmark, e.g. `#/chat`) and `space`
    // (space-first with a resolved appId, e.g. `#/~fp/cms/home` or
    // `#/board-42/forum`) both resolve to the same action: mount the app
    // IN-PLACE if it declared `mount` (see `_mountApp()`), else fall back
    // to redirecting to its standalone `entry` page (a service not yet
    // migrated to the mount contract).
    if (decision.kind === 'app' || decision.kind === 'space') {
      if (decision.mount) {
        this._mountApp(screen, decision, gen);
        return;
      }
      const redirecting = document.createElement('p');
      redirecting.textContent = `Weiterleitung zu ${decision.appId} …`;
      screen.appendChild(redirecting);
      location.href = decision.entry;
      return;
    }

    if (decision.kind === 'unknown') {
      const unknown = document.createElement('p');
      unknown.className = 'qu-shell-unknown';
      unknown.textContent = decision.spaceId
        ? `Unbekannte App "${decision.appId}" für Space "${decision.spaceId}"`
        : `Unbekannte App: "${decision.appId}"`;
      const home = document.createElement('a');
      home.href = buildPath();
      home.textContent = 'Zur Startseite';
      screen.append(unknown, home);
      return;
    }

    // 'pending' — catalog not loaded yet, nothing to decide conclusively
    const loading = document.createElement('p');
    loading.textContent = 'Lädt …';
    screen.appendChild(loading);
  }

  /**
   * The identity view (`renderIdentityView()` in `_renderRoute()` above) is
   * the ONE screen that reads `_swRegistration`/`_vapidPublicKey`/`_repl` —
   * all three are still `undefined` at `router.start()`'s own synchronous
   * first dispatch (see `_renderRoute()`'s own comment), so a page LOADED
   * directly on a `#/~<fp>` URL (a bookmark, a shared link, a reload) would
   * otherwise render the push toggle permanently stuck on "auf diesem
   * Relay deaktiviert" — the one-shot render never happens again on its
   * own once the real values arrive. Called after each of those three
   * settles; a no-op unless the CURRENTLY shown route is still the same
   * identity view (never re-renders out from under a since-navigated-away
   * screen or a since-mounted app).
   */
  _reRenderIdentityIfCurrent() {
    const d = this._lastDecision;
    if (d?.kind === 'space-default' && d.spaceId?.startsWith('~')) this._renderRoute(d);
  }

  /**
   * Purely a UI convenience, NOT a security check (same stance as dev/
   * portal.mjs's own revealAdminTabIfLocalIdentityIsAdmin(), which this
   * mirrors) — reveals `_adminLinkEl` only if THIS shell's already-loaded
   * identity happens to be on the relay's QU_RELAY_ADMINS list
   * (GET /relay/info). A real unauthorized write attempt still fails at
   * the relay's own ACL either way; this only saves an actual admin the
   * trouble of remembering/bookmarking `/examples/relay-admin/index.html`
   * — see qu-nav-dropdown.mjs's nav-catalog.mjs for why it isn't already
   * in the regular app menu.
   */
  async _revealAdminLinkIfAdmin(qu) {
    let admins;
    try {
      admins = (await (await fetch('/relay/info')).json()).admins ?? [];
    } catch (e) {
      console.error('[qu-app-shell] failed to load /relay/info — admin link stays hidden:', e);
      return;
    }
    if (this._adminLinkEl && admins.includes(qu.fingerprint)) this._adminLinkEl.hidden = false;
  }

  /**
   * A generic (non-`~fp`) Space-UUID with no appId segment given
   * (`space-default`) — reads that Space's own manifest for an optional
   * `appId` field (a caller-set convention: `qu.createSpace({..., appId})`,
   * see spaces.js's buildManifest()) to decide what renders it by default.
   * No such field, or the field doesn't resolve against the current
   * catalog -> a plain "no default app" message, never a crash or an
   * infinite loading spinner.
   *
   * `gen` guards against a race: if the hash changes again while this
   * manifest read is in flight, a NEWER `_renderRoute()` call already
   * bumped `this._routeGen` and owns `screen` — this stale continuation
   * must not clobber it.
   */
  async _renderGenericSpaceDefault(screen, spaceId, gen) {
    const loading = document.createElement('p');
    loading.textContent = 'Lädt …';
    screen.appendChild(loading);

    let manifest = null;
    try {
      const q = await this.qu.get(spaceId);
      manifest = q?.value ?? null;
    } catch (e) {
      console.error('[qu-app-shell] space manifest read failed:', e);
    }
    if (gen !== this._routeGen) return; // route moved on while this was in flight

    screen.textContent = '';
    const appId = manifest?.appId;
    const match = appId && this._services?.find((s) => s.id === appId && s.enabled !== false && (s.entry || s.mount));
    if (match?.mount) {
      this._mountApp(screen, { spaceId, appId, segments: [spaceId, appId], mount: match.mount }, gen);
      return;
    }
    if (match) {
      const redirecting = document.createElement('p');
      redirecting.textContent = `Weiterleitung zu ${appId} …`;
      screen.appendChild(redirecting);
      location.href = match.entry;
      return;
    }

    const msg = document.createElement('p');
    msg.className = 'qu-shell-unknown';
    msg.textContent = manifest
      ? `Dieser Space hat keine Standard-App konfiguriert (Space: "${spaceId}").`
      : `Unbekannter Space: "${spaceId}"`;
    const home = document.createElement('a');
    home.href = buildPath();
    home.textContent = 'Zur Startseite';
    screen.append(msg, home);
  }

  /**
   * Dynamically imports `decision.mount` (a module specifier — an absolute
   * or root-relative path, e.g. `/services/forum/mount.mjs`) and calls its
   * `mount(container, ctx)` export, keeping whatever it returns as the
   * "stop" callback for the NEXT route change (`_renderRoute()`'s own
   * `_stopMountedApp?.()` call, always run before anything else) to invoke.
   *
   * The mount CONTRACT (deliberately minimal — no real service uses this
   * yet, so anything beyond what's needed to prove the mechanism itself
   * would be speculative):
   *   `export function mount(container, { qu, spaceId, appId, segments }) -> stopFn?`
   *   - `container`: an emptied HTMLElement owned by the shell — the
   *     module renders its own UI into it however it likes (its own Custom
   *     Elements, manual DOM, `<qu-view>`/`<qu-list>`, anything).
   *   - `qu`: THIS shell's own, already-connected Qu instance — the whole
   *     point of mounting instead of redirecting: one identity, one
   *     connection, one reactive Runtime for the entire ecosystem, not a
   *     fresh bootstrap per app.
   *   - `spaceId`/`appId`/`segments`: exactly `decideRoute()`'s own fields
   *     (`segments` is the FULL hash path — a mount module wanting its own
   *     internal sub-routing slices off `segments.slice(2)` itself; this
   *     shell has no opinion on what a mounted app does with the rest of
   *     the path).
   *   - Return value: an optional cleanup function, called right before
   *     the NEXT route change (of ANY kind, mounted or not) tears this
   *     screen down — same "returns an unsubscribe" convention every other
   *     live subscription in this codebase already uses. A module that
   *     returns nothing simply has nothing to clean up.
   *
   * No partial/in-place updates: navigating from one mount decision to
   * ANOTHER (even the same appId with a different sub-path) always fully
   * stops and re-mounts — the simplest correct behavior, and the only one
   * with a real consumer to verify it against so far (see this feature's
   * own test coverage). A module wanting cheaper sub-path transitions can
   * always do its OWN internal routing inside a single mount() call by
   * reading `segments` reactively itself; nothing here prevents that.
   */
  async _mountApp(screen, decision, gen) {
    const loading = document.createElement('p');
    loading.textContent = `Lädt ${decision.appId} …`;
    screen.appendChild(loading);

    let mod;
    try {
      mod = await import(/* webpackIgnore: true */ decision.mount);
    } catch (e) {
      console.error(`[qu-app-shell] failed to load mount module for "${decision.appId}" (${decision.mount}):`, e);
      if (gen !== this._routeGen) return; // route moved on while importing
      screen.textContent = '';
      const err = document.createElement('p');
      err.className = 'qu-shell-error';
      err.textContent = `App "${decision.appId}" konnte nicht geladen werden.`;
      screen.append(err);
      return;
    }
    if (gen !== this._routeGen) return; // route moved on while importing — a later _renderRoute() already owns `screen`

    if (typeof mod.mount !== 'function') {
      console.error(`[qu-app-shell] mount module for "${decision.appId}" (${decision.mount}) has no mount() export`);
      screen.textContent = '';
      const err = document.createElement('p');
      err.className = 'qu-shell-error';
      err.textContent = `App "${decision.appId}" ist fehlerhaft konfiguriert (kein mount()-Export).`;
      screen.append(err);
      return;
    }

    screen.textContent = '';
    const stop = mod.mount(screen, { qu: this.qu, spaceId: decision.spaceId, appId: decision.appId, segments: decision.segments });
    this._stopMountedApp = typeof stop === 'function' ? stop : null;
  }
}

if (!customElements.get('qu-app-shell')) customElements.define('qu-app-shell', QuAppShellElement);
