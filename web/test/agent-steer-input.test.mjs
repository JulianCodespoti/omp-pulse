import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { agentsTabHarness } from './support/agents-tab.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(agentsTabHarness(require) + `
import { act } from ${JSON.stringify(require.resolve('react'))};
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
const calls = [], reads = [], intervals = new Map();
let timer = 0;
window.setInterval = (fn, ms) => { intervals.set(++timer, { fn, ms }); return timer; };
window.clearInterval = id => intervals.delete(id);
DaemonApi.prototype.getDesktopAgentRoster = async () => { throw Object.assign(new Error('Synthetic no desktop read lease'), { code: 'host_unavailable' }); };
DaemonApi.prototype.getSubagents = async session => {
  reads.push(session);
  return { agents: [{ id: 'synthetic-agent', name: 'Synthetic agent', status: 'running' }] };
};
DaemonApi.prototype.steerSubagent = (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject }));
const store = createOmpStore(), hosts = [agentsTab.host({ getStore: () => store })];
for (const fixtureStore of [store]) fixtureStore.setState({ connection: 'open', sessionAuthorities: Object.fromEntries(['/synthetic/a','/synthetic/b','/synthetic/steer'].map(path => [path, { owner: { kind: 'child' }, confidence: 'confirmed', connection: 'connected' }])) });
window.fixture = { act, calls, reads, mount: () => agentsTab.mount({ hosts, sessionPath: '/synthetic/steer' }) };
`);

async function fixture(t, draft = '  New direction 日本語  ') {
  const dom = createDomFixture(code);
  const w = dom.window;
  const { act, calls, reads } = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  // This synthetic scan is the only fetch allowed; no daemon or model runs.
  w.fetch = async url => {
    assert.match(String(url), /^\/api\/agents\?/);
    return { ok: true, json: async () => ({ agents: [] }) };
  };
  let mounted;
  t.after(async () => {
    try {
      if (mounted) await act(async () => mounted.unmount());
      assert.deepEqual(dom.blocked, []);
    } finally { dom.close(); }
  });
  await act(async () => { mounted = w.fixture.mount(); });
  assert.deepEqual(Array.from(reads), ['/synthetic/steer']);
  const button = label => [...w.document.querySelectorAll('button')].find(b => b.textContent === label);
  const input = () => w.document.querySelector('input[placeholder="Redirect the agent…"]');
  const type = value => act(async () => {
    assert.ok(input());
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input(), value);
    input().dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const click = label => act(async () => { assert.ok(button(label), label); button(label).click(); });
  await click('Redirect');
  await type(draft);
  return {
    w, act, calls, input, button, type, click,
    text: () => w.document.body.textContent,
    key: async (key, flags = {}) => {
      const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...flags });
      await act(async () => input().dispatchEvent(event));
      return event;
    },
    finish: index => act(async () => calls[index].resolve({})),
    fail: index => act(async () => calls[index].reject(new Error('Synthetic steering failure'))),
  };
}

const guarded = [
  ['native composition', { isComposing: true }],
  ['legacy IME 229 without native composition', { keyCode: 229, isComposing: false }],
  ['held-key repeat', { repeat: true }],
];

for (const [label, flags] of guarded) {
  test(`Enter during ${label} leaves the redirect unsent and editable`, async t => {
    const f = await fixture(t);
    const event = await f.key('Enter', flags);
    assert.equal(f.calls.length, 0, 'a composing or repeated Enter must not steer an agent');
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.input().value, '  New direction 日本語  ');
    assert.equal(f.input().disabled, false);
    assert.equal(f.button('Send').disabled, false);
    await f.type('Edited direction');
    assert.equal(f.input().value, 'Edited direction');
  });

  test(`explicit Send still works after Enter during ${label}`, async t => {
    const f = await fixture(t);
    await f.key('Enter', flags);
    assert.equal(f.calls.length, 0);
    await f.click('Send');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(Array.from(f.calls[0].args), ['/synthetic/steer', 'synthetic-agent', 'New direction 日本語']);
    await f.finish(0);
    assert.equal(f.input() === null, true);
  });
}

test('fresh Enter submits trimmed text once and success closes the redirect editor', async t => {
  const f = await fixture(t);
  await f.key('Enter');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Array.from(f.calls[0].args), ['/synthetic/steer', 'synthetic-agent', 'New direction 日本語']);
  assert.equal(f.input().disabled, true);
  assert.equal(f.button('Send').disabled, true);
  await f.finish(0);
  assert.equal(f.input() === null, true);
  await f.click('Redirect');
  assert.equal(f.input().value, '');
});

test('a repeat in the same React turn as fresh Enter cannot issue a second steering request', async t => {
  const f = await fixture(t);
  await f.act(async () => {
    for (const repeat of [false, true]) {
      f.input().dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true }));
    }
  });
  assert.equal(f.calls.length, 1);
  await f.finish(0);
});

for (const draft of ['', '   \t  ']) {
  test(`blank draft ${JSON.stringify(draft)} cannot be sent by Enter or the Send control`, async t => {
    const f = await fixture(t, draft);
    await f.key('Enter');
    assert.equal(f.button('Send').disabled, true);
    await f.click('Send');
    assert.equal(f.calls.length, 0);
    assert.equal(f.input().value, draft);
    assert.equal(f.input().disabled, false);
  });
}

for (const retry of ['Enter', 'Send']) {
  test(`current error keeps the draft for a deliberate ${retry} retry`, async t => {
    const f = await fixture(t);
    await f.key('Enter');
    await f.fail(0);
    assert.ok(f.text().includes('Synthetic steering failure'));
    assert.equal(f.input().value, '  New direction 日本語  ');
    assert.equal(f.input().disabled, false);
    for (const [, flags] of guarded) await f.key('Enter', flags);
    assert.equal(f.calls.length, 1, 'an incidental Enter must not retry a failed steering request');
    assert.ok(f.text().includes('Synthetic steering failure'));
    if (retry === 'Enter') await f.key('Enter');
    else await f.click('Send');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(Array.from(f.calls[1].args), Array.from(f.calls[0].args));
    assert.equal(f.text().includes('Synthetic steering failure'), false);
    await f.finish(1);
    assert.equal(f.input() === null, true);
  });
}

test('ordinary and repeated typing remain available without steering', async t => {
  const f = await fixture(t, 'a');
  for (const [key, flags] of [['a', { repeat: true }], ['ArrowLeft', { repeat: true }], ['Process', { keyCode: 229 }]]) {
    const event = await f.key(key, flags);
    assert.equal(event.defaultPrevented, false);
  }
  await f.type('aaa 日本語');
  assert.equal(f.input().value, 'aaa 日本語');
  assert.equal(f.calls.length, 0);
  await f.key('Enter');
  assert.equal(f.calls[0].args[2], 'aaa 日本語');
});

test('composition can finish before a fresh Enter sends the completed draft', async t => {
  const f = await fixture(t);
  await f.act(async () => f.input().dispatchEvent(new f.w.CompositionEvent('compositionstart', { bubbles: true })));
  await f.key('Enter', { isComposing: true });
  assert.equal(f.calls.length, 0);
  await f.act(async () => f.input().dispatchEvent(new f.w.CompositionEvent('compositionend', { bubbles: true, data: '完成' })));
  await f.type('完成');
  await f.key('Enter');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[2], '完成');
});

for (const flags of [{}, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
  test(`Escape ${JSON.stringify(flags)} retains its existing redirect cancellation`, async t => {
    const f = await fixture(t);
    await f.key('Escape', flags);
    assert.equal(f.input() === null, true);
    assert.equal(f.calls.length, 0);
    await f.click('Redirect');
    assert.equal(f.input().value, '');
  });
}
