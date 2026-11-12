import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStopRequest } from '../src/app/sessions/stop-request.ts';

test('acknowledgement means requested, never stopped', async () => {
  const request = new SessionStopRequest();
  assert.equal(await request.run(async () => {}, true), 'requested');
  assert.equal(request.pending, false);
});
test('a daemon that found no agent running says so, not "requested"', async () => {
  const request = new SessionStopRequest();
  assert.equal(await request.run(async () => false, true), 'nothing_running');
  assert.equal(request.pending, false);
  // Only an explicit false: an older daemon or a mock that returns nothing stays "requested".
  assert.equal(await request.run(async () => undefined, true), 'requested');
  assert.equal(await request.run(async () => true, true), 'requested');
});
test('explicit denial prevents dispatch; unknown capability preserves the route', async () => {
  const request = new SessionStopRequest();
  assert.equal(await request.run(async () => assert.fail('must not dispatch'), false), 'unavailable');
  let calls = 0;
  assert.equal(await request.run(async () => { calls++; }, null), 'requested');
  assert.equal(calls, 1);
});
test('a pending card issues only one request', async () => {
  const request = new SessionStopRequest();
  let finish;
  const first = request.run(() => new Promise(resolve => { finish = resolve; }), true);
  assert.equal(request.pending, true);
  assert.equal(await request.run(async () => assert.fail('duplicate'), true), null);
  finish();
  assert.equal(await first, 'requested');
});
test('failures are visible and only an explicit retry dispatches again', async () => {
  const request = new SessionStopRequest();
  let calls = 0;
  const send = async () => { if (!calls++) throw new Error('offline'); };
  assert.equal(await request.run(send, true), 'failed');
  assert.equal(request.pending, false);
  assert.equal(calls, 1);
  assert.equal(await request.run(send, true), 'requested');
  assert.equal(calls, 2);
});
test('unmount/session change ignores a late result without releasing a newer request', async () => {
  const request = new SessionStopRequest();
  let finishOld, finishNew;
  const old = request.run(() => new Promise(resolve => { finishOld = resolve; }), true);
  request.reset();
  const current = request.run(() => new Promise(resolve => { finishNew = resolve; }), true);
  finishOld();
  assert.equal(await old, null);
  assert.equal(request.pending, true);
  finishNew();
  assert.equal(await current, 'requested');
});
test('different cards do not block each other', async () => {
  const one = new SessionStopRequest(), two = new SessionStopRequest();
  let finish;
  const first = one.run(() => new Promise(resolve => { finish = resolve; }), true);
  assert.equal(await two.run(async () => {}, true), 'requested');
  assert.equal(one.pending, true);
  finish();
  await first;
});
