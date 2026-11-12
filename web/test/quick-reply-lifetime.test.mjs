import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act, StrictMode } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { RunSummary } from ${JSON.stringify(resolve(root, 'web/src/app/parts/RunSummary.tsx'))};
import { QuickReplies } from ${JSON.stringify(resolve(root, 'web/src/app/parts/QuickReplies.tsx'))};
window.requests = []; window.sent = []; window.other = [];
window.fixture = { act, mount(props, direct, strict) {
  const r = createRoot(document.getElementById('root'));
  const render = p => {
    const sent = () => window.sent.push([p.sessionPath, p.pendingAsk.id]);
    const other = () => window.other.push([p.sessionPath, p.pendingAsk.id]);
    const child = direct ? h(QuickReplies, { question: {callId:p.pendingAsk.id, question:p.pendingAsk.question, options:p.pendingAsk.options}, sessionPath:p.sessionPath, onOther:other, onSent:sent }) : h(RunSummary, {...p, onOtherQuestion:other, onAnswerSent:sent});
    r.render(strict ? h(StrictMode, null, child) : child);
  };
  render(props); return { render, unmount: () => r.unmount() };
} };
`, [{
  name: 'quick-reply-service-isolation',
  resolveId(id, importer) {
    if (importer?.endsWith('/QuickReplies.tsx') && id === '@/runtime/rpc-client') return '\0rpc';
    if (importer?.endsWith('/RunSummary.tsx') && ['./ToolPart', './ImagePart'].includes(id)) return '\0' + id.slice(2);
    return null;
  },
  load(id) {
    if (id === '\0rpc') return `export const answerPane = (...args) => new Promise((resolve, reject) => window.requests.push({args, resolve, reject}));`;
    if (id === '\0ToolPart') return 'export const ToolPart = () => null;';
    if (id === '\0ImagePart') return 'export const ImagePart = () => null;';
    return null;
  },
}]);

const sessionA = '/synthetic/session-a', sessionB = '/synthetic/session-b';
const ask = id => ({ kind: 'tool', callId: id, name: 'ask', state: 'running', args: { questions: [{ question: `Choose ${id}?`, options: [{ label: 'First π' }, { label: 'Second Ω' }] }] } });
const props = (id = 'q1', sessionPath = sessionA) => ({
  sessionPath, toolsLive: false,
  messages: [{ id: 'message', role: 'assistant', text: '', parts: [ask(id)] }],
  pendingAsk: { id, total: 1, index: 0, question: `Choose ${id}?`, options: ['First π', 'Second Ω'] },
});

async function fixture(t, { direct = false, strict = false } = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  const errors = [];
  w.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
  let mounted, unmounted = false;
  await act(async () => { mounted = w.fixture.mount(props(), direct, strict); });
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => mounted.unmount()); } };
  t.after(async () => {
    try { await unmount(); assert.deepEqual(dom.blocked, []); assert.deepEqual(errors, []); }
    finally { dom.close(); }
  });
  const option = (index = 0) => w.document.querySelectorAll('[data-testid="quick-reply-option"]')[index];
  return {
    w, act, unmount, option,
    replies: () => w.document.querySelector('[data-testid="quick-replies"]'),
    error: () => w.document.querySelector('[role="alert"]')?.textContent ?? null,
    sent: () => Array.from(w.sent, item => Array.from(item)),
    requests: () => Array.from(w.requests, item => JSON.parse(JSON.stringify(item.args))),
    click: (index = 0) => act(async () => option(index).click()),
    render: (id = 'q1', path = sessionA) => act(async () => mounted.render(props(id, path))),
    remount: () => act(async () => { mounted = w.fixture.mount(props(), direct, strict); unmounted = false; }),
    resolve: index => act(async () => w.requests[index].resolve()),
    reject: (index, message, status=400) => act(async () => w.requests[index].reject(Object.assign(new w.Error(message),{status}))),
  };
}

test('same-event repeated taps issue one exact answer and disable every row', async t => {
  const f = await fixture(t);
  assert.equal(f.w.document.querySelector('[data-testid="quick-replies"] [role="radiogroup"]')?.querySelectorAll('[role="radio"]').length, 2);
  assert.equal(f.option(1).getAttribute('role'), 'radio');
  assert.equal(f.option(1).getAttribute('aria-checked'), 'false');
  await f.act(async () => { const button = f.option(1); button.click(); button.click(); });
  assert.deepEqual(f.requests(), [[sessionA, 'Second Ω', { id: 'q1', index: 0, optionIndex: 1 }]]);
  assert.equal(f.replies().getAttribute('aria-busy'), 'true');
  // The row being sent is the checked radio; every row (Other… too) locks.
  assert.equal(f.option(1).getAttribute('aria-checked'), 'true');
  assert.equal(f.option(0).getAttribute('aria-checked'), 'false');
  assert.ok([...f.replies().querySelectorAll('button')].every(button => button.disabled));
});

test('current handoff calls its refresh once but keeps the selected answer visible', async t => {
  const f = await fixture(t); await f.click(); await f.resolve(0);
  assert.deepEqual(f.sent(), [[sessionA, 'q1']]);assert.equal(Boolean(f.replies()),true);assert.equal(f.option().disabled,true);
  await f.render();assert.equal(f.option().disabled,true);assert.equal(f.requests().length,1);assert.ok(f.replies().querySelector('[role="status"]'));
});

test('current rejection shows the error, permits one fresh retry, and then succeeds', async t => {
  const f = await fixture(t); await f.click(); await f.reject(0, 'Synthetic refusal');
  assert.ok(f.error().includes('Synthetic refusal')); assert.equal(f.option().disabled, false);
  assert.equal(f.replies().querySelector('[data-slot="notice"]')?.getAttribute('data-tone'), 'danger');
  assert.equal(f.option(0).getAttribute('aria-checked'), 'false');
  assert.equal(f.replies().getAttribute('aria-busy'), 'false'); assert.deepEqual(f.sent(), []);
  await f.act(async () => { f.option(1).click(); f.option(1).click(); });
  assert.equal(f.error() === null, true); assert.equal(f.requests().length, 2);
  await f.resolve(1); assert.equal(f.option(1).disabled, true); assert.deepEqual(f.sent(), [[sessionA, 'q1']]);
});

test('unconfirmed non-Error transport failure retains the choice without offering resend', async t => {
  const f = await fixture(t); await f.click();
  await f.act(async () => f.w.requests[0].reject('synthetic failure'));
  assert.ok(f.error().includes('Synthetic failure'));assert.equal(f.option().disabled,true);assert.equal(f.option().getAttribute('aria-checked'),'true');
  await f.click();assert.equal(f.requests().length,1);
});

test('late Q1 success cannot change handed-off Q2 or enable duplicate dispatch', async t => {
  const f = await fixture(t); await f.click(); await f.render('q2'); await f.click();
  await f.resolve(1);assert.equal(f.option().disabled,true);
  await f.resolve(0);assert.equal(f.option().disabled,true);
  assert.deepEqual(f.sent(), [[sessionA, 'q2']]);
  assert.equal(f.requests().length, 2);
});

for (const outcome of ['success', 'failure']) {
  test(`late Q1 ${outcome} cannot affect a pending Q2`, async t => {
    const f = await fixture(t); await f.click(); await f.render('q2'); await f.click();
    if (outcome === 'success') await f.resolve(0); else await f.reject(0, 'Obsolete Q1 failure');
    assert.deepEqual(f.sent(), []); assert.equal(f.error() === null, true); assert.equal(f.option().disabled, true);
    await f.click(); assert.equal(f.requests().length, 2);
    await f.resolve(1); assert.equal(f.option().disabled, true); assert.deepEqual(f.sent(), [[sessionA, 'q2']]);
  });

  test(`unmount ignores late ${outcome} and leaves a same-identity remount usable`, async t => {
    const f = await fixture(t); await f.click(); await f.unmount(); await f.remount();
    if (outcome === 'success') await f.resolve(0); else await f.reject(0, 'Unmounted failure');
    assert.deepEqual(f.sent(), []); assert.equal(f.error() === null, true); assert.equal(f.option().disabled, false);
    await f.click(); await f.resolve(1); assert.deepEqual(f.sent(), [[sessionA, 'q1']]);
  });

  test(`session change ignores old ${outcome} with the same call ID`, async t => {
    const f = await fixture(t); await f.click(); await f.render('q1', sessionB);
    assert.equal(f.option().disabled, false, 'new session must get a fresh sending state');
    await f.click();
    if (outcome === 'success') await f.resolve(0); else await f.reject(0, 'Old session failure');
    assert.deepEqual(f.sent(), []); assert.equal(f.error() === null, true); assert.equal(f.option().disabled, true);
    await f.click(); assert.equal(f.requests().length, 2);
    assert.equal(f.requests()[1][0], sessionB);
    await f.resolve(1); assert.equal(f.option().disabled, true); assert.deepEqual(f.sent(), [[sessionB, 'q1']]);
  });
}

test('direct unkeyed question changes reset errors and pending state', async t => {
  const f = await fixture(t, { direct: true }); await f.click(); await f.reject(0, 'Q1 failure');
  await f.render('q2'); assert.equal(f.error() === null, true); assert.equal(f.option().disabled, false);
  await f.click(); await f.render('q3'); assert.equal(f.option().disabled, false);
  await f.click(); await f.reject(1, 'Late Q2 failure');
  assert.equal(f.error() === null, true); assert.equal(f.option().disabled, true);
  await f.resolve(2); assert.deepEqual(f.sent(), [[sessionA, 'q3']]);
});

test('returning to the same session/question does not revive its earlier attempt', async t => {
  const f = await fixture(t, { direct: true }); await f.click();
  await f.render('q1', sessionB); await f.render();
  assert.equal(f.option().disabled, false); await f.click(); await f.resolve(0);
  assert.deepEqual(f.sent(), []); assert.equal(f.option().disabled, true);
  await f.resolve(1); assert.deepEqual(f.sent(), [[sessionA, 'q1']]);
});

test('same-identity prop churn preserves the pending lock and completion', async t => {
  const f = await fixture(t); await f.click(); await f.render();
  assert.equal(f.option().disabled, true); await f.click(); assert.equal(f.requests().length, 1);
  await f.resolve(0); assert.equal(f.option().disabled, true); assert.deepEqual(f.sent(), [[sessionA, 'q1']]);
});

test('StrictMode effect replay keeps a new lifetime usable', async t => {
  const f = await fixture(t, { strict: true }); await f.click(); await f.resolve(0);
  assert.equal(f.requests().length, 1); assert.equal(f.option().disabled, true);
  assert.deepEqual(f.sent(), [[sessionA, 'q1']]);
});

test('Other keeps its existing callback without sending an answer', async t => {
  const f = await fixture(t);
  await f.act(async () => f.w.document.querySelector('[data-testid="quick-reply-other"]').click());
  assert.deepEqual(Array.from(f.w.other, item => Array.from(item)), [[sessionA, 'q1']]);
  assert.deepEqual(f.requests(), []); assert.deepEqual(f.sent(), []);
});
