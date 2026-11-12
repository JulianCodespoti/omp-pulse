import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Run status events: omp's retry backoff, auto-compaction and live
// model/thinking events, from the controller's event switch through the store
// to the live turn footer's state (useLiveTurn) and the transcript's retry
// row (RetryNotice), plus the transcript's model-switch divider. Synthetic
// frames and a synthetic DOM only; no daemon, socket or model call.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { useLiveTurn } from ${JSON.stringify(resolve(root, 'web/src/app/chat/TurnStatus.tsx'))};
import { RetryNotice } from ${JSON.stringify(resolve(root, 'web/src/app/parts/TurnNotices.tsx'))};
import { retryCaption } from ${JSON.stringify(resolve(root, 'web/src/domain/turn-errors.ts'))};
import { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import { OmpSessionController } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import { getOfflineQueueNamespace } from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
import { canCancelRetry, parseRetryStart, retryCountdown, retryLabel, humanizeProviderError, parseThinkingLevelChanged } from ${JSON.stringify(resolve(root, 'web/src/domain/run-status.ts'))};
import { buildTimeline, addTimelineMarkers, clearTimelineMarkers } from ${JSON.stringify(resolve(root, 'web/src/domain/timeline.ts'))};
import { shortModel } from ${JSON.stringify(resolve(root, 'web/src/app/session-format.ts'))};
import { thinkingLabel } from ${JSON.stringify(resolve(root, 'web/src/app/chat/ModelPill.tsx'))};
function controller(store) {
  const c = Object.create(OmpSessionController.prototype);
  const seeds = [], rpcs = [];
  Object.assign(c, { store, generation: 0, activeSession: '/synthetic/a', disposed: false,
    queueNamespace: getOfflineQueueNamespace(),
    runningAgentCount: { invalidate() {} }, noteLocalActivity() {}, catchUp: async () => {},
    reconcileSessionState() {}, commitStreamingMessage() {}, setWorking() {}, reconcileReceipts: async () => {},
    seedQueuedMessages: async (generation, path) => { seeds.push(path + '@' + generation); },
    execRpc: async (command) => { rpcs.push(command); return c.rpcResult; }, rpcResult: { ok: true } });
  return { c, seeds, rpcs,
    event(type, fields = {}, generation = 0, path = '/synthetic/a') { c.handleFrame({ type: 'event', event: { type, ...fields } }, generation, path); },
    resync() { c.handleFrame({ type: 'resync' }, 0, '/synthetic/a'); } };
}
// What the newest turn's footer is fed, rendered plainly so the hook is the
// unit under test; the footer's presentation belongs to parts/TurnFooter.
function LiveTurnProbe({ controller }) {
  const live = useLiveTurn(controller);
  window.liveTurnProbe = live;
  if (!live) return null;
  return h('p', { 'data-testid': 'live-turn', 'data-state': live.state },
    h('span', { 'data-testid': 'live-turn-step' }, live.currentStep),
    live.action ? h('button', { type: 'button', 'data-testid': 'live-turn-action', onClick: live.action.onClick }, live.action.label) : null);
}
window.fixture = { act, createOmpStore, controller, canCancelRetry, parseRetryStart, retryCountdown, retryLabel, retryCaption, humanizeProviderError, parseThinkingLevelChanged,
  buildTimeline, addTimelineMarkers, clearTimelineMarkers, names: { model: shortModel, thinking: thinkingLabel },
  mount(store, ctl) {
    const r = createRoot(document.getElementById('root'));
    r.render(h(LiveTurnProbe, { controller: ctl }));
    return { unmount: () => r.unmount() };
  },
  mountNotice(props) {
    const r = createRoot(document.getElementById('root'));
    const render = next => r.render(h(RetryNotice, next));
    render(props);
    return { render, unmount: () => r.unmount() };
  } };
`, [{ name: 'controller-fixture-meta', transform(code, id) { if (id.endsWith('/omp-session-controller.ts')) return code.replaceAll('import.meta', JSON.stringify({ env: { VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: 'unit' } })); } }]);

function domFixture(t, teardown = true) {
  const dom = createDomFixture(code);
  if (teardown) t.after(() => { assert.deepEqual(dom.blocked, []); dom.close(); });
  return { dom, w: dom.window, f: dom.window.fixture };
}

const retryStart = { attempt: 2, maxAttempts: 5, delayMs: 8000, errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' };

test('retry adapter: valid start reads as a countdown with attempt bounds', t => {
  const { f } = domFixture(t);
  const retry = f.parseRetryStart(retryStart, 1_000_000);
  assert.equal(retry.resumeAt, 1_008_000);
  assert.equal(f.retryLabel(retry, 1_000_000), 'Retrying in 8s · attempt 2 of 5');
  assert.equal(f.retryLabel(retry, 1_007_100), 'Retrying in 1s · attempt 2 of 5');
  assert.equal(f.retryLabel(retry, 1_008_000) === null, true, 'an elapsed countdown is not shown');
  assert.equal(f.retryLabel(f.parseRetryStart({ ...retryStart, delayMs: 75_000 }, 0), 0), 'Retrying in 1m 15s · attempt 2 of 5');
  assert.equal(f.retryCountdown(retry, 1_000_000), '8s');
  assert.equal(f.retryCountdown(retry, 1_008_000) === null, true, 'elapsed: no countdown');
  const caption = (live, countdown) => f.retryCaption(1, false, { live, countdown, recovered: false });
  assert.equal(caption(retry, '8s'), 'Provider error · retrying in 8s (2/5)');
  assert.equal(caption(retry, null), 'Provider error · retrying (2/5)', 'elapsed: the live caption without a countdown');
});

test('retry adapter: malformed fields degrade the line, never show bogus numbers', t => {
  const { f } = domFixture(t);
  for (const event of [{}, { attempt: '2', maxAttempts: null, delayMs: -5, errorMessage: 42 },
    { attempt: 0, maxAttempts: 1.5, delayMs: Number.NaN }, { attempt: 2, delayMs: 1e12 }]) {
    const retry = f.parseRetryStart(event, 0);
    assert.equal(retry.resumeAt === null, true, JSON.stringify(event));
    assert.equal(retry.error === null, true);
    assert.ok(f.retryLabel(retry, 0).startsWith('Retrying…'), JSON.stringify(event));
    assert.equal(/\d+s/.test(f.retryLabel(retry, 0)), false);
    assert.equal(f.retryCountdown(retry, 0) === null, true, JSON.stringify(event));
    const caption = f.retryCaption(1, false, { live: retry, countdown: f.retryCountdown(retry, 0), recovered: false });
    assert.ok(caption.startsWith('Provider error · retrying'), JSON.stringify(event));
    assert.equal(/\d+s|\/\D|null|undefined/.test(caption), false, caption);
  }
  const unbounded = f.parseRetryStart({ attempt: 6, maxAttempts: 5 }, 0);
  assert.equal(f.retryLabel(unbounded, 0), 'Retrying… · attempt 6');
  assert.equal(f.retryCaption(1, false, { live: unbounded, recovered: false }), 'Provider error · retrying (6)');
});

test('provider errors humanize to one short line', t => {
  const { f } = domFixture(t);
  assert.equal(f.humanizeProviderError(retryStart.errorMessage), 'The provider is overloaded');
  assert.equal(f.humanizeProviderError('429 Too Many Requests'), 'The provider is rate limiting requests');
  assert.equal(f.humanizeProviderError('fetch failed: ECONNRESET'), "Couldn't reach the provider");
  assert.equal(f.humanizeProviderError('503 Service Unavailable'), 'The provider had an error (503)');
  assert.equal(f.humanizeProviderError('400 {"error":{"message":"Invalid  tool\\nschema"}}'), 'Invalid tool schema');
  assert.equal(f.humanizeProviderError('x'.repeat(400)).length, 140);
  assert.equal(f.humanizeProviderError(null) === null, true);
  assert.equal(f.humanizeProviderError('   ') === null, true);
});

test('store: retry and compaction follow start/end, terminal agent_end, resync and switch', t => {
  const { f } = domFixture(t);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a' });
  const ctl = f.controller(store);
  ctl.event('auto_retry_start', retryStart);
  assert.equal(store.getState().autoRetry.attempt, 2);
  assert.equal(store.getState().autoRetry.maxAttempts, 5);
  ctl.event('auto_retry_end', { success: true, attempt: 2 });
  assert.equal(store.getState().autoRetry === null, true);

  ctl.event('auto_compaction_start', { reason: 'threshold', action: 'context-full' });
  assert.equal(store.getState().compacting.reason, 'threshold');
  ctl.event('auto_compaction_end', { action: 'context-full', aborted: false, willRetry: false });
  assert.equal(store.getState().compacting === null, true);

  ctl.event('auto_retry_start', retryStart);
  ctl.event('auto_compaction_start', { reason: 'overflow' });
  ctl.event('agent_end', { isTerminal: false });
  assert.equal(store.getState().autoRetry !== null && store.getState().compacting !== null, true, 'a loop boundary is not the end');
  ctl.event('agent_end', { isTerminal: true });
  assert.equal(store.getState().autoRetry === null && store.getState().compacting === null, true);

  ctl.event('auto_retry_start', retryStart);
  ctl.event('auto_compaction_start', {});
  assert.equal(store.getState().compacting.reason === null, true, 'a malformed start still shows compaction');
  ctl.resync();
  assert.equal(store.getState().autoRetry === null && store.getState().compacting === null, true);

  ctl.event('auto_retry_start', retryStart);
  ctl.event('auto_compaction_start', { reason: 'idle' });
  store.getState().beginSession('/synthetic/b');
  assert.equal(store.getState().autoRetry === null && store.getState().compacting === null, true);
});

test('stale-session and stale-generation events change nothing', t => {
  const { f } = domFixture(t);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a', sessionModel: { model: 'claude-opus-4-1', thinkingLevel: 'low' } });
  const ctl = f.controller(store);
  for (const [generation, path] of [[1, '/synthetic/a'], [0, '/synthetic/b']]) {
    ctl.event('auto_retry_start', retryStart, generation, path);
    ctl.event('auto_compaction_start', { reason: 'threshold' }, generation, path);
    ctl.event('thinking_level_changed', { thinkingLevel: 'high' }, generation, path);
    ctl.event('model_changed', {}, generation, path);
  }
  assert.equal(store.getState().autoRetry === null && store.getState().compacting === null, true);
  assert.equal(store.getState().sessionModel.thinkingLevel, 'low');
  assert.equal(ctl.seeds.length, 0);
  // The store's open session moved on while the controller still points here.
  store.setState({ sessionPath: '/synthetic/b' });
  ctl.event('auto_retry_start', retryStart);
  assert.equal(store.getState().autoRetry === null, true);
});

test('model_changed re-reads state; thinking_level_changed patches the level', t => {
  const { f } = domFixture(t);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a', sessionModel: { model: 'claude-opus-4-1', thinkingLevel: 'low', contextWindow: 200000, ctxPercent: 40 } });
  const ctl = f.controller(store);
  ctl.event('model_changed');
  assert.equal(ctl.seeds.join(), '/synthetic/a@0');
  ctl.event('thinking_level_changed', { thinkingLevel: 'high', configured: 'auto' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'auto');
  assert.equal(store.getState().sessionModel.effectiveThinkingLevel, 'high');
  ctl.event('thinking_level_changed', { configured: 'medium' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'medium');
  ctl.event('thinking_level_changed', { thinkingLevel: 7 });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'medium', 'a malformed level is ignored');
  // What the re-read lands on: a switched model drops the old window and ctx%.
  store.getState().setSessionModel({ model: 'gpt-5', provider: 'openai' });
  assert.equal(store.getState().sessionModel.contextWindow === undefined && store.getState().sessionModel.ctxPercent === undefined, true);
});

test('abortRetry sends abort_retry, clears the line, and reports a refusal', async t => {
  const { f } = domFixture(t);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a' });
  const ctl = f.controller(store);
  ctl.event('auto_retry_start', retryStart);
  assert.equal(await ctl.c.abortRetry() === null, true);
  assert.equal(ctl.rpcs.join(), 'abort_retry');
  assert.equal(store.getState().autoRetry === null, true);
  ctl.event('auto_retry_start', retryStart);
  ctl.c.rpcResult = { ok: false, error: 'this conversation is open in omp on the desktop — change this setting there' };
  assert.equal(await ctl.c.abortRetry(), 'this conversation is open in omp on the desktop — change this setting there');
  assert.equal(store.getState().autoRetry !== null, true, 'a refused cancel leaves the countdown');
});

async function statusFixture(t, state = {}) {
  const { dom, w, f } = domFixture(t, false);
  let clock = 1_000_000;
  w.Date.now = () => clock;
  const intervals = new Map(); let sequence = 0;
  w.setInterval = fn => { const id = ++sequence; intervals.set(id, fn); return id; };
  w.clearInterval = id => intervals.delete(id);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a', connection: 'open', agentWorking: false, activity: null, ...state });
  const cancels = [];
  const ctl = { getStore: () => store, abortRetry: async () => { cancels.push(store.getState().sessionPath); return null; } };
  let mounted;
  await f.act(async () => { mounted = f.mount(store, ctl); });
  // Unmount before the window closes; a closed window never settles act().
  t.after(async () => {
    try { await f.act(async () => mounted.unmount()); assert.equal(intervals.size, 0); assert.deepEqual(dom.blocked, []); } finally { dom.close(); }
  });
  const q = sel => w.document.querySelector(sel);
  return { w, store, cancels, intervals, q,
    step: () => q('[data-testid="live-turn-step"]')?.textContent ?? null,
    set: patch => f.act(async () => store.setState(patch)),
    click: sel => f.act(async () => q(sel).click()),
    advance: ms => f.act(async () => { clock += ms; for (const fn of [...intervals.values()]) fn(); }),
    retry: (event = retryStart) => f.act(async () => store.getState().setAutoRetry(f.parseRetryStart(event, clock))) };
}

test('live turn: retry countdown replaces the running step and ticks only while shown', async t => {
  const s = await statusFixture(t);
  assert.equal(s.q('[data-testid="live-turn"]') === null, true, 'idle: nothing');
  assert.equal(s.intervals.size, 0);
  await s.retry();
  assert.equal(s.q('[data-testid="live-turn"]').getAttribute('data-state'), 'retrying');
  assert.ok(s.step().startsWith('Retrying in 8s · attempt 2 of 5'));
  assert.equal(s.intervals.size, 1, 'an idle-turn countdown still ticks');
  await s.advance(3000);
  assert.ok(s.step().startsWith('Retrying in 5s · attempt 2 of 5'));
  await s.advance(5000);
  assert.equal(s.q('[data-testid="live-turn"]') === null, true, 'elapsed countdown on an idle turn shows nothing');
  assert.equal(s.intervals.size, 0, 'the clock stops with the countdown');
});

test('live turn: an active turn returns to its normal step once the countdown elapses', async t => {
  const s = await statusFixture(t, { agentWorking: true });
  await s.retry();
  assert.equal(s.q('[data-testid="live-turn"]').getAttribute('data-state'), 'retrying');
  assert.equal(s.step().includes('Working'), false, 'replaces, not stacks');
  await s.advance(8000);
  assert.equal(s.q('[data-testid="live-turn"]').getAttribute('data-state'), 'running');
  assert.equal(s.step(), 'Working…');
});

test('live turn: activityAt moves on a token or tool change, not on unrelated state, and a retry wait has none', async t => {
  const s = await statusFixture(t, { agentWorking: true });
  const at = () => s.w.liveTurnProbe.activityAt();
  const first = at();
  await s.advance(30_000);
  await s.set({ connection: 'open' });
  assert.equal(at(), first, 'a store update that carries nothing new is not activity');
  await s.set({ streamingMessage: { id: 'a1', role: 'assistant', text: 'hi', parts: [] } });
  assert.equal(at(), first + 30_000, 'a token is activity');
  await s.advance(45_000);
  await s.set({ activity: { state: 'tool', tool: 'bash', label: 'Running bash', since: 1 } });
  assert.equal(at(), first + 75_000, 'a step change is activity');
  await s.retry();
  assert.equal(s.w.liveTurnProbe.activityAt, undefined, 'the retry countdown outranks the stall line');
});

test('live turn: the provider error rides on the retry step and Cancel calls abortRetry', async t => {
  const s = await statusFixture(t);
  await s.retry();
  assert.ok(s.step().endsWith(' · The provider is overloaded'));
  assert.equal(s.q('[data-testid="live-turn-action"]').textContent, 'Cancel');
  await s.click('[data-testid="live-turn-action"]');
  assert.equal(s.cancels.join(), '/synthetic/a');
  await s.retry({ attempt: 1, maxAttempts: 3, delayMs: 2000 });
  assert.equal(s.step(), 'Retrying in 2s · attempt 1 of 3', 'no error, no suffix');
});

test('live turn: desktop-owned sessions get no Cancel', async t => {
  const authority = { daemonInstanceId: 'd', revision: 1, bindingEpoch: 1, owner: { kind: 'bridge', pid: 1 }, confidence: 'confirmed',
    connection: 'connected', turn: 'running', observedAt: 1, activity: null, capabilities: { read: true } };
  const s = await statusFixture(t, { sessionAuthorities: { '/synthetic/a': authority } });
  await s.retry();
  assert.equal(s.q('[data-testid="live-turn"]').getAttribute('data-state'), 'retrying');
  assert.equal(s.q('[data-testid="live-turn-action"]') === null, true);
});

test('live turn: a lost link never reports the turn as working', async t => {
  const s = await statusFixture(t, { agentWorking: true });
  assert.equal(s.step(), 'Working…');
  for (const connection of ['reconnecting', 'offline', 'error']) {
    await s.set({ connection });
    assert.equal(s.q('[data-testid="live-turn"]') === null, true, connection);
  }
  const authority = { daemonInstanceId: 'd', revision: 1, bindingEpoch: 1, owner: { kind: 'child', pid: 1 }, confidence: 'confirmed',
    connection: 'reconnecting', turn: 'running', observedAt: 1, activity: null, capabilities: { read: true } };
  await s.set({ connection: 'open', sessionAuthorities: { '/synthetic/a': authority } });
  assert.equal(s.q('[data-testid="live-turn"]') === null, true, 'the owner link is down');
});

// The row omp's superseded attempts collapse into (timeline `retry` item).
async function noticeFixture(t, { cancellable = true } = {}) {
  const { dom, w, f } = domFixture(t, false);
  let clock = 1_000_000;
  w.Date.now = () => clock;
  const intervals = new Map(); let sequence = 0;
  w.setInterval = fn => { const id = ++sequence; intervals.set(id, fn); return id; };
  w.clearInterval = id => intervals.delete(id);
  const cancels = [];
  const messages = [{ id: 'a1', role: 'assistant', text: '', parts: [], stopReason: 'error', errorMessage: retryStart.errorMessage, retry: { status: 'superseded', attempt: 2 } }];
  const props = live => ({ messages, recovered: false, live, onCancel: cancellable ? async () => { cancels.push(live); } : undefined });
  let mounted;
  await f.act(async () => { mounted = f.mountNotice(props(null)); });
  t.after(async () => {
    try { await f.act(async () => mounted.unmount()); assert.equal(intervals.size, 0); assert.deepEqual(dom.blocked, []); } finally { dom.close(); }
  });
  const q = sel => w.document.querySelector(sel);
  return { cancels, intervals, q, text: () => q('[data-testid="retry-notice"]').textContent,
    click: sel => f.act(async () => q(sel).click()),
    advance: ms => f.act(async () => { clock += ms; for (const fn of [...intervals.values()]) fn(); }),
    retry: (event = retryStart) => f.act(async () => mounted.render(props(f.parseRetryStart(event, clock)))),
    end: () => f.act(async () => mounted.render(props(null))) };
}

test('retry row: counts the backoff down once a second, only while it runs', async t => {
  const s = await noticeFixture(t);
  assert.equal(s.text(), 'Provider error · retried 1×');
  assert.equal(s.intervals.size, 0, 'a finished retry does not tick');
  await s.retry();
  assert.ok(s.text().startsWith('Provider error · retrying in 8s (2/5)'), s.text());
  assert.equal(s.intervals.size, 1);
  await s.advance(3000);
  assert.ok(s.text().startsWith('Provider error · retrying in 5s (2/5)'), s.text());
  await s.advance(5000);
  assert.ok(s.text().startsWith('Provider error · retrying (2/5)'), 'elapsed: no stale 0s');
  assert.equal(s.intervals.size, 0, 'the clock stops with the countdown');
  await s.end();
  assert.equal(s.text(), 'Provider error · retried 1×');
  assert.equal(s.q('[data-testid="retry-cancel"]') === null, true, 'no Cancel once omp is done');
});

test('retry row: error is one tap deep and Cancel ends the wait', async t => {
  const s = await noticeFixture(t);
  await s.retry();
  assert.equal(s.q('[data-testid="retry-error"]') === null, true);
  assert.equal(s.q('[data-testid="retry-error-toggle"]').getAttribute('aria-expanded'), 'false');
  await s.click('[data-testid="retry-error-toggle"]');
  assert.equal(s.q('[data-testid="retry-error"]').textContent, 'The provider is overloaded');
  await s.click('[data-testid="retry-error-toggle"]');
  assert.equal(s.q('[data-testid="retry-error"]') === null, true);
  assert.equal(s.q('[data-testid="retry-cancel"]').textContent.trim(), 'Cancel');
  await s.click('[data-testid="retry-cancel"]');
  assert.equal(s.cancels.length, 1);
  await s.retry({ attempt: 1, maxAttempts: 3, delayMs: 2000 });
  assert.equal(s.q('[data-testid="retry-error-toggle"]') === null, true, 'no error, no toggle');
  await s.advance(2000);
});

test('retry row: no Cancel unless the daemon child runs the session', async t => {
  const s = await noticeFixture(t, { cancellable: false });
  await s.retry();
  assert.ok(s.text().startsWith('Provider error · retrying in 8s'));
  assert.equal(s.q('[data-testid="retry-cancel"]') === null, true);
  await s.advance(8000);
  const { f } = domFixture(t);
  assert.deepEqual(['child', 'bridge', 'host', undefined].map(f.canCancelRetry), [true, false, false, true]);
});

test('auto_retry_start folds the failed attempt into the retry row at once', t => {
  const { f } = domFixture(t);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a' });
  store.getState().mergeMessages([{ id: 'u1', role: 'user', text: 'go', parts: [{ kind: 'text', text: 'go' }] },
    { id: 'a1', role: 'assistant', text: '', parts: [], stopReason: 'error', errorMessage: retryStart.errorMessage }]);
  f.controller(store).event('auto_retry_start', retryStart);
  const failed = store.getState().messages.find(m => m.id === 'a1');
  assert.deepEqual({ ...failed.retry }, { status: 'superseded', attempt: 2 });
  assert.deepEqual(f.buildTimeline(store.getState().messages, [], f.names).map(item => item.kind), ['message', 'retry']);
});

test('auto_retry_end success=false leaves a warning marker; success=true leaves none', t => {
  const { f } = domFixture(t);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a' });
  const ctl = f.controller(store);
  f.clearTimelineMarkers();
  ctl.event('auto_retry_start', retryStart);
  ctl.event('auto_retry_end', { success: true, attempt: 2 });
  assert.equal(f.buildTimeline([], [], f.names).some(item => item.kind === 'marker'), false);
  ctl.event('auto_retry_start', retryStart);
  ctl.event('auto_retry_end', { success: false, attempt: 5, finalError: 'overloaded' });
  assert.equal(store.getState().autoRetry === null, true);
  const marker = f.buildTimeline([], [], f.names).find(item => item.kind === 'marker');
  assert.equal(marker?.label, 'Automatic recovery stopped');
  assert.equal(marker?.detail, 'overloaded');
  assert.equal(marker?.tone, 'warn');
  f.clearTimelineMarkers();
});

test('subagent_lifecycle settles or unsettles the agent and refreshes the running count', t => {
  const { f } = domFixture(t);
  const store = f.createOmpStore();
  store.setState({ sessionPath: '/synthetic/a' });
  const ctl = f.controller(store);
  let invalidated = 0;
  ctl.c.runningAgentCount = { invalidate() { invalidated++; } };
  ctl.event('subagent_lifecycle', { payload: { id: 'a1', status: 'completed' } });
  assert.equal(store.getState().settledAgents.a1, 'completed');
  ctl.event('subagent_lifecycle', { id: 'a2', status: 'failed' });
  assert.equal(store.getState().settledAgents.a2, 'failed');
  ctl.event('subagent_lifecycle', { payload: { id: 'a1', status: 'running' } });
  assert.equal('a1' in store.getState().settledAgents, false);
  assert.equal(invalidated, 3);
});

const msg = (id, role, model, at) => ({ id, role, text: role === 'user' ? 'question' : 'answer', model,
  parts: role === 'assistant' ? [{ kind: 'text', text: 'answer' }] : [], createdAt: new Date(at) });
const dividers = items => items.filter(item => item.kind === 'marker').map(item => item.label);
const position = (items, id) => items.findIndex(item => item.kind === 'message' && item.message.id === id);

test('divider: one marker before the first message of a new model', t => {
  const { f } = domFixture(t);
  f.clearTimelineMarkers();
  const base = Date.UTC(2026, 9, 15, 10);
  const messages = [msg('u1', 'user', undefined, base), msg('a1', 'assistant', 'claude-opus-4-1', base + 1),
    msg('a2', 'assistant', 'claude-opus-4-1', base + 2), msg('u2', 'user', undefined, base + 3),
    msg('a3', 'assistant', 'gpt-5', base + 4), msg('a4', 'assistant', 'gpt-5', base + 5)];
  const items = f.buildTimeline(messages, [], f.names);
  assert.deepEqual(dividers(items), ['Switched to GPT 5']);
  const marker = items.findIndex(item => item.kind === 'marker');
  assert.equal(marker, position(items, 'a3') - 1);
  assert.equal(f.buildTimeline(messages.slice(0, 4), [], f.names).some(item => item.kind === 'marker'), false, 'same model: none');
});

test('divider: carries the thinking level in force and defers to an existing model marker', t => {
  const { f } = domFixture(t);
  f.clearTimelineMarkers();
  const base = Date.UTC(2026, 9, 15, 10);
  // Only model markers carry the level now: thinking-level changes draw no marker.
  f.addTimelineMarkers([{ key: 'marker:model:m0', label: 'Switched to Opus 4 · Xhigh', at: base, icon: 'model', thinkingLevel: 'xhigh' }]);
  const messages = [msg('a1', 'assistant', 'claude-opus-4-1', base + 1), msg('a2', 'assistant', 'gpt-5', base + 10)];
  assert.deepEqual(dividers(f.buildTimeline(messages, [], f.names)), ['Switched to Opus 4 · Xhigh', 'Switched to GPT 5 · Extra high']);
  f.addTimelineMarkers([{ key: 'marker:model:m1', label: 'Switched to GPT 5', at: base + 5, icon: 'model' }]);
  assert.deepEqual(dividers(f.buildTimeline(messages, [], f.names)), ['Switched to Opus 4 · Xhigh', 'Switched to GPT 5']);
  f.clearTimelineMarkers();
});
