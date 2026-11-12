import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingDeletes } from '../src/app/sessions/pending-delete.ts';

// A manual clock: timers run only when the test says the window has passed.
function fixture() {
  const timers = new Map();
  let next = 0;
  const store = createPendingDeletes(5000, {
    set: (run) => { timers.set(++next, run); return next; },
    clear: (handle) => { timers.delete(handle); },
  });
  const tick = () => { for (const [handle, run] of [...timers]) { timers.delete(handle); run(); } };
  const calls = { removed: [], failed: [] };
  const remove = (path, outcome = Promise.resolve()) => () => { calls.removed.push(path); return outcome; };
  const onFail = (cause) => calls.failed.push(cause);
  return { store, timers, tick, calls, remove, onFail };
}
const settle = () => new Promise((done) => setImmediate(done));

test('scheduling hides the path at once and defers the daemon call', () => {
  const f = fixture();
  f.store.schedule('/a', f.remove('/a'), f.onFail);
  assert.deepEqual([...f.store.hiddenPaths()], ['/a']);
  assert.deepEqual(f.calls.removed, []);
});

test('undo cancels the timer and restores the row', () => {
  const f = fixture();
  f.store.schedule('/a', f.remove('/a'), f.onFail);
  assert.equal(f.store.undo('/a'), true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.store.hiddenPaths().size, 0);
  f.tick();
  assert.deepEqual(f.calls.removed, []);
});

test('expiry deletes once and the path stays hidden afterwards', async () => {
  const f = fixture();
  f.store.schedule('/a', f.remove('/a'), f.onFail);
  f.tick();
  await settle();
  assert.deepEqual(f.calls.removed, ['/a']);
  assert.deepEqual([...f.store.hiddenPaths()], ['/a']);
  assert.equal(f.store.undo('/a'), false);
});

test('a refused delete restores the row and reports the cause', async () => {
  const f = fixture();
  const refusal = new Error('owned by the computer');
  f.store.schedule('/a', f.remove('/a', Promise.reject(refusal)), f.onFail);
  f.tick();
  await settle();
  assert.equal(f.store.hiddenPaths().size, 0);
  assert.deepEqual(f.calls.failed, [refusal]);
});

test('flush runs every waiting delete now and leaves no timers', async () => {
  const f = fixture();
  f.store.schedule('/a', f.remove('/a'), f.onFail);
  f.store.schedule('/b', f.remove('/b'), f.onFail);
  f.store.flush();
  await settle();
  assert.deepEqual(f.calls.removed, ['/a', '/b']);
  assert.equal(f.timers.size, 0);
});

test('subscribers hear every change and scheduling twice is one delete', () => {
  const f = fixture();
  let heard = 0;
  f.store.subscribe(() => { heard++; });
  f.store.schedule('/a', f.remove('/a'), f.onFail);
  f.store.schedule('/a', f.remove('/a'), f.onFail);
  f.store.undo('/a');
  assert.equal(heard, 2);
  assert.equal(f.timers.size, 0);
});
