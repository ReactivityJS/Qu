// The CMS content module — content, templates, AND a site's own config all
// live in the same kind of Space as anything else (Whitepaper §8). A "site"
// is no new core concept, just a named convention over the usual five verbs
// (get/put/set/on/map), exactly like modules/chat.js (messages) or a ToDo
// list — only with more than one kind of content under a single Space:
//
//   <siteId>/cms/config           put() — { title, theme, language, navigationMode }
//   <siteId>/cms/templates/<name> put() — an HTML string, an interchangeable page layout
//   <siteId>/cms/pages/<slug>     put() — { title, template, blocks }, one page
//   <siteId>/cms/nav              set() — { label, slug, order }, menu entries (tombstone-delete, see removeNavItem())
//   <siteId>/cms/state/route      put() — the currently presented slug (only relevant in presentation mode)
//
// `navigationMode` decides HOW visitors move between pages — deliberately
// part of the SITE'S OWN CONFIG (written into the Space, read reactively by
// every client), not a URL flag: the owner decides how their site behaves,
// and every client visiting it picks that up automatically (a browser-side
// router built on this module reads this value reactively, not just once
// at load time):
//
//   "local"        — every client navigates on its own, via its own hash
//                    route (or however the embedding app addresses a path).
//   "presentation" — every client follows whatever route the Space owner
//                    (or another writer) puts under `cms/state/route`, e.g.
//                    for a talk/kiosk mode — a visitor's own navigation
//                    clicks don't change what's actually displayed.
//
// Templates are deliberately plain HTML strings, no format of their own — a
// page references one by name (`page.template`). Actually RENDERING a page
// (resolving placeholders/bindings) is deliberately NOT part of this file —
// pure store logic, fully testable without a browser — that's an embedding
// app's job, same cut as ui/bindings.js (logic) vs. ui/components.js (DOM)
// everywhere else in this repo.
//
// User management (adding/removing writers) is NOT reimplemented here —
// `qu.addToRole()`/`qu.removeFromRole()` (modules/spaces.js, already
// installed by createSpacesPlugin()) already do this for any kind of
// Space, CMS site or not; this module has no opinion on it, same stance
// modules/chat.js takes.
//
// WYSIWYG/rich-text editing is deliberately NOT part of this module (or of
// Qu-Core at all — zero-runtime-dependency is a core principle): `blocks`
// stays an opaque object a caller fills in however it likes, so the storage
// layer never needs to know or care which editor produced it.

import { setProfileAttr, getProfileAttr, onProfileAttrsChange } from './profiles.js';

/**
 * Creates a new site — Space + initial config in one call. Returns the site
 * id (for the link, same convention as every other `create*()` in
 * `src/modules/`).
 *
 * `cms/state/route` is already set to `defaultRoute` here, not only on the
 * first `presentRoute()` call: `.on()` never delivers an initial value for
 * a path that doesn't exist yet (core/runtime.js — `initial: true` only
 * ever catches up on what already matches), so a client joining BEFORE the
 * owner ever switches to "presentation" would otherwise wait on nothing at
 * all. With a defined starting value from site creation on, presentation
 * mode is usable immediately.
 */
export async function createSite(qu, { title = 'Neue Site', theme = 'light', language = 'de', navigationMode = 'local', defaultRoute = 'home', writers, readers = ['*'] } = {}) {
  const site = qu.createSpace({ writers: writers ?? [qu.fingerprint], readers }); // synchronous — see modules/spaces.js
  await site.ready; // actually wait for the manifest before handing out the id
  await site.get('cms/config').put({ title, theme, language, navigationMode });
  await site.get('cms/state/route').put(defaultRoute);
  return site.id;
}

/** Reads the current config — `null` if the site isn't (yet) visible to this client. */
export async function getConfig(qu, siteId) {
  const q = await qu.get(`${siteId}/cms/config`);
  return q?.value ?? null;
}

/** Live subscription to the config — delivers the current state first, then every change (e.g. a mode switch). */
export function onConfig(qu, siteId, callback, opts) {
  return qu.get(`${siteId}/cms/config`).on(callback, { initial: true, ...opts });
}

/** Patches individual config fields without losing the others — e.g. `updateConfig(qu, siteId, { theme: 'dark' })`. Any writer of the site may do this (no admin-only special case, same as everywhere else in Qu — see Whitepaper §8.3). */
export async function updateConfig(qu, siteId, patch) {
  const config = await getConfig(qu, siteId);
  if (!config) throw new Error('Site nicht gefunden — noch nicht gesynct?');
  return qu.get(`${siteId}/cms/config`).put({ ...config, ...patch });
}

/** Switches the navigation mode — a thin, self-explanatory wrapper around updateConfig(), validating the two allowed values. */
export async function setNavigationMode(qu, siteId, mode) {
  if (mode !== 'local' && mode !== 'presentation') {
    throw new Error(`Ungültiger navigationMode: "${mode}" (erwartet "local" oder "presentation")`);
  }
  return updateConfig(qu, siteId, { navigationMode: mode });
}

/** Creates/overwrites a template (an HTML string) — a named, mutable value, like any config (put(), not set()). */
export async function setTemplate(qu, siteId, name, html) {
  return qu.get(`${siteId}/cms/templates/${name}`).put(html);
}

/** Reads a template — `null` if it doesn't exist (yet). */
export async function getTemplate(qu, siteId, name) {
  const q = await qu.get(`${siteId}/cms/templates/${name}`);
  return q?.value ?? null;
}

/** Live subscription to one template — e.g. so a currently open page re-renders immediately if someone changes the layout it uses. */
export function onTemplate(qu, siteId, name, callback, opts) {
  return qu.get(`${siteId}/cms/templates/${name}`).on(callback, { initial: true, ...opts });
}

/**
 * Creates/overwrites a page. `blocks` stays ONE embedded object (not
 * leaf-per-field like `bindObject()`) — a page is typically saved as a
 * whole by one person in an editor, not a case of "several people
 * simultaneously editing different fields" (see ui/bindings.js's own doc on
 * exactly this trade-off).
 */
export async function setPage(qu, siteId, slug, { title = slug, template = 'default', blocks = {} } = {}) {
  return qu.get(`${siteId}/cms/pages/${slug}`).put({ title, template, blocks });
}

/** Reads a page — `null` if it doesn't exist (yet). */
export async function getPage(qu, siteId, slug) {
  const q = await qu.get(`${siteId}/cms/pages/${slug}`);
  return q?.value ?? null;
}

/** Live subscription to EXACTLY one page (what a router actually needs when displaying a route). */
export function onPage(qu, siteId, slug, callback, opts) {
  return qu.get(`${siteId}/cms/pages/${slug}`).on(callback, { initial: true, ...opts });
}

/** A new menu entry — set(), since several editors can independently add entries at the same time (collision-safe, same pattern as a ToDo list's addItem()). Returns the entry's QuBit id (for removeNavItem()). */
export async function addNavItem(qu, siteId, { label, slug, order = 0 }) {
  const { qubit } = await qu.get(`${siteId}/cms/nav`).set({ label, slug, order });
  return qubit.id;
}

/** No real deletion (QuBits are immutable) — a tombstone flag that listNav() filters out on read (same pattern as a ToDo list's deleteItem()). */
export async function removeNavItem(qu, navItemId) {
  const q = await qu.get(navItemId);
  if (!q) return;
  return qu.get(navItemId).put({ ...q.value, deleted: true });
}

/** All current (non-deleted) menu entries, sorted by `order` — a one-shot request. */
export async function listNav(qu, siteId) {
  const rows = await qu.session.query(`${siteId}/cms/nav/**`);
  return rows.filter((q) => !q.value.deleted).sort((a, b) => a.value.order - b.value.order);
}

/** Live subscription to the menu — delivers what already exists first, then anything new (map()'s default). */
export function onNav(qu, siteId, callback, opts) {
  return qu.get(`${siteId}/cms/nav`).map(callback, { deep: true, ...opts });
}

/**
 * Presentation mode: sets the currently shown slug for EVERY visitor. Only
 * meaningful while `navigationMode === "presentation"` — but technically
 * enforceable independent of that, so an owner can prepare the state before
 * ever switching modes.
 */
export async function presentRoute(qu, siteId, slug) {
  return qu.get(`${siteId}/cms/state/route`).put(slug);
}

/** Live subscription to the presented route. */
export function onPresentedRoute(qu, siteId, callback, opts) {
  return qu.get(`${siteId}/cms/state/route`).on(callback, { initial: true, ...opts });
}

// --- Per-user homepage discovery ---
//
// A user's own CMS site is just another generic Space — NOT squeezed into
// their reserved `~<fp>` User-Space (that stays the identity root, not a
// content container). Instead, which site (if any) is "this identity's
// homepage" is a single, ordinary public profile attribute (modules/
// profiles.js) — the same discovery mechanism any other app-participation
// marker already uses (see modules/README.md's `app-<appId>` convention),
// nothing CMS-specific invented here.
const HOMEPAGE_ATTR = 'homepage-site';

/** Marks `siteId` as the caller's own homepage — public by default (like any other profile attribute), so anyone looking at this identity can find it. */
export async function setHomepageSite(qu, siteId) {
  return setProfileAttr(qu, HOMEPAGE_ATTR, { siteId });
}

/** Reads `fingerprint`'s homepage site id — `null` if never set. */
export async function getHomepageSite(qu, fingerprint) {
  const attr = await getProfileAttr(qu, fingerprint, HOMEPAGE_ATTR);
  return attr?.siteId ?? null;
}

/**
 * Live subscription to `fingerprint`'s homepage-site attribute
 * (add/change/remove, `q.value === null` for a removal — same convention
 * `onProfileAttrsChange()` itself uses). Filters the whole `attrs/` feed
 * down to this one key, since profiles.js has no per-key subscription of
 * its own (attributes are a `map()` over the whole subtree, not
 * individually addressable QuBits with their own `.on()`).
 */
export function onHomepageSiteChange(qu, fingerprint, callback, opts) {
  return onProfileAttrsChange(qu, fingerprint, (q) => {
    if (q.id.endsWith(`/attrs/${HOMEPAGE_ATTR}`)) callback(q);
  }, opts);
}

/**
 * `qu.use(createCmsPlugin())` — attaches sugar for every function above,
 * mirroring every other `create*Plugin()` in this directory
 * (`createContactsPlugin()`, `createIncognitoPlugin()`). Requires
 * `createSpacesPlugin()` to already be installed (for `qu.createSpace()`,
 * used by `createSite()`), same dependency `modules/spaces.js` itself
 * documents for any Space-based module.
 */
export function createCmsPlugin() {
  return {
    install(qu) {
      qu.createSite = (opts) => createSite(qu, opts);
      qu.getConfig = (siteId) => getConfig(qu, siteId);
      qu.onConfig = (siteId, callback, opts) => onConfig(qu, siteId, callback, opts);
      qu.updateConfig = (siteId, patch) => updateConfig(qu, siteId, patch);
      qu.setNavigationMode = (siteId, mode) => setNavigationMode(qu, siteId, mode);
      qu.setTemplate = (siteId, name, html) => setTemplate(qu, siteId, name, html);
      qu.getTemplate = (siteId, name) => getTemplate(qu, siteId, name);
      qu.onTemplate = (siteId, name, callback, opts) => onTemplate(qu, siteId, name, callback, opts);
      qu.setPage = (siteId, slug, opts) => setPage(qu, siteId, slug, opts);
      qu.getPage = (siteId, slug) => getPage(qu, siteId, slug);
      qu.onPage = (siteId, slug, callback, opts) => onPage(qu, siteId, slug, callback, opts);
      qu.addNavItem = (siteId, opts) => addNavItem(qu, siteId, opts);
      qu.removeNavItem = (navItemId) => removeNavItem(qu, navItemId);
      qu.listNav = (siteId) => listNav(qu, siteId);
      qu.onNav = (siteId, callback, opts) => onNav(qu, siteId, callback, opts);
      qu.presentRoute = (siteId, slug) => presentRoute(qu, siteId, slug);
      qu.onPresentedRoute = (siteId, callback, opts) => onPresentedRoute(qu, siteId, callback, opts);
      qu.setHomepageSite = (siteId) => setHomepageSite(qu, siteId);
      qu.getHomepageSite = (fingerprint) => getHomepageSite(qu, fingerprint);
      qu.onHomepageSiteChange = (fingerprint, callback, opts) => onHomepageSiteChange(qu, fingerprint, callback, opts);
    },
  };
}
