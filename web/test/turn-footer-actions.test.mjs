import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { stallNotice } from '../src/app/chat/stall-notice.ts';

const require = createRequire(resolve(root, 'web/package.json'));
// Production TurnFooter in a synthetic DOM: the Try again menu and the stall line.
// Interaction only; no layout, haptics hardware or live turn.
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { TurnFooter } from ${JSON.stringify(resolve(root, 'web/src/app/parts/TurnFooter.tsx'))};
window.fixture = { act, mount(props) {
  const r = createRoot(document.getElementById('root'));
  r.render(h(TurnFooter, props));
  return r;
} };
`);

function fixture(t) {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const w = dom.window;
  const byId = (id) => w.document.querySelector(`[data-testid="${id}"]`);
  return { w, f: w.fixture, byId };
}

test('stall ladder: quiet below 40s, then escalation, then a 7s rotation from 80s', () => {
  assert.equal(stallNotice(0), null);
  assert.equal(stallNotice(39_999), null);
  assert.equal(stallNotice(Number.NaN), null);
  assert.equal(stallNotice(-5_000), null);
  assert.equal(stallNotice(40_000), 'Taking longer than usual');
  assert.equal(stallNotice(79_999), 'Taking longer than usual');
  assert.equal(stallNotice(80_000), 'Still working on it');
  assert.equal(stallNotice(86_999), 'Still working on it');
  assert.equal(stallNotice(87_000), 'Feel free to check back in a moment');
  assert.equal(stallNotice(94_000), 'Still working on it');
  assert.equal(stallNotice(10 * 60_000), stallNotice(10 * 60_000 - 14_000));
});

test('a running footer shows the stall line, and new activity clears it', async (t) => {
  const { f, byId } = fixture(t);
  let last = Date.now() - 45_000;
  await f.act(async () => { f.mount({ running: true, currentStep: 'Reading files…', stepShown: true, activityAt: () => last }); });
  assert.match(byId('turn-footer').textContent, /Taking longer than usual/);
  // A fresh token resets the clock; the footer re-reads it on its next tick.
  last = Date.now();
  await f.act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
  assert.doesNotMatch(byId('turn-footer').textContent, /Taking longer|Still working/);
});

test('without a stall the footer shows only the step, and a retry (no activityAt) never escalates', async (t) => {
  const { f, byId } = fixture(t);
  await f.act(async () => { f.mount({ running: true, currentStep: 'Retrying in 3s…', startedAt: Date.now() - 200_000 }); });
  assert.match(byId('turn-footer').textContent, /Retrying in 3s/);
  assert.doesNotMatch(byId('turn-footer').textContent, /Taking longer/);
});

async function open(w, f, trigger) {
  await f.act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      trigger.dispatchEvent(new (type.startsWith('pointer') ? (w.PointerEvent ?? w.MouseEvent) : w.MouseEvent)(type, { bubbles: true, button: 0, detail: 1 }));
    }
  });
}

test('Try again opens a menu instead of redoing; its first item redoes, its second picks a model first', async (t) => {
  const { w, f, byId } = fixture(t);
  const calls = [];
  await f.act(async () => { f.mount({ running: false, onTryAgain: () => calls.push('same'), onTryAnotherModel: () => calls.push('model') }); });
  const trigger = byId('turn-try-again');
  await open(w, f, trigger);
  assert.deepEqual(calls, [], 'the tap alone redoes nothing');
  assert.ok(byId('turn-try-again-menu'), 'the tap opens the menu');
  assert.equal(byId('turn-try-again-same').textContent, 'Try again');
  assert.equal(byId('turn-try-again-model').textContent, 'Try with another model…');
  await f.act(async () => byId('turn-try-again-same').click());
  assert.deepEqual(calls, ['same']);
  await open(w, f, byId('turn-try-again'));
  await f.act(async () => byId('turn-try-again-model').click());
  assert.deepEqual(calls, ['same', 'model']);
});

test('a disabled Try again stays closed', async (t) => {
  const { w, f, byId } = fixture(t);
  await f.act(async () => { f.mount({ running: false, onTryAgain() {}, onTryAnotherModel() {}, tryAgainDisabled: true }); });
  assert.equal(byId('turn-try-again').disabled, true);
  await open(w, f, byId('turn-try-again'));
  assert.equal(byId('turn-try-again-menu'), null);
});

test('a successful footer copy swaps to the check with a light haptic; a failed copy does neither', async (t) => {
  const { w, f, byId } = fixture(t);
  const buzzes = [];
  w.navigator.vibrate = (pattern) => { buzzes.push(pattern); return true; };
  let result;
  await f.act(async () => { f.mount({ running: false, onCopy: async () => result }); });
  await f.act(async () => byId('turn-copy').click());
  assert.equal(byId('turn-copy').getAttribute('aria-label'), 'Copied');
  assert.equal(buzzes.length, 1);
  assert.equal(byId('turn-copy').querySelectorAll('svg').length, 2, 'both icons stay mounted so they can cross-fade');
  await f.act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
  assert.equal(byId('turn-copy').getAttribute('aria-label'), 'Copy reply', 'the check resets after 1.2s');
  result = false;
  await f.act(async () => byId('turn-copy').click());
  assert.equal(byId('turn-copy').getAttribute('aria-label'), 'Copy reply');
  assert.equal(buzzes.length, 1);
});
