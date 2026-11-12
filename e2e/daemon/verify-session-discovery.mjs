#!/usr/bin/env node
// Real native filesystem events + listing WebSocket, without browser/OMP or
// listing polls between mutations and their expected notification.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const { OMP_PULSE_TEST_BASE: base, OMP_PULSE_TEST_TOKEN: token,
  OMP_PULSE_TEST_SESSIONS: root, OMP_PULSE_TEST_TMP: tmp } = process.env;
assert(base && token && root && tmp, 'run through e2e/with-test-daemon.sh');
const origin = new URL(base);
assert(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port !== '7682');
assert(path.resolve(root).startsWith(`${path.resolve(tmp)}${path.sep}`));
const headers = { Authorization: `Bearer ${token}` };
const get = async (route) => {
  const response = await fetch(`${base}${route}`, { headers });
  assert.equal(response.status, 200, `${route} status`);
  return { body: await response.json(), etag: response.headers.get('etag') };
};
const listing = (query = '') => get(`/api/sessions${query}`);
const stats = async () => (await get('/api/status')).body.index;
const fixture = async (file, title, timestamp = Date.now()) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    { type: 'session', id: path.basename(file), cwd: '/tmp/discovery-fixture', title },
    { type: 'message', id: 'entry', message: { role: 'user', timestamp,
      content: [{ type: 'text', text: 'Synthetic discovery fixture; no agent is started' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
};
const waitUntil = async (predicate, label, timeout = 1500) => {
  const start = performance.now();
  while (!predicate()) {
    assert(performance.now() - start < timeout, `${label} timed out`);
    await sleep(10);
  }
};
let socket;
let frames = [];
const connect = async () => {
  frames = [];
  const url = new URL('/ws/sessions', base.replace(/^http/, 'ws'));
  url.searchParams.set('token', token);
  socket = new WebSocket(url);
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === 'sessions') frames.push(frame);
  });
  // The initial validator proves the server has attached this audience.
  await waitUntil(() => frames.length > 0, 'initial sessions frame');
};
const disconnect = async () => {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
  socket.close();
  await closed;
  await sleep(100);
};
const change = async (label, mutate, verify) => {
  const count = frames.length;
  const start = performance.now();
  await mutate();
  // Deliberately no HTTP requests here: the native watch must start the scan.
  await waitUntil(() => frames.length > count, label);
  const elapsed = Math.round(performance.now() - start);
  await verify();
  console.log(`ok ${label}: ${elapsed} ms (no listing poll)`);
};

try {
  const oldAt = Date.now() - 86400000;
  for (let i = 0; i < 60; i++) {
    await fixture(path.join(root, 'existing', `${i}.jsonl`), `Seed ${i}`, oldAt + i * 1000);
  }
  const hidden = path.join(root, 'existing', '0.jsonl');
  // Startup can have a cached empty snapshot before fixtures are written.
  // Poll only during setup, before the no-poll discovery assertions begin.
  const setupStart = performance.now();
  while ((await listing()).body.sessions.length !== 50) {
    assert(performance.now() - setupStart < 6000, 'seed catalogue did not warm');
    await sleep(100);
  }
  await sleep(1000);
  const filtered = await listing('?q=Seed%200');
  assert.equal(filtered.body.sessions.length, 1);
  const before = await listing();
  assert(!before.body.sessions.some((row) => row.path === hidden));
  await connect();
  await change('filtered edit outside default page',
    () => fixture(hidden, 'Seed 0 renamed', oldAt), async () => {
      assert.equal((await listing()).etag, before.etag, 'default page must be unchanged');
      assert.equal((await listing('?q=Seed%200')).body.sessions[0].title, 'Seed 0 renamed');
    });
  const created = path.join(root, 'new-project', 'new.jsonl');
  await change('new project and session', () => fixture(created, 'New project'), async () => {
    assert((await listing()).body.sessions.some((row) => row.path === created));
  });
  const sibling = path.join(root, 'new-project', 'sibling.jsonl');
  await change('new sibling session', () => fixture(sibling, 'Sibling'), async () => {
    assert((await listing()).body.sessions.some((row) => row.path === sibling));
  });
  const renamed = path.join(root, 'new-project', 'renamed.jsonl');
  await change('rename session file', () => rename(sibling, renamed), async () => {
    const rows = (await listing()).body.sessions;
    assert(rows.some((row) => row.path === renamed));
    assert(!rows.some((row) => row.path === sibling));
  });
  await change('remove session', () => unlink(renamed), async () => {
    assert(!(await listing()).body.sessions.some((row) => row.path === renamed));
  });
  // A burst may arrive during a scan. Its final state must get a trailing scan.
  const scansBefore = (await stats()).refreshes;
  const frameBefore = frames.length;
  for (let i = 0; i < 40; i++) await fixture(created, `Burst ${i}`);
  await sleep(1700);
  assert(frames.length > frameBefore, 'burst must notify');
  const scansAfter = (await stats()).refreshes;
  assert(scansAfter - scansBefore <= 3, 'burst must use bounded refreshes');
  assert.equal((await listing()).body.sessions.find((row) => row.path === created).title, 'Burst 39');
  console.log(`ok burst final state: ${scansAfter - scansBefore} refreshes for 40 writes`);
  // A quiet audience must not perpetually drain the same pending hint.
  const settled = (await stats()).refreshes;
  await sleep(1700);
  assert.equal((await stats()).refreshes, settled, 'quiet watch must stop scanning');
  console.log('ok quiet watcher stops scanning');
  await disconnect();
  const idle = (await stats()).refreshes;
  const offline = path.join(root, 'new-project', 'offline.jsonl');
  await fixture(offline, 'While disconnected');
  await sleep(1100);
  assert.equal((await stats()).refreshes, idle, 'no audience means no event-triggered scan');
  console.log('ok no audience means no discovery scans');
  await sleep(2100);
  await listing(); // Existing HTTP stale-while-revalidate fallback.
  await sleep(300);
  assert((await listing()).body.sessions.some((row) => row.path === offline));
  console.log('ok HTTP fallback repairs disconnected catalogue');
  await connect();
  await change('native discovery after reconnect', () => unlink(offline), async () => {
    assert(!(await listing()).body.sessions.some((row) => row.path === offline));
  });
} catch (error) {
  // Never include a WebSocket URL or request credentials in test output.
  console.error(`FAIL ${String(error.message).replaceAll(token, '[redacted]')}`);
  process.exitCode = 1;
} finally {
  await disconnect();
}
