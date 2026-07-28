import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRootContentRoutes } from '../server/root-content-routes.mjs';

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qu-root-content-'));
  await fs.writeFile(path.join(root, 'index.html'), 'QUNIVERSE_SHELL');
  await fs.mkdir(path.join(root, 'dev'));
  await fs.writeFile(path.join(root, 'dev', 'index.html'), 'DEV_PORTAL');
  return root;
}

function fakeRes() {
  const res = { statusCode: null, headers: null, body: null };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
  res.end = (data) => { res.body = data; };
  return res;
}

test('createRootContentRoutes(): "/" is the only matched path', async () => {
  const root = await makeRoot();
  const [route] = createRootContentRoutes({ root, serveQuniverse: true, serveDocs: true, serveExamples: true });
  assert.equal(route.match('/'), true);
  assert.equal(route.match('/foo'), false);
  assert.equal(route.match('/index.html'), false);
});

test('createRootContentRoutes(): serveQuniverse=true serves the QUniverse shell at "/" regardless of the other two flags', async () => {
  const root = await makeRoot();
  const [route] = createRootContentRoutes({ root, serveQuniverse: true, serveDocs: false, serveExamples: false });
  const res = fakeRes();
  await route.handle({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'QUNIVERSE_SHELL');
});

test('createRootContentRoutes(): serveQuniverse=false falls back to the dev portal at "/" when docs or examples are enabled', async () => {
  const root = await makeRoot();
  const [route] = createRootContentRoutes({ root, serveQuniverse: false, serveDocs: true, serveExamples: false });
  const res = fakeRes();
  await route.handle({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'DEV_PORTAL');
});

test('createRootContentRoutes(): serveQuniverse=false + serveExamples=true (no docs) still falls back to the dev portal', async () => {
  const root = await makeRoot();
  const [route] = createRootContentRoutes({ root, serveQuniverse: false, serveDocs: false, serveExamples: true });
  const res = fakeRes();
  await route.handle({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'DEV_PORTAL');
});

test('createRootContentRoutes(): all three toggles off serves an honest placeholder, not a crash', async () => {
  const root = await makeRoot();
  const [route] = createRootContentRoutes({ root, serveQuniverse: false, serveDocs: false, serveExamples: false });
  const res = fakeRes();
  await route.handle({}, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.toString(), /Kein Inhaltsbereich aktiviert/);
});
