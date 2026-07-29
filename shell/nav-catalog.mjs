// Pure, DOM-free catalog logic for qu-nav-dropdown.mjs — split out the same
// way Qu's own ui/bindings.js (DOM-free) sits next to ui/components.js
// (browser-only, extends HTMLElement at module-eval time, which throws in
// Node). qu-nav-dropdown.mjs itself can't be imported in Node for the same
// reason, so anything worth a real `node --test` has to live here instead.

const CATEGORY_ORDER = ['service', 'example', 'documentation', 'custom'];

/** Which catalog entries qu-nav-dropdown ever shows: no admin-category entries (this is a product nav, not a dev/ops catalog), nothing explicitly disabled, and only entries this shell can actually act on — a set `entry` (redirect) and/or `mount` (in-place, see qu-app-shell.mjs's mount loader). A definition with neither has nothing to load at all yet. */
export function visibleCatalogEntries(services) {
  return services.filter((s) => s.category !== 'admin' && s.enabled !== false && (s.entry || s.mount));
}

/** Category first (fixed display order, unknown categories sort last), then `navOrder` ascending (missing sorts last within its category), then label as the final tiebreak. */
export function sortCatalog(list) {
  return [...list].sort((a, b) => {
    const catA = CATEGORY_ORDER.indexOf(a.category);
    const catB = CATEGORY_ORDER.indexOf(b.category);
    if (catA !== catB) return (catA === -1 ? CATEGORY_ORDER.length : catA) - (catB === -1 ? CATEGORY_ORDER.length : catB);
    const orderA = a.navOrder ?? Infinity;
    const orderB = b.navOrder ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return (a.label ?? '').localeCompare(b.label ?? '');
  });
}

const FOOTER_CATEGORIES = ['example', 'documentation'];

/**
 * The bottom-of-menu Examples/Documentation section — real 'service'/
 * 'custom' apps now live exclusively in the App-Verzeichnis
 * (services/app-directory, itself just a fixed link in this dropdown, see
 * qu-nav-dropdown.mjs's own doc), not individually listed in this compact
 * dropdown anymore. Examples/Documentation stay listed here directly
 * (they're one-off reference pages, not "apps" someone browses/enables/
 * favorites the way App-Verzeichnis handles those) — naturally empty
 * (renders nothing) when QU_SERVE_EXAMPLES/QU_SERVE_DOCS are both off,
 * since /relay/services then never contains such entries at all.
 */
export function footerEntries(services) {
  return visibleCatalogEntries(services).filter((s) => FOOTER_CATEGORIES.includes(s.category));
}

/**
 * Resolves a favorited-appId list (src/modules/favorites.js's
 * `listFavorites()`/`onFavoritesChange()`) against the CURRENT catalog —
 * a favorited id that's since been removed/disabled (or was an example/
 * doc entry filtered out by visibleCatalogEntries()'s own `enabled`/
 * loader check) is silently dropped, never a broken/blank menu entry
 * pointing nowhere. Order follows the catalog's own `favoriteIds`
 * argument order, not alphabetical — a caller wanting stable display
 * order applies `sortCatalog()` to the result, same as any other list
 * this module produces.
 */
export function resolveFavoriteEntries(services, favoriteIds) {
  const byId = new Map(visibleCatalogEntries(services).map((s) => [s.id, s]));
  return favoriteIds.map((id) => byId.get(id)).filter(Boolean);
}
