import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { liveOutput } from '../omp-pulse-child.ts';

// The child extension's `/pulse-bash` output batcher: pure timing/string
// contract, no omp, daemon or phone.
test('chunks inside one interval leave as one frame', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const sent = [];
  const live = liveOutput((text) => sent.push(text), 100, 1024);
  live.push('a\n');
  live.push('b\n');
  mock.timers.tick(99);
  assert.deepEqual(sent, []);
  mock.timers.tick(1);
  assert.deepEqual(sent, ['a\nb\n']);
  live.push('c\n');
  mock.timers.tick(100);
  assert.deepEqual(sent, ['a\nb\n', 'c\n']);
  mock.timers.tick(1000);
  assert.equal(sent.length, 2, 'no output, no frame');
});

test('a slow interval keeps only the newest output', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const sent = [];
  const live = liveOutput((text) => sent.push(text), 100, 8);
  live.push('0123456789');
  live.push('abc');
  mock.timers.tick(100);
  assert.deepEqual(sent, ['56789abc']);
});

test('stop drops unsent output and emits nothing after', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const sent = [];
  const live = liveOutput((text) => sent.push(text), 100, 1024);
  live.push('late');
  live.stop();
  live.push('later');
  mock.timers.tick(500);
  assert.deepEqual(sent, []);
});
