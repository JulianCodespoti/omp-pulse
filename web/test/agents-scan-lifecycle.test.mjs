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
const store = createOmpStore();
const hosts = [agentsTab.host({ getStore: () => store })];
DaemonApi.prototype.getDesktopAgentRoster = async () => { throw Object.assign(new Error('Synthetic no desktop read lease'), { code: 'host_unavailable' }); };
DaemonApi.prototype.getSubagents = async () => [];
for (const fixtureStore of [store]) fixtureStore.setState({ connection: 'open', sessionAuthorities: Object.fromEntries(['/synthetic/a','/synthetic/b','/synthetic/steer'].map(path => [path, { owner: { kind: 'child' }, confidence: 'confirmed', connection: 'connected' }])) });
window.fixture = { act, store, mount: () => agentsTab.mount({ hosts }) };
`);

const scan = name => ({ agents: [{ callId: `call-${name}`, name }] });
async function fixture(t) {
  const dom = createDomFixture(code);
  const w = dom.window;
  const { act, store } = w.fixture;
  const requests = [];
  w.Element.prototype.getAnimations = () => [];
  w.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  return {
    w, act, store, requests,
    text: () => w.document.body.textContent,
    render: (...args) => act(async () => mounted.render(...args)),
    respond: (index, body, ok = true) => act(async () => requests[index].resolve({ ok, json: async () => body })),
    reject: index => act(async () => requests[index].reject(new Error('Synthetic scan failure'))),
  };
}

test('completed scan is discarded on session switch while replacement is pending or fails', async t => {
  const f = await fixture(t);
  await f.respond(0, scan('Previous agent'));
  assert.ok(f.text().includes('Previous agent'));
  await f.render(true, '/synthetic/b');
  assert.equal(f.requests.length, 2);
  assert.equal(f.text().includes('Previous agent'), false);
  await f.reject(1);
  assert.equal(f.text().includes('Previous agent'), false);
  assert.ok(f.text().includes('No agents yet'));
});

// Reopening the drawer on the same chat keeps its rows (a skeleton over a list
// the phone already had is worse); the next scan replaces them when it lands.
test('completed scan survives a reopen of the same chat and is replaced by the next one', async t => {
  const f = await fixture(t);
  await f.respond(0, scan('Previous agent'));
  await f.render(false);
  await f.render(true);
  assert.equal(f.requests.length, 2);
  assert.ok(f.text().includes('Previous agent'));
  await f.respond(1, scan('Current agent'));
  assert.ok(f.text().includes('Current agent'));
  assert.equal(f.text().includes('Previous agent'), false);
});

test('current scan still displays after session switch and old pending result cannot replace it', async t => {
  const f = await fixture(t);
  await f.render(true, '/synthetic/b');
  await f.respond(1, scan('Current agent'));
  await f.respond(0, scan('Previous agent'));
  assert.ok(f.text().includes('Current agent'));
  assert.equal(f.text().includes('Previous agent'), false);
  assert.equal(new URL(f.requests[1].url, 'http://synthetic.invalid').searchParams.get('session'), '/synthetic/b');
});

test('scan JSON completing after tab reactivation cannot replace current agents', async t => {
  const f = await fixture(t);
  let finishBody;
  await f.act(async () => f.requests[0].resolve({ ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) }));
  await f.render(false);
  await f.render(true);
  await f.respond(1, scan('Current agent'));
  await f.act(async () => finishBody(scan('Previous agent')));
  assert.ok(f.text().includes('Current agent'));
  assert.equal(f.text().includes('Previous agent'), false);
});

test('failed replacement scan leaves the current loaded-transcript fallback visible', async t => {
  const f = await fixture(t);
  await f.respond(0, scan('Previous agent'));
  await f.act(async () => f.store.setState({ messages: [{
    id: 'current-message', role: 'assistant', text: '',
    parts: [{ kind: 'tool', name: 'task', callId: 'current-call', state: 'ok', args: { tasks: [{ name: 'Current window agent' }] } }],
  }] }));
  await f.render(true, '/synthetic/b');
  await f.respond(1, {}, false);
  assert.ok(f.text().includes('Current window agent'));
  assert.equal(f.text().includes('Previous agent'), false);
});

test('malformed replacement scan cannot resurrect the previous session scan', async t => {
  const f = await fixture(t);
  await f.respond(0, scan('Previous agent'));
  await f.render(true, '/synthetic/b');
  await f.respond(1, { agents: null });
  assert.equal(f.text().includes('Previous agent'), false);
  assert.ok(f.text().includes('No agents yet'));
});

test('an empty replacement scan does not reuse the previous names', async t => {
  const f = await fixture(t);
  await f.respond(0, scan('Previous agent'));
  await f.render(true, '/synthetic/b');
  await f.respond(1, { agents: [] });
  assert.equal(f.text().includes('Previous agent'), false);
  assert.ok(f.text().includes('No agents yet'));
});

test('current live collab agents still take precedence over the transcript scan', async t => {
  const f = await fixture(t);
  await f.respond(0, scan('Recorded agent'));
  await f.act(async () => f.store.setState({ collabAgents: [{
    id: 'live-agent', kind: 'subagent', displayName: 'Live agent', status: 'running',
  }] }));
  assert.ok(f.text().includes('Live agent'));
  assert.equal(f.text().includes('Recorded agent'), false);
});
