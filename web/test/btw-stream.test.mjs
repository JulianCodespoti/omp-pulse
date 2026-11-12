import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_BTW, adoptBtwRecord, latestBtwTurn, mergeBtwHistory, reduceBtwFrame,
} from '../src/runtime/btw.ts';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// omp 18.8.6 frame shapes (wire/frames.ts BtwDeltaEvent / BtwRecordEvent).
const record = (fields = {}) => ({ id: 'b1', question: 'why the lock?', answer: '', status: 'running', leafId: 'l1', createdAt: 1, updatedAt: 1, ...fields });
const started = { type: 'btw_record', record: record() };
const delta = (text, recordId = 'b1') => ({ type: 'btw_delta', recordId, delta: text });

test('deltas accumulate onto the running answer and the final record wins', () => {
  let state = reduceBtwFrame(EMPTY_BTW, '/s.jsonl', started);
  state = reduceBtwFrame(state, '/s.jsonl', delta('Two workers '));
  state = reduceBtwFrame(state, '/s.jsonl', delta('race.'));
  assert.equal(state.records[0].answer, 'Two workers race.');
  state = reduceBtwFrame(state, '/s.jsonl', { type: 'btw_record', record: record({ answer: 'Two workers race on it.', status: 'complete' }) });
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].answer, 'Two workers race on it.');
  assert.equal(state.records[0].status, 'complete');
  // A straggling delta cannot extend a finished answer.
  assert.equal(reduceBtwFrame(state, '/s.jsonl', delta(' again')), state);
});

test('a follow-up streams into its own turn, not the topic question', () => {
  let state = reduceBtwFrame(EMPTY_BTW, '/s.jsonl', { type: 'btw_record', record: record({ answer: 'First.', status: 'complete', followUps: [{ question: 'and then?', answer: '', status: 'running', createdAt: 2, updatedAt: 2 }] }) });
  state = reduceBtwFrame(state, '/s.jsonl', delta('Second.'));
  assert.equal(state.records[0].answer, 'First.');
  assert.equal(latestBtwTurn(state.records[0]).answer, 'Second.');
});

test('frames for an unknown record or another session do not leak in', () => {
  const state = reduceBtwFrame(EMPTY_BTW, '/a.jsonl', started);
  assert.equal(reduceBtwFrame(state, '/a.jsonl', delta('x', 'other')), state);
  assert.equal(reduceBtwFrame(state, '/b.jsonl', delta('x')), state);
  const switched = reduceBtwFrame(state, '/b.jsonl', { type: 'btw_record', record: record({ id: 'b2' }) });
  assert.deepEqual(switched.records.map((r) => r.id), ['b2']);
  assert.equal(switched.path, '/b.jsonl');
});

test('history keeps text streamed while it was in flight, and newer records', () => {
  let state = reduceBtwFrame(EMPTY_BTW, '/s.jsonl', started);
  state = reduceBtwFrame(state, '/s.jsonl', delta('Two workers race.'));
  const merged = mergeBtwHistory(state, '/s.jsonl', [record({ answer: 'Two' }), record({ id: 'old', question: 'q0', answer: 'done', status: 'complete' })]);
  assert.deepEqual(merged.records.map((r) => r.id), ['b1', 'old']);
  assert.equal(merged.records[0].answer, 'Two workers race.');
  // A record omp has not listed yet but is answering stays at the top.
  const missing = mergeBtwHistory(state, '/s.jsonl', [record({ id: 'old', question: 'q0', answer: 'done', status: 'complete' })]);
  assert.deepEqual(missing.records.map((r) => r.id), ['b1', 'old']);
  // A finished snapshot replaces the local copy.
  const finished = mergeBtwHistory(state, '/s.jsonl', [record({ answer: 'Two workers race.', status: 'complete' })]);
  assert.equal(finished.records[0].status, 'complete');
});

test('the btw reply never erases an answer the socket already streamed', () => {
  let state = reduceBtwFrame(EMPTY_BTW, '/s.jsonl', started);
  state = reduceBtwFrame(state, '/s.jsonl', delta('Already here.'));
  assert.equal(adoptBtwRecord(state, '/s.jsonl', record()).records[0].answer, 'Already here.');
  const fresh = adoptBtwRecord(EMPTY_BTW, '/s.jsonl', record());
  assert.equal(fresh.records[0].id, 'b1');
  assert.equal(adoptBtwRecord(EMPTY_BTW, '/s.jsonl', { nope: true }), EMPTY_BTW);
});

const require = createRequire(resolve(root, 'web/package.json'));
const sheetCode = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { BtwSheet } from ${JSON.stringify(resolve(root, 'web/src/app/chat/BtwSheet.tsx'))};
import { createBtwStore, reduceBtwFrame } from ${JSON.stringify(resolve(root, 'web/src/runtime/btw.ts'))};
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
const calls = [], store = createBtwStore(), controller = { getBtwStore: () => store };
DaemonApi.prototype.rpc = function(path, command, args) {
  return new Promise((resolve, reject) => calls.push({ path, command, args, resolve, reject }));
};
window.sheetFixture = { act, calls, store,
  frame(path, frame) { store.setState(reduceBtwFrame(store.getState(), path, frame)); },
  mount() {
    const root = createRoot(document.getElementById('root'));
    let props = { open: true, seed: { question: '' }, sessionPath: '/a', controller, onOpenChange: () => {} };
    const render = (change = {}) => { props = { ...props, ...change }; root.render(h(BtwSheet, props)); };
    render();
    return { render, unmount: () => root.unmount() };
  },
};
`);

async function sheet(t) {
  const dom = createDomFixture(sheetCode), w = dom.window, f = w.sheetFixture;
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let mounted, dead = false;
  await f.act(async () => { mounted = f.mount(); });
  const unmount = async () => { if (!dead) { dead = true; await f.act(async () => mounted.unmount()); } };
  t.after(async () => { try { await unmount(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const input = () => w.document.querySelector('[data-testid="btw-input"]');
  const type = text => f.act(async () => {
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input(), text);
    input().dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  return {
    ...f, w, input, unmount, type,
    render: props => f.act(async () => mounted.render(props)),
    ask: async text => { await type(text); await f.act(async () => w.document.querySelector('[data-testid="btw-ask"]').click()); },
    finish: (call, data) => f.act(async () => call.resolve(data)),
    fail: call => f.act(async () => call.reject(new Error('stale synthetic refusal'))),
    frame: (path, frame) => f.act(async () => f.frame(path, frame)),
    rpc: command => f.calls.filter(call => call.command === command),
    busy: () => w.document.querySelector('[data-testid="btw-ask"]')?.disabled ?? true,
  };
}

for (const fails of [false, true]) {
  test(`late ${fails ? 'failure' : 'success'} from A cannot retarget B or release B's pending request`, async t => {
    const f = await sheet(t);
    await f.ask('A question');
    const old = f.rpc('btw')[0];
    await f.render({ sessionPath: '/b' });
    await f.ask('B question');
    await f.frame('/b', { type: 'btw_record', record: record({ id: 'b' }) });
    await f.frame('/b', delta('B streamed', 'b'));
    const before = f.store.getState();
    if (fails) await f.fail(old);
    else await f.finish(old, { record: record({ id: 'a' }) });
    assert.equal(f.store.getState(), before, 'the persistent store keeps B and all its deltas');
    assert.equal(f.store.getState().path, '/b');
    assert.equal(f.store.getState().records[0].answer, 'B streamed');
    assert.equal(f.input().value, '', 'an old failure cannot restore A into B');
    assert.equal(f.w.document.body.textContent.includes('stale synthetic refusal'), false);
    // Finish B's streaming record, leaving its HTTP request pending. The old
    // finally must not unlock this request even after the socket goes idle.
    await f.frame('/b', { type: 'btw_record', record: record({ id: 'b', answer: 'B streamed', status: 'complete' }) });
    await f.type('Another B question');
    assert.equal(f.busy(), true);
    assert.equal(f.rpc('btw').length, 2);
  });

  test(`A → B → A rejects the first visit's late ${fails ? 'failure' : 'success'}`, async t => {
    const f = await sheet(t);
    await f.ask('Old A');
    const old = f.rpc('btw')[0];
    await f.render({ sessionPath: '/b' });
    await f.render({ sessionPath: '/a' });
    await f.ask('Current A');
    await f.frame('/a', { type: 'btw_record', record: record({ id: 'current', answer: 'new deltas' }) });
    const before = f.store.getState();
    if (fails) await f.fail(old);
    else await f.finish(old, { record: record({ id: 'old' }) });
    assert.equal(f.store.getState(), before);
    await f.frame('/a', { type: 'btw_record', record: record({ id: 'current', answer: 'new deltas', status: 'complete' }) });
    await f.type('Next draft');
    assert.equal(f.busy(), true, 'the current request, not the path alone, owns pending');
    assert.equal(f.input().value, 'Next draft');
  });
}

test('dismiss/reopen fences an old follow-up but accepts current history and stream before its RPC acknowledgement', async t => {
  const f = await sheet(t);
  const topic = record({ id: 'topic', answer: 'First answer', status: 'complete' });
  await f.finish(f.rpc('get_btw_history')[0], { records: [topic] });
  await f.act(async () => [...f.w.document.querySelectorAll('button')].find(b => b.textContent.includes(topic.question)).click());
  await f.ask('Old follow-up');
  assert.equal(f.rpc('btw')[0].args.recordId, 'topic');
  await f.render({ open: false });
  await f.render({ open: true, seed: { question: '' } });
  // The thread and its draft now survive a close; this visit starts from the list.
  assert.equal(f.w.document.querySelector('[data-testid="btw-thread"]') !== null, true);
  await f.act(async () => f.w.document.querySelector('button[aria-label="All side questions"]').click());
  await f.ask('Current question');
  await f.frame('/a', { type: 'btw_record', record: record({ id: 'current' }) });
  await f.frame('/a', delta('Already streaming', 'current'));
  await f.finish(f.rpc('get_btw_history').at(-1), { records: [topic, record({ id: 'current' })] });
  await f.finish(f.rpc('btw')[0], { record: { ...topic, followUps: [{ question: 'Old follow-up', answer: '', status: 'running' }] } });
  assert.equal(f.store.getState().records.some(r => r.id === 'topic' && r.followUps?.length), false);
  await f.finish(f.rpc('btw')[1], { record: record({ id: 'current' }) });
  assert.equal(f.store.getState().records.find(r => r.id === 'current').answer, 'Already streaming');
  assert.equal(f.w.document.querySelector('[data-testid="btw-thread"]') !== null, true);
  await f.frame('/a', { type: 'btw_record', record: record({ id: 'current', answer: 'Already streaming', status: 'complete' }) });
  await f.ask('Valid follow-up');
  assert.equal(f.rpc('btw').at(-1).args.recordId, 'current');
});

test('closing and reopening keeps the half-typed question per conversation', async t => {
  const f = await sheet(t);
  await f.type('half a ques');
  await f.render({ open: false });
  await f.render({ open: true, seed: { question: '' } });
  assert.equal(f.input().value, 'half a ques');
  await f.render({ sessionPath: '/b' });
  assert.equal(f.input().value, '');
  await f.render({ sessionPath: '/a' });
  assert.equal(f.input().value, 'half a ques');
});

for (const departure of ['credential', 'unmount']) {
  test(`${departure} fences a late side-question acknowledgement and history`, async t => {
    const f = await sheet(t);
    await f.ask('Old question');
    const before = f.store.getState();
    if (departure === 'credential') f.w.localStorage.setItem('omp-remote-token', 'replacement');
    else await f.unmount();
    await f.finish(f.rpc('btw')[0], { record: record() });
    await f.finish(f.rpc('get_btw_history')[0], { records: [record()] });
    assert.equal(f.store.getState(), before);
  });
}

test('current follow-up survives history and HTTP snapshots that predate its streamed turn', async t => {
  const f = await sheet(t);
  const topic = record({ id: 'topic', answer: 'First answer', status: 'complete' });
  await f.frame('/a', { type: 'btw_record', record: topic });
  await f.act(async () => [...f.w.document.querySelectorAll('button')].find(b => b.textContent.includes(topic.question)).click());
  await f.ask('Current follow-up');
  const followUp = { question: 'Current follow-up', answer: '', status: 'running', createdAt: 2, updatedAt: 2 };
  await f.frame('/a', { type: 'btw_record', record: { ...topic, followUps: [followUp] } });
  await f.frame('/a', delta('Follow-up already streamed', 'topic'));
  await f.finish(f.rpc('get_btw_history')[0], { records: [topic] });
  assert.equal(latestBtwTurn(f.store.getState().records[0]).answer, 'Follow-up already streamed');
  await f.finish(f.rpc('btw')[0], { record: { ...topic, followUps: [followUp] } });
  assert.equal(f.store.getState().records[0].followUps.length, 1);
  assert.equal(latestBtwTurn(f.store.getState().records[0]).answer, 'Follow-up already streamed');
  assert.equal(f.rpc('btw')[0].args.recordId, 'topic');
});
