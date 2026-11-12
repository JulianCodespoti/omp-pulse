import test from 'node:test';
import assert from 'node:assert/strict';
import { admit, dragOffsetY, dropUndo, expire, isToastPaused, swipeOutcome, toastDurationMs } from '../src/app/toast-stack.ts';

// A toast as showToast builds it. `action`/`kind` decide who may displace whom.
const input = (message, extra = {}) => ({ message, tone: 'info', durationMs: 2200, ...extra });
const undo = (message = 'Conversation deleted', extra = {}) =>
  input(message, { action: { label: 'Undo', onClick() {} }, kind: 'undo', durationMs: 5000, ...extra });
const open = (message, extra = {}) => input(message, { action: { label: 'Open', onClick() {} }, durationMs: null, ...extra });

// Admit a sequence; ids count up the way showToast's sequence does.
const run = (...inputs) => inputs.reduce((stack, toast, i) => admit(stack, toast, i, i + 1), []);
const messages = stack => stack.map(t => t.message);

test('toast time grows with the text: 4 s error and 2.2 s info base, +40 ms per character past 60, capped at 8 s', () => {
  assert.equal(toastDurationMs('Short failure', 'error'), 4000);
  assert.equal(toastDurationMs('Copied', 'info'), 2200);
  assert.equal(toastDurationMs('x'.repeat(100), 'info'), 2200 + 40 * 40);
  assert.equal(toastDurationMs('y'.repeat(900), 'warn'), 8000);
});

test('an Undo survives a later passive toast, which shows below it', () => {
  const stack = run(undo(), input('Copied', { tone: 'success' }));
  assert.deepEqual(messages(stack), ['Conversation deleted', 'Copied']);
  // Even with the stack full, a passive newcomer takes the passive slot.
  assert.deepEqual(messages(admit(stack, input('Saved', { tone: 'success' }), 9, 9)), ['Conversation deleted', 'Saved']);
});

test('a toast of the same group, or the same message and tone, updates in place and restarts', () => {
  const first = run(open('Reply ready', { group: 'reply-ready', title: 'Fix build' }), input('Copied'));
  const grouped = admit(first, open('2 replies ready', { group: 'reply-ready', title: 'Fix build' }), 50, 3);
  assert.deepEqual(messages(grouped), ['2 replies ready', 'Copied']);
  assert.equal(grouped[0].id, first[0].id);
  assert.equal(grouped[0].revision, 1);
  assert.equal(grouped[0].startedAt, 50);
  const repeated = admit(first, input('Copied'), 60, 4);
  assert.equal(repeated.length, 2);
  assert.equal(repeated[1].revision, 1);
  // Same text, different tone: a different toast.
  assert.deepEqual(messages(admit(run(input('Done')), input('Done', { tone: 'warn' }), 1, 2)), ['Done', 'Done']);
});

test('two deletions never merge: each keeps its own Undo', () => {
  const stack = run(undo('Conversation deleted'), undo('Conversation deleted'));
  assert.equal(stack.length, 2);
  assert.equal(stack[0].action !== stack[1].action, true);
});

test('the third toast replaces the oldest passive one, not an action toast', () => {
  assert.deepEqual(messages(run(input('a'), input('b'), input('c'))), ['b', 'c']);
  assert.deepEqual(messages(run(open('go'), input('b'), input('c'))), ['go', 'c']);
  // The newcomer lands below the survivor.
  assert.deepEqual(messages(run(input('a'), open('go'), input('c'))), ['go', 'c']);
});

test('two action toasts plus an Undo keep the Undo', () => {
  // Both visible have actions: the oldest that is not an undo goes.
  assert.deepEqual(messages(run(open('A1'), undo(), open('A2'))), ['Conversation deleted', 'A2']);
  assert.deepEqual(messages(run(open('A1'), open('A2'), undo())), ['A2', 'Conversation deleted']);
  // A passive toast cannot displace the Undo even when the other slot is an action toast.
  assert.deepEqual(messages(run(open('A1'), undo(), input('Copied'))), ['Conversation deleted', 'Copied']);
  // With two Undos only an action toast can replace one, and it replaces the older.
  const two = run(undo('first'), undo('second'));
  assert.deepEqual(messages(admit(two, input('Copied'), 9, 9)), ['first', 'second']);
  assert.deepEqual(messages(admit(two, open('Open'), 9, 9)), ['second', 'Open']);
  assert.deepEqual(messages(admit(two, undo('third'), 9, 9)), ['second', 'third']);
});

test('a routine info or success cannot replace an unread plain error; a warning, an error or an action can', () => {
  const full = run(input('Disk is full', { tone: 'error', durationMs: 4000 }), open('go'));
  // The error is protected, so the routine toast takes the action toast's place, never the error's.
  assert.deepEqual(messages(admit(full, input('Copied'), 9, 9)), ['Disk is full', 'Copied']);
  const errors = run(input('Disk is full', { tone: 'error' }), input('Other failure', { tone: 'error' }));
  assert.equal(admit(errors, input('Copied', { tone: 'success' }), 9, 9), errors);
  assert.deepEqual(messages(admit(errors, input('Careful', { tone: 'warn' }), 9, 9)), ['Other failure', 'Careful']);
  assert.deepEqual(messages(admit(errors, input('Third failure', { tone: 'error' }), 9, 9)), ['Other failure', 'Third failure']);
  assert.deepEqual(messages(admit(errors, undo('Session deleted'), 9, 9)), ['Other failure', 'Session deleted']);
});

test('expire removes one toast; an Undo ignores pause and is dropped when the page hides', () => {
  const stack = run(undo(), input('Copied'));
  assert.deepEqual(messages(expire(stack, stack[0].id)), ['Copied']);
  assert.equal(expire(stack, 99), stack);

  assert.equal(isToastPaused(stack[0], true), false);
  assert.equal(isToastPaused(stack[1], true), true);
  assert.equal(isToastPaused(stack[1], false), false);

  assert.deepEqual(messages(dropUndo(stack)), ['Copied']);
  const plain = run(input('a'), open('b'));
  assert.equal(dropUndo(plain), plain);
});

test('a drag up or sideways past 48 px, or a quick flick, dismisses; a short drag springs back; down never dismisses', () => {
  assert.equal(swipeOutcome(0, -49, 0, 0), 'up');
  assert.equal(swipeOutcome(0, -48, 0, 0), 'back');
  assert.equal(swipeOutcome(60, -5, 0, 0), 'right');
  assert.equal(swipeOutcome(-60, 5, 0, 0), 'left');
  assert.equal(swipeOutcome(4, -20, 0, -0.9), 'up');
  assert.equal(swipeOutcome(-20, 3, -0.9, 0), 'left');
  // A twitch is not a flick.
  assert.equal(swipeOutcome(0, -4, 0, -2), 'back');
  assert.equal(swipeOutcome(0, 200, 0, 2), 'back');
  assert.equal(swipeOutcome(10, -20, 0, 0), 'back');
  // Diagonal: the longer leg decides.
  assert.equal(swipeOutcome(55, -80, 0, 0), 'up');
  assert.equal(swipeOutcome(90, -60, 0, 0), 'right');
});

test('dragging down moves a third of the distance; up follows the finger', () => {
  assert.equal(dragOffsetY(90), 30);
  assert.equal(dragOffsetY(-90), -90);
  assert.equal(dragOffsetY(0), 0);
});
