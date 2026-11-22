import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// What the chat shows for the model and thinking level after the reader changes
// them, with the real store, the real composer chip, model picker and session
// settings sheet. Only the daemon (DaemonApi) is synthetic: every request is
// held until the test answers it, so each ordering is explicit.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act, useSyncExternalStore } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { ModelChip } from ${JSON.stringify(resolve(root, 'web/src/app/composer/ComposerChips.tsx'))};
import { ModelPicker } from ${JSON.stringify(resolve(root, 'web/src/app/sessions/ModelPicker.tsx'))};
import { SessionSettingsSheet } from ${JSON.stringify(resolve(root, 'web/src/app/tools/SessionSettingsSheet.tsx'))};
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};

const PATH = '/synthetic/a';
const efforts = ['low', 'high', 'max'];
const models = [
  { id: 'model-one', name: 'Model one', provider: 'p', reasoning: true, thinking: { efforts, defaultLevel: 'high' } },
  { id: 'model-two', name: 'Model two', provider: 'p', reasoning: true, thinking: { efforts, defaultLevel: 'high' } },
  { id: 'plain', name: 'Plain', provider: 'p', reasoning: false },
];
const reads = [], writes = [], states = [];
DaemonApi.prototype.getAvailableModels = async () => models;
DaemonApi.prototype.getRecentModels = async () => [];
DaemonApi.prototype.getState = (path, options) => new Promise((resolve, reject) => reads.push({ path, options, resolve, reject }));
for (const method of ['setModel', 'setThinkingLevel', 'setFastMode'])
  DaemonApi.prototype[method] = (...args) => new Promise((resolve, reject) => writes.push({ method, args, resolve, reject }));
const store = createOmpStore();
store.getState().beginSession(PATH);

// Wired as ChatScreen wires them: the held model flows down, reads and
// acknowledgements flow back into the store.
const onStateChanged = (patch, source) => { states.push({ patch, source }); store.getState().setSessionModel(patch, source); };
function Held({ children }) {
  const sessionModel = useSyncExternalStore(store.subscribe, () => store.getState().sessionModel);
  return children(sessionModel);
}
const mounts = {
  chip: () => h(Held, null, () => h(ModelChip, { store, sessionPath: PATH, fallbackModel: 'model-one', onOpenModelPicker() {}, onModelChanged() {} })),
  picker: () => h(Held, null, (sessionModel) => h(ModelPicker, { open: true, onOpenChange() {}, sessionPath: PATH, sessionModelHint: sessionModel, onStateChanged })),
  settings: () => h(Held, null, (sessionModel) => h(SessionSettingsSheet, { open: true, onOpenChange() {}, sessionPath: PATH, sessionModelHint: sessionModel, onStateChanged })),
};
window.fixture = { act, reads, writes, states, store, mount(kind) {
  const root = createRoot(document.getElementById('root'));
  root.render(mounts[kind]());
  return { unmount: () => root.unmount() };
} };
`);

async function fixture(t, kind, held) {
  const dom = createDomFixture(code), w = dom.window, { act, reads, writes, states, store } = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  if (held) store.getState().setSessionModel(held);
  let mounted;
  await act(async () => { mounted = w.fixture.mount(kind); });
  t.after(async () => { try { await act(async () => mounted.unmount()); } finally { dom.close(); } });
  const $ = (selector) => w.document.querySelector(selector);
  const model = () => store.getState().sessionModel;
  const f = {
    w, act, reads, writes, states, store, $, model,
    text: () => w.document.body.textContent,
    click: (selector) => act(async () => { $(selector).click(); }),
    answerRead: (i, data) => act(async () => reads[i].resolve(data)),
    failRead: (i) => act(async () => reads[i].reject(new Error('offline'))),
    ack: (i) => act(async () => writes[i].resolve()),
    reject: (i, message) => act(async () => writes[i].reject(new Error(message))),
    // Let the catalogue load (the picker and the chip popover read it).
    settle: () => act(async () => {}),
    chosen: (level) => states.map((entry) => entry.patch.thinkingLevel).filter((value) => value !== undefined).includes(level),
  };
  return f;
}
const owner = (id, thinkingLevel, provider = 'p') => ({ model: { id, provider }, thinkingLevel });
const ONE = { model: 'model-one', provider: 'p', thinkingLevel: 'low', effectiveThinkingLevel: 'low' };

test('picker: a model switch shows the level omp reports, never the predicted default', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('button[data-model="p/model-two"]');
  assert.equal(f.writes[0].method, 'setModel');
  assert.deepEqual(Array.from(f.writes[0].args), [ '/synthetic/a', 'p', 'model-two' ]);
  await f.ack(0);
  assert.equal(f.reads.length, 2, 'the acknowledgement is verified against the owner');
  assert.equal(f.model().model, 'model-one', 'nothing is claimed before the owner answers');
  // omp kept Low although the model's default is High, which is what levelAfterModelSwitch predicts.
  await f.answerRead(1, owner('model-two', 'low'));
  assert.equal(f.model().model, 'model-two');
  assert.equal(f.model().thinkingLevel, 'low');
  assert.equal(f.model().effectiveThinkingLevel, 'low');
  assert.equal(f.chosen('high'), false, 'the predicted level is never written');
});

test('picker: a switch to a model without thinking takes the effort the owner reports and never keeps the old model’s', async (t) => {
  const f = await fixture(t, 'picker', { ...ONE, thinkingLevel: 'high', effectiveThinkingLevel: 'high' });
  await f.answerRead(0, owner('model-one', 'high'));
  await f.settle();
  await f.click('button[data-model="p/plain"]');
  await f.ack(0);
  await f.answerRead(1, owner('plain', 'off'));
  assert.equal(f.model().model, 'plain');
  assert.equal(f.model().thinkingLevel, 'off');
  assert.equal(f.model().effectiveThinkingLevel, 'off');
});

test('picker: when the owner cannot be read after a switch, no level of the old model is claimed for the new one', async (t) => {
  const f = await fixture(t, 'picker', { ...ONE, thinkingLevel: 'high', effectiveThinkingLevel: 'high' });
  await f.answerRead(0, owner('model-one', 'high'));
  await f.settle();
  await f.click('button[data-model="p/plain"]');
  await f.ack(0);
  await f.failRead(1);
  assert.equal(f.model().model, 'plain');
  assert.equal(f.model().thinkingLevel, '');
  assert.equal(f.model().effectiveThinkingLevel, undefined);
});

test('picker: the model the owner reports (routed provider and id) replaces the one requested', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('button[data-model="p/model-two"]');
  await f.ack(0);
  await f.answerRead(1, owner('vendor/model-two-routed', 'low', 'router'));
  assert.equal(f.model().model, 'vendor/model-two-routed');
  assert.equal(f.model().provider, 'router');
});

test('picker: a file snapshot never confirms a switch, so the acknowledged model stays', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('button[data-model="p/model-two"]');
  await f.ack(0);
  // An idle session's file, which omp has not yet flushed the switch into.
  await f.answerRead(1, { source: 'file', model: 'model-one', configuredThinkingLevel: 'high', sessionModelPending: false });
  assert.equal(f.model().model, 'model-two');
  assert.equal(f.model().thinkingLevel, '');
});

test('picker: a configured Auto survives a model switch and a native read, which reports only the effective effort', async (t) => {
  const f = await fixture(t, 'picker', { ...ONE, thinkingLevel: 'auto', effectiveThinkingLevel: 'low' });
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('button[data-model="p/model-two"]');
  await f.ack(0);
  await f.answerRead(1, owner('model-two', 'medium'));
  assert.equal(f.model().thinkingLevel, 'auto');
  assert.equal(f.model().effectiveThinkingLevel, 'medium');
});

test('picker: an effort omp clamps shows the clamped level, not the requested one', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('[data-value="max"]');
  assert.deepEqual(Array.from(f.writes[0].args), [ '/synthetic/a', 'max' ]);
  await f.ack(0);
  await f.answerRead(1, owner('model-one', 'high'));
  assert.equal(f.model().thinkingLevel, 'high');
  assert.equal(f.chosen('max'), false);
});

test('picker: a thinking-level request that omp acknowledged but cannot be read back is kept as asked', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('[data-value="max"]');
  await f.ack(0);
  await f.failRead(1);
  assert.equal(f.model().thinkingLevel, 'max');
  assert.equal(f.model().effectiveThinkingLevel, 'max');
});

test('picker: a read still in flight when a change is made cannot undo it', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.settle();
  await f.click('[data-value="max"]');
  await f.ack(0);
  await f.answerRead(1, owner('model-one', 'max'));
  const written = f.states.length;
  // The read the sheet opened with was issued before the change and answers last.
  await f.answerRead(0, owner('model-one', 'low'));
  assert.equal(f.model().thinkingLevel, 'max');
  assert.equal(f.states.length, written);
});

test('picker: an idle session’s file snapshot stays file-owned, so a later file read can still refresh it', async (t) => {
  const f = await fixture(t, 'picker', { model: 'model-one', provider: 'p' });
  await f.answerRead(0, { source: 'file', model: 'model-one', configuredThinkingLevel: 'low', sessionModelPending: false });
  assert.equal(f.states[0].source, 'file');
  assert.equal(f.model().thinkingLevel, 'low');
  assert.equal(f.store.getState().sessionModelProvenance.thinkingLevel, 'file');
  await f.act(async () => { f.store.getState().setSessionModel({ thinkingLevel: 'high' }, 'file'); });
  assert.equal(f.model().thinkingLevel, 'high');
});

test('picker: a refused thinking change is not reported as a failed model change', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('[data-value="max"]');
  await f.reject(0, 'thinking level was not applied');
  assert.ok(f.text().includes('Couldn’t change the thinking level.'));
  assert.equal(f.text().includes('Couldn’t change the model.'), false);
  assert.equal(f.model().thinkingLevel, 'low', 'a refusal leaves the held level alone');
});

test('picker: a refused model change is labelled as the model', async (t) => {
  const f = await fixture(t, 'picker', ONE);
  await f.answerRead(0, owner('model-one', 'low'));
  await f.settle();
  await f.click('button[data-model="p/model-two"]');
  await f.reject(0, 'requested model is not available');
  assert.ok(f.text().includes('Couldn’t change the model.'));
  assert.equal(f.model().model, 'model-one');
});

test('settings sheet: reading the session never moves a configured Auto to the effort the last turn resolved', async (t) => {
  const f = await fixture(t, 'settings', { ...ONE, thinkingLevel: 'auto', effectiveThinkingLevel: 'low' });
  await f.answerRead(0, { model: { id: 'model-one', provider: 'p' }, thinkingLevel: 'high', fastModeEnabled: false });
  assert.equal(f.model().thinkingLevel, 'auto');
  assert.equal(f.model().effectiveThinkingLevel, 'high');
  assert.ok(f.$('[data-testid="settings-model"]').textContent.includes('Thinking auto'), 'the row agrees with the composer chip');
  // Any switch in the sheet re-reads the session.
  await f.click('#fast-mode');
  await f.ack(0);
  await f.answerRead(1, { model: { id: 'model-one', provider: 'p' }, thinkingLevel: 'medium', fastModeEnabled: true });
  assert.equal(f.model().thinkingLevel, 'auto');
  assert.equal(f.model().effectiveThinkingLevel, 'medium');
  assert.equal(f.model().fastMode, true);
});

test('settings sheet: a model row without a held model shows what the session reports', async (t) => {
  const f = await fixture(t, 'settings');
  await f.answerRead(0, { model: { id: 'model-two', provider: 'p' }, thinkingLevel: 'high' });
  const row = f.$('[data-testid="settings-model"]').textContent;
  assert.ok(row.includes('Model Two') && row.includes('Thinking high'));
});

test('chip: a model switch settles on the owner’s report and the chip never shows the predicted level', async (t) => {
  const f = await fixture(t, 'chip', ONE);
  await f.click('[data-testid="composer-model"]');
  await f.settle();
  await f.click('[data-testid="composer-model-option"][data-model="model-two"]');
  assert.equal(f.writes[0].method, 'setModel');
  await f.ack(0);
  assert.equal(f.reads.length, 1, 'the acknowledgement is verified against the owner');
  assert.equal(f.$('[data-testid="composer-model"]').textContent, 'Model One · Low', 'nothing is claimed before the owner answers');
  await f.answerRead(0, owner('model-two', 'low'));
  assert.equal(f.$('[data-testid="composer-model"]').textContent, 'Model Two · Low');
  assert.equal(f.$('[data-testid="composer-model"]').getAttribute('data-level'), 'low');
});

test('chip: switching to a model without thinking leaves no level from the old model on the chip', async (t) => {
  const f = await fixture(t, 'chip', { ...ONE, thinkingLevel: 'high', effectiveThinkingLevel: 'high' });
  await f.click('[data-testid="composer-model"]');
  await f.settle();
  await f.click('[data-testid="composer-model-option"][data-model="plain"]');
  await f.ack(0);
  await f.failRead(0);
  assert.equal(f.$('[data-testid="composer-model"]').textContent, 'Plain');
});

test('chip: a clamped thinking level shows the clamped level', async (t) => {
  const f = await fixture(t, 'chip', ONE);
  await f.click('[data-testid="composer-model"]');
  await f.settle();
  await f.click('[data-testid="composer-thinking-option"][data-value="max"]');
  assert.equal(f.writes[0].method, 'setThinkingLevel');
  await f.ack(0);
  await f.answerRead(0, owner('model-one', 'high'));
  assert.equal(f.$('[data-testid="composer-model"]').getAttribute('data-level'), 'high');
});

test('store: the previous model’s effective effort does not outlive a model switch', async (t) => {
  const f = await fixture(t, 'chip', { model: 'model-one', provider: 'p', thinkingLevel: 'high', effectiveThinkingLevel: 'high' });
  await f.act(async () => { f.store.getState().setSessionModel({ model: 'plain', provider: 'p' }); });
  assert.equal(f.model().effectiveThinkingLevel, undefined);
  // A frame that carries the new model's own effort (config_update) keeps it.
  await f.act(async () => { f.store.getState().setSessionModel({ model: 'model-two', provider: 'p', thinkingLevel: 'low', effectiveThinkingLevel: 'low' }); });
  assert.equal(f.model().effectiveThinkingLevel, 'low');
});

// The model catalogue can boot a cold omp child, so it gets a longer deadline
// than a passive read; a get_state peek must stay short.
const deadlineCode = await bundleDomFixture(`
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
window.fixture = { DaemonApi };
`);

test('the model catalogue read outlasts the daemon’s cold start while a state peek stays short', async (t) => {
  const dom = createDomFixture(deadlineCode), w = dom.window;
  t.after(() => dom.close());
  // A 25-second cold start exceeds a passive read's budget but can still
  // deliver a perfectly valid catalogue. Advance the clock without sleeping.
  w.AbortSignal.timeout = (ms) => {
    const controller = new w.AbortController();
    if (ms <= 25_000) controller.abort(new Error('read expired'));
    return controller.signal;
  };
  w.fetch = async (_url, { signal }) => {
    signal.throwIfAborted();
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { models: [{ provider: 'p', id: 'slow-model' }] } }) };
  };
  const api = new w.fixture.DaemonApi('token');
  const models = await api.getAvailableModels('/synthetic/a');
  assert.equal(models[0]?.id, 'slow-model');
  await assert.rejects(api.getState('/synthetic/a', { peek: true }), /read expired/);
});
