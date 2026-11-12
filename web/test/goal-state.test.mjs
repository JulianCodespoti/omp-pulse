import test from 'node:test';
import assert from 'node:assert/strict';
import { goalFromState, goalIsOpen, goalTokensLabel, reduceGoal } from '../src/runtime/goal-state.ts';
import { thinkingChoices } from '../src/app/tools/thinking-choices.ts';

// Shapes from omp wire/state.ts (Goal, GoalModeState) and wire/events.ts (goal_updated).
const goal = (over = {}) => ({ id: 'g1', objective: 'Ship the fix', status: 'active', tokensUsed: 12_400, tokenBudget: 50_000, timeUsedSeconds: 3, createdAt: 1, updatedAt: 10, ...over });

test('goal_updated replaces the shown goal and a null goal clears it', () => {
  const shown = reduceGoal(null, { type: 'goal_updated', goal: goal() });
  assert.equal(shown.objective, 'Ship the fix');
  assert.equal(goalIsOpen(shown), true);
  assert.equal(goalTokensLabel(shown), '12k of 50k tokens');
  const paused = reduceGoal(shown, { type: 'goal_updated', goal: goal({ status: 'paused', updatedAt: 11 }) });
  assert.equal(paused.status, 'paused');
  assert.equal(reduceGoal(paused, { type: 'goal_updated', goal: null }), null);
});

test('a stale report never rolls back a newer goal, and malformed reports change nothing', () => {
  const newer = reduceGoal(null, { goal: goal({ status: 'paused', updatedAt: 20 }) });
  assert.equal(reduceGoal(newer, { goal: goal({ status: 'active', updatedAt: 19 }) }).status, 'paused');
  assert.equal(reduceGoal(newer, { goal: { id: 'g1' } }), newer);
  assert.equal(reduceGoal(newer, { type: 'goal_updated' }), newer);
  // A different goal is never "stale" against the old one.
  assert.equal(reduceGoal(newer, { goal: goal({ id: 'g2', updatedAt: 1 }) }).id, 'g2');
});

test('finished goals get no chip; get_state speaks only when it carries goal', () => {
  assert.equal(goalIsOpen(reduceGoal(null, { goal: goal({ status: 'complete' }) })), false);
  assert.equal(goalFromState({ model: 'x' }), undefined, 'file-only peek keeps what is known');
  assert.equal(goalFromState({ goal: null }), null);
  assert.equal(goalFromState({ goal: { enabled: true, mode: 'active', goal: goal() } }).id, 'g1');
});

test('thinking picker offers the model levels, else the full list', () => {
  assert.deepEqual(thinkingChoices({ levels: ['off', 'low', 'high'] }, 'high'), ['inherit', 'off', 'low', 'high']);
  // The current level stays selectable even when the model no longer lists it.
  assert.deepEqual(thinkingChoices({ levels: ['off', 'low'] }, 'max'), ['inherit', 'off', 'low', 'max']);
  const fallback = ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  assert.deepEqual(thinkingChoices(null, 'inherit'), fallback, 'RPC failed');
  assert.deepEqual(thinkingChoices({ levels: [] }, 'low'), fallback, 'empty answer');
  assert.deepEqual(thinkingChoices({ nope: 1 }, 'low'), fallback, 'unexpected shape');
});

test('Auto stays selectable without inventing fixed effort support', () => {
  const choices = thinkingChoices({ levels: ['off', 'low'] }, 'auto');
  for (const level of ['inherit', 'auto', 'off', 'low']) assert.equal(choices.includes(level), true);
  assert.equal(choices.includes('high'), false, 'do not invent fixed effort support');
  assert.equal(new Set(choices).size, choices.length);
  assert.equal(thinkingChoices(null, 'auto').includes('auto'), true, 'an unavailable catalogue does not remove Auto');
});
