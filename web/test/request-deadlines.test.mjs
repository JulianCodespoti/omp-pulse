#!/usr/bin/env node
// Exercise the actual fetch transport: both missing headers and a stalled JSON
// body must release deduplicated reads, without retrying side effects.
//
// The read deadline is expired by this test, not by the clock. A shortened
// wall-clock deadline (100 ms) also fired on the healthy reads that follow a
// timeout whenever the machine was loaded, failing "fresh data" for a request
// that was merely slow. Here a deadline expires only once the request has
// reached the stage under test (the server holds the request, or the client
// holds the stalled response's headers), and never on a healthy read.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from '../node_modules/vite/dist/node/index.js';
const vite = await createServer({ root: new URL('..', import.meta.url).pathname, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } }, logLevel: 'error' });
let mode = 'headers', calls = 0;
let requestArrived = () => {};
const server = createHttpServer((req, res) => {
  calls++;
  requestArrived();
  if (mode === 'headers') return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (mode === 'body') { res.write('{"ok":'); return; }
  res.end(JSON.stringify(req.url === '/api/rpc' ? {ok: true, data: {isStreaming: false}} : {ok: true, sessions: ['recovered']}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// Every read deadline the client arms, as a signal this test fires.
const originalTimeout = AbortSignal.timeout;
const deadlines = [];
AbortSignal.timeout = () => { const deadline = new AbortController(); deadlines.push(deadline); return deadline.signal; };
function expireDeadlines() {
  for (const deadline of deadlines.splice(0)) deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
}
// Resolves when the client has the response headers in hand (fetch resolved).
const originalFetch = globalThis.fetch;
let headersReceived = () => {};
globalThis.fetch = (...args) => originalFetch(...args).then(response => { headersReceived(); return response; });
const next = hook => new Promise(resolve => { hook(resolve); });
const requestReached = () => next(resolve => { requestArrived = resolve; });
const headersReached = () => next(resolve => { headersReceived = resolve; });

// Deadlines are test-controlled, so nothing would end a hung read: this bound
// is the hang detector. Healthy settles take milliseconds; it only has to
// outlast a loaded machine.
const HANG_MS = 10_000;
let failures = 0;
async function bounded(operation) {
  let timer;
  try {
    const result = await Promise.race([
      operation.then(value => ({value}), error => ({error})),
      new Promise(resolve => { timer = setTimeout(() => resolve({hung: true}), HANG_MS); }),
    ]);
    if (result.hung) {
      server.closeAllConnections();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return result;
  }
  finally { clearTimeout(timer); }
}
// Start `read`, wait until it is held at `stage`, then expire its deadline.
async function expiredAt(stage, read) {
  const reached = stage();
  const operation = read();
  operation.catch(() => {});
  const held = await bounded(reached);
  if (held.hung) return held;
  expireDeadlines();
  return bounded(operation);
}
function check(name, ok) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; }
try {
  const { DaemonApi } = await vite.ssrLoadModule('/src/runtime/rpc-client.ts');
  const api = new DaemonApi('test-token', base);
  const headers = await expiredAt(requestReached, () => api.awaiting());
  check('missing headers time out rather than holding the shared read', !!headers.error && !headers.hung);
  mode = 'success';
  check("a subsequent read after timeout gets fresh data", (await bounded(api.awaiting())).value?.[0] === "recovered");
  mode = 'body';
  const body = await expiredAt(headersReached, () => api.awaiting());
  check('stalled response body times out instead of becoming empty success', !!body.error && !body.hung);
  mode = 'headers';
  const status = await expiredAt(requestReached, () => api.getState('/sessions/test'));
  check('read-only POST status RPC is also bounded', !!status.error && !status.hung);
  mode = 'success';
  check("status recovers on a later request", (await bounded(api.getState("/sessions/test"))).value?.isStreaming === false);
  const cancelled = new AbortController(); cancelled.abort();
  const before = calls;
  const result = await bounded(api.fetchJson('/api/awaiting', {signal: cancelled.signal}));
  check('caller cancellation remains authoritative and does not dispatch', !!result.error && calls === before);
} finally {
  AbortSignal.timeout = originalTimeout;
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await vite.close();
}
assert.equal(failures, 0, `${failures} request deadline checks failed`);
