import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import config from '../vite.config.ts';

// Run the production build hook and worker, with only CacheStorage/network and
// worker lifecycle boundaries replaced. No daemon, browser or real deployment.
const origin = 'https://pulse.test';
const scope = `${origin}/app/`;
const href = value => new URL(typeof value === 'string' ? value : value.url, scope).href;
const releasePlugin = config.plugins.flat(Infinity).find(plugin => plugin?.name === 'release-identity');

function release(t, name) {
  const directory = mkdtempSync(join(tmpdir(), 'pulse-worker-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const assets = new Map([
    [`assets/entry-${name}.js`, `import {label} from './dep-${name}.js'; export const screen=label; export async function openChat(){return (await import('./chat-${name}.js')).message;}`],
    [`assets/dep-${name}.js`, `export const label=${JSON.stringify(`Sessions ${name}`)};`],
    [`assets/chat-${name}.js`, `export const message=${JSON.stringify(`Chat ${name}`)};`],
    [`assets/style-${name}.css`, `@font-face{font-family:pulse;src:url('./font-${name}.woff2')} body{color:red}`],
    [`assets/font-${name}.woff2`, `font-${name}`],
  ]);
  const html = `<!doctype html><link rel="stylesheet" href="./assets/style-${name}.css"><link rel="modulepreload" href="./assets/dep-${name}.js"><div id="root"></div><script type="module" src="./assets/entry-${name}.js"></script>`;
  writeFileSync(join(directory, 'index.html'), html);
  // The Vite hook consumes its final output bundle, including lazy chunks and
  // non-code assets, rather than trying to parse only the entry script.
  releasePlugin.writeBundle.handler({ dir: directory }, Object.fromEntries([...assets.keys()].map(fileName => [fileName, { fileName }])));
  const source = readFileSync(join(directory, 'sw.js'), 'utf8');
  return { name, source, html, assets, directory };
}

function environment() {
  const stores = new Map();
  const requests = [];
  let online = true, deployed = null, override = null;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(key) { return entries.get(href(key))?.clone(); },
        async put(key, response) { entries.set(href(key), response.clone()); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  async function fetch(input, options) {
    const url = href(input);
    requests.push({ url, options });
    if (!online) throw new Error('offline');
    if (override) {
      const response = await override(url);
      if (response) return response;
    }
    const path = new URL(url).pathname;
    if (path === '/app/' || path === '/app/index.html') {
      // Fetch exposes decompressed HTML even when the daemon serves a sidecar.
      return new Response(deployed.html, { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } });
    }
    const asset = path.slice('/app/'.length);
    if (deployed.assets.has(asset)) {
      const type = asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'font/woff2';
      return new Response(deployed.assets.get(asset), { headers: { 'content-type': type } });
    }
    if (['manifest.webmanifest', 'icon-192.png', 'badge-96.png', 'icon.svg'].includes(asset)) return new Response(asset);
    return new Response('not found', { status: 404 });
  }
  function worker(source) {
    const listeners = new Map();
    let skips = 0, claims = 0;
    const context = vm.createContext({
      URL, Response, Uint8Array, crypto: webcrypto, caches, fetch,
      self: {
        registration: { scope }, location: { origin },
        clients: { async claim() { claims++; } },
        skipWaiting() { skips++; },
        addEventListener(name, fn) { listeners.set(name, fn); },
      },
    });
    new vm.Script(source).runInContext(context);
    async function lifecycle(name) {
      const pending = [];
      listeners.get(name)({ waitUntil(promise) { pending.push(promise); } });
      await Promise.all(pending);
    }
    return {
      install: () => lifecycle('install'), activate: () => lifecycle('activate'),
      get skips() { return skips; }, get claims() { return claims; },
      apply() { listeners.get('message')({ data: { type: 'SKIP_WAITING' } }); },
      async request(path, mode = 'cors', method = 'GET') {
        let response;
        const pending = [];
        listeners.get('fetch')({
          request: { url: href(path), method, mode },
          respondWith(value) { response = Promise.resolve(value); },
          waitUntil(value) { pending.push(value); },
        });
        const result = await response;
        await Promise.all(pending);
        return result;
      },
    };
  }
  return {
    worker, caches, requests,
    deploy(value) { deployed = value; }, offline() { online = false; }, online() { online = true; },
    intercept(value) { override = value; },
  };
}

async function launch(worker) {
  const response = await worker.request('/app/?resume=1', 'navigate');
  const html = await response.text();
  // Exercise what the consumer loads, including preloads, styles and fonts.
  for (const [, path] of html.matchAll(/href="([^"]+)"/g)) {
    const asset = await worker.request(new URL(path, scope).href);
    assert.equal(asset.ok, true);
    if (path.endsWith('.css')) {
      const css = await asset.text();
      for (const [, font] of css.matchAll(/url\('([^']+)'\)/g)) {
        const fontResponse = await worker.request(new URL(font, new URL(path, scope)).href);
        assert.equal(fontResponse.ok, true);
        assert.match(await fontResponse.text(), /^font-/);
      }
    }
  }
  const entry = new URL(html.match(/<script[^>]+src="([^"]+)"/)[1], scope).href;
  const context = vm.createContext({});
  const modules = new Map();
  async function load(url) {
    if (modules.has(url)) return modules.get(url);
    const asset = await worker.request(url);
    const module = new vm.SourceTextModule(await asset.text(), {
      context, identifier: url,
      async importModuleDynamically(specifier, parent) {
        const dynamic = await load(new URL(specifier, parent.identifier).href);
        if (dynamic.status === 'linked') await dynamic.evaluate();
        return dynamic;
      },
    });
    modules.set(url, module);
    await module.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
    return module;
  }
  const module = await load(entry);
  await module.evaluate();
  return { screen: module.namespace.screen, chat: await module.namespace.openChat() };
}

test('slow deployment navigation cannot replace the offline shell before explicit activation', async t => {
  const old = release(t, 'old'), next = release(t, 'next');
  const env = environment();
  env.deploy(old);
  const active = env.worker(old.source);
  await active.install(); await active.activate();
  env.deploy(next);
  let slowNavigation = false;
  env.intercept(url => {
    if (new URL(url).pathname === '/app/') {
      slowNavigation = true;
      return new Promise(() => {});
    }
  });
  assert.deepEqual(await launch(active), { screen: 'Sessions old', chat: 'Chat old' });
  // A navigation no longer starts the unsafe late response at all.
  assert.equal(slowNavigation, false);
  env.offline();
  assert.deepEqual(await launch(active), { screen: 'Sessions old', chat: 'Chat old' });
  env.online(); env.intercept(null);
  const waiting = env.worker(next.source);
  await waiting.install();
  assert.equal(waiting.skips, 0);
  assert.equal(waiting.claims, 0);
  assert.deepEqual(await launch(active), { screen: 'Sessions old', chat: 'Chat old' });
  waiting.apply();
  assert.equal(waiting.skips, 1);
  await waiting.activate();
  env.offline();
  assert.deepEqual(await launch(waiting), { screen: 'Sessions next', chat: 'Chat next' });
});

for (const failure of ['missing dynamic chunk', 'HTML instead of CSS', 'mismatched shell']) {
  test(`incomplete update (${failure}) leaves the usable release intact`, async t => {
    const old = release(t, 'old'), next = release(t, 'next');
    const env = environment(); env.deploy(old);
    const active = env.worker(old.source);
    await active.install(); await active.activate();
    const before = await env.caches.keys();
    env.deploy(next);
    env.intercept(url => {
      if (failure === 'missing dynamic chunk' && url.endsWith('/chat-next.js')) return new Response('', { status: 404 });
      if (failure === 'HTML instead of CSS' && url.endsWith('.css')) return new Response('<html>fallback</html>', { headers: { 'content-type': 'text/html' } });
      if (failure === 'mismatched shell' && url === scope) return new Response(old.html);
    });
    await assert.rejects(env.worker(next.source).install());
    assert.deepEqual(await env.caches.keys(), before);
    env.offline();
    assert.deepEqual(await launch(active), { screen: 'Sessions old', chat: 'Chat old' });
    // Reinstalling identical HTML with the same release id reuses the commit.
    await env.worker(old.source).install();
    assert.deepEqual(await launch(active), { screen: 'Sessions old', chat: 'Chat old' });
  });
}

test('activation retains only the previous activated release and its lazy chunks', async t => {
  const env = environment();
  const releases = ['one', 'two', 'three'].map(name => release(t, name));
  let active;
  for (const built of releases) {
    env.deploy(built); active = env.worker(built.source);
    await active.install(); await active.activate();
  }
  assert.equal((await env.caches.keys()).length, 3); // state + two releases
  env.offline();
  assert.deepEqual(await launch(active), { screen: 'Sessions three', chat: 'Chat three' });
  assert.match(await (await active.request('/app/assets/chat-two.js')).text(), /Chat two/);
  await assert.rejects(active.request('/app/assets/chat-one.js'), /offline/);
});

test('install bounds asset requests and never fetches private/API content', { timeout: 10_000 }, async t => {
  const built = release(t, 'bounded');
  const env = environment(); env.deploy(built);
  const held = [];
  env.intercept(url => {
    if (url !== scope) return new Promise(resolve => held.push(resolve));
  });
  const active = env.worker(built.source);
  const install = active.install();
  // Yield to native crypto/Response tasks without advancing a wall-clock deadline.
  while (held.length < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal(held.length, 4);
  assert.equal(env.requests.length, 5); // shell + at most four assets
  env.intercept(null);
  for (const resolve of held) resolve(new Response('public asset'));
  await install;
  const count = env.requests.length;
  for (const path of ['/api/sessions', '/ws', '/private', 'https://elsewhere.test/app/assets/x.js']) {
    assert.equal(await active.request(path), undefined);
  }
  assert.equal(env.requests.length, count);
  assert.equal(env.requests.every(request => new URL(request.url).pathname.startsWith('/app/')), true);
  assert.equal(env.requests.every(request => request.options?.credentials === 'omit'), true);
});

test('unstamped development source refuses installation without fetching anything', async () => {
  const env = environment();
  await assert.rejects(env.worker(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')).install(), /no built release/);
  assert.equal(env.requests.length, 0);
});

test('first atomic activation preserves one legacy cache for open-page chunks', async t => {
  const built = release(t, 'atomic');
  const env = environment(); env.deploy(built);
  const older = await env.caches.open('omp-pulse-legacy-older');
  await older.put('/app/', new Response('obsolete HTML'));
  const previous = await env.caches.open('omp-pulse-legacy-last');
  await previous.put('/app/', new Response('mutable legacy HTML'));
  await previous.put('/app/assets/legacy-chat.js', new Response('legacy chat'));
  const active = env.worker(built.source);
  await active.install(); await active.activate(); env.offline();
  assert.deepEqual(await launch(active), { screen: 'Sessions atomic', chat: 'Chat atomic' });
  assert.equal(await (await active.request('/app/assets/legacy-chat.js')).text(), 'legacy chat');
  assert.equal((await env.caches.keys()).includes('omp-pulse-legacy-older'), false);
  assert.equal((await env.caches.keys()).length, 3);
});

test('precompressed workers contain the same final release manifest as the identity response', async t => {
  const built = release(t, 'compressed');
  const compression = config.plugins.flat(Infinity).find(plugin => plugin?.name === 'precompress-output');
  compression.configResolved({ root: built.directory, build: { outDir: '.' } });
  compression.closeBundle.handler();
  for (const [extension, decode] of [['gz', gunzipSync], ['br', brotliDecompressSync]]) {
    const source = decode(readFileSync(join(built.directory, `sw.js.${extension}`))).toString();
    assert.equal(source, built.source);
    const env = environment(); env.deploy(built);
    const active = env.worker(source);
    await active.install(); await active.activate(); env.offline();
    assert.deepEqual(await launch(active), { screen: 'Sessions compressed', chat: 'Chat compressed' });
  }
});
