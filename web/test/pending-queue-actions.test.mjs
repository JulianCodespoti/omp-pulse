import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingQueueActions } from '../src/app/chat/pending-queue-actions.ts';

test('different rows remain pending independently', () => {
  const pending = new PendingQueueActions();
  const one = pending.begin('one'), two = pending.begin('two');
  assert(pending.isCurrent('one', one));
  assert(pending.isCurrent('two', two));
  assert(pending.finish('one', one));
  assert(pending.isCurrent('two', two));
});
test('a second click on a pending row cannot start another action', () => {
  const pending = new PendingQueueActions();
  const token = pending.begin('row');
  assert.equal(pending.begin('row'), null);
  assert(pending.isCurrent('row', token));
});
test('out-of-order completion releases only its own row', () => {
  const pending = new PendingQueueActions();
  const one = pending.begin('one'), two = pending.begin('two');
  assert(pending.finish('two', two));
  assert(pending.isCurrent('one', one));
  assert.equal(pending.finish('one', two), false);
  assert(pending.finish('one', one));
});
test('session change invalidates old outcomes even when row text/key is reused', () => {
  const pending = new PendingQueueActions();
  const old = pending.begin('same row');
  pending.reset();
  const current = pending.begin('same row');
  assert.equal(pending.isCurrent('same row', old), false);
  assert.equal(pending.finish('same row', old), false);
  assert(pending.isCurrent('same row', current));
});
test('completed row can be used again without a stale completion clearing it', () => {
  const pending = new PendingQueueActions();
  const old = pending.begin('row');
  pending.finish('row', old);
  const current = pending.begin('row');
  assert.notEqual(old, current);
  assert.equal(pending.finish('row', old), false);
  assert(pending.isCurrent('row', current));
});
