import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, createProfilesPlugin } from '../index.js';
import {
  createSite, getConfig, onConfig, updateConfig, setNavigationMode,
  setTemplate, getTemplate, onTemplate,
  setPage, getPage, onPage,
  addNavItem, removeNavItem, listNav, onNav,
  presentRoute, onPresentedRoute,
  setHomepageSite, getHomepageSite, onHomepageSiteChange,
  createCmsPlugin,
} from './cms.js';

test('createSite() writes a manifest and an initial config in one call, with sensible defaults', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner, { title: 'Mein Blog' });

  const config = await getConfig(owner, siteId);
  assert.equal(config.title, 'Mein Blog');
  assert.equal(config.theme, 'light');
  assert.equal(config.language, 'de');
  assert.equal(config.navigationMode, 'local'); // default, until someone explicitly switches it
});

test('createSite() seeds cms/state/route so a late joiner in presentation mode gets an initial delivery, not silence', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner, { defaultRoute: 'intro' });

  const seen = [];
  onPresentedRoute(owner, siteId, (q) => { if (q) seen.push(q.value); });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['intro']);
});

test('updateConfig() merges instead of replacing, setNavigationMode() validates its input', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner, { title: 'Mein Blog', theme: 'light' });

  await updateConfig(owner, siteId, { theme: 'dark' });
  let config = await getConfig(owner, siteId);
  assert.equal(config.theme, 'dark');
  assert.equal(config.title, 'Mein Blog', 'other fields must survive a partial update');

  await setNavigationMode(owner, siteId, 'presentation');
  config = await getConfig(owner, siteId);
  assert.equal(config.navigationMode, 'presentation');

  await assert.rejects(() => setNavigationMode(owner, siteId, 'nonsense'), /Ungültiger navigationMode/);
});

test('onConfig() delivers the current config, then live updates (e.g. a mode switch)', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner);

  const seenModes = [];
  onConfig(owner, siteId, (q) => seenModes.push(q.value.navigationMode));
  await setNavigationMode(owner, siteId, 'presentation');
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(seenModes, ['local', 'presentation']);
});

test('a site\'s write access is governed by the ordinary Space manifest (qu.addToRole()), not any CMS-specific mechanism', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const stranger = await Qu.create({ runtime: owner.runtime });
  const siteId = await createSite(owner);

  await assert.rejects(() => setNavigationMode(stranger, siteId, 'presentation'));

  await owner.addToRole(siteId, 'writers', stranger.fingerprint);
  await setNavigationMode(stranger, siteId, 'presentation'); // must not throw anymore

  const manifest = await owner.get(siteId);
  assert.ok(manifest.value.writers.includes(owner.fingerprint));
  assert.ok(manifest.value.writers.includes(stranger.fingerprint));
});

test('a stranger cannot write config/pages/nav on a site they are not a writer of', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const stranger = await Qu.create({ runtime: owner.runtime });
  const siteId = await createSite(owner);

  await assert.rejects(() => setNavigationMode(stranger, siteId, 'presentation'));
  await assert.rejects(() => setPage(stranger, siteId, 'home', { title: 'Hacked' }));
  await assert.rejects(() => addNavItem(stranger, siteId, { label: 'Evil', slug: 'evil' }));

  // Reading stays open (default readers: ['*']).
  const config = await getConfig(stranger, siteId);
  assert.equal(config.title, 'Neue Site');
});

test('templates: set, get, live update', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner);

  await setTemplate(owner, siteId, 'default', '<article>{{content}}</article>');
  assert.equal(await getTemplate(owner, siteId, 'default'), '<article>{{content}}</article>');
  assert.equal(await getTemplate(owner, siteId, 'missing'), null);

  const seen = [];
  onTemplate(owner, siteId, 'default', (q) => seen.push(q.value));
  await setTemplate(owner, siteId, 'default', '<main>{{content}}</main>');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['<article>{{content}}</article>', '<main>{{content}}</main>']);
});

test('pages: set, get, overwrite, live update on exactly one slug', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner);

  await setPage(owner, siteId, 'home', { title: 'Willkommen', blocks: { hero: 'Hallo Welt' } });
  await setPage(owner, siteId, 'about', { title: 'Über uns' });

  const home = await getPage(owner, siteId, 'home');
  assert.equal(home.title, 'Willkommen');
  assert.equal(home.template, 'default');
  assert.deepEqual(home.blocks, { hero: 'Hallo Welt' });

  const seenTitles = [];
  onPage(owner, siteId, 'home', (q) => seenTitles.push(q.value.title));
  await setPage(owner, siteId, 'home', { title: 'Willkommen v2' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seenTitles, ['Willkommen', 'Willkommen v2']);

  // 'about' must be unaffected by writes to 'home' — each slug its own QuBit.
  const about = await getPage(owner, siteId, 'about');
  assert.equal(about.title, 'Über uns');
});

test('nav: add, list sorted by order, remove (tombstone, filtered out), live updates', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner);

  const seen = [];
  onNav(owner, siteId, (q) => seen.push(q.value.label));

  const aboutId = await addNavItem(owner, siteId, { label: 'Über uns', slug: 'about', order: 2 });
  await addNavItem(owner, siteId, { label: 'Start', slug: 'home', order: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen.sort(), ['Start', 'Über uns']);

  let nav = await listNav(owner, siteId);
  assert.deepEqual(nav.map((n) => n.value.slug), ['home', 'about'], 'sorted by order, not insertion order');

  await removeNavItem(owner, aboutId);
  nav = await listNav(owner, siteId);
  assert.deepEqual(nav.map((n) => n.value.slug), ['home']);
});

test('presentation mode: presentRoute()/onPresentedRoute() let an owner drive every visitor\'s current page', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const siteId = await createSite(owner, { navigationMode: 'presentation' });

  const visitor = await Qu.create({ runtime: owner.runtime });
  const seenByVisitor = [];
  onPresentedRoute(visitor, siteId, (q) => { if (q) seenByVisitor.push(q.value); });

  await presentRoute(owner, siteId, 'intro');
  await presentRoute(owner, siteId, 'slide-2');
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(seenByVisitor, ['home', 'intro', 'slide-2'], 'createSite() seeds a default route (so late joiners always get an initial delivery), then the visitor follows the owner\'s route, not their own');

  // A visitor who is not a writer can still observe the presented route (reading stays open).
  await assert.rejects(() => presentRoute(visitor, siteId, 'sneaky'));
});

test('setHomepageSite()/getHomepageSite(): a public, per-identity pointer to the user\'s own CMS site', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin()).use(createProfilesPlugin());
  const other = await Qu.create({ runtime: owner.runtime });
  const siteId = await createSite(owner, { title: 'Meine Homepage' });

  assert.equal(await getHomepageSite(other, owner.fingerprint), null, 'nothing set yet');

  await setHomepageSite(owner, siteId);
  assert.equal(await getHomepageSite(other, owner.fingerprint), siteId, 'readable by anyone, same as any other public profile attribute');
});

test('onHomepageSiteChange(): live subscription fires only for the homepage-site attribute, not unrelated profile attrs', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin()).use(createProfilesPlugin());
  const siteId = await createSite(owner);

  const seen = [];
  onHomepageSiteChange(owner, owner.fingerprint, (q) => seen.push(q.value));
  await owner.setProfileAttr('unrelated-key', { anything: true });
  await setHomepageSite(owner, siteId);
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(seen, [{ siteId }], 'the unrelated attribute write must not have triggered this callback');
});

test('createCmsPlugin() attaches sugar methods bound to the installing Qu instance', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin()).use(createProfilesPlugin()).use(createCmsPlugin());
  const siteId = await owner.createSite({ title: 'Via Plugin' });

  assert.equal((await owner.getConfig(siteId)).title, 'Via Plugin');
  await owner.setPage(siteId, 'home', { title: 'Startseite' });
  assert.equal((await owner.getPage(siteId, 'home')).title, 'Startseite');

  await owner.setHomepageSite(siteId);
  assert.equal(await owner.getHomepageSite(owner.fingerprint), siteId);
});
