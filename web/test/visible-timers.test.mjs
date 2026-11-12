import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Real timer helper, controller and outbox with synthetic scheduling/transport.
// No daemon, native storage, device state or network is touched.
const src = (path) => JSON.stringify(resolve(root, 'web/src', path));
const setup = {
  'fake-intervals': `
    window.fakeIntervals = new Map(); let next = 0;
    window.setInterval = (fn, ms) => { window.fakeIntervals.set(++next, { fn, ms }); return next; };
    window.clearInterval = (id) => { window.fakeIntervals.delete(id); };
  `,
  'native-bridge': `
    window.nativeCalls = []; window.nativeReplies = []; window.nativeRows = []; window.changeEvents = true;
    window.makeNativeBridge = () => {
      const bridge = { onmessage: null, postMessage(raw) {
        const call = JSON.parse(raw); window.nativeCalls.push(call);
        // Capture at request time: late replies must not magically see newer rows.
        const value = call.op === 'list' ? JSON.parse(JSON.stringify(window.nativeRows)) : null;
        window.nativeReplies.push({ call, bridge, value });
      } };
      return bridge;
    };
    window.OmpOutbox = window.makeNativeBridge();
  `,
};
const setupPlugin = {
  name: 'visible-timers-setup',
  resolveId: (id) => (id in setup ? '\0' + id : null),
  load: (id) => (id.startsWith('\0') && id.slice(1) in setup ? setup[id.slice(1)] : null),
};
const bundle = (native) => bundleDomFixture(`
import 'fake-intervals';
${native ? "import 'native-bridge';" : ''}
import { startVisibleInterval } from ${src('runtime/visible-interval.ts')};
import * as queue from ${src('runtime/offline-queue.ts')};
import * as nativeOutbox from ${src('runtime/native-outbox.ts')};
import { OmpSessionController } from ${src('runtime/omp-session-controller.ts')};
import { createOmpStore } from ${src('runtime/omp-store.ts')};
window.fixture = { startVisibleInterval, queue, nativeOutbox, OmpSessionController, createOmpStore };
`, [setupPlugin]);
const plainCode = await bundle(false), nativeCode = await bundle(true);
const nextTask = () => new Promise((done) => setImmediate(done));
const page = () => ({ entries: [], endOffset: 0, nextBefore: null });
const row = (state, commandId = 'c1') => ({ commandId, sessionPath: '/synthetic/a', text: 'hello', createdAt: 1, updatedAt: 1, state, imageCount: 0, imageBytes: 0 });

function fixture(t, { native = false } = {}) {
  const dom = createDomFixture(native ? nativeCode : plainCode), w = dom.window;
  const cleanups = [];
  t.after(() => { try { for (const cleanup of cleanups) cleanup(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  w.WebSocket = class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    constructor(url) { this.url = String(url); }
    send() {}
    close() { this.readyState = 3; this.onclose?.({}); }
  };
  // The controller asks the link once at boot; answer it so the probe is not a blocked network call.
  w.fetch = async () => ({ status: 200, headers: { get: () => 'application/json' }, body: null });
  const intervals = w.fakeIntervals, timeouts = new Map();
  let id = 1_000_000;
  const realTimeout = w.setTimeout.bind(w), realClear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...args) => {
    if (ms >= 1000) { timeouts.set(++id, { fn, ms }); return id; }
    return realTimeout(fn, ms, ...args);
  };
  w.clearTimeout = (key) => { if (!timeouts.delete(key)) realClear(key); };
  const visibility = (value, dispatch = true) => {
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, value });
    if (dispatch) w.document.dispatchEvent(new w.Event('visibilitychange'));
  };
  const periods = () => [...intervals.values()].map((entry) => entry.ms).sort((a, b) => a - b);
  const fire = () => { for (const entry of [...intervals.values()]) entry.fn(); };
  const fireTimeout = (key) => { const entry = timeouts.get(key); assert.ok(entry); timeouts.delete(key); entry.fn(); };
  const reply = (pending, fields = {}) => {
    const index = w.nativeReplies.indexOf(pending);
    if (index !== -1) w.nativeReplies.splice(index, 1);
    pending.bridge.onmessage({ data: JSON.stringify({ id: pending.call.id, ok: true, changeEvents: w.changeEvents, value: pending.value, ...fields }) });
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await nextTask();
      for (const pending of [...(w.nativeReplies ?? [])]) reply(pending);
    }
  };
  const push = (bridge = w.OmpOutbox) => bridge.onmessage({ data: JSON.stringify({ event: 'outbox-changed' }) });
  const lists = () => w.nativeCalls.filter((call) => call.op === 'list').length;
  const controller = () => {
    const store = w.fixture.createOmpStore();
    const c = new w.fixture.OmpSessionController(store, 'synthetic-token', 'http://synthetic.invalid');
    cleanups.push(() => c.dispose());
    const fetches = [], refreshes = [];
    Object.assign(c, {
      refreshSessions: async () => { refreshes.push(true); },
      flushQueue: async () => {}, maintainLocalPendingSends: async () => {}, reconcileReceipts: async () => {}, reviveSocket: () => {},
      fetchHistory: async (path, options) => { fetches.push({ path, options }); return page(); },
    });
    c.activeSession = '/synthetic/a';
    c.lastFrameAt = Date.now();
    store.setState({ sessionPath: c.activeSession });
    return { c, store, fetches, refreshes };
  };
  return { w, f: w.fixture, intervals, timeouts, visibility, periods, fire, fireTimeout, reply, settle, push, lists, controller };
}

test('visible intervals stop on hide, catch clocks up once on show and dispose permanently', (t) => {
  const { f, intervals, visibility, fire } = fixture(t);
  let plain = 0, clock = 0;
  const stopPlain = f.startVisibleInterval(() => plain++, 5000);
  const stopClock = f.startVisibleInterval(() => clock++, 1000, { tickOnShow: true });
  const stale = [...intervals.values()].map(({ fn }) => fn);
  assert.equal(intervals.size, 2);
  visibility('hidden');
  assert.equal(intervals.size, 0);
  for (const fn of stale) fn();
  assert.deepEqual([plain, clock], [0, 0]);
  visibility('visible'); visibility('visible');
  assert.equal(intervals.size, 2);
  assert.deepEqual([plain, clock], [0, 1]);
  for (const fn of stale) fn();
  assert.deepEqual([plain, clock], [0, 1], 'an old queued delivery cannot tick into a new visit');
  fire();
  assert.deepEqual([plain, clock], [1, 2]);
  stopPlain(); stopClock();
  for (const fn of stale) fn();
  visibility('hidden'); visibility('visible');
  assert.equal(intervals.size, 0);
  assert.deepEqual([plain, clock], [1, 2]);
});

test('a hidden-mounted timer stays unarmed and can stop itself during the show tick', (t) => {
  const { f, intervals, visibility } = fixture(t);
  visibility('hidden');
  let ticks = 0;
  const stop = f.startVisibleInterval(() => { ticks++; stop(); }, 1000, { tickOnShow: true });
  assert.equal(intervals.size, 0);
  visibility('visible'); visibility('visible');
  assert.equal(ticks, 1);
  assert.equal(intervals.size, 0);
});

test('controller timers and listing poll stop hidden; healthy pushes relax only the visible fallback', async (t) => {
  const f = fixture(t), { c, refreshes } = f.controller();
  c.startWatchdog(); c.startLivenessProbe(); c.startSessionsPolling();
  // 1 s offline ticker, 5 s silence suspicion, 15 s watchdog, 30 s liveness probe.
  assert.deepEqual(f.periods(), [1000, 5000, 15000, 30000]);
  assert.equal(f.timeouts.get(c.sessionsTimer).ms, 3000);
  const oldPoll = f.timeouts.get(c.sessionsTimer).fn;
  f.visibility('hidden');
  assert.deepEqual(f.periods(), []);
  assert.equal(c.sessionsTimer, null);
  c.scheduleSessionsPoll();
  assert.equal(c.sessionsTimer, null);
  f.visibility('visible'); f.visibility('visible');
  assert.deepEqual(f.periods(), [1000, 5000, 15000, 30000]);
  assert.equal([...f.timeouts.values()].filter(({ ms }) => ms === 3000).length, 1);
  const restoredPoll = c.sessionsTimer, restoredReads = refreshes.length;
  oldPoll();
  assert.equal(c.sessionsTimer, restoredPoll, 'an old queued poll cannot orphan the new timer');
  assert.equal(refreshes.length, restoredReads);
  await nextTask();
  const pending = c.sessionsTimer, before = refreshes.length;
  f.visibility('hidden', false);
  f.fireTimeout(pending);
  assert.equal(refreshes.length, before);
  assert.equal(c.sessionsTimer, null);
  f.visibility('visible', false);
  c.sessionsSocket.readyState = 1;
  c.sessionsLastFrameAt = Date.now(); c.scheduleSessionsPoll();
  assert.equal(f.timeouts.get(c.sessionsTimer).ms, 30000);
  c.sessionsLastFrameAt = Date.now() - 40_000; c.scheduleSessionsPoll();
  assert.ok(f.timeouts.get(c.sessionsTimer).ms <= 5000);
  c.sessionsLastFrameAt = Date.now(); c.scheduleSessionsPoll();
  c.sessionsSocket.close();
  assert.equal(f.timeouts.get(c.sessionsTimer).ms, 3000);
  const reconnect = f.timeouts.get(c.sessionsReconnectTimer).fn;
  f.visibility('hidden');
  assert.equal(c.sessionsReconnectTimer, null);
  reconnect();
  assert.equal(c.sessionsSocket, null, 'a queued reconnect cannot redial a hidden listing');
  f.visibility('visible');
  const stale = f.timeouts.get(c.sessionsTimer).fn;
  c.dispose();
  stale(); f.visibility('hidden'); f.visibility('visible');
  assert.deepEqual(f.periods(), []);
  assert.equal(c.sessionsTimer, null);
});

test('visibility reports every hide/show and StrictMode-style resume rebinds the controller once', async (t) => {
  const f = fixture(t), { c, refreshes } = f.controller();
  const sent = [];
  c.socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)), close() {} };
  f.visibility('hidden'); f.visibility('visible'); f.visibility('hidden');
  assert.deepEqual(sent.filter(({ type }) => type === 'visibility').map(({ visible }) => visible), [false, true, false]);
  await nextTask();
  c.dispose();
  const before = refreshes.length;
  f.visibility('visible');
  assert.equal(refreshes.length, before);
  c.resume(); c.resume();
  assert.deepEqual(f.periods(), [1000]);
  f.visibility('hidden'); f.visibility('visible');
  assert.equal(refreshes.length, before + 1);
});

for (const reason of ['resync', 'poll']) test(`hidden ${reason} waits for show and survives the catch-up cooldown`, async (t) => {
  const f = fixture(t), { c, fetches } = f.controller();
  f.visibility('hidden');
  await c.catchUp(reason);
  assert.equal(fetches.length, 0);
  c.lastCatchUpAt = Date.now(); c.lastFrameAt = Date.now();
  f.visibility('visible');
  await nextTask();
  assert.equal(fetches.length, 0);
  assert.notEqual(c.catchUpTimer, null);
  c.lastCatchUpAt -= 2000;
  f.fireTimeout(c.catchUpTimer);
  await nextTask();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].options.feedback, true, 'restore retains dialog/command-feedback resync');
});

test('a short hidden restore queues a read newer than an older in-flight catch-up', async (t) => {
  const f = fixture(t), { c } = f.controller();
  const hold = Promise.withResolvers();
  let reads = 0;
  c.fetchHistory = () => { reads++; return reads === 1 ? hold.promise : Promise.resolve(page()); };
  const first = c.catchUp('manual');
  f.visibility('hidden'); f.visibility('visible');
  assert.equal(reads, 1);
  assert.equal(c.catchUpOwed, 'resync');
  hold.resolve(page()); await first; await nextTask();
  c.lastCatchUpAt -= 2000;
  f.fireTimeout(c.catchUpTimer); await nextTask();
  assert.equal(reads, 2);
});

test('restore before the initial bundle survives opening and session close cancels its debt', async (t) => {
  const f = fixture(t), { c, fetches } = f.controller();
  const open = c.openSession('/synthetic/a');
  f.visibility('hidden'); f.visibility('visible');
  assert.equal(fetches.length, 0);
  assert.equal(c.catchUpOwed, 'resync');
  c.handleFrame({ type: 'bundle', history: page(), running: false }, c.generation, '/synthetic/a');
  await open; await nextTask();
  assert.equal(fetches.length, 1);
  f.visibility('hidden'); await c.catchUp('resync');
  c.closeSession(); f.visibility('visible'); await nextTask();
  assert.equal(fetches.length, 1, 'old conversation debt cannot refetch after closing');
  assert.equal(c.resyncPending, false);
});

test('failed restore on a healthy socket retains its error/debt and retries once without another event', async (t) => {
  const f = fixture(t), { c, store } = f.controller();
  const retry = Promise.withResolvers();
  let reads = 0;
  c.socket = { readyState: 1, send() {}, close() {} };
  store.setState({ connection: 'open' });
  c.fetchHistory = async () => {
    reads++;
    if (reads === 1) throw new Error('Synthetic history failure');
    return retry.promise;
  };
  f.visibility('hidden'); f.visibility('visible'); await nextTask();
  assert.equal(reads, 1);
  assert.equal(c.resyncPending, true);
  const errorBeforeRetry = store.getState().error;
  assert.equal(typeof errorBeforeRetry, 'string', 'the failed recovery remains visible');
  assert.equal(store.getState().connection, 'open');
  assert.notEqual(c.catchUpTimer, null);
  c.lastCatchUpAt -= 2000;
  f.fireTimeout(c.catchUpTimer); await nextTask();
  assert.equal(reads, 2);
  assert.equal(c.resyncPending, true, 'an in-flight retry is not proof of recovery');
  assert.equal(store.getState().error, errorBeforeRetry, 'retry does not suppress failure UI');
  retry.resolve(page()); await nextTask();
  assert.equal(c.resyncPending, false);
  assert.equal(store.getState().error, null);
  assert.equal(c.catchUpTimer, null);
});

test('exhausted resync retry preserves explicit failure until manual recovery, without a retry loop', async (t) => {
  const f = fixture(t), { c, store } = f.controller();
  let reads = 0, fail = true;
  c.socket = { readyState: 1, send() {}, close() {} };
  store.setState({ connection: 'open' });
  c.fetchHistory = async () => {
    reads++;
    if (fail) throw new Error('Synthetic persistent history failure');
    return page();
  };
  await c.catchUp('resync');
  c.lastCatchUpAt -= 2000;
  f.fireTimeout(c.catchUpTimer); await nextTask();
  assert.equal(reads, 2);
  assert.equal(c.catchUpTimer, null, 'one automatic retry, not an indefinitely rearmed loop');
  assert.equal(c.resyncPending, true);
  const exhaustedError = store.getState().error;
  assert.equal(typeof exhaustedError, 'string', 'exhausted recovery remains visible');
  assert.equal(store.getState().connection, 'open');
  c.recordSuccess(); // Other healthy traffic must not reset this recovery's cap.
  for (let i = 0; i < 10; i++) f.fire();
  await nextTask();
  assert.equal(reads, 2);
  assert.equal(c.catchUpTimer, null);
  assert.equal(store.getState().error, exhaustedError);
  fail = false;
  await c.reloadHistory();
  assert.equal(reads, 3);
  assert.equal(c.resyncPending, false);
  assert.equal(store.getState().error, null);
});

test('hide defers a failed resync retry; disposal and a different visit fence its queued callback', async (t) => {
  const f = fixture(t), { c } = f.controller();
  let reads = 0, fail = true;
  c.fetchHistory = async () => {
    reads++;
    if (fail) throw new Error('Synthetic history failure');
    return page();
  };
  await c.catchUp('resync');
  const stale = f.timeouts.get(c.catchUpTimer).fn;
  f.visibility('hidden');
  assert.equal(c.catchUpTimer, null);
  stale(); await nextTask();
  assert.equal(reads, 1);
  assert.equal(c.resyncPending, true);
  fail = false; c.lastCatchUpAt -= 2000;
  f.visibility('visible'); await nextTask();
  assert.equal(reads, 2);
  assert.equal(c.resyncPending, false);
  fail = true; c.lastCatchUpAt -= 2000;
  await c.catchUp('resync');
  const disposed = f.timeouts.get(c.catchUpTimer).fn;
  c.dispose(); c.resume();
  c.activeSession = '/synthetic/b';
  disposed(); await nextTask();
  assert.equal(reads, 3, 'old session/visit retry cannot read the replacement session');
  assert.equal(c.resyncPending, false);
});

test('an older successful catch-up cannot settle newer hidden restore debt', async (t) => {
  const f = fixture(t), { c } = f.controller();
  const old = Promise.withResolvers();
  let reads = 0;
  c.fetchHistory = () => { reads++; return reads === 1 ? old.promise : Promise.resolve(page()); };
  const first = c.catchUp('resync');
  f.visibility('hidden');
  old.resolve(page()); await first;
  assert.equal(c.resyncPending, true);
  c.lastCatchUpAt -= 2000;
  f.visibility('visible'); await nextTask();
  assert.equal(reads, 2);
  assert.equal(c.resyncPending, false);
});

test('ordinary catch-up failures do not gain a generic request retry policy', async (t) => {
  const f = fixture(t), { c, store } = f.controller();
  c.fetchHistory = async () => { throw new Error('Synthetic manual read failure'); };
  await c.catchUp('manual');
  assert.equal(c.resyncPending, false);
  assert.equal(c.catchUpTimer, null);
  assert.equal(typeof store.getState().error, 'string', 'the manual failure remains visible');
});

test('native push refreshes visible rows, catches up hidden gaps and coalesces hints during a read', async (t) => {
  const f = fixture(t, { native: true });
  f.f.queue.setOfflineQueueNamespace('cred-synthetic'); await f.settle();
  assert.deepEqual(f.periods(), [], 'confirmed push with a settled outbox arms no timer');
  let before = f.lists();
  f.push(); await f.settle();
  assert.equal(f.lists(), before + 1);
  f.visibility('hidden'); before = f.lists();
  f.w.nativeRows = [row('dispatching')]; f.push(); f.push(); await f.settle();
  assert.equal(f.lists(), before);
  assert.deepEqual(f.periods(), []);
  f.visibility('visible'); await f.settle();
  assert.equal(f.lists(), before + 1);
  assert.equal(f.f.queue.getSnapshot()[0].state, 'dispatching');
  before = f.lists();
  f.push(); f.w.nativeRows = [row('completed')]; f.push(); f.push();
  assert.equal(f.lists(), before + 1);
  await f.settle();
  assert.equal(f.lists(), before + 2);
  assert.equal(f.f.queue.getSnapshot()[0].state, 'completed');
  assert.deepEqual(f.periods(), []);
});

test('unfinished native rows retain a 30 s visible fallback even if a push is missed', async (t) => {
  const f = fixture(t, { native: true });
  f.w.nativeRows = [row('dispatching')];
  f.f.queue.setOfflineQueueNamespace('cred-synthetic'); await f.settle();
  assert.deepEqual(f.periods(), [30000]);
  f.visibility('hidden'); assert.deepEqual(f.periods(), []);
  f.visibility('visible'); await f.settle();
  assert.deepEqual(f.periods(), [30000]);
  f.w.nativeRows = [row('completed')]; f.fire(); await f.settle();
  assert.equal(f.f.queue.getSnapshot()[0].state, 'completed');
  assert.deepEqual(f.periods(), []);
});

test('failed push refresh on an idle supporting APK retains its fallback until success', async (t) => {
  const f = fixture(t, { native: true });
  f.f.queue.setOfflineQueueNamespace('cred-synthetic'); await f.settle();
  f.w.nativeRows = [row('dispatching')]; f.push();
  f.reply(f.w.nativeReplies[0], { ok: false, error: 'Synthetic storage failure', code: 'storage' });
  await nextTask();
  assert.deepEqual(f.periods(), [30000]);
  f.fire(); await f.settle();
  assert.equal(f.f.queue.getSnapshot()[0].state, 'dispatching');
});

test('an old APK keeps 1 s pending / 5 s idle polling until capability is confirmed', async (t) => {
  const f = fixture(t, { native: true });
  f.w.changeEvents = undefined;
  f.w.nativeRows = [row('dispatching')];
  f.f.queue.setOfflineQueueNamespace('cred-synthetic');
  assert.deepEqual(f.periods(), [1000], 'before the first reply');
  await f.settle();
  assert.deepEqual(f.periods(), [1000]);
  const before = f.lists(); f.fire(); await f.settle();
  assert.equal(f.lists(), before + 1);
  f.visibility('hidden'); assert.deepEqual(f.periods(), []);
  f.visibility('visible'); await f.settle(); assert.deepEqual(f.periods(), [1000]);
  f.w.nativeRows = [row('completed')]; f.fire(); await f.settle();
  assert.deepEqual(f.periods(), [5000]);
  f.w.changeEvents = true; f.fire(); await f.settle();
  assert.deepEqual(f.periods(), []);
  f.f.queue.setOfflineQueueNamespace('anonymous');
  f.push(); await f.settle();
  assert.deepEqual(f.periods(), [], 'signed-out pages do not poll native rows');
});

test('bridge replacement resets capability, ignores retired pushes and keeps compatibility fallback', async (t) => {
  const f = fixture(t, { native: true });
  f.f.queue.setOfflineQueueNamespace('cred-synthetic'); await f.settle();
  const retired = f.w.OmpOutbox;
  f.w.OmpOutbox = f.w.makeNativeBridge(); f.w.changeEvents = undefined;
  assert.equal(f.f.nativeOutbox.nativeChangeEventsSupported(), false);
  f.visibility('hidden'); f.visibility('visible'); await f.settle();
  assert.deepEqual(f.periods(), [5000]);
  const before = f.lists(); f.push(retired); await f.settle();
  assert.equal(f.lists(), before);
  f.w.nativeRows = [row('dispatching')]; f.fire(); await f.settle();
  assert.equal(f.f.queue.getSnapshot()[0].state, 'dispatching');
  assert.deepEqual(f.periods(), [1000]);
});

test('late pre-restore and previous-namespace lists cannot overwrite a newer snapshot', async (t) => {
  const f = fixture(t, { native: true });
  f.f.queue.setOfflineQueueNamespace('cred-a'); await f.settle();
  f.w.nativeRows = [row('dispatching', 'old')]; f.push();
  const old = f.w.nativeReplies[0];
  f.w.nativeRows = [row('completed', 'current')];
  f.f.queue.setOfflineQueueNamespace('cred-b');
  for (let i = 0; i < 20; i++) {
    await nextTask();
    for (const pending of [...f.w.nativeReplies].filter(({ call }) => call.namespace === 'cred-b')) f.reply(pending);
  }
  assert.equal(f.f.queue.getSnapshot()[0].commandId, 'current');
  f.reply(old); await f.settle();
  assert.equal(f.f.queue.getSnapshot()[0].commandId, 'current');
});

test('a push racing hydration wins even when the older first listing replies last', async (t) => {
  const f = fixture(t, { native: true });
  f.f.queue.setOfflineQueueNamespace('cred-synthetic');
  const initial = f.w.nativeReplies[0];
  f.w.nativeRows = [row('completed', 'newer')]; f.push();
  const newer = f.w.nativeReplies.find((pending) => pending !== initial && pending.call.op === 'list');
  assert.ok(newer);
  f.reply(newer); await nextTask();
  assert.equal(f.f.queue.getSnapshot()[0].commandId, 'newer');
  f.reply(initial); await f.settle();
  assert.equal(f.f.queue.getSnapshot()[0].commandId, 'newer');
  assert.deepEqual(f.periods(), []);
});

test('native change subscriptions dispose without disturbing other listeners or request replies', async (t) => {
  const f = fixture(t, { native: true });
  let a = 0, b = 0;
  const stopA = f.f.nativeOutbox.subscribeNativeOutboxChanges(() => a++);
  const stopB = f.f.nativeOutbox.subscribeNativeOutboxChanges(() => b++);
  stopA(); f.push();
  assert.deepEqual([a, b], [0, 1]);
  const request = f.f.nativeOutbox.nativeOutboxRequest('list', 'cred-synthetic');
  await f.settle(); await request;
  assert.deepEqual([a, b], [0, 1], 'request replies are not change hints');
  stopB(); f.push(); assert.deepEqual([a, b], [0, 1]);
});
