import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { MessageParts } from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import { RefusalNote, RetryNotice, TranscriptActionsContext } from ${JSON.stringify(resolve(root, 'web/src/app/parts/TurnNotices.tsx'))};
import { classifyTurnError, usageResetIn } from ${JSON.stringify(resolve(root, 'web/src/domain/turn-errors.ts'))};
import { buildTimeline } from ${JSON.stringify(resolve(root, 'web/src/domain/timeline.ts'))};
import { entryToUiMessage } from ${JSON.stringify(resolve(root, 'web/src/domain/messages.ts'))};
import { bindUserRowStatus } from ${JSON.stringify(resolve(root, 'web/src/runtime/user-row-status.ts'))};
import { turnOutcome } from ${JSON.stringify(resolve(root, 'web/src/runtime/receipt-outcome.ts'))};
const calls = { switchModel: 0, edits: [], retry: 0 };
const actions = { switchModel: () => { calls.switchModel++; }, editPrompt: text => { calls.edits.push(text); } };
window.fixture = { act, calls, classifyTurnError, usageResetIn, buildTimeline, entryToUiMessage, bindUserRowStatus, turnOutcome,
 mount(node, withActions = true) {
  const r = createRoot(document.getElementById('root'));
  const view = kind => kind.type === 'refusal' ? h(RefusalNote, { text: kind.text })
   : kind.type === 'retry' ? h(RetryNotice, kind.props)
   : h(MessageParts, { message: kind.message, onRetry:kind.retry?()=>calls.retry++:undefined });
  r.render(withActions ? h(TranscriptActionsContext.Provider, { value: actions }, view(node)) : view(node));
  return r;
 } };
`);

async function fixture(t, node, withActions) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  let mounted;
  if (node) await f.act(async () => { mounted = f.mount(node, withActions); });
  t.after(async () => { try { if (mounted) await f.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const get = selector => w.document.querySelector(selector);
  const buttons = () => Array.from(w.document.querySelectorAll('button'), b => b.textContent.trim()).filter(Boolean);
  return { w, f, get, buttons, text: () => w.document.body.textContent,
    click: async label => { const b = Array.from(w.document.querySelectorAll('button')).find(x => x.textContent.trim() === label); assert.ok(b, label); await f.act(async () => b.click()); } };
}

const assistant = (id, errorMessage, extra = {}) => ({ id, role: 'assistant', text: '', parts: [], errorMessage, stopReason: 'error', ...extra });
const user = (id, text, extra = {}) => ({ id, role: 'user', text, parts: text ? [{ kind: 'text', text }] : [], ...extra });
const tool = id => ({ id, role: 'assistant', text: '', parts: [{ kind: 'tool', callId: id, name: 'read', args: {}, state: 'ok' }] });
const reply = id => ({ id, role: 'assistant', text: 'Done.', parts: [{ kind: 'text', text: 'Done.' }] });
const entry = (commandId, text, state, extra = {}) => ({ id: commandId, commandId, sessionPath: '/s', text, state, imageCount: 0, imageBytes: 0, droppedImages: false, createdAt: extra.createdAt ?? 1, updatedAt: 1, ...extra });

test('assistant errors are labelled by what happened, muted unless the turn ended on something to act on', async t => {
  const { f } = await fixture(t);
  const view = (errorMessage, stopReason = 'error') => {
    const v = f.classifyTurnError({ errorMessage, stopReason });
    return v && { label: v.label, tone: v.tone, hidden: !!v.hidden, hint: v.hint ?? '', switchModel: !!v.switchModel, summary: v.summary ?? '' };
  };
  assert.deepEqual(view('Interrupted by user', 'aborted'), { label: 'Stopped', tone: 'muted', hidden: false, hint: '', switchModel: false, summary: '' });
  assert.equal(view('Previous OMP process exited before completing the turn.', 'aborted').label, 'Interrupted by a restart');
  assert.equal(view('Previous OMP process exited before completing the turn.', 'aborted').tone, 'muted');
  assert.equal(view('TTSR matched rule: state-paths', 'aborted').hidden, true);
  for (const raw of ['getaddrinfo ETIMEOUT chatgpt.com', 'Connection error.', 'The socket connection was closed unexpectedly before the response completed', 'The operation timed out.', 'connect ECONNREFUSED 1.2.3.4:443']) {
    const v = view(raw);
    assert.equal(v.label, 'Network issue', raw); assert.equal(v.tone, 'muted', raw);
    assert.equal(v.hint, 'Check your connection; retries automatically', raw);
  }
  const exhausted = view('Retry budget exhausted after 10 retries: getaddrinfo ETIMEOUT chatgpt.com');
  assert.equal(exhausted.tone, 'danger'); assert.equal(exhausted.label, 'Network issue'); assert.equal(exhausted.summary, 'Gave up after 10 retries');
  const usage = view('You have hit your ChatGPT usage limit (self_serve_business_prolite plan). Try again in ~8645 min.');
  assert.equal(usage.label, 'Usage limit reached · resets in ~6 d'); assert.equal(usage.switchModel, true);
  assert.equal(f.usageResetIn('Try again in ~90 min'), '~2 h'); assert.equal(f.usageResetIn('Try again in 20 minutes'), '~20 min');
  assert.equal(view('Refusal (cyber): This request triggered restrictions.').label, 'Declined');
  assert.equal(view('Refusal (cyber): This request triggered restrictions.').switchModel, true);
  assert.equal(view('403 {\n  "error": {\n    "message": "Your plan does not include this model"\n  }\n}').summary, 'Your plan does not include this model');
  assert.equal(view('<html>\n  <head>\n    <meta name="x">').summary, 'The provider sent back an error page.');
  assert.equal(view('Synthetic provider failure').label, 'Provider error');
  assert.equal(view('Synthetic provider failure').tone, 'danger');
  assert.equal(view(undefined, 'stop'), null);
});

test('rendered chips carry their tone; a usage limit offers Switch model; the TTSR re-run renders nothing', async t => {
  const usage = await fixture(t, { message: assistant('a1', 'You have hit your ChatGPT usage limit. Try again in ~8645 min.') });
  assert.equal(usage.get('[data-testid="turn-error"]').dataset.tone, 'danger');
  assert.ok(usage.text().includes('Usage limit reached · resets in ~6 d'));
  assert.ok(usage.buttons().includes('Switch model'));
  await usage.click('Switch model'); assert.equal(usage.f.calls.switchModel, 1);

  const restart = await fixture(t, { message: assistant('a2', 'Previous OMP process exited before completing the turn.', { stopReason: 'aborted' }) });
  assert.equal(restart.get('[data-testid="turn-error"]').dataset.tone, 'info');
  assert.ok(restart.text().includes('Interrupted by a restart')); assert.equal(restart.text().includes('Stopped'), false);

  const network = await fixture(t, { message: assistant('a3', 'getaddrinfo ETIMEOUT chatgpt.com') });
  assert.equal(network.get('[data-testid="turn-error"]').dataset.tone, 'info');
  assert.ok(network.text().includes('Check your connection; retries automatically'));

  const ttsr = await fixture(t, { message: assistant('a4', 'TTSR matched rule: state-paths', { stopReason: 'aborted' }) });
  assert.equal(ttsr.get('[data-testid="turn-error"]') === null, true);

  const bare = await fixture(t, { message: assistant('a5', 'You have hit your ChatGPT usage limit.') }, false);
  assert.equal(bare.buttons().includes('Switch model'), false);
});

test('omp retryRecovery is read from the session file shape', async t => {
  const { f } = await fixture(t);
  const message = f.entryToUiMessage({ type: 'message', id: 'e1', timestamp: '2026-10-14T10:00:00.000Z', message: {
    role: 'assistant', content: [], stopReason: 'error', errorMessage: 'getaddrinfo ETIMEOUT chatgpt.com',
    retryRecovery: { kind: 'auto-retry', status: 'superseded', attempt: 4, recovery: 'plain', note: 'error; retried' } } }, 0);
  assert.equal(message.retry.status, 'superseded'); assert.equal(message.retry.attempt, 4);
  const final = f.entryToUiMessage({ type: 'message', id: 'e2', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Retry budget exhausted after 10 retries: x' } }, 1);
  assert.equal(final.retry === undefined, true);
});

test('retried attempts collapse into one row; only the error a turn ends on stays its own message', async t => {
  const { f } = await fixture(t);
  const attempts = n => Array.from({ length: n }, (_, i) => assistant(`r${i}`, 'getaddrinfo ETIMEOUT chatgpt.com', { retry: { status: 'superseded', attempt: i + 1 } }));
  const recoveredPlan = f.buildTimeline([user('u1', 'go'), tool('t1'), ...attempts(3), tool('t2'), reply('a1')]);
  const kinds = plan => Array.from(plan.filter(item => item.kind !== 'day'), item => item.kind === 'retry' ? `retry:${item.messages.length}:${item.recovered}` : item.kind === 'run' ? `run:${item.continued}` : item.kind);
  assert.deepEqual(kinds(recoveredPlan), ['message', 'run:true', 'retry:3:true', 'run:true', 'message']);

  const exhausted = f.buildTimeline([user('u1', 'go'), ...attempts(10), assistant('x', 'Retry budget exhausted after 10 retries: getaddrinfo ETIMEOUT chatgpt.com')]);
  assert.deepEqual(kinds(exhausted), ['message', 'retry:10:false', 'message']);

  // A TTSR re-run is not shown and does not split the run around it.
  const ttsr = f.buildTimeline([user('u1', 'go'), tool('t1'), assistant('h', 'TTSR matched rule: state-paths', { stopReason: 'aborted' }), tool('t2'), reply('a1')]);
  assert.deepEqual(kinds(ttsr), ['message', 'run:true', 'message']);
  assert.deepEqual(Array.from(ttsr.find(item => item.kind === 'run').messages, m => m.id), ['t1', 't2']);
});

test('the retry row is one muted caption, live while omp retries', async t => {
  const messages = [assistant('r0', 'getaddrinfo ETIMEOUT chatgpt.com', { retry: { status: 'superseded', attempt: 1 } }),
    assistant('r1', 'Connection error.', { retry: { status: 'recovered', attempt: 2 } }), assistant('r2', 'Connection error.', { retry: { status: 'recovered', attempt: 3 } })];
  const done = await fixture(t, { type: 'retry', props: { messages, recovered: true, live: null } });
  assert.equal(done.get('[data-testid="retry-notice"]').textContent, 'Network issue · retried 3×, recovered');
  const live = await fixture(t, { type: 'retry', props: { messages, recovered: false, live: { attempt: 4, maxAttempts: 10, resumeAt: null, error: null } } });
  assert.ok(live.text().startsWith('Network issue · retrying (4/10)'));
  assert.ok(live.text().includes('Check your connection; retries automatically'));
});

test('the refusal note offers Switch model and Edit, and Edit only hands the text back', async t => {
  const f = await fixture(t, { type: 'refusal', text: 'Scan this host' });
  assert.ok(f.text().startsWith('The model declined this request.'));
  assert.deepEqual(f.buttons(), ['Switch model', 'Edit']);
  await f.click('Edit'); assert.deepEqual(Array.from(f.f.calls.edits), ['Scan this host']);
  await f.click('Switch model'); assert.equal(f.f.calls.switchModel, 1);
});

test('receipt codes say how a received turn ended; old failed receipts read the same', async t => {
  const { f } = await fixture(t);
  const outcome = (state, code, error) => f.turnOutcome({ state, receipt: code ? { code, error } : undefined, error });
  assert.equal(outcome('completed', 'agent_aborted', 'The turn was stopped.'), 'stopped');
  assert.equal(outcome('failed', 'agent_aborted', 'The turn was stopped.'), 'stopped');
  assert.equal(outcome('failed', 'agent_failed', 'Refusal (cyber): no'), 'refused');
  assert.equal(outcome('completed', 'agent_refused', 'Refusal (cyber): no'), 'refused');
  assert.equal(outcome('completed', 'agent_interrupted', 'Previous OMP process exited'), 'interrupted');
  assert.equal(outcome('completed', 'agent_failed', 'socket closed'), 'errored');
  assert.equal(outcome('failed', 'agent_rejected', 'Agent is already processing.'), null);
  assert.equal(outcome('failed', undefined, 'agent_failed'), 'errored');
  assert.equal(outcome('forwarded', 'agent_accepted_outcome_untracked', undefined), null);
});

test('status binds to the echo by command id and to transcript rows newest-first, image-only included', async t => {
  const { f } = await fixture(t);
  const summary = map => Object.fromEntries(Array.from(map, ([row, s]) => [row, { pills: Array.from(s.pills, e => e.commandId), refused: s.refused?.commandId ?? null }]));
  // Three "Continue" rows; the middle send is uncertain, the newer one finished.
  const messages = [user('m1', 'Continue'), user('m2', 'Continue'), user('m3', 'Continue')];
  const entries = [entry('c1', 'Continue', 'completed', { createdAt: 1 }), entry('c2', 'Continue', 'uncertain', { createdAt: 2 }), entry('c3', 'Continue', 'completed', { createdAt: 3 })];
  assert.deepEqual(summary(f.bindUserRowStatus(messages, entries, '/s', false)), { m2: { pills: ['c2'], refused: null } });

  // The echo binds exactly, even when an older transcript row has the same text.
  const echoed = [user('m1', 'Continue'), user('local:c9', 'Continue')];
  assert.deepEqual(summary(f.bindUserRowStatus(echoed, [entry('c9', 'Continue', 'failed', { error: 'Agent is already processing.' })], '/s', false)),
    { 'local:c9': { pills: ['c9'], refused: null } });

  // Image-only prompts are keyed by their image count.
  const photo = { ...user('p1', ''), parts: [{ kind: 'image', src: null, mimeType: 'image/png' }, { kind: 'image', src: null, mimeType: 'image/png' }] };
  assert.deepEqual(summary(f.bindUserRowStatus([photo], [entry('i1', '', 'uncertain', { imageCount: 2 })], '/s', false)), { p1: { pills: ['i1'], refused: null } });

  // A refused prompt gets the note, never a pill; a stopped one gets nothing.
  const refused = entry('r1', 'Scan this', 'completed', { receipt: { code: 'agent_refused', error: 'Refusal (cyber): no' }, createdAt: 2 });
  const stopped = entry('s1', 'Stop me', 'failed', { receipt: { code: 'agent_aborted', error: 'The turn was stopped.' } });
  assert.deepEqual(summary(f.bindUserRowStatus([user('u1', 'Stop me'), user('u2', 'Scan this')], [stopped, refused], '/s', false)), { u2: { pills: [], refused: 'r1' } });
  // ...unless the live stream already shows the refusal as the reply.
  assert.deepEqual(summary(f.bindUserRowStatus([user('u2', 'Scan this'), assistant('a', 'Refusal (cyber): no')], [refused], '/s', false)), {});
});

test('model setup replaces turn retry with model choice, without resending the failed prompt',async t=>{
 const f=await fixture(t,{message:assistant('needs-model','agent process exited: No default model selected'),retry:true});
 assert.equal(f.get('[data-testid="retry-turn"]')===null,true);
 await f.click('Choose model');assert.equal(f.f.calls.switchModel,1);assert.equal(f.f.calls.retry,0);
});
test('explicit provider credentials failure opens provider setup rather than another turn or a model picker',async t=>{
 const f=await fixture(t,{message:assistant('needs-auth','401 {\"error\":{\"type\":\"authentication_error\",\"message\":\"Invalid credentials\"}}'),retry:true});
 assert.equal(f.get('[data-testid="retry-turn"]')===null,true);
 await f.click('Model providers');assert.equal(f.f.calls.switchModel,0);assert.equal(f.f.calls.retry,0);
});
