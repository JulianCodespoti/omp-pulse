import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Production component/store in a synthetic DOM. Operation counts, not timing,
// browser layout, frame rates or live-session performance claims.
const code = await bundleDomFixture(`
import { createElement as h, act, StrictMode } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { useLiveTurn } from ${JSON.stringify(resolve(root, 'web/src/app/chat/TurnStatus.tsx'))};
import { TurnFooter } from ${JSON.stringify(resolve(root, 'web/src/app/parts/TurnFooter.tsx'))};
import { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import { createLastUserMessageAtSelector } from ${JSON.stringify(resolve(root, 'web/src/app/chat/turn-status-selectors.ts'))};
// The live turn exactly as ChatScreen composes it: useLiveTurn feeding a running TurnFooter.
function LiveFooter({ controller }) {
  const live = useLiveTurn(controller);
  return live ? h(TurnFooter, { running: true, startedAt: live.startedAt, currentStep: live.currentStep, action: live.action }) : null;
}
window.fixture = { act, createOmpStore, createLastUserMessageAtSelector, mount(store, strict = false) {
  const r = createRoot(document.getElementById('root'));
  const controller = { getStore: () => store };
  const render = () => r.render(strict ? h(StrictMode, null, h(LiveFooter, { controller })) : h(LiveFooter, { controller }));
  render(); return { render, unmount: () => r.unmount() };
} };
`);

function message(id, role, createdAt) {
  return Object.freeze({ id, role, createdAt, text: '', parts: Object.freeze([]) });
}
function instrument(messages) {
  let reads = 0;
  return { messages: Object.freeze(messages.map(m => new Proxy(m, {
    get(target, key, receiver) { if (key === 'role') reads++; return Reflect.get(target, key, receiver); },
  }))), count: () => reads, reset: () => { reads = 0; } };
}
async function fixture(t, messages, strict = false) {
  const dom = createDomFixture(code), w = dom.window;
  const { act, createOmpStore } = w.fixture, store = createOmpStore();
  const intervals = new Map(); let sequence = 0;
  // Fixed clock and manually driven ticks keep status assertions deterministic.
  w.Date.now = () => 1_000_000;
  w.setInterval = fn => { const id = ++sequence; intervals.set(id, fn); return id; };
  w.clearInterval = id => intervals.delete(id);
  const stream = text => Object.freeze({ id: 'stream', role: 'assistant', createdAt: new w.Date(990_000), text: '', parts: Object.freeze([{ kind: 'thinking', text }]) });
  store.setState({ sessionPath: '/synthetic/a', messages, connection: 'open', agentWorking: true,
    activity: null });
  store.getState().setStreamingMessage(stream('initial reasoning'));
  let mounted;
  await act(async () => { mounted = w.fixture.mount(store, strict); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); assert.equal(intervals.size, 0); } finally { dom.close(); } });
  const update = patch => act(async () => store.setState(patch));
  const status = () => w.document.querySelector('[data-testid="turn-footer"][data-state="running"]');
  const elapsed = () => status()?.querySelector('[data-testid="turn-elapsed"]')?.textContent ?? null;
  // What the footer says the agent is doing: its text without the trailing clock.
  const step = () => { const el = status(); return el ? el.textContent.slice(0, el.textContent.length - (elapsed() ?? '').length) : null; };
  return { w, store, act, update, stream, intervals, status, elapsed, step,
    tick: () => act(async () => { for (const fn of intervals.values()) fn(); }),
    remount: () => act(async () => { mounted.unmount(); mounted = w.fixture.mount(store, strict); }) };
}

for (const strict of [false, true]) {
  test(`unchanged long history has zero timestamp-role reads across 100 streaming notifications (StrictMode=${strict})`, async t => {
    const history = instrument([message('user', 'user', new Date(980_000)),
      ...Array.from({ length: 500 }, (_, i) => message('assistant-' + i, 'assistant'))]);
    const f = await fixture(t, history.messages, strict);
    assert.equal(f.step(), 'Thinking…');
    assert.equal(f.elapsed(), '20s');
    history.reset();
    for (let i = 0; i < 100; i++) await f.act(async () => f.store.getState().setStreamingMessage(f.stream('reasoning ' + i)));
    assert.equal(f.store.getState().messages, history.messages);
    t.diagnostic(JSON.stringify({ metric: 'historical-role-reads-after-warmup', messages: 501, notifications: 100, strict, reads: history.count() }));
    assert.equal(history.count(), 0);
    assert.equal(f.step(), 'Thinking…');
    assert.equal(f.elapsed(), '20s');
    assert.equal(f.store.getState().streamingMessage.parts[0].text, 'reasoning 99');
  });
}

function selectorFixture(t) {
  const dom = createDomFixture(code);
  t.after(() => { assert.deepEqual(dom.blocked, []); dom.close(); });
  return dom.window.fixture;
}

test('selector caches valid, null and zero results without searching past the newest user', t => {
  const { createLastUserMessageAtSelector } = selectorFixture(t), select = createLastUserMessageAtSelector();
  for (const createdAt of [undefined, new Date(NaN), new Date(0), new Date(980_000)]) {
    const history = instrument([message('old-user', 'user', new Date(970_000)),
      message('new-user', 'user', createdAt), message('a', 'assistant')]);
    const expected = createdAt !== undefined && Number.isFinite(createdAt.getTime()) ? createdAt.getTime() : null;
    assert.equal(select({ messages: history.messages }), expected);
    assert.equal(history.count(), 2, 'stop at newest user even when timestamp is unavailable');
    history.reset();
    for (let i = 0; i < 100; i++) assert.equal(select({ messages: history.messages, partialLine: String(i) }), expected);
    assert.equal(history.count(), 0);
  }
  for (const messages of [[], [message('assistant-only', 'assistant')]]) {
    const history = instrument(messages);
    assert.equal(select({ messages: history.messages }) === null, true);
    history.reset();
    assert.equal(select({ messages: history.messages }) === null, true);
    assert.equal(history.count(), 0, 'null is a cached result');
  }
});

test('same-length replacement and changed timestamp invalidate; a single-entry cache does not retain old histories', t => {
  const { createLastUserMessageAtSelector } = selectorFixture(t), select = createLastUserMessageAtSelector();
  const first = instrument([message('same-id', 'user', new Date(980_000))]);
  const second = instrument([message('same-id', 'user', new Date(990_000))]);
  assert.equal(select({ messages: first.messages }), 980_000);
  assert.equal(select({ messages: second.messages }), 990_000);
  assert.equal(second.count(), 1);
  first.reset();
  assert.equal(select({ messages: first.messages }), 980_000);
  assert.equal(first.count(), 1, 'returning to older history recomputes rather than retaining a multi-history cache');
});

test('separate mounted consumers own separate caches', t => {
  const { createLastUserMessageAtSelector } = selectorFixture(t);
  const a = createLastUserMessageAtSelector(), b = createLastUserMessageAtSelector();
  const history = instrument([message('user', 'user', new Date(980_000))]);
  assert.equal(a({ messages: history.messages }), 980_000);
  assert.equal(b({ messages: history.messages }), 980_000);
  assert.equal(history.count(), 2);
  history.reset();
  a({ messages: [] });
  assert.equal(b({ messages: history.messages }), 980_000);
  assert.equal(history.count(), 0, 'one consumer cannot evict another consumer');
});

test('real history actions replace snapshots and keep the mounted timestamp truthful', async t => {
  const user = message('user', 'user', new Date(980_000));
  const f = await fixture(t, Object.freeze([user, message('a', 'assistant')]));
  const duration = () => f.elapsed();
  const change = async (run, expected) => {
    const before = f.store.getState().messages, beforeEntries = [...before];
    Object.freeze(before);
    await f.act(async () => run(f.store.getState()));
    const after = f.store.getState().messages;
    assert.notEqual(after, before, 'history edits publish replacement array identities');
    assert.deepEqual(Array.from(before), beforeEntries, 'old array contents remain unchanged');
    assert.equal(duration(), expected);
  };
  // The live clock is a Timer metric in short units (`20s`, `1m 04s`).
  assert.equal(duration(), '20s');
  await change(s => s.setHistory([message('user', 'user', new Date(990_000)), message('a', 'assistant')]), '10s');
  await change(s => s.mergeMessages([message('user', 'user', new Date(995_000))]), '5s');
  await change(s => s.prependMessages([message('older', 'user', new Date(900_000))]), '5s');
  await change(s => s.appendMessage(message('newest', 'user', new Date(997_000))), '3s');
  await change(s => s.trimWindow(3, false), '5s');
  await change(s => s.trimWindow(1, true), null); // no loaded user: the clock disappears rather than guessing
  await change(s => s.prependMessages([message('restored', 'user', new Date(990_000))]), '10s');
  await change(s => s.setHistory([]), null);
  await change(s => s.setHistory([message('different', 'user', new Date(980_000))]), '20s');
  await f.act(async () => f.store.getState().beginSession('/synthetic/b'));
  assert.equal(f.status() === null, true, 'session switch clears active state and old history');
  assert.equal(f.store.getState().messages.length, 0);
  await f.act(async () => {
    const s = f.store.getState();
    s.setHistory([message('session-b', 'user', new Date(999_000))]);
    s.setStreamingMessage(f.stream('new session reasoning'));
    f.store.setState({ connection: 'open', agentWorking: true, activity: null });
  });
  assert.equal(duration(), '1s');
  await f.remount();
  assert.equal(duration(), '1s');
});

test('stream commits and tool results publish immutable transcript snapshots', t => {
  const { createOmpStore, createLastUserMessageAtSelector } = selectorFixture(t), store = createOmpStore();
  const select = createLastUserMessageAtSelector();
  const user = message('u', 'user', new Date(980_000));
  const tool = Object.freeze({ ...message('a', 'assistant'), parts: Object.freeze([
    Object.freeze({ kind: 'tool', callId: 'call', name: 'read', args: { path: 'synthetic.txt' }, state: 'running' }),
  ]) });
  store.getState().setHistory([user, tool]);
  const before = store.getState().messages; Object.freeze(before);
  assert.equal(select(store.getState()), 980_000);
  store.getState().applyResults([{ callId: 'call', name: 'read', output: 'exact result\n', isError: false, pruned: false }]);
  assert.notEqual(store.getState().messages, before);
  assert.equal(before[1].parts[0].state, 'running');
  assert.equal(store.getState().messages[1].parts[0].output, 'exact result\n');
  assert.equal(select(store.getState()), 980_000);
  const beforeCommit = store.getState().messages; Object.freeze(beforeCommit);
  store.getState().setStreamingMessage(message('new-a', 'assistant', new Date(990_000)));
  store.getState().commitStreamingMessage();
  assert.notEqual(store.getState().messages, beforeCommit);
  assert.equal(beforeCommit.length, 2);
  assert.equal(select(store.getState()), 980_000);
});

test('live reasoning, tools, reconnecting and idle truth remain live while timestamp cache is warm', async t => {
  const f = await fixture(t, Object.freeze([message('u', 'user', new Date(980_000))]));
  assert.equal(f.step(), 'Thinking…');
  await f.update({ streamingMessage: { ...f.stream(''), parts: [{ kind: 'text', text: 'Exact café\n' }] } });
  assert.equal(f.step(), 'Working…');
  assert.equal(f.store.getState().streamingMessage.parts[0].text, 'Exact café\n');
  await f.update({ streamingMessage: { ...f.stream(''), parts: [
    { kind: 'tool', callId: 'call', name: 'read', args: { path: 'synthetic.txt' }, intent: 'Inspect synthetic file', state: 'running' },
  ] } });
  assert.equal(f.step(), 'Inspect synthetic file…');
  assert.equal(f.elapsed(), '20s');
  // Uncertain state is never reported as working: the offline notice owns that moment.
  await f.update({ sessionAuthorities: { '/synthetic/a': { turn: 'running', connection: 'reconnecting', activity: null } }, connection: 'reconnecting' });
  assert.equal(f.status() === null, true);
  await f.update({ sessionAuthorities: { '/synthetic/a': { turn: 'running', connection: 'connected', activity: null } }, connection: 'open' });
  assert.equal(f.step(), 'Inspect synthetic file…');
  assert.equal(f.elapsed(), '20s');
  await f.update({ sessionAuthorities: {}, connection: 'open', agentWorking: false, streamingMessage: null });
  assert.equal(f.status() === null, true);
});

test('first-frame markdown ownership replaces history; further stream-only updates retain it', t => {
  const { createOmpStore, createLastUserMessageAtSelector } = selectorFixture(t), store = createOmpStore();
  const select = createLastUserMessageAtSelector();
  store.getState().setHistory([message('u', 'user', new Date(980_000)), message('a', 'assistant')]);
  const before = store.getState().messages; Object.freeze(before);
  assert.equal(select(store.getState()), 980_000);
  store.getState().setStreamingMessage(message('a', 'assistant'));
  const promoted = store.getState().messages;
  assert.notEqual(promoted, before);
  assert.equal(before[1].eagerMarkdown, undefined);
  assert.equal(promoted[1].eagerMarkdown, true);
  assert.equal(select(store.getState()), 980_000);
  store.getState().setStreamingMessage({ ...message('a', 'assistant'), text: 'exact streamed text' });
  assert.equal(store.getState().messages, promoted);
  assert.equal(select(store.getState()), 980_000);
});
