import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setImmediate as settleTask } from 'node:timers/promises';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const A = '/synthetic/project/chat A.jsonl';
const B = '/synthetic/project/chat B.jsonl';

// The real hook, store and read-state markers; only the screen is a probe.
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {useOpenChatReadState} from ${JSON.stringify(resolve(root, 'web/src/app/read-state.ts'))};
import {hasUnread, markSeen} from ${JSON.stringify(resolve(root, 'web/src/app/session-format.ts'))};
function Probe({store, open}) { useOpenChatReadState(store, open); return null; }
window.fixture = {act, hasUnread, markSeen, store: createOmpStore(), mount() {
  const reactRoot = createRoot(document.getElementById('root'));
  return { render: (props) => reactRoot.render(h(Probe, props)), unmount: () => reactRoot.unmount() };
}};
`);

function setup() {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  let visibility = 'visible';
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => visibility });
  const mounted = f.mount();
  const act = (fn) => f.act(async () => { fn(); await settleTask(); });
  const entry = (id, role = 'assistant') => ({ id: `ui:${id}`, role, text: id, parts: [], sourceEntryId: id });
  return {
    w, f, mounted, act, entry,
    show: (open) => act(() => mounted.render({ store: f.store, open })),
    state: (patch) => act(() => f.store.setState(patch)),
    setVisible: (next) => act(() => { visibility = next ? 'visible' : 'hidden'; w.document.dispatchEvent(new w.Event('visibilitychange')); }),
    unread: (path, revision, latestEntryId) => f.hasUnread({ path, revision: String(revision), latestEntryId }),
    marker: (path) => w.localStorage.getItem('omp-seen:' + path),
    close: async () => { await act(() => mounted.unmount()); dom.close(); },
  };
}

test('a reply watched in the open chat stays read after Back, even before the listing catches up', async () => {
  const t = setup();
  try {
    await t.state({ sessionPath: A, sessions: [{ path: A, revision: '1', latestEntryId: 'u1' }], messages: [t.entry('u1', 'user')] });
    await t.show(true);
    assert.equal(t.marker(A), 'r:1;e:u1');
    // The listing is not polled while a chat is open: the reply arrives only in the transcript.
    await t.state({ messages: [t.entry('u1', 'user'), t.entry('a1')] });
    await t.show(false);
    assert.equal(t.unread(A, 2, 'a1'), false, 'the reply the user watched is not unread');
    // A later reply, after the chat closed, is.
    await t.state({ messages: [t.entry('u1', 'user'), t.entry('a1'), t.entry('a2')] });
    assert.equal(t.unread(A, 3, 'a2'), true);
  } finally { await t.close(); }
});

test('opening by any path marks the chat read: notification, Recent and branch all end at the store session', async () => {
  const t = setup();
  try {
    t.w.localStorage.setItem('omp-seen:' + A, 'r:1');
    t.w.localStorage.setItem('omp-seen:' + B, 'r:4');
    await t.state({ sessions: [{ path: A, revision: '2', latestEntryId: 'a2' }, { path: B, revision: '5', latestEntryId: 'b5' }] });
    assert.equal(t.unread(A, 2, 'a2'), true);
    assert.equal(t.unread(B, 5, 'b5'), true);
    // No list tap: the deep link sets the store's session directly.
    await t.show(true);
    await t.state({ sessionPath: A, messages: [t.entry('a2')] });
    assert.equal(t.unread(A, 2, 'a2'), false);
    // Switching inside the chat (Recent drawer) hands ownership to the new chat.
    await t.state({ sessionPath: B, messages: [t.entry('b5')] });
    assert.equal(t.unread(B, 5, 'b5'), false);
  } finally { await t.close(); }
});

test('a chat created on the phone gets a marker, so later replies show a dot', async () => {
  const t = setup();
  try {
    await t.show(true);
    await t.state({ sessionPath: B, sessions: [], messages: [] });
    assert.equal(t.marker(B), 'r:');
    await t.state({ messages: [t.entry('u1', 'user'), t.entry('a1')] });
    await t.show(false);
    assert.equal(t.unread(B, 9, 'a1'), false);
    assert.equal(t.unread(B, 10, 'a2'), true);
  } finally { await t.close(); }
});

test('a chat in a hidden app is not being read', async () => {
  const t = setup();
  try {
    await t.state({ sessionPath: A, sessions: [{ path: A, revision: '1', latestEntryId: 'a1' }], messages: [t.entry('a1')] });
    await t.show(true);
    await t.setVisible(false);
    await t.state({ messages: [t.entry('a1'), t.entry('a2')] });
    assert.equal(t.unread(A, 2, 'a2'), true, 'the reply arrived while the app was in the background');
    await t.setVisible(true);
    assert.equal(t.unread(A, 2, 'a2'), false);
  } finally { await t.close(); }
});

test('markers keep the revision rule and older marker shapes', async () => {
  const t = setup();
  try {
    t.w.localStorage.setItem('omp-seen:' + A, 'r:7');
    assert.equal(t.unread(A, 7, 'x'), false);
    assert.equal(t.unread(A, 8, 'x'), true);
    t.w.localStorage.setItem('omp-seen:' + A, '12345');
    assert.equal(t.unread(A, 8, 'x'), false, 'a legacy byte-size marker reads as seen');
    t.w.localStorage.removeItem('omp-seen:' + A);
    assert.equal(t.unread(A, 8, 'x'), false, 'never opened is not unread');
    // Unknown revision keeps the stored one and records the entries.
    t.w.localStorage.setItem('omp-seen:' + A, 'r:7');
    t.f.markSeen(A, undefined, ['e1', 'e2']);
    assert.equal(t.marker(A), 'r:7;e:e1,e2');
    const many = Array.from({ length: 12 }, (_, i) => `e${i}`);
    t.f.markSeen(A, '9', many);
    assert.equal(t.marker(A), `r:9;e:${many.slice(-8).join(',')}`, 'only the newest entries are kept');
  } finally { await t.close(); }
});

test('revisions above 2^53 stay exact, and a marker an older app rounded still reads as seen', async () => {
  const t = setup();
  try {
    // u64 content hashes: as JSON numbers both rounded to 4059089593305379000.
    t.f.markSeen(A, '4059089593305379123');
    assert.equal(t.unread(A, '4059089593305379123', 'x'), false);
    assert.equal(t.unread(A, '4059089593305379124', 'x'), true, 'a new reply is not hidden by rounding');
    t.w.localStorage.setItem('omp-seen:' + A, `r:${Number('4059089593305379123')}`);
    assert.equal(t.unread(A, '4059089593305379123', 'x'), false, 'no unread burst after the upgrade');
  } finally { await t.close(); }
});
