import test from 'node:test';
import assert from 'node:assert/strict';
import { sendBlockedReason, sendModeChoiceVisible } from '../src/domain/send-mode.ts';

test('an allowed send has no reason; a terminal-owned chat points to /collab', () => {
  assert.equal(sendBlockedReason(true, 'foreign'), null);
  assert.match(sendBlockedReason(false, 'foreign'), /open on your computer.*\/collab/);
  assert.match(sendBlockedReason(false, undefined), /isn’t available/);
});

test('the send-mode choice arrives with focus, and never where queueing is impossible', () => {
  const base = { running: true, hasContent: false, canQueue: null, canInterrupt: null };
  assert.equal(sendModeChoiceVisible({ ...base, focused: false }), false);
  assert.equal(sendModeChoiceVisible({ ...base, focused: true }), true);
  assert.equal(sendModeChoiceVisible({ ...base, hasContent: true, focused: false }), true);
  assert.equal(sendModeChoiceVisible({ ...base, focused: true, canQueue: false }), false);
  assert.equal(sendModeChoiceVisible({ ...base, running: false, focused: true }), false);
});
