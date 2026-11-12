import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
  import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
  import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
  import {SessionActionsSheet} from ${JSON.stringify(resolve(root, 'web/src/app/sessions/SessionActionsSheet.tsx'))};
  import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
  const calls = [], closed = [], changed = [];
  for (const method of Object.getOwnPropertyNames(DaemonApi.prototype)) {
    if (method !== 'constructor') DaemonApi.prototype[method] = () => { throw new Error('Unexpected daemon call: ' + method); };
  }
  DaemonApi.prototype.setSessionName = (...args) => new Promise((resolve, reject) => calls.push({args, resolve, reject}));
  window.fixture = {act, calls, closed, changed, mount() {
    const r = createRoot(document.getElementById('root'));
    r.render(h(SessionActionsSheet, {
      session: {path:'/synthetic/rename.jsonl', title:'Original', cwd:'/synthetic', running:false},
      onOpenChange:v => closed.push(v), onChanged:() => changed.push(true), onOpenSession:() => {},
    }));
    return r;
  }};
`);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window;
  const {act, calls, closed, changed} = w.fixture;
  const clipboardCalls = [];
  Object.defineProperty(w.navigator, 'clipboard', {value: {writeText() {
    clipboardCalls.push(true);
    throw new Error('Unexpected clipboard write');
  }}});
  w.document.execCommand = () => { clipboardCalls.push(true); throw new Error('Unexpected clipboard fallback'); };
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => {
    try {
      await act(async () => mounted.unmount());
      assert.deepEqual(dom.blocked, []);
      assert.deepEqual(clipboardCalls, []);
    } finally { dom.close(); }
  });
  const el = id => w.document.querySelector(`[data-testid="${id}"]`);
  const click = id => act(async () => { assert.ok(el(id), id); el(id).click(); });
  await click('action-rename');
  return {
    w, act, calls, closed, changed, el, click,
    type: value => act(async () => {
      const input = el('rename-input');
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new w.Event('input', {bubbles:true}));
    }),
    key: async (key, options = {}) => {
      const event = new w.KeyboardEvent('keydown', {key, bubbles:true, cancelable:true, ...options});
      await act(async () => el('rename-input').dispatchEvent(event));
      return event;
    },
    finish: () => act(async () => calls[0].resolve()),
    fail: () => act(async () => calls[0].reject(new Error('Synthetic rename failure'))),
  };
}

for (const [label, options] of [
  ['native composition', {isComposing:true}],
  ['legacy IME keyCode 229', {keyCode:229}],
  ['held Enter', {repeat:true}],
]) {
  test(`${label}: Enter preserves the draft without a rename request`, async t => {
    const f = await fixture(t);
    await f.type('  日本語  draft  ');
    const event = await f.key('Enter', options);
    assert.equal(f.calls.length, 0);
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.el('rename-input').value, '  日本語  draft  ');
    assert.equal(f.closed.length + f.changed.length, 0);
    await f.key('Enter');
    assert.deepEqual(Array.from(f.calls[0].args), ['/synthetic/rename.jsonl', '日本語  draft']);
  });
}

for (const submit of ['Enter', 'Save']) {
  test(`${submit}: trims only the edges and acknowledges the current rename`, async t => {
    const f = await fixture(t);
    await f.type('  日本語  e\u0301 😀  ');
    if (submit === 'Enter') await f.key('Enter'); else await f.click('rename-save');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(Array.from(f.calls[0].args), ['/synthetic/rename.jsonl', '日本語  e\u0301 😀']);
    await f.finish();
    assert.deepEqual(Array.from(f.closed), [false]);
    assert.equal(f.changed.length, 1);
  });
}

test('empty names remain blocked through Enter and Save', async t => {
  const f = await fixture(t);
  await f.type('   ');
  assert.equal(f.el('rename-save').disabled, true);
  await f.key('Enter');
  await f.click('rename-save');
  assert.equal(f.calls.length, 0);
});

test('held Enter after a failed request cannot retry until a fresh press', async t => {
  const f = await fixture(t);
  await f.type('Draft');
  await f.key('Enter');
  await f.fail();
  await f.key('Enter', {repeat:true});
  assert.equal(f.calls.length, 1);
  await f.key('Enter');
  assert.equal(f.calls.length, 2);
});

test('same-turn ordinary Enter still respects the pending mutation guard', async t => {
  const f = await fixture(t);
  await f.act(async () => {
    for (let i = 0; i < 2; i++) f.el('rename-input').dispatchEvent(new f.w.KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
  });
  assert.equal(f.calls.length, 1);
});

for (const cancel of ['Escape', 'Cancel']) {
  test(`${cancel}: cancels editing and ignores a late rename result`, async t => {
    const f = await fixture(t);
    await f.key('Enter');
    if (cancel === 'Escape') await f.key('Escape'); else await f.click('rename-back');
    assert.equal(f.el('rename-input') === null, true);
    assert.ok(f.el('action-rename'));
    assert.deepEqual(Array.from(f.closed), cancel === 'Escape' ? [false] : []);
    await f.finish();
    assert.deepEqual(Array.from(f.closed), cancel === 'Escape' ? [false] : []);
    assert.equal(f.changed.length, 0);
  });
}
