import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';
import { root } from './support/react-dom.mjs';

const build = await rolldown({
  input: 'usage-semantics', platform: 'browser',
  resolve: { alias: { '@': resolve(root, 'web/src') } },
  plugins: [{ name: 'fixture',
    resolveId: id => id === 'usage-semantics' ? '\0usage-semantics' : null,
    load: id => id === '\0usage-semantics' ? `
      export { thinkingChoices, levelAfterModelSwitch, modelChipLabel } from ${JSON.stringify(resolve(root, 'web/src/app/sessions/thinking-levels.ts'))};
      export { parseSessionModel, parsePassiveSessionModel, createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
      export { deriveStats, sessionUsageReport } from ${JSON.stringify(resolve(root, 'web/src/domain/session-stats.ts'))};
      export { sessionCost } from ${JSON.stringify(resolve(root, 'web/src/domain/usage-meter.ts'))};
      export { formatCommandResult } from ${JSON.stringify(resolve(root, 'web/src/app/commands/format-result.ts'))};
      export { parseModelFallback, modelFallbackMarker } from ${JSON.stringify(resolve(root, 'web/src/domain/model-fallback.ts'))};
      export { reduceStateEvent } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-state-events.ts'))};
      export { classifyCommand, resolveDrill } from ${JSON.stringify(resolve(root, 'web/src/app/commands/command-registry.ts'))};
    ` : null,
  }],
});
const { output } = await build.generate({ format: 'esm', codeSplitting: false });
await build.close();
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const f = await import(`data:text/javascript,${encodeURIComponent(output[0].code)}`);
const model = { id: 'fixture', provider: 'fixture', reasoning: true, thinking: { efforts: ['low', 'medium', 'high'], defaultLevel: 'high' } };

test('Auto is offered only for verified reasoning models and remains a selector across switches', () => {
  assert.deepEqual(f.thinkingChoices(model), ['off', 'auto', 'low', 'medium', 'high']);
  assert.deepEqual(f.thinkingChoices({ ...model, thinking: { ...model.thinking, unverified: true } }), ['off', 'low', 'medium', 'high']);
  assert.deepEqual(f.thinkingChoices({ ...model, reasoning: false }), []);
  assert.equal(f.levelAfterModelSwitch(model, 'auto'), 'auto', 'a model default cannot pin Auto');
  assert.equal(f.levelAfterModelSwitch({ ...model, reasoning: false }, 'auto'), 'auto', 'native OMP preserves the selection even without a reasoning control');
  assert.equal(f.levelAfterModelSwitch(model, 'low'), 'high', 'fixed choices retain native model-default semantics');
  assert.ok(f.modelChipLabel('fixture', 'auto').endsWith(' · Auto'));
});

test('a reconnect restores configured Auto while live state updates only the effective effort', () => {
  const restored = f.parseSessionModel({ model, thinkingLevel: 'low', configuredThinkingLevel: 'auto' });
  assert.equal(restored.thinkingLevel, 'auto');
  assert.equal(restored.effectiveThinkingLevel, 'low');
  const live = f.parsePassiveSessionModel({ model: { ...model, id: 'other' }, thinkingLevel: 'high' }, restored);
  assert.equal(live.thinkingLevel ?? restored.thinkingLevel, 'auto');
  assert.equal(live.effectiveThinkingLevel, 'high');
});

test('file ownership refreshes controls independently, including null fallback, until a live receipt acquires them', () => {
  const store = f.createOmpStore();
  store.getState().beginSession('/fixture');
  const file = snapshot => {
    const state = store.getState();
    state.setSessionModel(f.parsePassiveSessionModel({ ...snapshot, source: 'file' }, state.sessionModel, state.sessionModelProvenance), 'file');
  };
  file({ configuredThinkingLevel: 'auto', thinkingLevel: 'low', modelFallback: null });
  const fallback = { from: 'provider/primary', to: 'provider/recovery', role: 'default', entryId: 'receipt', at: 1 };
  file({ configuredThinkingLevel: 'high', thinkingLevel: 'high', modelFallback: fallback });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'high');
  assert.equal(store.getState().sessionModel.effectiveThinkingLevel, 'high');
  assert.deepEqual(store.getState().sessionModel.modelFallback, fallback);
  // A same-value live receipt still acquires ownership; equality is not provenance.
  f.reduceStateEvent(store.getState(), '/fixture', { type: 'thinking_level_changed', thinkingLevel: 'high' });
  file({ configuredThinkingLevel: 'auto', thinkingLevel: 'low', modelFallback: null });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'high');
  assert.equal(store.getState().sessionModel.effectiveThinkingLevel, 'high');
  assert.equal(store.getState().sessionModel.modelFallback, null, 'independent file-owned fallback still refreshes');
  store.getState().setSessionModel({ modelFallback: null }, 'live');
  file({ modelFallback: fallback });
  assert.equal(store.getState().sessionModel.modelFallback, null, 'known live null is authoritative, not missing');
  store.getState().beginSession('/other');
  assert.deepEqual(store.getState().sessionModelProvenance, {});
});

test('pending file snapshots expose no ambiguous thinking or fallback authority', () => {
  const parsed = f.parsePassiveSessionModel({
    source: 'file', sessionModelPending: true, configuredThinkingLevel: 'high', thinkingLevel: 'high',
    modelFallback: { from: 'provider/primary', to: 'provider/abandoned', role: 'default' },
  }, null);
  assert.equal(parsed.thinkingLevel, undefined);
  assert.equal(parsed.effectiveThinkingLevel, undefined);
  assert.equal(parsed.modelFallback, undefined);
});

test('only accepted confirmed owner replacement or release retires live control protection', () => {
  const store = f.createOmpStore(), path = '/binding-fixture';
  store.getState().beginSession(path);
  const owner = { kind: 'child', pid: 100, processStart: 10 };
  const record = (revision, patch = {}) => ({
    daemonInstanceId: 'binding-test', revision, bindingEpoch: 1, owner, turn: 'idle',
    confidence: 'confirmed', connection: 'connected', observedAt: 1, activity: null, capabilities: { read: true }, ...patch,
  });
  const reconcile = (revision, patch) => store.getState().reconcileSessionState(path, { sessionState: record(revision, patch) }, revision);
  const file = snapshot => {
    const state = store.getState();
    state.setSessionModel(f.parsePassiveSessionModel({ source: 'file', ...snapshot }, state.sessionModel, state.sessionModelProvenance), 'file');
  };
  assert.equal(reconcile(1), true);
  store.getState().setSessionModel({ thinkingLevel: 'auto', effectiveThinkingLevel: 'low', modelFallback: null });
  store.getState().setConnection('reconnecting');
  assert.equal(reconcile(2, { connection: 'reconnecting' }), true);
  assert.equal(reconcile(3, { confidence: 'inferred', owner: { kind: 'none' }, connection: 'unavailable' }), true);
  assert.equal(reconcile(2, { bindingEpoch: 2, owner: { kind: 'none' } }), false, 'stale release is not evidence');
  file({ configuredThinkingLevel: 'high', thinkingLevel: 'high', modelFallback: { from: 'old', to: 'stale', role: 'default' } });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'auto');
  assert.equal(store.getState().sessionModel.modelFallback, null);
  assert.equal(reconcile(4), true);
  file({ configuredThinkingLevel: 'high', thinkingLevel: 'high' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'auto', 'the same current owner stays protected');
  const replacement = { kind: 'bridge', pid: 200, processStart: 20 };
  assert.equal(reconcile(5, { bindingEpoch: 2, owner: replacement }), true);
  file({ configuredThinkingLevel: 'high', thinkingLevel: 'high' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'high');
  store.getState().setSessionModel({ thinkingLevel: 'auto', effectiveThinkingLevel: 'low', modelFallback: null });
  file({ configuredThinkingLevel: 'high', thinkingLevel: 'high' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'auto', 'a new owner can acquire live protection');
  assert.equal(reconcile(6, { bindingEpoch: 3, owner: { kind: 'none' }, connection: 'unavailable' }), true);
  const fallback = { from: 'desktop', to: 'recovery', role: 'default', entryId: 'new-binding-receipt', at: 2 };
  file({ configuredThinkingLevel: 'high', thinkingLevel: 'high', modelFallback: fallback });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'high');
  assert.deepEqual(store.getState().sessionModel.modelFallback, fallback);
  assert.equal(store.getState().sessionModelAuthority, null);
});

const assistant = (id, cost, snapshot) => ({ id, role: 'assistant', parts: [], text: '', usage: { input: 10, output: 2, totalTokens: 12, cost: { total: cost } }, ...(snapshot ? { contextSnapshot: snapshot } : {}) });
const rows = data => Object.fromEntries(f.formatCommandResult('/usage', data).rows.map(row => [row.label, row.value]));
const usageOf = data => f.formatCommandResult('/usage', data).usage;

test('compaction and branch changes alter the current-context footnote, never the whole-file spend headline', () => {
  const whole = f.sessionCost(12, 'a-old', [assistant('a-old', 3)]);
  for (const contextCost of [3, 0.75, 0.25]) {
    const { cost } = usageOf(f.sessionUsageReport({ cost: contextCost, tokens: { input: 10, output: 2, total: 12 } }, whole));
    assert.equal(cost.value, '$12.00');
    assert.ok(cost.scope.includes(`$${contextCost.toFixed(2)} of it is in the current context`));
  }
});

test('desktop loaded pages never masquerade as the whole session or active context', () => {
  const derived = f.deriveStats([assistant('before-compaction', 3), assistant('current-page', 0.25, { promptTokens: 100, compactionEpoch: 1 })]);
  const result = rows(f.sessionUsageReport(derived, 12));
  const { cost } = usageOf(f.sessionUsageReport(derived, 12));
  assert.deepEqual({ ...cost }, { value: '$12.00', scope: 'Whole conversation.' });
  assert.equal(result['Loaded messages cost (partial)'], '$3.25');
  const sectionNames = f.formatCommandResult('/usage', f.sessionUsageReport(derived, 12)).sections.map(section => section.title);
  assert.ok(sectionNames.includes('Loaded tokens (partial)'));
  assert.ok(sectionNames.includes('Loaded messages (partial)'));
  assert.ok(sectionNames.includes('Latest loaded context snapshot'));
});

test('unknown whole spend and breakdown-only usage never fabricate zero-dollar totals', () => {
  const derived = f.deriveStats([{ id: 'old', role: 'assistant', parts: [], usage: { cost: { input: 0.3 } } }]);
  assert.equal(derived.cost.total, undefined);
  const result = rows(f.sessionUsageReport(derived, undefined));
  assert.equal(usageOf(f.sessionUsageReport(derived, undefined)).cost.value, 'Not available');
  assert.equal(result['Loaded messages cost (partial)'], undefined);
  assert.equal(result['Loaded input cost (partial)'], '$0.30');
  assert.equal(usageOf(f.sessionUsageReport({ cost: 0 }, 0)).cost.value, '$0.00', 'known zero is not unknown');
  // Partial loaded figures are labelled as such when they are all there is.
  const loaded = f.deriveStats([assistant('a', 2)]);
  assert.deepEqual({ ...usageOf(f.sessionUsageReport(loaded, undefined)).cost }, { value: '$2.00', scope: 'Loaded messages only' });
});

test('live and reopened fallback data preserve the exact provider reason without a restoration promise', () => {
  const event = { type: 'retry_fallback_applied', from: 'openai/primary:high', to: 'anthropic/recovery', role: 'default', reason: 'Request failed: 529 overloaded' };
  const live = f.parseModelFallback(event);
  const entry = JSON.parse(JSON.stringify({ type: 'custom', customType: 'omp-pulse-model-fallback', data: event }));
  assert.deepEqual(f.parseModelFallback(entry.data), live);
  const marker = f.modelFallbackMarker(live, 'fallback:entry', 42);
  assert.equal(marker.tone, 'warn');
  assert.ok(marker.label.includes('Fallback'));
  assert.ok(marker.detail.includes(event.from));
  assert.ok(marker.detail.includes(event.to));
  assert.ok(marker.detail.includes(event.reason));
  assert.doesNotMatch(marker.detail, /will (return|restore)|next turn/i);
  const store = f.createOmpStore();
  store.getState().beginSession('/fixture');
  f.reduceStateEvent(store.getState(), '/fixture', event);
  f.reduceStateEvent(store.getState(), '/fixture', { type: 'config_update', model: { id: 'recovery', provider: 'anthropic' }, thinkingLevel: 'low' });
  assert.deepEqual(store.getState().sessionModel.modelFallback, live, 'later model refresh does not discard the explanation');
});

test('fast status uses native text and keeps standard, fast and ultrafast distinct', () => {
  const command = f.classifyCommand({ name: 'fast', source: 'builtin', subcommands: [{ name: 'on' }, { name: 'off' }, { name: 'ultra' }, { name: 'status' }] });
  const status = f.resolveDrill(command, 'status');
  assert.equal(status.shape, 'prompt');
  assert.equal(status.name, 'fast status');
  const displayed = ['Fast mode is off.', 'Fast mode is on.', 'Fast mode is ultra.'].map(output =>
    f.formatCommandResult('/fast status', output).rows.map(row => row.value).join('\\n'));
  assert.equal(new Set(displayed).size, 3, 'a boolean enabled flag cannot collapse fast and ultrafast');
  assert.match(displayed[2], /ultra/);
});
