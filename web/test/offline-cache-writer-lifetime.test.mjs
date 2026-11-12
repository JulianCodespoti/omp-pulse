import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';

// Exact production module, synthetic clock and transactional storage boundary.
// No browser, network, daemon, real sessions, device or model calls. Run with:
// node --experimental-vm-modules --test web/test/offline-cache-writer-lifetime.test.mjs
// OFFLINE_CACHE_SOURCE can select the unmodified baseline for differential proof.
const sourcePath = process.env.OFFLINE_CACHE_SOURCE
  ? resolve(process.env.OFFLINE_CACHE_SOURCE)
  : new URL('../src/runtime/offline-cache.ts', import.meta.url);
const source = readFileSync(sourcePath, 'utf8');

function storageFixture() {
  const data = new Map([['history', new Map()], ['sessions', new Map()]]);
  const transactions = [], held = [];
  let active = false, failNext = false, holdNext = false;
  const writes = [];
  function start() {
    if (active || !transactions.length) return;
    active = true;
    transactions.shift()();
  }
  const db = {
    objectStoreNames: { contains: name => data.has(name) },
    close() {},
    transaction(name, mode) {
      const operations = [];
      let working, finished = false, scheduled = false;
      const tx = {
        oncomplete: null, onerror: null, onabort: null,
        abort() { finish(false); },
        objectStore() {
          const request = operation => {
            const req = { result: undefined, onsuccess: null, onerror: null };
            operations.push(() => { req.result = operation(); req.onsuccess?.(); });
            return req;
          };
          return {
            keyPath: 'key',
            get(key) { return request(() => structuredClone(working.get(key))); },
            put(value) {
              const snapshot = structuredClone(value);
              return request(() => {
                if (failNext) { failNext = false; throw new Error('synthetic write failure'); }
                working.set(snapshot.key, snapshot);
                if (name === 'history' && Array.isArray(snapshot.messages)) writes.push(structuredClone(snapshot));
                return snapshot.key;
              });
            },
            delete(key) { return request(() => working.delete(key)); },
            openCursor() {
              const req = { result: undefined, onsuccess: null, onerror: null };
              let keys, index = 0;
              const step = () => {
                keys ??= [...working.keys()].sort();
                const key = keys[index++];
                req.result = key === undefined ? null : {
                  value: structuredClone(working.get(key)),
                  continue() { operations.push(step); },
                  delete() { operations.push(() => working.delete(key)); },
                };
                req.onsuccess?.();
              };
              operations.push(step);
              return req;
            },
          };
        },
      };
      function finish(ok) {
        if (finished) return;
        finished = true;
        if (ok && mode === 'readwrite') data.set(name, working);
        if (ok) tx.oncomplete?.(); else tx.onabort?.();
        active = false;
        queueMicrotask(start);
      }
      function pump() {
        if (finished) return;
        if (operations.length) {
          try { operations.shift()(); } catch { tx.onerror?.(); finish(false); return; }
          queueMicrotask(pump);
        } else if (holdNext && mode === 'readwrite') {
          holdNext = false;
          held.push(() => finish(true));
        } else finish(true);
      }
      transactions.push(() => {
        working = new Map([...data.get(name)].map(([k, v]) => [k, structuredClone(v)]));
        if (!scheduled) { scheduled = true; queueMicrotask(pump); }
      });
      queueMicrotask(start);
      return tx;
    },
  };
  return {
    indexedDB: { open() {
      const req = { result: db, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    } },
    writes,
    data,
    fail() { failNext = true; },
    hold() { holdNext = true; },
    release() { for (const release of held.splice(0)) release(); },
    get heldCount() { return held.length; },
  };
}

async function fixture({ unavailable = false } = {}) {
  const storage = storageFixture();
  const timers = new Map(), callbacks = new Map(), listeners = new Map();
  let nextTimer = 0, now = 1_000_000;
  class Clock extends Date { static now() { return now; } }
  const blocked = () => { throw new Error('External I/O is forbidden in this fixture'); };
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => listeners.set(name, fn) };
  const context = vm.createContext({
    Date: Clock,
    indexedDB: unavailable ? undefined : storage.indexedDB,
    document,
    window: { addEventListener: (name, fn) => listeners.set(name, fn) },
    fetch: blocked,
    WebSocket: class { constructor() { blocked(); } },
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay }); callbacks.set(id, fn);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const observe = '\nexport const inspectWriters = () => [...tailWriters].map(([key, writer]) => ({key, pending: !!writer.pending}));';
  const module = new vm.SourceTextModule(stripTypeScriptTypes(source + observe), {
    context, identifier: new URL('../src/runtime/offline-cache.ts', import.meta.url).href,
  });
  const domainRoot = new URL('../src/domain/', import.meta.url).href;
  const domainModules = new Map();
  await module.link(async (name, parent) => {
    if (name.endsWith('/offline-queue')) {
      return new vm.SyntheticModule(['offlineQueueNamespaceForCredential'], function () {
        this.setExport('offlineQueueNamespaceForCredential', value => `synthetic-${value}`);
      }, { context });
    }
    const url = new URL(`${name}.ts`, parent.identifier);
    if (!url.href.startsWith(domainRoot)) throw new Error(`Unexpected source dependency: ${name}`);
    if (!domainModules.has(url.href)) {
      const { code } = await transformWithOxc(readFileSync(url, 'utf8'), url.pathname, { lang: 'ts' });
      domainModules.set(url.href, new vm.SourceTextModule(code, { context, identifier: url.href }));
    }
    return domainModules.get(url.href);
  });
  await module.evaluate();
  const api = module.namespace;
  const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return {
    api, storage, timers, callbacks, drain,
    count: () => api.inspectWriters().length,
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); due[1].fn(); await drain();
      }
      await drain();
    },
    setNow(value) { now = value; },
    async hide() { document.visibilityState = 'hidden'; listeners.get('visibilitychange')?.(); await drain(); },
    async pagehide() { listeners.get('pagehide')?.(); await drain(); },
  };
}

const path = '/synthetic/session', scope = 'synthetic-namespace';
const messages = text => [{ id: text, role: 'assistant', text, parts: [{ kind: 'text', text }] }];

test('old cached internal deliveries stay hidden on offline opens without losing deliberate messages', async () => {
  const f = await fixture();
  const visible = [...messages('Visible reply'), {
    id: 'extension', role: 'assistant', customType: 'extension-note',
    text: 'Explain <system-notice>quoted text</system-notice>.',
    parts: [{ kind: 'text', text: 'Explain <system-notice>quoted text</system-notice>.' }],
  }];
  await f.api.saveTail(path, visible, scope);
  const record = [...f.storage.data.get('history').values()].find(value => Array.isArray(value.messages));
  for (const customType of ['irc:incoming', 'async-result', 'launch-completion']) {
    record.messages.unshift({
      id: customType, role: 'assistant', customType,
      text: '<system-notice>PRIVATE DELIVERY</system-notice>',
      parts: [{ kind: 'text', text: '<system-notice>PRIVATE DELIVERY</system-notice>' }],
    });
  }
  const cached = await f.api.loadTail(path, scope);
  assert.deepEqual(Array.from(cached.messages, message => message.id), ['Visible reply', 'extension']);
});

test('cached generated results keep every image slot and shell outcome without retaining inline data', async () => {
  const f = await fixture();
  const blob = 'blob:sha256:abcdef123456';
  const source = [{
    id: 'generation', role: 'assistant', text: '', parts: [{
      kind: 'tool', callId: 'image-call', name: 'generate_image', args: {}, state: 'ok',
      images: [{ src: blob, mimeType: 'image/png' }, { src: 'data:image/png;base64,' + 'x'.repeat(500000), mimeType: 'image/png' }, { src: null, mimeType: 'image/webp' }],
    }, {
      kind: 'tool', callId: 'bash-call', name: 'bash', args: {}, state: 'error', shell: { kind: 'timeout' }, output: 'Command timed out',
    }, {
      kind: 'tool', callId: 'todo-call', name: 'todo', args: {}, state: 'ok', todo: [{ name: 'Ship', tasks: [{ content: 'Release', status: 'blocked', blocker: 'Waiting for signing key' }] }],
    }],
  }];
  await f.api.saveTail(path, source, scope);
  const cached = await f.api.loadTail(path, scope);
  const parts = cached.messages[0].parts;
  assert.equal(parts[0].images.length, 3);
  assert.deepEqual(Array.from(parts[0].images, image => image.src), [blob, null, null]);
  assert.equal(parts[1].shell.kind, 'timeout');
  assert.equal(parts[2].todo[0].tasks[0].blocker, 'Waiting for signing key');
  assert.equal(JSON.stringify([...f.storage.data.get('history').values()]).includes('x'.repeat(500000)), false);
});

test('cached context boundaries follow the latest coalesced tail through unknown and explicit clear', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('legacy'), scope);
  assert.equal((await f.api.loadTail(path, scope)).contextBoundary, undefined);
  const zero = f.api.saveTail(path, messages('zero'), scope, { entryId: 'c-zero', at: 1234, tokens: 0 });
  const measured = await f.api.loadTail(path, scope);
  await zero;
  assert.equal(measured.contextBoundary.tokens, 0);
  assert.equal(measured.contextBoundary.at, 1234, 'native timestamps are persisted without clock conversion');
  const old = f.api.saveTail(path, messages('superseded'), scope, { entryId: 'c-old', at: 2345, tokens: 20 });
  const unknown = { entryId: 'c-current', at: 3456 };
  const newest = f.api.saveTail(path, messages('current'), scope, unknown);
  unknown.at = 9999;
  const cached = await f.api.loadTail(path, scope);
  await Promise.all([old, newest]);
  assert.equal(cached.messages[0].text, 'current');
  assert.equal(cached.contextBoundary.entryId, 'c-current');
  assert.equal(cached.contextBoundary.at, 3456);
  assert.equal(cached.contextBoundary.tokens, undefined);
  const clear = f.api.saveTail(path, messages('cleared'), scope, null);
  assert.equal((await f.api.loadTail(path, scope)).contextBoundary, null);
  await clear;
  assert.equal(await f.api.loadTail(path, 'other-namespace'), null);
  await f.api.clearTail(path, scope);
  assert.equal(await f.api.loadTail(path, scope), null);
});

test('cached context boundary validation bounds identity and strips untrusted fields without deleting legacy messages', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('kept'), scope, { entryId: 'valid', at: 1234, tokens: 0, excess: 'x'.repeat(500000) });
  let record = [...f.storage.data.get('history').values()].find(value => Array.isArray(value.messages));
  assert.equal(record.contextBoundary.tokens, 0);
  assert.equal(record.contextBoundary.excess, undefined);
  for (const boundary of [
    { entryId: '', at: 1 }, { entryId: 'x'.repeat(257), at: 1 }, { entryId: 7, at: 1 },
    { entryId: 'bad', at: NaN }, { entryId: 'bad', at: Infinity }, { entryId: 'bad', at: '1' },
  ]) {
    record.contextBoundary = boundary;
    const cached = await f.api.loadTail(path, scope);
    assert.equal(cached.contextBoundary, undefined);
    assert.equal(cached.messages[0].text, 'kept');
  }
  for (const tokens of [-1, NaN, Infinity, '1', 1.5]) {
    record.contextBoundary = { entryId: 'unknown', at: 1234, tokens };
    const cached = await f.api.loadTail(path, scope);
    assert.equal(cached.contextBoundary.entryId, 'unknown');
    assert.equal(cached.contextBoundary.tokens, undefined, 'an invalid estimate cannot revive pre-compaction fullness');
  }
  const pending = f.api.saveTail(path, messages('saved-invalid'), scope, { entryId: 'too-long'.repeat(100), at: 1 });
  const cached = await f.api.loadTail(path, scope);
  await pending;
  assert.equal(cached.contextBoundary, undefined);
  assert.equal(cached.messages[0].text, 'saved-invalid');
});

test('idle writers expire without another save or explicit cache clearing', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('first'), scope);
  assert.equal(f.count(), 1);
  await f.advance(1999); assert.equal(f.count(), 1);
  await f.advance(1); assert.equal(f.count(), 0);
  assert.equal(f.timers.size, 0);
  assert.equal((await f.api.loadTail(path, scope)).messages[0].text, 'first');
});

test('10,000 distinct session saves do not accumulate idle state when storage is unavailable', async () => {
  const f = await fixture({ unavailable: true });
  for (let i = 0; i < 10000; i++) {
    await f.api.saveTail(`/synthetic/session-${i}`, [], scope);
    await f.advance(2000);
    assert.equal(f.count(), 0, `after session ${i}`);
  }
  assert.equal(f.timers.size, 0);
});

test('normal cache eviction and writer expiry keep their independent bounds', async () => {
  const f = await fixture();
  for (let i = 0; i < 1000; i++) {
    await f.api.saveTail(`/synthetic/session-${i}`, messages(`body-${i}`), scope);
    await f.advance(2000);
    assert.equal(f.count(), 0, `after session ${i}`);
  }
  const rows = [...f.storage.data.get('history').values()].filter(row => Array.isArray(row.messages));
  assert.equal(rows.length, 8);
  assert.equal(f.timers.size, 0);
  assert.equal((await f.api.loadTail('/synthetic/session-999', scope)).messages[0].text, 'body-999');
  assert.equal(await f.api.loadTail('/synthetic/session-0', scope), null);
});

test('rapid saves still coalesce into one trailing write with every waiter settled', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('first'), scope);
  let settled = 0;
  const pending = Array.from({ length: 20 }, (_, i) => f.api.saveTail(path, messages(`new-${i}`), scope).then(() => settled++));
  await f.advance(1999);
  assert.equal(f.storage.writes.length, 1); assert.equal(settled, 0);
  assert.equal(f.count(), 1); assert.equal(f.timers.size, 1);
  await f.advance(1); await Promise.all(pending);
  assert.equal(f.storage.writes.length, 2); assert.equal(settled, 20);
  assert.equal(f.storage.writes[1].messages[0].text, 'new-19');
  await f.advance(2000); assert.equal(f.count(), 0); assert.equal(f.timers.size, 0);
});

for (const flush of ['load', 'hide', 'pagehide']) test(`${flush} flush preserves the latest pending tail and resets idle cleanup`, async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('first'), scope);
  const pending = f.api.saveTail(path, messages('latest'), scope);
  await f.advance(500);
  if (flush === 'load') assert.equal((await f.api.loadTail(path, scope)).messages[0].text, 'latest');
  else await f[flush]();
  await pending;
  assert.equal(f.storage.writes.length, 2);
  assert.equal(f.storage.writes[1].messages[0].text, 'latest');
  await f.advance(1999); assert.equal(f.count(), 1);
  await f.advance(1); assert.equal(f.count(), 0); assert.equal(f.timers.size, 0);
});

test('clearing a tail settles pending saves, cancels its timers and cannot delete a replacement', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('first'), scope);
  const staleCleanup = [...f.timers.values()][0]?.fn;
  assert.equal(typeof staleCleanup, 'function');
  const pending = f.api.saveTail(path, messages('cancelled'), scope);
  await f.api.clearTail(path, scope); await pending;
  assert.equal(f.count(), 0); assert.equal(f.timers.size, 0);
  assert.equal(await f.api.loadTail(path, scope), null);
  await f.api.saveTail(path, messages('replacement'), scope);
  staleCleanup();
  assert.equal(f.count(), 1);
  assert.equal((await f.api.loadTail(path, scope)).messages[0].text, 'replacement');
  await f.advance(2000); assert.equal(f.count(), 0);
});

test('a cancelled cleanup from an earlier window cannot expire a newer window on the same writer', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('first'), scope);
  const staleCleanup = [...f.timers.values()][0].fn;
  // The clock advanced while timers were not serviced, as with a busy event loop.
  f.setNow(1_003_000);
  await f.api.saveTail(path, messages('new-window'), scope);
  staleCleanup();
  assert.equal(f.count(), 1); assert.equal(f.timers.size, 1);
  await f.advance(1999); assert.equal(f.count(), 1);
  await f.advance(1); assert.equal(f.count(), 0);
});

test('namespace clearing cancels only its own idle and pending writers', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('one'), 'one');
  await f.api.saveTail(path, messages('two'), 'two');
  const pending = f.api.saveTail(path, messages('one-latest'), 'one');
  await f.api.clearAllCachedHistory('one'); await pending;
  assert.equal(f.count(), 1);
  assert.equal(await f.api.loadTail(path, 'one'), null);
  assert.equal((await f.api.loadTail(path, 'two')).messages[0].text, 'two');
  await f.advance(2000); assert.equal(f.count(), 0); assert.equal(f.timers.size, 0);
});

test('failed storage writes and trailing-write waiters do not prevent cleanup', async () => {
  const f = await fixture();
  f.storage.fail(); await f.api.saveTail(path, messages('fails'), scope);
  await f.advance(2000); assert.equal(f.count(), 0);
  await f.api.saveTail(path, messages('good'), scope);
  f.storage.fail(); const pending = f.api.saveTail(path, messages('trailing-fails'), scope);
  await f.advance(2000); await pending;
  await f.advance(2000); assert.equal(f.count(), 0); assert.equal(f.timers.size, 0);
  assert.equal((await f.api.loadTail(path, scope)).messages[0].text, 'good');
});

test('late completion of an in-flight write cannot delete a successor writer', async () => {
  const f = await fixture();
  f.storage.hold();
  const first = f.api.saveTail(path, messages('old'), scope);
  await f.drain(); assert.equal(f.storage.heldCount, 1);
  await f.advance(2000); assert.equal(f.count(), 0);
  const replacement = f.api.saveTail(path, messages('new'), scope);
  assert.equal(f.count(), 1);
  f.storage.release(); await first; await replacement;
  assert.equal(f.count(), 1);
  assert.equal((await f.api.loadTail(path, scope)).messages[0].text, 'new');
  await f.advance(2000); assert.equal(f.count(), 0);
});

test('a save arriving at trailing-write settlement still belongs to the current window', async () => {
  const f = await fixture();
  await f.api.saveTail(path, messages('first'), scope);
  const pending = f.api.saveTail(path, messages('second'), scope);
  let last;
  void pending.then(() => { last = f.api.saveTail(path, messages('third'), scope); });
  await f.advance(2000); await pending; await f.drain();
  assert.equal(f.count(), 1); assert.equal(f.timers.size, 1);
  assert.equal(f.storage.writes.length, 2);
  await f.advance(2000); await last;
  assert.equal(f.storage.writes.length, 3);
  assert.equal(f.storage.writes[2].messages[0].text, 'third');
  await f.advance(2000); assert.equal(f.count(), 0);
});

test('offline tool images retain unavailable slots and search coverage metadata', async () => {
  const f = await fixture();
  const part = {kind:'tool',callId:'generation',name:'generate_image',args:{},state:'ok',
    images:[{src:'data:image/png;base64,YQ==',mimeType:'image/png'},{src:'blob:sha256:abcdef0123456789',mimeType:'image/webp'},{src:null,mimeType:'image/png'}],
    search:{truncated:true,perFileLimitReached:20}};
  await f.api.saveTail(path,[{id:'tool',role:'assistant',text:'',parts:[part]}],scope);
  const restored=(await f.api.loadTail(path,scope)).messages[0].parts[0];
  assert.deepEqual(Array.from(restored.images,image=>image.src),[null,'blob:sha256:abcdef0123456789',null]);
  assert.equal(restored.search.truncated,true);
  assert.equal(restored.search.perFileLimitReached,20);
});
