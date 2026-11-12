#!/usr/bin/env node
// Isolated protocol-host fixture: real encrypted sockets and daemon routes, no model calls.
import { loadWs } from '../lib/env.mjs';
const WebSocket = await loadWs();
const { WebSocketServer } = WebSocket;
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const { OMP_PULSE_TEST_BASE: base, OMP_PULSE_TEST_TOKEN: token, OMP_PULSE_TEST_SESSIONS: root, OMP_PULSE_TEST_TMP: tmp } = process.env;
assert(base && root && token && tmp && new URL(base).hostname === '127.0.0.1' && new URL(base).port !== '7682', 'isolated harness required');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
async function api(path, body) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: r.status, data: await r.json() };
}
const key = randomBytes(32), writeToken = randomBytes(16);
function seal(frame) {
  const peer = Buffer.alloc(4); peer.writeUInt32BE(1);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([peer, iv, cipher.update(JSON.stringify(frame)), cipher.final(), cipher.getAuthTag()]);
}
function open(bytes) {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16, -16)), decipher.final()]).toString());
}
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
const rooms = new Map(), holders = [], phones = [];
server.on('connection', (socket, req) => {
  const room = rooms.get(new URL(req.url, "http://fixture").pathname.split("/").pop());
  assert(room, 'known fixture room'); room.socket = socket;
  socket.on('message', bytes => {
    const frame = open(bytes); room.received.push(frame);
    if (frame.t === 'hello') {
      assert.equal(frame.writeToken, room.writable ? writeToken.toString('base64url') : undefined);
      socket.send(seal({ t: 'welcome', entryCount: 0, state: { isStreaming: false }, agents: [] }));
    }
  });
});
try {
  for (const writable of [true, false]) {
    const id = randomUUID(), roomId = randomBytes(16).toString('base64url');
    const folder = `${root}/-tmp-collab-authority`, sessionPath = `${folder}/${id}.jsonl`;
    mkdirSync(folder, { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({ type: 'session', version: 3, id, cwd: tmp, timestamp: new Date().toISOString() }) + '\n');
    // Minimal environment deliberately excludes operator terminal identity. This process
    // holds the fixture only; it cannot be adopted as the developer's real terminal.
    const holder = spawn('/bin/bash', ['-c', 'exec -a "$1/omp" /bin/bash -c \'exec 3< "$1"; while read -r line; do :; done\' _ "$2"', '_', tmp, sessionPath], { env: { PATH: '/usr/bin:/bin', HOME: tmp }, stdio: ['pipe', 'ignore', 'ignore'] });
    holders.push(holder);
    const room = { writable, received: [], socket: null }; rooms.set(roomId, room);
    const secret = Buffer.concat(writable ? [key, writeToken] : [key]).toString('base64url');
    const link = `ws://127.0.0.1:${server.address().port}/r/${roomId}.${secret}`;
    const attach = await api('/api/collab/attach', { sessionPath, link });
    assert.equal(attach.data.ok, true, JSON.stringify(attach.data));
    await until('guest welcome', () => room.received.some(f => f.t === 'hello'));
    const openPhone = async () => {
      const frames = [];
      const phone = new WebSocket(base.replace(/^http/, "ws") + "/ws?caps=bundle&session=" + encodeURIComponent(sessionPath), { headers: { Authorization: `Bearer ${token}` } });
      phones.push(phone);
      phone.on('message', (bytes, binary) => { if (!binary) frames.push(JSON.parse(bytes.toString())); });
      await until('phone bundle', () => frames.some(f => f.type === 'bundle'));
      return { phone, frames };
    };
    let { phone, frames } = await openPhone();
    room.socket.send(seal({ t: 'event', event: { type: 'agent_start' } }));
    await until('stream start', () => frames.some(f => f.event?.type === 'agent_start'));
    const runningHistory = await api("/api/history?session=" + encodeURIComponent(sessionPath));
    assert.equal(runningHistory.data.sessionState?.turn, "running", "history shares collab live state");
    assert.equal(runningHistory.data.sessionState?.owner.kind, "collab");
    assert.equal(runningHistory.data.sessionState?.capabilities.send, writable);
    assert.equal(runningHistory.data.sessionState?.capabilities.settings, false, "plain collab does not invent settings support");
    room.socket.send(seal({ t: 'event', event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'collaboration increment' }] } } }));
    await until('incremental content', () => frames.some(f => JSON.stringify(f).includes('collaboration increment')));
    const commandId = randomUUID();
    const sent = await api('/api/prompt', { sessionPath, commandId, text: 'fixture prompt' });
    if (writable) {
      assert.equal(sent.data.receipt?.state, 'forwarded', JSON.stringify(sent.data));
      await until('host receives prompt', () => room.received.some(f => f.t === 'prompt' && f.text === 'fixture prompt'));
      await api('/api/prompt', { sessionPath, commandId, text: 'fixture prompt' });
      assert.equal(room.received.filter(f => f.t === 'prompt').length, 1, 'receipt retry must not dispatch twice');
      const stopped = await api('/api/abort', { sessionPath });
      assert.equal(stopped.data.ok, true, JSON.stringify(stopped.data));
      await until('host receives abort', () => room.received.some(f => f.t === 'abort'));
      room.socket.send(seal({ t: 'ui-request', request: { reqId: 17, kind: 'editor', title: 'Fixture editor', prefill: 'Original\nsecond line' } }));
      await until('pending question', () => frames.some(f => f.event?.type === 'collab_ui_request'));
      const firstRequest = frames.find(f => f.event?.type === 'collab_ui_request' && f.event.request?.reqId === 17).event.request;
      assert.equal(firstRequest.prefill, 'Original\nsecond line');
      const firstToken = firstRequest.pulseQuestionToken;
      phone.send(JSON.stringify({ type: 'collab-ui-response', reqId: 17, value: 'Edited\nsecond line', pulseQuestionToken: firstToken }));
      await until('answer reaches host', () => room.received.some(f => f.t === 'ui-response' && f.reqId === 17 && f.value === 'Edited\nsecond line'));
      await until('forwarding acknowledgement', () => frames.some(f => f.event?.type === 'ui_response_ack' && f.event.reqId === 17 && f.event.pulseQuestionToken === firstToken && f.event.ok === true));
      // This phone misses the host's end. A fresh pending-set snapshot must
      // settle its retained answer without a replay log of completed IDs.
      const witness = await openPhone();
      await until('witness question snapshot', () => witness.frames.some(f => f.event?.type === 'collab_ui_snapshot'));
      const pending = witness.frames.find(f => f.event?.type === 'collab_ui_snapshot').event.requests.find(request => request.reqId === 17);
      assert.equal(pending?.prefill, 'Original\nsecond line', 'a reconnecting phone sees the pending question with its prefill');
      phone.close();
      await until('phone disconnects before closure', () => phone.readyState === WebSocket.CLOSED);
      room.socket.send(seal({ t: 'ui-request-end', reqId: 17 }));
      await until('host question closes', () => witness.frames.some(f => f.event?.type === 'collab_ui_request_end' && f.event.reqId === 17));
      witness.phone.close();
      ({ phone, frames } = await openPhone());
      await until('complete question snapshot', () => frames.some(f => f.event?.type === 'collab_ui_snapshot'));
      const snapshot = frames.find(f => f.event?.type === 'collab_ui_snapshot').event;
      assert.equal(snapshot.complete, true);
      assert.equal(snapshot.requests.some(request => request.reqId === 17), false, 'missed closure is recovered on reconnect');
      room.socket.send(seal({ t: 'ui-request', request: { reqId: 17, kind: 'select', title: 'Next choice', options: ['Yes', 'No'] } }));
      await until('reused numeric question ID', () => frames.some(f => f.event?.type === 'collab_ui_request' && f.event.request?.reqId === 17));
      const nextToken = frames.find(f => f.event?.type === 'collab_ui_request' && f.event.request?.reqId === 17).event.request.pulseQuestionToken;
      assert.notEqual(nextToken, firstToken);
      phone.send(JSON.stringify({ type: 'collab-ui-response', reqId: 17, value: 'Yes', pulseQuestionToken: firstToken }));
      await until('stale answer refused', () => frames.some(f => f.event?.type === 'ui_response_ack' && f.event.pulseQuestionToken === firstToken && f.event.ok === false));
      phone.send(JSON.stringify({ type: 'collab-ui-response', reqId: 17, value: 'No', pulseQuestionToken: nextToken }));
      await until('new answer reaches host', () => room.received.some(f => f.t === 'ui-response' && f.reqId === 17 && f.value === 'No'));
      assert.equal(room.received.filter(f => f.t === 'ui-response' && f.reqId === 17).length, 2, 'stale token never reaches the new question');
    } else {
      assert(!sent.data.ok || sent.data.receipt?.state === 'failed', 'view link must not create another writer');
      assert.equal(room.received.filter(f => f.t === 'prompt').length, 0);
      // A refused answer must be told so; a silent drop leaves the phone "sending" forever.
      phone.send(JSON.stringify({ type: 'collab-ui-response', reqId: 17, value: 'Must not reach host', pulseQuestionToken: 'fixture-read-only-token' }));
      await until('read-only answer rejection', () => frames.some(f => f.event?.type === 'ui_response_ack' && f.event.reqId === 17 && f.event.pulseQuestionToken === 'fixture-read-only-token' && f.event.ok === false));
      assert.equal(room.received.filter(f => f.t === 'ui-response').length, 0);
    }
    room.socket.send(seal({ t: "event", event: { type: "agent_end", isTerminal: false } }));
    await until("nonterminal event", () => frames.some(f => f.event?.type === "agent_end" && f.event.isTerminal === false));
    const continuing = await api("/api/history?session=" + encodeURIComponent(sessionPath));
    assert.equal(continuing.data.sessionState?.turn, "running", "intermediate end must not settle the host turn");
    room.socket.send(seal({ t: "event", event: { type: "agent_end", isTerminal: true } }));
    await until("terminal event", () => frames.some(f => f.event?.type === "agent_end" && f.event.isTerminal === true));
    const history = await api('/api/history?session=' + encodeURIComponent(sessionPath));
    assert.equal(history.status, 200, 'history remains readable');
    assert.equal(history.data.sessionState?.turn, "idle", "terminal collab event settles history");
    let row;
    await until("listing discovers fixture and converges", async () => {
      const listing = await api("/api/sessions");
      row = listing.data.sessions.find(item => item.path === sessionPath);
      return row?.sessionState?.turn === "idle";
    });
    assert.equal(row?.sessionState?.turn, "idle", "listing shares terminal collab state");
    assert.equal(row.sessionState.daemonInstanceId, history.data.sessionState.daemonInstanceId);
    assert.equal(row.sessionState.bindingEpoch, history.data.sessionState.bindingEpoch);
    const fresh = new WebSocket(base.replace(/^http/, "ws") + "/ws?caps=bundle&session=" + encodeURIComponent(sessionPath), { headers: { Authorization: `Bearer ${token}` } });
    phones.push(fresh);
    let snapshot;
    fresh.on("message", (bytes, binary) => { if (!binary) { const frame = JSON.parse(bytes.toString()); if (frame.type === "bundle") snapshot = frame; } });
    await until("fresh terminal bundle", () => snapshot);
    assert.equal(snapshot.sessionState?.turn, "idle", "reconnect agrees with history and listing");
    assert.equal(snapshot.sessionState?.bindingEpoch, history.data.sessionState.bindingEpoch);
    fresh.close();
    console.log(`ok ${writable ? 'writable' : 'read-only'} encrypted collab: stream, control boundaries, history`);
    phone.close();
    await api('/api/collab/detach', { sessionPath });
  }
} finally {
  for (const phone of phones) phone.terminate();
  for (const holder of holders) holder.stdin.end();
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
}
