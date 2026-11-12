import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { recentProjects } from '../src/domain/recent-projects.ts';

// The real client and durable queue over a synthetic daemon: every request is
// answered in-process and recorded, nothing reaches the network.
const code = await bundleDomFixture(`
import { DaemonApi, startSession, StartSessionError } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import * as queue from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
// The app activates the credential's queue at pairing; the durable send only
// flushes the active namespace.
queue.setOfflineQueueNamespace(queue.offlineQueueNamespaceForCredential('synthetic-start'));
const calls = [];
let failCommand = null;
DaemonApi.prototype.fetchJson = async function (path, init) {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ path, body });
  if (path === '/api/version') return { protocolVersion: 1, minClientProtocolVersion: 1, capabilities: ['receipt-session-binding-v1'] };
  if (path === '/api/new') return { ok: true, sessionPath: '/s/new.jsonl' };
  if (path === '/api/rpc') {
    if (body.command === failCommand) throw new Error('The session did not apply the requested model and reasoning level.');
    return { ok: true, data: {} };
  }
  if (path === '/api/prompt') {
    const receipt = { commandId: body.commandId, sessionPath: body.sessionPath, state: 'accepted', createdAt: 1, updatedAt: 2 };
    return { ok: true, receipt, receiptBinding: { version: 1, requestedSessionPath: body.sessionPath, canonicalSessionPath: body.sessionPath } };
  }
  throw new Error('Unexpected synthetic route ' + path);
};
DaemonApi.prototype.dedupedFetch = DaemonApi.prototype.fetchJson;
window.fixture = {
  calls,
  failOn(command) { failCommand = command; },
  start: (options) => startSession({ token: 'synthetic-start', ...options }),
  StartSessionError,
};
`);

// Attachments persist through IndexedDB before the first POST, so the DOM
// realm gets the synthetic one the other durable-send tests use.
function fixture(t) {
  const dom = createDomFixture(`window.idb=(${memoryIndexedDb.toString()})();window.indexedDB=window.idb.indexedDB;` + code);
  t.after(() => { assert.deepEqual(dom.blocked, []); dom.close(); });
  return dom.window.fixture;
}

// Fixture values come from the DOM realm; compare their JSON, not prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const routes = (f) => Array.from(f.calls, (call) => (call.path === '/api/rpc' ? `rpc:${call.body.command}` : call.path));

test('model and thinking level are applied to the new session before the first prompt', async (t) => {
  const f = fixture(t);
  const result = await f.start({ cwd: '/work/repo', model: { provider: 'anthropic', id: 'opus' }, thinkingLevel: 'high', prompt: 'Hello' });
  assert.equal(result.sessionPath, '/s/new.jsonl');
  assert.equal(result.receipt.sessionPath, '/s/new.jsonl');
  assert.deepEqual(routes(f), ['/api/new', 'rpc:set_model', '/api/version', '/api/prompt']);
  assert.deepEqual(plain(f.calls[0].body), { cwd: '/work/repo' });
  assert.deepEqual(plain(f.calls[1].body.params), { provider: 'anthropic', modelId: 'opus', thinkingLevel: 'high' });
  assert.equal(f.calls[3].body.text, 'Hello');
  assert.equal(f.calls[3].body.sessionPath, '/s/new.jsonl');
});

test('a thinking level alone uses set_thinking_level; no prompt only creates the session', async (t) => {
  const f = fixture(t);
  const result = await f.start({ cwd: '/work/repo', thinkingLevel: 'low' });
  assert.deepEqual(plain(result), { sessionPath: '/s/new.jsonl' });
  assert.deepEqual(routes(f), ['/api/new', 'rpc:set_thinking_level']);
  assert.deepEqual(plain(f.calls[1].body.params), { level: 'low' });
});

test('attachments without text are still sent as the first message', async (t) => {
  const f = fixture(t);
  const image = { data: 'aGk=', mimeType: 'image/png' };
  await f.start({ cwd: '/work/repo', attachments: [image] });
  const prompt = Array.from(f.calls).find((call) => call.path === '/api/prompt');
  assert.deepEqual(plain(prompt.body.images), [image]);
});

test('a settings failure keeps the created session and never sends the prompt', async (t) => {
  const f = fixture(t);
  f.failOn('set_model');
  await assert.rejects(
    f.start({ cwd: '/work/repo', model: { provider: 'p', id: 'm' }, prompt: 'Hello' }),
    (error) => error instanceof f.StartSessionError && error.stage === 'settings' && error.sessionPath === '/s/new.jsonl',
  );
  assert.equal(f.calls.some((call) => call.path === '/api/prompt'), false);
});

test('recent projects group the listing by directory, newest use first', () => {
  const rows = [
    { path: '/s/1', cwd: '/work/a', activeAt: 300, mtime: 1 },
    { path: '/s/2', cwd: '/work/b/', activeAt: 500, mtime: 1 },
    { path: '/s/3', cwd: '/work/a', activeAt: 900, mtime: 1 },
    { path: '/s/4', activeAt: 999 },
    { path: '/s/5', cwd: '/work/c', mtime: 10_000 },
  ];
  assert.deepEqual(recentProjects(rows), [
    { cwd: '/work/a', label: 'a', lastActiveAt: 900, sessionCount: 2 },
    { cwd: '/work/b/', label: 'b', lastActiveAt: 500, sessionCount: 1 },
    { cwd: '/work/c', label: 'c', lastActiveAt: 0, sessionCount: 1 },
  ]);
  assert.deepEqual(recentProjects(rows, 1).map((p) => p.cwd), ['/work/a']);
});
