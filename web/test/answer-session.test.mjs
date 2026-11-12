import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnswerSession, answerQuestionKey } from '../src/app/sessions/answer-session.ts';
const row = (path, index = 0, id = 'ask') => ({ path, pendingAsk: { id, index, total: 2 } });

test('selected path receives the fresh next question instead of captured state', () => {
  const selected = row('/a', 0), fresh = row('/a', 1);
  assert.equal(resolveAnswerSession(selected, [row('/other'), fresh]), fresh);
  assert.equal(selected.pendingAsk.index, 0);
});
test('page omission preserves selection and does not imply completion', () => {
  const selected = row('/a');
  assert.equal(resolveAnswerSession(selected, [row('/other')]), selected);
  assert.equal(resolveAnswerSession(null, [selected]), null);
});
test('fresh explicit question removal replaces the selected snapshot', () => {
  const fresh = { path: '/a' };
  assert.equal(resolveAnswerSession(row('/a'), [fresh]), fresh);
});
test('question identity changes only with its session, index, ask or removal', () => {
  const initial = answerQuestionKey(row('/a'));
  assert.equal(initial, answerQuestionKey({ ...row('/a'), title: 'renamed' }));
  for (const session of [row('/b'), row('/a', 1), row('/a', 0, 'new'), { path: '/a' }]) {
    assert.notEqual(initial, answerQuestionKey(session));
  }
});
test('generic native, collab and terminal catalogue rows never share an answerable null identity', () => {
  for (const session of [null, { path: '/a' }, { path: '/a', pendingAsk: null }, { path: '/a', pendingAsk: { index: 0 } }]) {
    assert.equal(answerQuestionKey(session), null);
  }
  assert.notEqual(answerQuestionKey(row('/a', 0, 'later-ask')), null);
});
