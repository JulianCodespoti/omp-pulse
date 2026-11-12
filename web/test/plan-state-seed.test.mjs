import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// The real controller's page adoption: plan mode is known off only once the
// branch was read back to the file's first line; until then it is unknown.
const code = await bundleDomFixture(`
import { OmpSessionController } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
window.fixture = () => {
  const store = createOmpStore();
  return { store, controller: new OmpSessionController(store, 'synthetic-plan') };
};
`);
const planEntry = { type: 'mode_change', id: 'm1', mode: 'plan', timestamp: '2026-10-15T10:00:00.000Z', data: { planFilePath: '/p/plan.md' } };

function open(t) {
  const dom = createDomFixture(code);
  t.after(() => { assert.deepEqual(dom.blocked, []); dom.close(); });
  return dom.window.fixture();
}

test('a tail that stops short of the start leaves plan mode unknown', (t) => {
  const { store, controller } = open(t);
  controller.applyTailPage({ entries: [], nextBefore: 4096, endOffset: 8192 });
  assert.equal(store.getState().planMode, null);
});

test('a tail that reaches the start with no mode_change is known off', (t) => {
  const { store, controller } = open(t);
  controller.applyTailPage({ entries: [], nextBefore: null, endOffset: 10 });
  assert.equal(JSON.stringify(store.getState().planMode), '{"enabled":false}');
});

test('an older page reaching the start settles unknown to off, and a found entry wins', (t) => {
  const { store, controller } = open(t);
  controller.applyTailPage({ entries: [], nextBefore: 4096, endOffset: 8192 });
  controller.adoptPlanEntries([], true, false);
  assert.equal(store.getState().planMode, null);
  controller.adoptPlanEntries([], true, true);
  assert.equal(JSON.stringify(store.getState().planMode), '{"enabled":false}');

  const second = open(t);
  second.controller.applyTailPage({ entries: [], nextBefore: 4096, endOffset: 8192 });
  second.controller.adoptPlanEntries([planEntry], true, true);
  assert.equal(second.store.getState().planMode.enabled, true);
});

test('a live append never resets a known state', (t) => {
  const { store, controller } = open(t);
  controller.applyTailPage({ entries: [], nextBefore: null, endOffset: 10 });
  controller.adoptPlanEntries([]);
  assert.equal(JSON.stringify(store.getState().planMode), '{"enabled":false}');
  // A later tail reseed that skips a gap makes it unknown again.
  controller.applyTailPage({ entries: [], nextBefore: 4096, endOffset: 9000 });
  assert.equal(store.getState().planMode, null);
});
