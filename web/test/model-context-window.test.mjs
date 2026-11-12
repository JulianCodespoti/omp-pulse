import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Actual header, picker, selectors and store. Only the daemon responses are
// synthetic; resolving a deferred catalogue controls the race without timers.
const code = await bundleDomFixture(`
import { createElement as h, act, StrictMode, useState } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { SessionHeader } from ${JSON.stringify(resolve(root, 'web/src/app/chat/SessionHeader.tsx'))};
import { ModelPicker } from ${JSON.stringify(resolve(root, 'web/src/app/sessions/ModelPicker.tsx'))};
import { createOmpStore, selectContextPercent, contextWindowFor } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import { useStoreValue } from ${JSON.stringify(resolve(root, 'web/src/app/store-hooks.ts'))};
import { contextTier } from ${JSON.stringify(resolve(root, 'web/src/app/session-format.ts'))};
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};

const store = createOmpStore(), catalogues = [], mutations = [], stateCalls = [];
const models = [
  { id: 'model-a', provider: 'fixture', name: 'Model A', contextWindow: 100000 },
  { id: 'model-b', provider: 'fixture', name: 'Model B', contextWindow: 1000000 },
];
const history = [{ id: 'turn', role: 'assistant', parts: [], contextSnapshot: { promptTokens: 95000 } }];
let stateResponse = {};
DaemonApi.prototype.getAvailableModels = path => new Promise((resolve, reject) => catalogues.push({ path, resolve, reject }));
DaemonApi.prototype.getRecentModels = async () => [];
DaemonApi.prototype.getState = async (...args) => { stateCalls.push(args); return stateResponse; };
DaemonApi.prototype.setModel = async (...args) => { mutations.push(args); };
const noop = () => {};
function App({ showHeader }) {
  const model = useStoreValue(store, s => s.sessionModel);
  const path = useStoreValue(store, s => s.sessionPath);
  const percent = useStoreValue(store, selectContextPercent);
  const [open, setOpen] = useState(false);
  // The header owns the passive model reads and the catalogue request under
  // test; the model chip and context ring now live in the composer, so two
  // probes stand in for them: one opens the picker, one shows the figure.
  return h('div', null,
    showHeader && h(SessionHeader, { key: path, sessionPath: path, store, summary: null, connection: 'open',
      onBack: noop, onRename: noop, onOpenModelPicker: () => setOpen(true), onOpenSessionSettings: noop, onReload: noop }),
    h('button', { type: 'button', 'data-testid': 'model-probe', onClick: () => setOpen(true) }),
    percent === undefined ? null : h('span', { 'data-testid': 'context-probe', 'data-tone': contextTier(percent) ?? 'muted' }, Math.round(percent) + '%'),
    h(ModelPicker, { open, onOpenChange: setOpen, sessionPath: path,
      sessionModelHint: { ...model, ctxPercent: percent }, onStateChanged: store.getState().setSessionModel })
  );
}
window.fixture = { act, store, catalogues, mutations, stateCalls, models, history,
  contextWindowFor, selectContextPercent,
  setStateResponse(value) { stateResponse = value; },
  mount(strict) {
    store.setState({ sessionPath: '/synthetic/session', messages: history });
    store.getState().setSessionModel({ model: 'model-a', provider: 'fixture' });
    const r = createRoot(document.getElementById('root'));
    const render = (showHeader = true) => {
      const app = h(App, { showHeader });
      r.render(strict ? h(StrictMode, null, app) : app);
    };
    render();
    return { render, unmount: () => r.unmount() };
  }
};
`);

async function fixture(t, { strict = false } = {}) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  let mounted;
  await f.act(async () => { mounted = f.mount(strict); });
  t.after(async () => {
    try { await f.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  assert.equal(f.catalogues.length, 1);
  assert.equal(f.catalogues[0].path, '/synthetic/session');
  return { ...f, w,
    patch: patch => f.act(async () => f.store.getState().setSessionModel(patch)),
    finish: (index = 0, models = f.models) => f.act(async () => f.catalogues[index].resolve(models)),
    render: show => f.act(async () => mounted.render(show)),
    navigate: (path, model) => f.act(async () => {
      f.store.getState().beginSession(path);
      f.store.getState().setSessionModel(model);
      f.store.getState().setHistory(f.history);
    }),
    peek: response => f.act(async () => {
      f.setStateResponse(response);
      w.document.dispatchEvent(new w.Event('visibilitychange'));
    }),
    model: () => f.store.getState().sessionModel,
    percent: () => f.selectContextPercent(f.store.getState()),
    // The context figure and tone the composer's ring is fed, or null when there is none.
    meter: () => {
      const el = w.document.querySelector('[data-testid="context-probe"]');
      return el ? `${el.textContent} ${el.getAttribute('data-tone')}` : null;
    },
    cache: () => JSON.parse(w.localStorage.getItem('omp-model-context-windows') ?? '{}'),
  };
}

test('late A catalogue cannot overwrite the actual picker selection, live B window or B cache', async t => {
  const f = await fixture(t);
  await f.act(async () => f.w.document.querySelector('[data-testid="model-probe"]').click());
  await f.finish(1);
  f.setStateResponse({ model: { id: 'model-b', provider: 'fixture', contextWindow: 1000000 } });
  await f.act(async () => f.w.document.querySelector('button[data-model="fixture/model-b"]').click());
  assert.deepEqual(Array.from(f.mutations[0]), ['/synthetic/session', 'fixture', 'model-b']);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.model().contextWindow, 1000000);
  const selected = f.model();

  await f.finish();
  assert.equal(f.model(), selected);
  assert.equal(f.model().model, 'model-b');
  assert.equal(f.model().contextWindow, 1000000);
  assert.equal(f.percent(), 9.5);
  assert.equal(f.meter(), '10% muted');
  assert.equal(f.w.document.querySelector('[data-testid="model-context"]').getAttribute('aria-label'), 'Context 10% used');
  assert.equal(f.w.document.querySelector('button[data-model="fixture/model-b"]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.contextWindowFor('model-b'), 1000000);
  assert.equal(f.cache()['model-b'], 1000000);
  assert.ok(f.stateCalls.every(([, options]) => options.peek === true));
});

test('old model cannot fill an unresolved replacement model; each catalogue still warms its own cache', async t => {
  const f = await fixture(t);
  await f.patch({ model: 'model-b' });
  assert.equal(f.catalogues.length, 2);
  const selected = f.model();
  await f.finish(0, [f.models[0]]);
  assert.equal(f.model(), selected);
  assert.equal(f.model().contextWindow, undefined);
  assert.equal(f.percent(), undefined);
  assert.equal(f.meter(), null);
  assert.equal(f.cache()['model-a'], 100000);
  assert.equal(f.cache()['model-b'], undefined);

  await f.finish(1, [f.models[1]]);
  assert.equal(f.model().contextWindow, 1000000);
  assert.equal(f.percent(), 9.5);
  assert.equal(f.cache()['model-b'], 1000000);
});

test('newer live same-model window survives the older catalogue completion', async t => {
  const f = await fixture(t);
  await f.peek({ model: { id: 'model-a', provider: 'fixture', contextWindow: 1000000 }, thinkingLevel: 'high' });
  const current = f.model();
  assert.equal(current.contextWindow, 1000000);
  await f.finish();
  assert.equal(f.model(), current);
  assert.equal(f.model().contextWindow, 1000000);
  assert.equal(f.model().thinkingLevel, 'high');
  assert.equal(f.percent(), 9.5);
  assert.equal(f.meter(), '10% muted');
  // Shared same-model cache source precedence is deliberately separate from
  // the active-store race; this assertion makes the scope explicit.
  assert.equal(f.cache()['model-a'], 100000);
});

test('unchanged unresolved model learns its window and renders the real figure in red', async t => {
  const f = await fixture(t);
  await f.finish();
  assert.equal(f.model().contextWindow, 100000);
  assert.equal(f.percent(), 95);
  assert.equal(f.meter(), '95% red');
  assert.equal(f.cache()['model-a'], 100000);
  assert.equal(f.cache()['model-b'], 1000000);
  assert.equal(f.mutations.length, 0);
});

test('thinking-only rerender retains new metadata while learning the current model window', async t => {
  const f = await fixture(t);
  await f.patch({ thinkingLevel: 'high', fastMode: true });
  await f.finish();
  assert.equal(f.model().contextWindow, 100000);
  assert.equal(f.model().thinkingLevel, 'high');
  assert.equal(f.model().fastMode, true);
  assert.equal(f.meter(), '95% red');
  assert.equal(f.catalogues.length, 1);
});

test('changed session path keeps its unresolved store value while the old catalogue warms', async t => {
  const f = await fixture(t);
  await f.navigate('/synthetic/other', { model: 'model-a', provider: 'fixture' });
  const current = f.model();
  await f.finish();
  assert.equal(f.model(), current);
  assert.equal(f.model().contextWindow, undefined);
  assert.equal(f.store.getState().sessionPath, '/synthetic/other');
  assert.equal(f.cache()['model-a'], 100000);
});

test('session A to other to A remount keeps the new authoritative same-model window', async t => {
  const f = await fixture(t);
  await f.navigate('/synthetic/other', { model: 'model-b', contextWindow: 1000000 });
  await f.navigate('/synthetic/session', { model: 'model-a', contextWindow: 1000000 });
  const current = f.model();
  await f.finish();
  assert.equal(f.model(), current);
  assert.equal(f.model().contextWindow, 1000000);
  assert.equal(f.percent(), 9.5);
  assert.equal(f.meter(), '10% muted');
});

test('model A to B to A roundtrip keeps its newer explicit window and current metadata', async t => {
  const f = await fixture(t);
  await f.patch({ model: 'model-b', contextWindow: 1000000 });
  await f.patch({ model: 'model-a', contextWindow: 2000000, thinkingLevel: 'low' });
  const current = f.model();
  await f.finish();
  assert.equal(f.model(), current);
  assert.equal(f.model().contextWindow, 2000000);
  assert.equal(f.model().thinkingLevel, 'low');
  assert.equal(f.percent(), 4.8);
});

test('provider-only switch with a new explicit window preserves that live value', async t => {
  const f = await fixture(t);
  await f.patch({ provider: 'other-provider', contextWindow: 1000000 });
  const current = f.model();
  await f.finish();
  assert.equal(f.model(), current);
  assert.equal(f.model().provider, 'other-provider');
  assert.equal(f.model().contextWindow, 1000000);
  assert.equal(f.meter(), '10% muted');
});

test('StrictMode effect replay still learns from its single pending catalogue request', async t => {
  const f = await fixture(t, { strict: true });
  await f.finish();
  assert.equal(f.catalogues.length, 1);
  assert.equal(f.model().contextWindow, 100000);
  assert.equal(f.meter(), '95% red');
});

test('same-session header remount still learns from the deduplicated pending request', async t => {
  const f = await fixture(t);
  await f.render(false);
  await f.render(true);
  assert.equal(f.catalogues.length, 1);
  await f.finish();
  assert.equal(f.model().contextWindow, 100000);
  assert.equal(f.meter(), '95% red');
});

test('catalogue without this model leaves its unknown window unchanged', async t => {
  const f = await fixture(t);
  const current = f.model();
  await f.finish(0, [f.models[1]]);
  assert.equal(f.model(), current);
  assert.equal(f.model().contextWindow, undefined);
  assert.equal(f.meter(), null);
  assert.equal(f.cache()['model-a'], undefined);
  assert.equal(f.cache()['model-b'], 1000000);
});


test('newest assistant owns derived context while the open model picker clears and recovers', async t => {
  const f = await fixture(t);
  await f.finish();
  await f.act(async () => f.w.document.querySelector('[data-testid="model-probe"]').click());
  await f.finish(1);
  // The picker footer's ContextMeter carries the figure in its accessible name.
  const text = () => f.w.document.querySelector('[data-testid="model-context"]')?.getAttribute('aria-label') ?? '';
  const history = async newest => f.act(async () => f.store.getState().setHistory([...f.history, newest]));
  assert.equal(f.percent(), 95);
  assert.match(text(), /95% used/);
  await history({ id: 'newest', role: 'assistant', parts: [] });
  assert.equal(f.percent(), undefined);
  assert.equal(f.meter(), null);
  assert.doesNotMatch(text(), /95% used/);
  await history({ id: 'newest', role: 'assistant', parts: [], contextSnapshot: { promptTokens: 0 } });
  assert.equal(f.percent(), 0);
  assert.equal(f.meter(), '0% muted');
  assert.match(text(), /0% used/);
  await history({ id: 'newest', role: 'assistant', parts: [], contextSnapshot: { promptTokens: 80000 } });
  assert.equal(f.percent(), 80);
  assert.equal(f.meter(), '80% amber');
  assert.match(text(), /80% used/);
});

test('derived context uses only a usable newest assistant snapshot, ignoring trailing other roles', async t => {
  const f = await fixture(t);
  await f.finish();
  const state = f.store.getState();
  for (const promptTokens of [undefined, -1, NaN, Infinity, -Infinity]) {
    const messages = [...f.history, { id: 'newest', role: 'assistant', parts: [], contextSnapshot: { promptTokens } }];
    assert.equal(f.selectContextPercent({ ...state, messages }), undefined, String(promptTokens));
  }
  const newest = { id: 'newest', role: 'assistant', parts: [], contextSnapshot: { promptTokens: 40000 } };
  assert.equal(f.selectContextPercent({ ...state, messages: [...f.history, newest,
    { id: 'user', role: 'user', parts: [] }, { id: 'tool', role: 'tool', parts: [] }] }), 40);
  assert.equal(f.selectContextPercent({ ...state, sessionModel: { model: 'unknown-model' } }), undefined);
  assert.equal(f.selectContextPercent({ ...state, sessionModel: { ...state.sessionModel, ctxPercent: 12 } }), 12);
  assert.equal(f.selectContextPercent({ ...state, sessionModel: { ...state.sessionModel, ctxPercent: 0 } }), 0);
});
