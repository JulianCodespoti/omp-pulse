import assert from 'node:assert/strict';
import test from 'node:test';

import { detectReplyReady, replyPreview, replyRow } from '../src/app/reply-ready.ts';

const row = (path, turn, extra = {}) => ({ path, turn, interrupted: false, ...extra });
const run = (watch, rows, current = null) => detectReplyReady(watch, rows, current);

test('first load fires nothing, whether sessions are idle or already running', () => {
  assert.deepEqual(run(new Map(), [row('/a', 'idle'), row('/b', 'idle')]).ready, []);
  const first = run(new Map(), [row('/a', 'running', { text: 'old' })]);
  assert.deepEqual(first.ready, []);
  assert.deepEqual([...first.watch.keys()], ['/a']);
});

test('running to idle in another session fires once', () => {
  const watching = run(new Map(), [row('/a', 'running', { text: 'old' }), row('/cur', 'running')], '/cur');
  const done = run(watching.watch, [row('/a', 'idle', { text: 'new reply' }), row('/cur', 'idle')], '/cur');
  assert.deepEqual(done.ready, [{ path: '/a', text: 'new reply' }]);
  assert.deepEqual(run(done.watch, [row('/a', 'idle', { text: 'new reply' })], '/cur').ready, []);
});

test('the open session never fires, even after it was watched elsewhere', () => {
  const watching = run(new Map(), [row('/a', 'running')], null);
  assert.deepEqual(run(watching.watch, [row('/a', 'idle', { text: 'x' })], '/a').ready, []);
});

test('stopped, failed and interrupted turns are not replies; unknown keeps the watch', () => {
  const watching = run(new Map(), [row('/a', 'running'), row('/b', 'running'), row('/c', 'running'), row('/d', 'running')]);
  const done = run(watching.watch, [
    row('/a', 'idle', { outcome: 'failed' }),
    row('/b', 'idle', { outcome: 'interrupted' }),
    row('/c', 'idle', { interrupted: true }),
    row('/d', 'unknown'),
  ]);
  assert.deepEqual(done.ready, []);
  assert.deepEqual([...done.watch.keys()], ['/d']);
  assert.deepEqual(run(done.watch, [row('/d', 'idle', { outcome: 'completed', text: 'ok' })]).ready, [{ path: '/d', text: 'ok' }]);
});

test('a listing that has not caught up (same text as when the turn began) shows no text; a vanished row drops its watch', () => {
  const watching = run(new Map(), [row('/a', 'running', { text: 'prev' }), row('/b', 'running')]);
  const done = run(watching.watch, [row('/a', 'idle', { text: 'prev' })]);
  assert.deepEqual(done.ready, [{ path: '/a', text: undefined }]);
  assert.equal(done.watch.has('/b'), false);
});

test('rows only offer assistant text', () => {
  assert.equal(replyRow({ path: '/a', snippet: { role: 'user', text: 'hi' } }, 'idle').text, undefined);
  assert.equal(replyRow({ path: '/a', snippet: { role: 'assistant', text: 'hello' } }, 'idle').text, 'hello');
  assert.equal(replyRow({ path: '/a', interrupted: { startedAt: 1 } }, 'idle').interrupted, true);
});

test('preview strips markdown crudely and cuts at 120 characters with an ellipsis', () => {
  assert.equal(replyPreview(undefined), '');
  assert.equal(replyPreview('## Done\n\n- fixed **the** `bug` in [docs](http://x.y)\n\n```ts\nlet a_b = 1;\n```'), 'Done fixed the bug in docs let a_b = 1;');
  const long = replyPreview('word '.repeat(60));
  assert.equal(long.endsWith('…'), true);
  assert.equal(Array.from(long).length <= 121, true);
  assert.equal(replyPreview('a'.repeat(120)), 'a'.repeat(120));
});
