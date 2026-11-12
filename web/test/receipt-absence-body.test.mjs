import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { consumeReceiptAbsenceBody } from '../src/runtime/receipt-absence-body.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';

// request.ts reaches ./link-state by an extensionless import, which plain Node
// cannot resolve, so the real module is bundled first.
const root = fileURLToPath(new URL('../../', import.meta.url));
const build = await rolldown({
  input: 'request-fixture',
  platform: 'node',
  transform: { define: { 'import.meta.env': JSON.stringify({}) } },
  plugins: [{
    name: 'request-fixture',
    resolveId: (id) => (id === 'request-fixture' ? '\0request-fixture' : null),
    load: (id) => (id === '\0request-fixture' ? `export * from ${JSON.stringify(resolve(root, 'web/src/runtime/request.ts'))};` : null),
  }],
});
let request;
try {
  const generated = await build.generate({ format: 'esm', codeSplitting: false });
  request = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString('base64')}`);
} finally {
  await build.close();
}
const { fetchWithDeadline } = request;

// Native Responses, streams, readers and fetch. Reader wrappers only count calls;
// none substitutes a read result or the production consumer. No browser evidence.
const absenceBody = new TextEncoder().encode('{"ok":false,"error":"receipt not found"}');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture(chunks = [], { finish = true, failure, cancel } = {}) {
  const calls = { acquire: 0, read: 0, cancel: 0, release: 0, pull: 0 };
  let controller, index = 0;
  const stream = new ReadableStream({
    start(value) { controller = value; },
    pull(value) {
      calls.pull++;
      if (index < chunks.length) value.enqueue(chunks[index++]);
      else if (failure !== undefined) value.error(failure);
      else if (finish) value.close();
    },
    cancel(reason) { return cancel?.(reason); },
  }, { highWaterMark: 0 });
  const nativeGetReader = stream.getReader.bind(stream);
  stream.getReader = (...args) => {
    calls.acquire++;
    const reader = nativeGetReader(...args);
    for (const [method, counter] of [['read', 'read'], ['cancel', 'cancel'], ['releaseLock', 'release']]) {
      const native = reader[method].bind(reader);
      reader[method] = (...values) => { calls[counter]++; return native(...values); };
    }
    return reader;
  };
  return { response: new Response(stream, { status: 404 }), stream, calls, controller };
}

function observe(promise) {
  const state = { settled: false };
  state.result = promise.then(
    value => { state.settled = true; return { value }; },
    error => { state.settled = true; return { error }; },
  );
  return state;
}

function assertReleased(f, { reads, cancelled = false } = {}) {
  assert.equal(f.calls.acquire, 1);
  if (reads !== undefined) assert.equal(f.calls.read, reads);
  assert.equal(f.calls.cancel, cancelled ? 1 : 0);
  assert.equal(f.calls.release, 1);
  assert.equal(f.stream.locked, false);
}

function safeError(error, marker = 'PRIVATE_BODY_MARKER') {
  assert.ok(error instanceof Error);
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= 160);
  assert.ok(!error.message.includes(marker));
  return true;
}

async function rejectsPromptly(promise, validation) {
  let timeout;
  try {
    await assert.rejects(Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('test cleanup watchdog expired')), 1_000); }),
    ]), error => {
      assert.notEqual(error.message, 'test cleanup watchdog expired');
      return validation(error);
    });
  } finally { clearTimeout(timeout); }
}

test('fragmented real 40-byte absence body waits for true EOF, without success cancellation', async () => {
  assert.equal(absenceBody.byteLength, 40);
  const f = fixture([absenceBody.subarray(0, 1), absenceBody.subarray(1, 17), absenceBody.subarray(17)], { finish: false });
  const pending = observe(consumeReceiptAbsenceBody(f.response));
  await nextTurn();
  assert.equal(f.calls.read, 4);
  assert.equal(pending.settled, false);
  assert.equal(f.stream.locked, true);
  assert.equal(f.calls.cancel, 0);
  f.controller.close();
  assert.deepEqual(await pending.result, { value: undefined });
  assert.equal(f.response.bodyUsed, true);
  assertReleased(f, { reads: 4 });
});

test('native null-body Response is already complete', async () => {
  const response = new Response(null, { status: 404 });
  assert.equal(response.body, null);
  assert.equal(await consumeReceiptAbsenceBody(response), undefined);
  assert.equal(response.bodyUsed, false);
});

test('closed empty stream completes after its sole EOF result', async () => {
  const f = fixture();
  await consumeReceiptAbsenceBody(f.response);
  assertReleased(f, { reads: 1 });
});

test('arbitrary non-JSON bytes, including invalid UTF-8, are discarded unchanged', async () => {
  const bytes = new Uint8Array([255, 0, 254, 123, 128]);
  const f = fixture([bytes]);
  await consumeReceiptAbsenceBody(f.response);
  assert.deepEqual(bytes, new Uint8Array([255, 0, 254, 123, 128]));
  assertReleased(f, { reads: 2 });
});

test('body consumer never delegates to decoding, copying or secondary-response methods', async () => {
  const f = fixture([absenceBody]);
  for (const method of ['text', 'json', 'arrayBuffer', 'bytes', 'blob', 'formData', 'clone']) {
    f.response[method] = () => { assert.fail(`unexpected Response.${method}`); };
  }
  f.stream.tee = () => { assert.fail('unexpected stream tee'); };
  await consumeReceiptAbsenceBody(f.response);
  assertReleased(f, { reads: 2 });
});

for (const length of [65_535, 65_536]) {
  test(`${length} bytes in one chunk completes at EOF`, async () => {
    const f = fixture([new Uint8Array(length)]);
    await consumeReceiptAbsenceBody(f.response);
    assertReleased(f, { reads: 2 });
  });
}

test('exact 65,536 bytes fragmented into 1,024 non-EOF results allows the final EOF read', async () => {
  const f = fixture(Array.from({ length: 1_024 }, () => new Uint8Array(64)));
  await consumeReceiptAbsenceBody(f.response);
  assertReleased(f, { reads: 1_025 });
});

test('1,024 empty chunks count toward the non-EOF cap and still permit EOF', async () => {
  const f = fixture(Array.from({ length: 1_024 }, () => new Uint8Array(0)));
  await consumeReceiptAbsenceBody(f.response);
  assertReleased(f, { reads: 1_025 });
});

test('65,537 bytes rejects on the first chunk and never reads again', async () => {
  const f = fixture([new Uint8Array(65_537), absenceBody]);
  await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
  assertReleased(f, { reads: 1, cancelled: true });
});

test('fragmented overflow rejects the first chunk exceeding the remaining budget', async () => {
  const f = fixture([new Uint8Array(65_535), new Uint8Array(2), absenceBody]);
  await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
  assertReleased(f, { reads: 2, cancelled: true });
});

test('a chunk after the exact byte cap fails, but empty chunks do not consume bytes', async () => {
  const f = fixture([new Uint8Array(65_536), new Uint8Array(0), new Uint8Array(1), absenceBody]);
  await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
  assertReleased(f, { reads: 3, cancelled: true });
});

test('1,025 empty non-EOF results reject without a 1,026th read', async () => {
  const f = fixture(Array.from({ length: 1_026 }, () => new Uint8Array(0)));
  await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
  assertReleased(f, { reads: 1_025, cancelled: true });
});

test('1,025 nonempty non-EOF results reject even while below the byte cap', async () => {
  const f = fixture(Array.from({ length: 1_026 }, () => new Uint8Array(1)));
  await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
  assertReleased(f, { reads: 1_025, cancelled: true });
});

test('Content-Length is not trusted for completion or either byte boundary', async () => {
  const allowed = fixture([absenceBody]);
  allowed.response.headers.set('Content-Length', '999999999');
  await consumeReceiptAbsenceBody(allowed.response);
  assertReleased(allowed, { reads: 2 });
  const overflow = fixture([new Uint8Array(65_537)]);
  overflow.response.headers.set('Content-Length', '0');
  await assert.rejects(consumeReceiptAbsenceBody(overflow.response), safeError);
  assertReleased(overflow, { reads: 1, cancelled: true });
});

const malformed = [
  ['string', 'PRIVATE_BODY_MARKER'],
  ['undefined', undefined],
  ['null', null],
  ['number', 7],
  ['plain object', { byteLength: 0, toString: () => 'PRIVATE_BODY_MARKER' }],
  ['array', [1, 2]],
  ['ArrayBuffer', new ArrayBuffer(2)],
  ['DataView', new DataView(new ArrayBuffer(2))],
  ['Uint16Array', new Uint16Array(2)],
  ['Int8Array', new Int8Array(2)],
  ['Uint8ClampedArray', new Uint8ClampedArray(2)],
  ['spoofed Uint8Array object', { [Symbol.toStringTag]: 'Uint8Array', byteLength: 0 }],
  ['spoofed Uint16Array tag', Object.defineProperty(new Uint16Array(2), Symbol.toStringTag, { value: 'Uint8Array' })],
];
for (const [name, chunk] of malformed) {
  test(`native stream with ${name} chunk rejects with a bounded, content-free error`, async () => {
    const f = fixture([chunk, absenceBody]);
    await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
    assertReleased(f, { reads: 1, cancelled: true });
  });
}

test('genuine cross-realm Uint8Array and Node byte buffers are accepted', async () => {
  const foreign = runInNewContext('new Uint8Array([1, 2, 3])');
  assert.equal(foreign instanceof Uint8Array, false);
  const f = fixture([foreign, Buffer.from([4, 5])]);
  await consumeReceiptAbsenceBody(f.response);
  assertReleased(f, { reads: 3 });
});

test('an already locked native stream rejects without stealing or releasing its owner lock', async () => {
  const f = fixture([absenceBody]);
  const owner = f.stream.getReader();
  try {
    await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
    assert.equal(f.calls.acquire, 1);
    assert.equal(f.calls.read, 0);
    assert.equal(f.calls.cancel, 0);
    assert.equal(f.calls.release, 0);
    assert.equal(f.stream.locked, true);
  } finally { owner.releaseLock(); }
});

test('used-but-unlocked native stream rejects without accepting partial consumption as absence', async () => {
  const f = fixture([absenceBody.subarray(0, 20), absenceBody.subarray(20)]);
  const owner = f.stream.getReader();
  await owner.read();
  owner.releaseLock();
  assert.equal(f.response.bodyUsed, true);
  assert.equal(f.stream.locked, false);
  await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
  assert.deepEqual(f.calls, { acquire: 1, read: 1, cancel: 0, release: 1, pull: 1 });
});

test('fully consumed and unlocked native Response rejects without acquiring another reader', async () => {
  const f = fixture([absenceBody]);
  const owner = f.stream.getReader();
  assert.equal((await owner.read()).done, false);
  assert.equal((await owner.read()).done, true);
  owner.releaseLock();
  assert.equal(f.response.bodyUsed, true);
  assert.equal(f.response.body.locked, false);
  const before = { ...f.calls };
  await assert.rejects(consumeReceiptAbsenceBody(f.response), safeError);
  assert.deepEqual(f.calls, before);
  assert.equal(f.stream.locked, false);
});

test('a fully consumed native Response cannot be reused as absence', async () => {
  const response = new Response(absenceBody, { status: 404 });
  await response.arrayBuffer();
  assert.equal(response.bodyUsed, true);
  await assert.rejects(consumeReceiptAbsenceBody(response), safeError);
});

test('header-only mock with undefined body is rejected rather than treated as a null body', async () => {
  await assert.rejects(consumeReceiptAbsenceBody({ status: 404, bodyUsed: false }));
});

for (const [name, chunks] of [['before data', []], ['after data', [absenceBody.subarray(0, 20)]]]) {
  test(`reader failure ${name} is preserved and the reader lock is released`, async () => {
    const original = new Error(`synthetic stream failure ${name}`);
    const f = fixture(chunks, { failure: original });
    await assert.rejects(consumeReceiptAbsenceBody(f.response), error => error === original);
    assertReleased(f, { reads: chunks.length + 1, cancelled: true });
    await nextTurn(); // Rejected native cancellation must be handled, never unhandled.
  });
}

test('a stream failure after the exact cap is not converted into EOF', async () => {
  const original = new Error('synthetic failure instead of final EOF');
  const f = fixture(Array.from({ length: 1_024 }, () => new Uint8Array(64)), { failure: original });
  await assert.rejects(consumeReceiptAbsenceBody(f.response), error => error === original);
  assertReleased(f, { reads: 1_025, cancelled: true });
});

test('an already errored native stream rejects its original failure', async () => {
  const original = new Error('synthetic pre-existing stream failure');
  const f = fixture();
  f.controller.error(original);
  await assert.rejects(consumeReceiptAbsenceBody(f.response), error => error === original);
  assertReleased(f, { reads: 1, cancelled: true });
});

for (const [name, cancel] of [
  ['rejecting', () => Promise.reject(new Error('PRIVATE_BODY_MARKER cleanup rejection'))],
  ['throwing', () => { throw new Error('PRIVATE_BODY_MARKER cleanup throw'); }],
  ['never-settling', () => new Promise(() => {})],
]) {
  test(`${name} cancellation neither hides a limit failure nor retains the reader lock`, async () => {
    const f = fixture([new Uint8Array(65_537)], { cancel });
    await rejectsPromptly(consumeReceiptAbsenceBody(f.response), error => {
      safeError(error);
      assert.match(error.message, /limit|large|size|byte/i);
      return true;
    });
    assertReleased(f, { reads: 1, cancelled: true });
    await nextTurn();
  });
}

async function stalledServer() {
  const requests = [], sockets = new Set();
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.write(absenceBody.subarray(0, 20));
    // Deliberately no end(): production fetch's original signal must end the read.
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/synthetic-receipt`, requests,
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
    },
  };
}

test('native fetchWithDeadline preserves a real caller abort while the 404 body is pending', { timeout: 10_000 }, async t => {
  const server = await stalledServer();
  const abort = new AbortController();
  try {
    const response = await fetchWithDeadline(server.url, { signal: abort.signal, cache: 'no-store' });
    assert.equal(response.status, 404);
    const pending = observe(consumeReceiptAbsenceBody(response));
    await nextTurn();
    assert.equal(pending.settled, false);
    abort.abort(new DOMException('Synthetic caller abort', 'AbortError'));
    const result = await pending.result;
    assert.equal(result.error?.name, 'AbortError');
    assert.equal(response.body.locked, false);
    assert.deepEqual(server.requests, [{ method: 'GET', url: '/synthetic-receipt' }]);
    t.diagnostic('Native loopback fetch, one GET, explicit caller AbortController; no replacement fetch or retry.');
  } finally { await server.close(); }
});

test('native fetchWithDeadline keeps its genuine 20-second request-start deadline over a stalled 404 body', { timeout: 35_000 }, async t => {
  const server = await stalledServer();
  const started = performance.now();
  try {
    const response = await fetchWithDeadline(server.url, { cache: 'no-store' });
    assert.equal(response.status, 404);
    const pending = observe(consumeReceiptAbsenceBody(response));
    await nextTurn();
    assert.equal(pending.settled, false);
    const result = await pending.result;
    const elapsed = performance.now() - started;
    assert.ok(result.error instanceof Error, 'deadline rejects instead of successful absence');
    assert.match(result.error.name, /AbortError|TimeoutError/);
    assert.ok(elapsed >= 19_500, `production deadline shortened: ${elapsed} ms`);
    assert.ok(elapsed < 30_000, `production deadline did not bound the body: ${elapsed} ms`);
    assert.equal(response.body.locked, false);
    assert.deepEqual(server.requests, [{ method: 'GET', url: '/synthetic-receipt' }]);
    t.diagnostic(`Native loopback fetch rejected in ${elapsed.toFixed(1)} ms using the unmodified production 20,000 ms deadline.`);
  } finally { await server.close(); }
});
