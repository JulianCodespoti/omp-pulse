import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// The compaction pill above the composer: when it offers, how a dismissal
// holds, and that a compaction is visible from the tap to the figure it
// freed. omp sends no events for a requested compaction, so the running state
// exists only for the life of the request. Synthetic store and fetch; no daemon.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { CompactPill, useCompaction, useCompactOffer } from ${JSON.stringify(resolve(root, 'web/src/app/chat/CompactPill.tsx'))};
import { useStoreValue } from ${JSON.stringify(resolve(root, 'web/src/app/store-hooks.ts'))};
import { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
function Probe({ store }) {
  const path = useStoreValue(store, (s) => s.sessionPath);
  const busy = useStoreValue(store, (s) => s.agentWorking);
  const compaction = useCompaction(store, path);
  const offer = useCompactOffer(store, path, busy || compaction.phase !== null);
  window.runCompact = compaction.run;
  window.compactPhase = compaction.phase;
  return compaction.phase || offer ? h(CompactPill, { phase: compaction.phase, offer, onCompact: () => void compaction.run().catch(() => {}) }) : null;
}
window.fixture = { act, createOmpStore, mount(store) {
  const r = createRoot(document.getElementById('root'));
  r.render(h(Probe, { store }));
  return { unmount: () => r.unmount() };
} };
`);

async function pill(t, state = {}) {
  const dom = createDomFixture(code);
  const w = dom.window, f = w.fixture;
  // Only the result's fold-away and the elapsed clock are long timers; React's
  // own scheduling runs on zero-delay timeouts and must stay real.
  const timers = new Map();
  let nextTimer = -1;
  const realTimeout = w.setTimeout.bind(w), realClear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...rest) => {
    if (ms < 1000) return realTimeout(fn, ms, ...rest);
    const id = nextTimer--;
    timers.set(id, () => fn(...rest));
    return id;
  };
  w.clearTimeout = id => { if (!timers.delete(id)) realClear(id); };
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  const calls = [];
  const replies = [];
  w.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.command);
    const next = replies.shift();
    if (!next) throw new Error(`unexpected ${body.command}`);
    return next.then((json) => ({ ok: true, status: 200, json: async () => json }));
  };
  const reply = () => { let settle; replies.push(new Promise((r) => { settle = r; })); return settle; };
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/s/a', agentWorking: false, sessionModel: { model: 'm', contextWindow: 1000, ctxPercent: 45 }, ...state });
  let mounted;
  await f.act(async () => { mounted = f.mount(store); });
  t.after(async () => { try { await f.act(async () => mounted.unmount()); } finally { dom.close(); } });
  const q = (sel) => w.document.querySelector(sel);
  return {
    store, calls, reply,
    phase: () => w.compactPhase,
    run: (instructions) => f.act(async () => { void w.runCompact(instructions); }),
    remount: () => f.act(async () => { mounted.unmount(); mounted = f.mount(store); }),
    state: () => q('[data-testid="compact-pill"]')?.getAttribute('data-state') ?? null,
    text: () => q('[data-testid="compact-pill"]')?.textContent ?? '',
    set: (patch) => f.act(async () => store.setState(patch)),
    live: (ctxPercent) => f.act(async () => store.setState({ sessionModel: { ...store.getState().sessionModel, ctxPercent } })),
    click: (sel) => f.act(async () => q(sel).click()),
    flush: () => f.act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => realTimeout(r, 0)); }),
    expire: () => f.act(async () => { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); }),
  };
}

test('offers from 40% on an idle turn, and a dismissal holds until ten more points', async t => {
  const p = await pill(t, { sessionModel: { model: 'm', contextWindow: 1000, ctxPercent: 35 } });
  assert.equal(p.state(), null, 'below 40%: nothing');
  await p.live(45);
  assert.equal(p.state(), 'offer');
  assert.ok(p.text().includes('Context 45% full'));
  await p.set({ agentWorking: true });
  assert.equal(p.state(), null, 'compacting aborts a turn, so no offer mid-turn');
  await p.set({ agentWorking: false });
  await p.click('[data-testid="compact-pill-dismiss"]');
  assert.equal(p.state(), null);
  await p.live(49);
  assert.equal(p.state(), null, 'same band stays dismissed');
  await p.live(51);
  assert.equal(p.state(), 'offer', 'the next band offers again');
});

test('a tapped compaction shows while it runs, then the drop it made', async t => {
  const p = await pill(t);
  const compact = p.reply();
  await p.click('[data-testid="compact-pill-run"]');
  assert.equal(p.state(), 'compacting', 'visible for the whole wait, not after');
  assert.ok(p.text().includes('Compacting context'));
  const state = p.reply();
  compact({ ok: true, data: { tokensBefore: 450 } });
  state({ ok: true, data: { contextUsage: { tokens: 90, contextWindow: 1000, percent: 9 } } });
  await p.flush();
  assert.deepEqual(p.calls, ['compact', 'get_state']);
  assert.equal(p.state(), 'done');
  assert.ok(p.text().includes('45% → 9%'), p.text());
  await p.expire();
  assert.equal(p.state(), null, 'the result folds away and 9% offers nothing');
});

test('a session too small to compact says so instead of failing', async t => {
  const p = await pill(t);
  const compact = p.reply();
  await p.click('[data-testid="compact-pill-run"]');
  compact({ ok: false, error: 'Nothing to compact (session too small)' });
  await p.flush();
  assert.equal(p.state(), 'refused');
  assert.ok(p.text().includes('Nothing to compact'));
});

test('a request that times out keeps compacting and settles when the fill drops', async t => {
  const p = await pill(t);
  const compact = p.reply();
  await p.click('[data-testid="compact-pill-run"]');
  compact({ ok: false, error: 'rpc compact timed out after 30000ms' });
  await p.flush();
  assert.equal(p.state(), 'compacting', 'omp is still summarising: no failure yet');
  p.reply()({ ok: true, data: { contextUsage: { tokens: 450, contextWindow: 1000, percent: 45 } } });
  await p.expire();
  await p.flush();
  assert.equal(p.state(), 'compacting', 'an unchanged fill is still the old history');
  p.reply()({ ok: true, data: { contextUsage: { tokens: 90, contextWindow: 1000, percent: 9 } } });
  await p.expire();
  await p.flush();
  assert.deepEqual(p.calls, ['compact', 'get_state', 'get_state']);
  assert.equal(p.state(), 'done');
  assert.ok(p.text().includes('45% → 9%'), p.text());
});

test('omp’s own compaction shows too and settles to the new fill', async t => {
  const p = await pill(t, { sessionModel: { model: 'm', contextWindow: 1000, ctxPercent: 80 } });
  await p.set({ agentWorking: true });
  await p.set({ compacting: { reason: 'threshold' } });
  assert.equal(p.state(), 'compacting', 'mid-turn auto-compaction is shown');
  const state = p.reply();
  await p.set({ compacting: null });
  state({ ok: true, data: { contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 } } });
  await p.flush();
  assert.equal(p.state(), 'done');
  assert.ok(p.text().includes('80% → 12%'), p.text());
});

test('without a live reading the pre-summary fill never re-offers until the next reply', async t => {
  const reply = (id, promptTokens) => ({ id, role: 'assistant', text: 'ok', parts: [], contextSnapshot: { promptTokens } });
  const p = await pill(t, { sessionModel: { model: 'm', contextWindow: 1000 }, messages: [reply('r1', 600)] });
  assert.equal(p.state(), 'offer', 'derived 60% from the newest reply');
  const compact = p.reply();
  await p.click('[data-testid="compact-pill-run"]');
  const state = p.reply();
  compact({ ok: true, data: {} });
  state({ ok: true, data: { source: 'file' } });
  await p.flush();
  assert.equal(p.state(), 'done');
  assert.equal(p.text().includes('→'), false, 'no invented figure');
  await p.expire();
  assert.equal(p.state(), null, 'the stale 60% does not offer again');
  await p.set({ messages: [reply('r1', 600), reply('r2', 450)] });
  assert.equal(p.state(), 'offer', 'a new reply is a real reading');
});

test('focused and bare calls in the same event share the pending mutation and uncertain outcome', async t => {
  const p = await pill(t);
  const compact = p.reply();
  await p.run('Preserve the constraints');
  await p.run();
  assert.deepEqual(p.calls, ['compact']);
  compact({ ok: false, error: 'Network request failed to fetch' });
  await p.flush();
  assert.equal(p.phase().kind, 'uncertain');
  await p.run('Another focus must not duplicate it');
  assert.deepEqual(p.calls, ['compact']);
  p.reply()({ ok: true, data: { contextUsage: { percent: 0, tokens: 0 } } });
  await p.expire();
  await p.flush();
  assert.equal(p.phase().kind, 'done');
  assert.equal(p.phase().after, 0);
});

test('an uncertain compaction survives hook unmount and resumes read-only reconciliation', async t => {
  const p = await pill(t);
  const compact = p.reply();
  await p.run();
  compact({ ok: false, error: 'Timed out' });
  await p.flush();
  await p.remount();
  assert.equal(p.phase().kind, 'uncertain');
  await p.run();
  assert.deepEqual(p.calls, ['compact']);
  p.reply()({ ok: true, data: { contextUsage: { percent: 5 } } });
  await p.expire();
  await p.flush();
  assert.equal(p.phase().kind, 'done');
  assert.equal(p.store.getState().sessionModel.ctxPercent, 5);
});

test('without initial context data a lost acknowledgement remains uncertain until observed compaction ends', async t => {
  const p = await pill(t, { sessionModel: { model: 'm' } });
  const compact = p.reply();
  await p.run('Focused without a context meter');
  compact({ ok: false, error: 'Timed out' });
  await p.flush();
  assert.equal(p.phase().kind, 'uncertain');
  p.reply()({ ok: true, data: { isCompacting: true } });
  await p.expire();
  await p.flush();
  await p.run();
  assert.deepEqual(p.calls, ['compact', 'get_state']);
  p.reply()({ ok: true, data: { isCompacting: false, contextUsage: { percent: 6 } } });
  await p.expire();
  await p.flush();
  assert.equal(p.phase().kind, 'done');
  assert.equal(p.phase().before, null);
  assert.equal(p.phase().after, 6);
});

test('a real failure is distinct from uncertainty and does not poll or automatically retry', async t => {
  const p = await pill(t);
  const compact = p.reply();
  await p.run('Focus');
  compact({ ok: false, error: 'Provider refused the compaction request' });
  await p.flush();
  assert.equal(p.phase().kind, 'failed');
  await p.expire();
  await p.flush();
  assert.deepEqual(p.calls, ['compact']);
});
