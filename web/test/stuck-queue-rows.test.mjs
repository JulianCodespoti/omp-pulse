import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Rows that stayed in the composer's queue bar after their messages were
// answered: a transcript row stamped by a slow computer clock never matched
// the phone's send time, and the daemon's receipt (settled elsewhere) used to
// say "Sending…" for messages the computer already had. Real projection and
// real bar; only the network is blocked.
const require = createRequire(resolve(root, 'web/package.json'));
const source = path => JSON.stringify(resolve(root, 'web/src', path));
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {QueuedMessagesBar} from ${source('app/chat/QueuedMessagesBar.tsx')};
import {projectPendingIntents} from ${source('runtime/browser-pending-presentation.ts')};
import {createOmpStore} from ${source('runtime/omp-store.ts')};
const path='/synthetic/stuck';
const store=createOmpStore();store.setState({sessionPath:path});
const controller={getStore:()=>store};
window.fixture={act,projectPendingIntents,
 mount(pending){const r=createRoot(document.getElementById('root'));
  const render=next=>r.render(h(QueuedMessagesBar,{controller,pending:next}));render(pending);return {render,unmount:()=>r.unmount()};}};
`);

const path = '/synthetic/stuck';
const NOW = 1_700_000_000_000;
const entry = (id, state, extra = {}) => ({
  id, commandId: id, sessionPath: path, text: `message ${id}`, state, imageCount: 0, imageBytes: 0,
  droppedImages: false, createdAt: NOW, updatedAt: NOW, ...extra,
});
const row = (id, text, at) => ({
  id: `row-${id}`, sourceEntryId: `row-${id}`, role: 'user', text, parts: [{ kind: 'text', text }], createdAt: new Date(at),
});
const project = (w, messages, entries, clockShift) =>
  w.fixture.projectPendingIntents(messages, entries, path, 'scope', {}, 'native', undefined, clockShift);
const pendingIds = (w, ...args) => Array.from(project(w, ...args).pending, e => e.commandId).join(',');

test('a transcript row stamped by a slow computer clock still confirms the delivered message', t => {
  const dom = createDomFixture(code); t.after(() => dom.close());
  const w = dom.window;
  const sent = entry('c1', 'running', { text: 'Continue', createdAt: NOW });
  // The computer runs five minutes behind: its row for this very send reads as
  // earlier than the phone's send time.
  const slow = row('1', 'Continue', NOW - 5 * 60_000 + 2_000);
  assert.equal(pendingIds(w, [slow], [sent], 0), 'c1', 'the raw comparison sees an older row');
  assert.equal(pendingIds(w, [slow], [sent], 5 * 60_000), '', 'shifted onto the phone clock it is the echo');
  // Same shift, but the row really is older than the send: it is somebody
  // else's, and must not claim the newer send.
  const genuinelyOlder = row('0', 'Continue', NOW - 5 * 60_000 - 10 * 60_000);
  assert.equal(pendingIds(w, [genuinelyOlder], [sent], 5 * 60_000), 'c1');
});

test('a repeated prompt: the newer send is not confirmed by the older twin, even on a skewed clock', t => {
  const dom = createDomFixture(code); t.after(() => dom.close());
  const w = dom.window, shift = 120_000;
  const older = entry('old', 'completed', { text: 'Continue', createdAt: NOW - 600_000 });
  const newer = entry('new', 'running', { text: 'Continue', createdAt: NOW });
  const oldRow = row('old', 'Continue', NOW - 600_000 - shift + 1_000);
  assert.equal(pendingIds(w, [oldRow], [older, newer], shift), 'new');
  const newRow = row('new', 'Continue', NOW - shift + 1_000);
  assert.equal(pendingIds(w, [oldRow, newRow], [older, newer], shift), '');
});

async function mountBar(t, entries) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  let mounted;
  await f.act(async () => { mounted = f.mount(entries); });
  t.after(async () => { try { await f.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const doc = w.document;
  return {
    w, f,
    rows: () => [...doc.querySelectorAll('[data-testid="queued-message"]')],
    labels: () => [...doc.querySelectorAll('[data-testid="queued-message"] [role="status"]')].map(s => s.textContent),
    summary: () => doc.querySelector('[data-testid="queued-delivered-summary"]'),
    text: () => doc.querySelector('[data-testid="queued-messages"]')?.textContent ?? '',
    click: element => f.act(async () => { element.click(); }),
  };
}

test('a message the computer already has never says Sending…', async t => {
  const busy = { receipt: { code: 'agents_busy', error: 'Waiting for a free agent.' } };
  for (const [state, extra, label] of [
    ['accepted', {}, 'Queued'],
    ['received', {}, 'Queued'],
    ['running', {}, 'Delivered'],
    ['accepted', busy, 'Waiting for a free agent'],
    ['dispatching', { createdAt: Date.now() }, 'Sending…'],
  ]) {
    const f = await mountBar(t, [entry('c1', state, extra)]);
    assert.deepEqual(f.labels(), [label], state);
    assert.equal(f.summary(), null, 'one row is not worth a summary');
  }
});

test('delivered messages without a transcript row collapse to one expandable line', async t => {
  const delivered = ['accepted', 'received', 'running', 'running'].map((state, index) =>
    entry(`d${index}`, state, { createdAt: NOW + index }));
  const failed = entry('f1', 'failed', { createdAt: NOW + 10, error: 'agent_rejected: nope' });
  const f = await mountBar(t, [...delivered, failed]);
  assert.equal(f.summary().textContent, '4 messages delivered');
  // The summary and the one failed row: two lines, not five.
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].getAttribute('data-command-id'), 'f1', 'actionable rows are never folded away');
  assert.equal(f.summary().querySelector('button').getAttribute('aria-expanded'), 'false');
  await f.click(f.summary().querySelector('button'));
  assert.equal(f.summary().querySelector('button').getAttribute('aria-expanded'), 'true');
  assert.equal(f.rows().length, 5);
  assert.deepEqual(f.labels().slice(0, 4), ['Queued', 'Queued', 'Delivered', 'Delivered']);
  await f.click(f.summary().querySelector('button'));
  assert.equal(f.rows().length, 1);
});

test('a held send keeps its own row beside the delivered summary', async t => {
  const held = entry('h1', 'accepted', { createdAt: NOW + 5, receipt: { code: 'agents_busy', error: 'Waiting' } });
  const delivered = [entry('d0', 'running'), entry('d1', 'received', { createdAt: NOW + 1 })];
  const f = await mountBar(t, [...delivered, held]);
  assert.equal(f.summary().textContent, '2 messages delivered');
  assert.deepEqual(f.labels(), ['Waiting for a free agent']);
});
