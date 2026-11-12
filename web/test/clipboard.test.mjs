import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText, legacyCopyText, ClipboardAttempt } from '../src/platform/clipboard.ts';

const denied = async () => { throw new Error('denied'); };
test('modern success is acknowledged without fallback', async () => {
  const received = [];
  assert.equal(await copyText(' exact text ', {
    writeText: async value => received.push(value),
    legacyCopy: () => assert.fail('fallback should not run'),
  }), true);
  assert.deepEqual(received, [' exact text ']);
});
test('modern rejection or absence can use a successful legacy write', async () => {
  for (const writeText of [denied, undefined]) {
    let received;
    assert.equal(await copyText('path', { writeText, legacyCopy: text => { received = text; return true; } }), true);
    assert.equal(received, 'path');
  }
});
test('legacy false and throws are failures, never success', async () => {
  for (const legacyCopy of [() => false, () => { throw new Error('legacy denied'); }]) {
    assert.equal(await copyText('path', { writeText: denied, legacyCopy }), false);
  }
});
function fakeDocument(outcome) {
  const calls = [];
  const area = { style: {}, select: () => calls.push('select'), remove: () => calls.push('remove') };
  return { area, calls, doc: {
    activeElement: { focus: options => { assert.deepEqual(options, { preventScroll: true }); calls.push('restore focus'); } },
    createElement: tag => { assert.equal(tag, 'textarea'); return area; },
    body: { appendChild: value => { assert.equal(value, area); calls.push('append'); } },
    execCommand: command => { assert.equal(command, 'copy'); calls.push('copy'); if (outcome instanceof Error) throw outcome; return outcome; },
  } };
}
test('legacy path cleans temporary text and restores focus for every outcome', () => {
  for (const result of [true, false, new Error('denied')]) {
    const { doc, calls, area } = fakeDocument(result);
    if (result instanceof Error) assert.throws(() => legacyCopyText('/a/long path', doc), /denied/);
    else assert.equal(legacyCopyText('/a/long path', doc), result);
    assert.equal(area.value, '/a/long path');
    assert.equal(area.readOnly, true);
    assert.deepEqual(calls, ['append', 'select', 'copy', 'remove', 'restore focus']);
  }
});
test('focus restoration failure does not turn an acknowledged write into failure', () => {
  const { doc } = fakeDocument(true);
  doc.activeElement.focus = () => { throw new Error('detached'); };
  assert.equal(legacyCopyText('id', doc), true);
});
test('duplicate pending attempts do not issue another clipboard write', async () => {
  let finish;
  let count = 0;
  const attempt = new ClipboardAttempt(() => { count++; return new Promise(resolve => { finish = resolve; }); });
  const first = attempt.run('first');
  assert.equal(attempt.busy, true);
  assert.equal(await attempt.run('duplicate'), null);
  assert.equal(count, 1);
  finish(true);
  assert.equal(await first, true);
  assert.equal(attempt.busy, false);
});
test('closing or changing a sheet invalidates old outcomes without clearing a newer pending attempt', async () => {
  const finishes = [];
  const attempt = new ClipboardAttempt(() => new Promise(resolve => finishes.push(resolve)));
  const old = attempt.run('old');
  attempt.cancel();
  const current = attempt.run('new');
  finishes[0](true);
  assert.equal(await old, null);
  assert.equal(attempt.busy, true);
  finishes[1](false);
  assert.equal(await current, false);
  assert.equal(attempt.busy, false);
});
test('unexpected copy rejection releases the attempt for retry', async () => {
  let calls = 0;
  const attempt = new ClipboardAttempt(async () => { if (!calls++) throw new Error('failed'); return true; });
  assert.equal(await attempt.run('one'), false);
  assert.equal(attempt.busy, false);
  assert.equal(await attempt.run('two'), true);
});
