import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContextReport } from '../src/app/commands/context-report.ts';

// omp 18.8.6 `/context` output after the daemon stripped its SGR colours.
const report = [
  'Context window: 200000 tokens (7% used)',
  '  System prompt    [░░░░░░░░░░░░░░░░░░░░░░░░] 1%  2792 tokens',
  '  Messages         [░░░░░░░░░░░░░░░░░░░░░░░░] 1%  1473 tokens',
  '  Auto-compact buf [████░░░░░░░░░░░░░░░░░░░░] 15%  30000 tokens',
  '  Free             [███████████████████░░░░░] 78%  156174 tokens',
  'Snapcompact: inactive (model has no image input)',
].join('\n');

test('the breakdown becomes a total and one row per category', () => {
  const parsed = parseContextReport(report);
  assert.equal(parsed.contextWindow, 200000);
  assert.equal(parsed.percent, 7);
  assert.deepEqual(parsed.categories.map((c) => [c.label, c.percent, c.tokens]), [
    ['System prompt', 1, 2792], ['Messages', 1, 1473], ['Auto-compact reserve', 15, 30000], ['Free', 78, 156174],
  ]);
  assert.deepEqual(parsed.notes, ['Snapcompact: inactive (model has no image input)']);
});

test('text that is not the breakdown is left to the plain view', () => {
  assert.equal(parseContextReport('Context usage is unavailable: no model is selected for this session.'), null);
  assert.equal(parseContextReport(''), null);
});
