import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// The launcher normally replaces this expression before loading the extension.
globalThis.__OMP_PULSE_STATE_DIR_JSON__ = '';
const { default: install } = await import('../omp-pulse-control.ts');
delete globalThis.__OMP_PULSE_STATE_DIR_JSON__;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-owner-lifecycle-'));
  const previousBun = globalThis.Bun;
  const previousStateDir = process.env.OMP_PULSE_STATE_DIR;
  const previousChild = process.env.OMP_PULSE_CHILD;
  process.env.OMP_PULSE_STATE_DIR = root;
  delete process.env.OMP_PULSE_CHILD;
  let fetchHandler;
  let stopped = false;
  globalThis.Bun = {
    serve(options) {
      fetchHandler = options.fetch;
      stopped = false;
      return { port: 12345, stop() { stopped = true; } };
    },
  };
  const handlers = new Map();
  const sent = [];
  const entries = [];
  let configuredThinking = 'medium';
  let effectiveThinking = 'medium';
  let idle = true;
  let path = join(root, 'owner.jsonl');
  let aborts = 0;
  let shutdowns = 0;
  let compactions = 0;
  const settings = new Map();
  let tools = ['task', 'eval'];
  let submission;
  const terminalCalls = [];
  const queues = { steering: [], followUp: [] };
  const ownerCalls = [];
  const queueSubscribers = new Set();
  let abortOwner;
  const emitQueue = () => {
    const event = { type: 'queue_update', steering: queues.steering.map(({ text }) => text), followUp: queues.followUp.map(({ text }) => text) };
    for (const listener of queueSubscribers) listener(event);
  };
  const rawMessages = new WeakMap(), originals = new WeakMap();
  const raw = entry => {
    if (!rawMessages.has(entry)) {
      const message = { role: 'user', content: [{ type: 'text', text: entry.text }, ...(entry.images ?? [])] };
      rawMessages.set(entry, message); originals.set(message, entry);
    }
    return rawMessages.get(entry);
  };
  let editorText = '';
  const ui = {
    notify(...args) { terminalCalls.push(['notify', ...args]); },
    setStatus(...args) {
      if (args[0] === 'throws') throw new Error('terminal rejected status');
      terminalCalls.push(['setStatus', ...args]);
    },
    setWidget(...args) { terminalCalls.push(['setWidget', ...args]); },
    setEditorText(text) { editorText = text; terminalCalls.push(['setEditorText', text]); },
    pasteToEditor(text) { editorText += text; terminalCalls.push(['pasteToEditor', text]); },
    getEditorText() { return editorText; },
  };
  const originalUI = { ...ui };
  const owner = {
    configuredThinkingLevel: () => configuredThinking,
    setThinkingLevel(level) {
      configuredThinking = level;
      effectiveThinking = level === 'auto' ? 'medium' : level;
    },
    settings: { rawValue: ({ segments }) => settings.get(segments.join('.')) },
    getEnabledToolNames: () => tools,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [{ provider: 'fixture', id: 'fixture', name: 'Fixture' }] },
    findMentionableModel: (selector) => selector === 'fixture/fixture',
    clearQueue(options) {
      ownerCalls.push(['clearQueue', options]);
      const withdrawn = { steering: queues.steering.splice(0), followUp: queues.followUp.splice(0) };
      emitQueue();
      return withdrawn;
    },
    agent: {
      peekSteeringQueue: () => queues.steering.map(raw),
      peekFollowUpQueue: () => queues.followUp.map(raw),
      peekLiveSteeredMessages: () => [],
      replaceQueue(queue, messages) {
        ownerCalls.push(['replaceQueue', queue]);
        queues[queue] = messages.map(message => originals.get(message));
        emitQueue();
      },
    },
    async abort(options) {
      ownerCalls.push(['abort', options]);
      await abortOwner?.();
    },
    getQueuedMessages: () => ({
      steering: queues.steering.map(({ text }) => text),
      followUp: queues.followUp.map(({ text }) => text),
    }),
    subscribe(listener) {
      queueSubscribers.add(listener);
      return () => queueSubscribers.delete(listener);
    },
    async prompt(text, options) {
      if (submission) return submission(text, options);
      sent.push({ text, images: options.images, streamingBehavior: options.streamingBehavior });
      options.onPromptAdmitted();
      return true;
    },
  };
  const context = {
    agent: { kind: 'main', id: 'main' },
    hasUI: true,
    ui,
    sessionManager: { getSessionFile: () => path, getLeafEntry: () => entries.at(-1), getBranch: () => entries },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    model: { provider: 'fixture', id: 'fixture', reasoning: true, thinking: { efforts: ['low', 'medium', 'high'] } },
    abort() { aborts++; },
    shutdown() { shutdowns++; },
    compact() { compactions++; },
  };
  const api = {
    on(name, handler) { handlers.set(name, handler); },
    getThinkingLevel: () => effectiveThinking,
    setThinkingLevel: (level) => owner.setThinkingLevel(level),
    appendEntry(customType, data) { entries.push({ type: 'custom', id: `entry-${entries.length}`, timestamp: '2026-10-25T10:00:01Z', customType, data: structuredClone(data) }); },
    pi: { AgentRegistry: { global: () => ({ get: (id) => id === 'main' ? { session: owner } : undefined }) } },
    sendUserMessage() { throw new Error('bypasses normal prompt processing'); },
  };
  install(api);
  const emit = (type, event = {}) => handlers.get(type)?.({ type, ...event }, context);
  t.after(async () => {
    await emit('session_shutdown');
    globalThis.Bun = previousBun;
    if (previousStateDir === undefined) delete process.env.OMP_PULSE_STATE_DIR;
    else process.env.OMP_PULSE_STATE_DIR = previousStateDir;
    if (previousChild === undefined) delete process.env.OMP_PULSE_CHILD;
    else process.env.OMP_PULSE_CHILD = previousChild;
    await rm(root, { recursive: true, force: true });
  });
  await emit('session_start');
  async function request(method, params = {}, sessionPath = path) {
    const descriptor = JSON.parse(await readFile(join(root, 'desktop-controls', `${process.pid}.json`), 'utf8'));
    return fetchHandler(new Request(`http://127.0.0.1:12345/${method === 'events' ? 'events' : 'control'}`, {
      method: method === 'events' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${descriptor.token}` },
      ...(method === 'events' ? {} : { body: JSON.stringify({ sessionPath, method, params }) }),
    }));
  }
  async function connect() {
    const response = await request('events');
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const next = async () => {
      const { value, done } = await reader.read();
      return done ? undefined : JSON.parse(new TextDecoder().decode(value));
    };
    return { reader, next, hello: await next() };
  }
  return {
    emit, request, connect, sent, entries,
    async recoveries(sessionPath = path) {
      const directory = join(root, 'queue-recovery', createHash('sha256').update(sessionPath).digest('hex'));
      const names = await readdir(directory).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
    },
    host: api.pi,
    owner, settings, queues, ownerCalls, queueSubscribers, emitQueue,
    setAbortOwner(value) { abortOwner = value; },
    get path() { return path; },
    ui, originalUI, terminalCalls,
    setUI(value) { context.ui = value; },
    setModel(value) { context.model = value; },
    setTools(value) { tools = value; },
    setSubmission(value) { submission = value; },
    setIdle(value) { idle = value; },
    async switchSession() { path = join(root, 'other.jsonl'); await emit('session_switch'); },
    get aborts() { return aborts; },
    get shutdowns() { return shutdowns; },
    get compactions() { return compactions; },
    get stopped() { return stopped; },
  };
}

test('desktop Auto acknowledges the configured selector separately from its effective effort', async (t) => {
  const f = await fixture(t);
  const response = await f.request('set_thinking_level', { level: 'auto' });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.configuredThinkingLevel, 'auto');
  assert.equal(data.thinkingLevel, 'medium');
  const reopened = (await (await f.request('get_state')).json()).data;
  assert.equal(reopened.configuredThinkingLevel, 'auto');
  assert.equal(reopened.thinkingLevel, 'medium');
  const fixed = await (await f.request('set_thinking_level', { level: 'medium' })).json();
  assert.equal(fixed.data.configuredThinkingLevel, 'medium', 'pinning the same effort exits Auto');
});

test('unverified models cannot select Auto through desktop controls', async (t) => {
  const f = await fixture(t);
  f.setModel({ provider: 'fixture', id: 'fixture', reasoning: true, thinking: { efforts: ['medium'], unverified: true } });
  const response = await f.request('set_thinking_level', { level: 'auto' });
  assert.equal(response.status, 400);
  assert.equal((await (await f.request('get_state')).json()).data.configuredThinkingLevel, 'medium');
});

test('desktop fallback explanations are journalled by the owner and forwarded intact', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  const event = { from: 'openai/primary', to: 'anthropic/recovery', role: 'default', reason: 'Request failed: provider is overloaded' };
  await f.emit('retry_fallback_applied', event);
  const forwarded = await stream.next();
  assert.deepEqual(forwarded, { type: 'retry_fallback_applied', ...event, entryId: 'entry-0', at: 1_792_922_401_000 });
  assert.deepEqual(f.entries, [{ type: 'custom', id: 'entry-0', timestamp: '2026-10-25T10:00:01Z', customType: 'omp-pulse-model-fallback', data: { type: 'retry_fallback_applied', ...event } }]);
  const reopened = (await (await f.request('get_state')).json()).data.modelFallback;
  assert.deepEqual(reopened, forwarded, 'reopening uses the exact durable identity and explanation');
  await stream.reader.cancel();
});

test('the desktop hook leaves daemon-child fallback journalling to the child owner', async (t) => {
  const f = await fixture(t);
  process.env.OMP_PULSE_CHILD = '1';
  await f.emit('retry_fallback_applied', { from: 'p/a', to: 'p/b', role: 'default', reason: 'capacity' });
  assert.equal(f.entries.length, 0);
});

test('desktop thinking frames reach the phone without a model request', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  const event = { type: 'thinking_level_changed', configured: 'auto', thinkingLevel: 'high', resolved: 'high' };
  for (const listener of f.queueSubscribers) listener(event);
  assert.deepEqual(await stream.next(), event);
  await stream.reader.cancel();
});

test('owner continuation end stays running through maintenance and reconnect until the final end', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  assert.equal(stream.hello.isStreaming, false);
  f.setIdle(false);
  await f.emit('agent_start');
  assert.equal((await stream.next()).type, 'agent_start');
  // Installed OMP projects AgentSession.isTerminal=false as willContinue=true
  // for extension hooks, after the underlying model call has become idle.
  f.setIdle(true);
  await f.emit('agent_end', { messages: [], willContinue: true });
  assert.deepEqual(await stream.next(), {
    type: 'agent_end', messages: [], willContinue: true, isTerminal: false,
  });
  for (const type of ['auto_compaction_start', 'auto_compaction_end', 'auto_retry_start', 'auto_retry_end']) {
    await f.emit(type);
    assert.equal((await stream.next()).type, type);
  }
  assert.equal((await (await f.request('get_state')).json()).data.isStreaming, true);
  const refused = await f.request('compact');
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'session_busy');
  assert.equal(f.compactions, 0);
  assert.equal((await (await f.request('close_if_idle')).json()).code, 'turn_running');
  assert.equal(f.shutdowns, 0);
  await f.request('prompt', { text: 'Continue with this too' });
  assert.deepEqual(f.sent, [{ text: 'Continue with this too', images: undefined, streamingBehavior: 'steer' }]);
  await stream.reader.cancel();
  const resumed = await f.connect();
  assert.equal(resumed.hello.isStreaming, true, 'a paused owner must not reconnect as idle');
  // No fresh agent_start is required between maintenance and the real end.
  await f.emit('agent_end', { messages: [], willContinue: false });
  assert.equal((await resumed.next()).isTerminal, true);
  assert.equal((await (await f.request('get_state')).json()).data.isStreaming, false);
  await resumed.reader.cancel();
  const idle = await f.connect();
  assert.equal(idle.hello.isStreaming, false);
  await idle.reader.cancel();
});

test('aborts and terminal errors clear only on the owner end, not on the control request', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  for (const stopReason of ['aborted', 'error', 'stop']) {
    f.setIdle(false);
    await f.emit('agent_start');
    await stream.next();
    f.setIdle(true);
    await f.emit('agent_end', { messages: [], isTerminal: false });
    assert.equal((await stream.next()).isTerminal, false, 'preserve an explicit nonterminal owner end too');
    const response = await f.request('abort');
    assert.equal((await response.json()).data.isStreaming, true);
    await f.emit('agent_end', { messages: [{ role: 'assistant', stopReason }] });
    assert.equal((await stream.next()).isTerminal, true);
    assert.equal((await (await f.request('get_state')).json()).data.isStreaming, false);
  }
  assert.equal(f.aborts, 3);
  await stream.reader.cancel();
});

test('desktop Stop withdraws both queues with original photos before awaiting owner abort', async (t) => {
  const f = await fixture(t);
  await f.emit('agent_start');
  const image = { type: 'image', data: 'original-photo'.repeat(50_000), mimeType: 'image/png' };
  const steering = { text: '  keep whitespace\n', images: [image] };
  const followUp = { text: '', images: [{ type: 'image', data: 'image-only', mimeType: 'image/jpeg' }] };
  f.queues.steering.push(steering);
  f.queues.followUp.push(followUp, { text: 'last queued message' });
  let release;
  let entered;
  const abortEntered = new Promise((resolve) => { entered = resolve; });
  f.setAbortOwner(() => { entered(); return new Promise((resolve) => { release = resolve; }); });
  const stopping = f.request('abort_and_restore_queue');
  await abortEntered;
  assert.deepEqual(f.queues, { steering: [], followUp: [] }, 'queue withdrawal precedes abort so it cannot auto-send after Stop');
  const journal = await f.recoveries();
  assert.equal(journal.length, 1, 'withdrawal is durable before abort or HTTP delivery finishes');
  assert.deepEqual(journal[0].data.steering, [steering]);
  assert.deepEqual(journal[0].data.followUp, [followUp, { text: 'last queued message' }]);
  release();
  const response = await stopping;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, {
    steering: [steering], followUp: [followUp, { text: 'last queued message' }], recoveryId: journal[0].id,
  });
  assert.deepEqual(f.ownerCalls, [
    ['clearQueue', { forInterrupt: true }],
    ['abort', { reason: 'Interrupted by user' }],
  ]);
  assert.equal(f.aborts, 0, 'restoring Stop uses authoritative AgentSession abort, not the fire-and-forget context callback');
  assert.equal((await (await f.request('get_state')).json()).data.isStreaming, true, 'owner end alone settles activity');
});

test('desktop queued edit selects exact duplicate identity and its own photos, including image-only input', async (t) => {
  const f = await fixture(t);
  await f.emit('agent_start');
  const first = { text: ' duplicate \n', images: [{ type: 'image', data: 'original-first', mimeType: 'image/png' }] };
  const second = { text: first.text, images: [{ type: 'image', data: 'original-second', mimeType: 'image/jpeg' }] };
  f.queues.steering.push(first, second);
  f.queues.followUp.push({ text: '', images: [{ type: 'image', data: 'only-photo', mimeType: 'image/webp' }] });
  const snapshot = (await (await f.request('get_state')).json()).data.queuedMessages;
  const take = async (itemId, queue) => {
    const data = (await (await f.request('remove_queued_message', { itemId, queue })).json()).data;
    if (data.removed) {
      // The journal is keyed by the owner-issued item, never by the text.
      const saved = (await f.recoveries()).find((entry) => entry.id === data.recoveryId);
      assert.equal(saved.itemId, itemId);
      assert.deepEqual(saved.data, data);
      delete data.recoveryId;
    }
    return data;
  };
  assert.deepEqual(await take(snapshot.steeringIds[1], 'steering'), { removed: true, text: second.text, images: second.images });
  assert.deepEqual(f.queues.steering, [first]);
  assert.deepEqual(await take(snapshot.followUpIds[0], 'followUp'), { removed: true, text: '[Image]', images: [{ type: 'image', data: 'only-photo', mimeType: 'image/webp' }] });
  assert.deepEqual(await take(snapshot.steeringIds[0], 'followUp'), { removed: false }, 'never remove a different queue match');
  assert.deepEqual(await take(snapshot.steeringIds[1], 'steering'), { removed: false }, 'retired selectors never match a duplicate');
  assert.equal(f.aborts, 0);
});

test('unsupported desktop recovery refuses before mutation while plain notification Stop is unchanged', async (t) => {
  const f = await fixture(t);
  f.queues.steering.push({ text: '', images: [{ type: 'image', data: 'must-remain', mimeType: 'image/png' }] });
  delete f.owner.agent;
  let response = await f.request('remove_queued_message', { itemId: 'missing', queue: 'steering' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'unsupported_owner_api');
  delete f.owner.abort;
  response = await f.request('abort_and_restore_queue');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'unsupported_owner_api');
  assert.deepEqual(f.ownerCalls, [], 'feature detection must finish before clearQueue');
  assert.equal(f.queues.steering[0].images[0].data, 'must-remain');
  assert.equal((await f.request('abort')).status, 200);
  assert.equal(f.aborts, 1);
  assert.equal(f.queues.steering.length, 1, 'plain Stop must not withdraw the queue');
});

test('desktop recovery rejects a stale session binding and preserves actual owner loss flags', async (t) => {
  const f = await fixture(t);
  const oldPath = f.path;
  await f.switchSession();
  const refused = await f.request('abort_and_restore_queue', {}, oldPath);
  assert.equal(refused.status, 409);
  assert.deepEqual(f.ownerCalls, []);
  const nativeClear = f.owner.clearQueue;
  f.owner.clearQueue = (options) => ({ ...nativeClear(options), imagesDropped: true, truncated: true });
  f.queues.followUp.push({ text: 'native text prefix' });
  const restored = await (await f.request('abort_and_restore_queue')).json();
  const [saved] = await f.recoveries();
  assert.equal(saved.id, restored.data.recoveryId);
  delete restored.data.recoveryId;
  assert.deepEqual(restored.data, { steering: [], followUp: [{ text: 'native text prefix' }], imagesDropped: true, truncated: true });
});

test('lost withdrawal response keeps recoverable photos across bridge reconnect and navigation', async (t) => {
  const f = await fixture(t);
  await f.emit('agent_start');
  const originalPath = f.path;
  const images = [{ type: 'image', data: 'desktop-only-photo', mimeType: 'image/png' }];
  f.queues.followUp.push({ text: 'recover this [Photo 1]', images });
  const snapshot = (await (await f.request('get_state')).json()).data.queuedMessages;
  await f.request('remove_queued_message', { itemId: snapshot.followUpIds[0], queue: 'followUp' });
  const saved = await f.recoveries();
  assert.equal(saved.length, 1);
  const stream = await f.connect();
  await stream.reader.cancel();
  assert.deepEqual(await f.recoveries(), saved, 'opening a stream is not acknowledgement');
  await f.switchSession();
  assert.deepEqual(await f.recoveries(), [], 'recovery is scoped to original session');
  assert.deepEqual((await f.recoveries(originalPath))[0].data.images, images);
  assert.deepEqual(f.sent, [], 'recovery never automatically submits input');
});

test('one owner-issued item is one journal record however often its withdrawal is replayed', async (t) => {
  const f = await fixture(t);
  await f.emit('agent_start');
  f.queues.followUp.push({ text: 'same preview' }, { text: 'same preview' });
  const snapshot = (await (await f.request('get_state')).json()).data.queuedMessages;
  const [a, b] = snapshot.followUpIds;
  const first = (await (await f.request('remove_queued_message', { itemId: a, queue: 'followUp' })).json()).data;
  const again = (await (await f.request('remove_queued_message', { itemId: a, queue: 'followUp' })).json()).data;
  assert.deepEqual(again, { removed: false }, 'a retired item never withdraws its twin');
  assert.equal((await f.recoveries()).length, 1);
  const second = (await (await f.request('remove_queued_message', { itemId: b, queue: 'followUp' })).json()).data;
  assert.notEqual(first.recoveryId, second.recoveryId);
  assert.equal((await f.recoveries()).length, 2);
});

test('desktop queues seed owner state and subscribe only to the current session queue events', async (t) => {
  const f = await fixture(t);
  f.queues.steering.push({ text: '' });
  const snapshot = (await (await f.request('get_state')).json()).data.queuedMessages;
  assert.deepEqual(snapshot.steering, ['']); assert.deepEqual(snapshot.followUp, []);
  assert.equal(typeof snapshot.steeringIds[0], 'string');
  const stream = await f.connect();
  const [stale] = f.queueSubscribers;
  f.queues.followUp.push({ text: 'next' });
  f.emitQueue();
  let event = await stream.next();
  assert.deepEqual(event.steering, ['']); assert.deepEqual(event.followUp, ['next']);
  assert.equal(event.steeringIds[0], snapshot.steeringIds[0]);
  await f.switchSession();
  assert.equal(f.queueSubscribers.size, 1, 'navigation replaces, rather than duplicates, native subscriptions');
  await stream.reader.cancel();
  const next = await f.connect();
  stale({ type: 'queue_update', steering: ['wrong conversation'], followUp: [] });
  f.emitQueue();
  event = await next.next();
  assert.deepEqual(event.steering, ['']); assert.deepEqual(event.followUp, ['next']);
  assert.equal(event.steeringIds[0], snapshot.steeringIds[0]);
  await next.reader.cancel();
  await f.emit('session_shutdown');
  assert.equal(f.queueSubscribers.size, 0);
});

test('owner navigation and shutdown close streams without inventing terminal completion', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  await f.emit('agent_start');
  await stream.next();
  await f.emit('agent_end', { messages: [], willContinue: true });
  await stream.next();
  await f.switchSession();
  assert.equal(await stream.next(), undefined);
  const nextSession = await f.connect();
  assert.equal(nextSession.hello.isStreaming, false, 'the old turn cannot leak into a new binding');
  await f.emit('agent_start');
  await nextSession.next();
  await f.emit('session_shutdown');
  assert.equal(await nextSession.next(), undefined, 'transport loss is not a terminal agent_end');
  assert.equal(f.stopped, true);
  await f.emit('session_start');
  const restarted = await f.connect();
  assert.equal(restarted.hello.isStreaming, false);
  await restarted.reader.cancel();
});

test('a slow event subscriber remains bounded while a continuing turn stays running', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  await f.emit('agent_start');
  await stream.next();
  await f.emit('agent_end', { messages: [], willContinue: true });
  await stream.next();
  // The stream has a 4096-frame high-water mark and sendLine permits a
  // 4096-frame negative desiredSize before dropping the reader. Overflow
  // therefore occurs after 8193 queued frames, not after the high-water mark.
  for (let index = 0; index < 8400; index++) await f.emit('auto_retry_start', { attempt: index });
  let count = 0;
  while (count <= 8193 && await stream.next() !== undefined) count++;
  assert.equal(count, 8193, 'the slow reader closes at the existing bounded queue ceiling');
  const resumed = await f.connect();
  assert.equal(resumed.hello.isStreaming, true);
  await resumed.reader.cancel();
});

test('all prompt delivery modes preserve images and reach admission without waiting for a model turn', async (t) => {
  const f = await fixture(t);
  for (const [running, deliverAs, delivery] of [[false, undefined, 'prompt'], [true, 'steer', 'steer'], [true, 'followUp', 'followUp']]) {
    if (running) await f.emit('agent_start');
    const accepted = [];
    f.setSubmission((text, options) => {
      accepted.push({ text, images: options.images, mode: options.streamingBehavior });
      options.onPromptAdmitted();
      return new Promise(() => {});
    });
    const response = await f.request('prompt', {
      text: 'ultrathink ^fixture/fixture /template',
      images: [{ data: 'YWJj', mime: 'image/jpeg' }], deliverAs,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.delivery, delivery);
    assert.deepEqual(accepted, [{
      text: 'ultrathink ^fixture/fixture /template',
      images: [{ type: 'image', data: 'YWJj', mimeType: 'image/jpeg' }],
      mode: deliverAs ?? 'steer',
    }]);
  }
});

test('unsupported owner and immediate expansion or auth errors refuse rather than accept', async (t) => {
  const f = await fixture(t);
  const prompt = f.owner.prompt;
  delete f.owner.prompt;
  assert.equal((await (await f.request('prompt', { text: 'hello' })).json()).ok, false);
  f.owner.prompt = prompt;
  for (const afterAdmission of [false, true]) {
    f.setSubmission(async (_text, options) => {
      if (afterAdmission) options.onPromptAdmitted();
      throw new Error(afterAdmission ? 'No API key found' : 'template cannot be expanded');
    });
    const response = await f.request('prompt', { text: '/template' });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'prompt_rejected');
  }
  assert.equal(f.sent.length, 0);
});

test('a rejection after admission is a visible notice without invented lifecycle', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  let fail;
  f.setSubmission((_text, options) => {
    options.onPromptAdmitted();
    return new Promise((_resolve, reject) => { fail = reject; });
  });
  assert.equal((await f.request('prompt', { text: 'hello' })).status, 200);
  fail(new Error('credentials expired'));
  const event = await stream.next();
  assert.deepEqual(event, {
    type: 'notice', level: 'error', source: 'omp-pulse-control',
    message: 'Desktop prompt failed: credentials expired',
  });
  assert.equal((await (await f.request('get_state')).json()).data.isStreaming, false);
  await stream.reader.cancel();
});

test('effective metadata follows live switches, required tools and model scope', async (t) => {
  const f = await fixture(t);
  const config = async () => (await (await f.request('get_prompt_config')).json()).data;
  assert.deepEqual((await config()).magicKeywords.map(({ word }) => word), ['ultrathink', 'orchestrate', 'workflowz', 'jevify']);
  f.settings.set('magicKeywords.workflow', false);
  assert.deepEqual((await config()).magicKeywords.map(({ word }) => word), ['ultrathink', 'orchestrate', 'jevify']);
  f.setTools([]);
  assert.deepEqual((await config()).magicKeywords, [{ id: 'ultrathink', word: 'ultrathink', hue: [0, 330] }]);
  f.settings.set('magicKeywords.enabled', false);
  assert.deepEqual(await config(), { magicKeywords: [] });
  delete f.owner.settings;
  const unavailable = await f.request('get_prompt_config');
  assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).ok, false);
  assert.deepEqual((await (await f.request('get_model_mention_choices')).json()).data.choices, [
    { selector: 'fixture/fixture', name: 'Fixture', provider: 'fixture' },
  ]);
  f.owner.scopedModels = [{ model: { provider: 'elsewhere', id: 'scoped' } }];
  assert.deepEqual((await (await f.request('get_model_mention_choices')).json()).data.choices, []);
  assert.equal(f.sent.length, 0, 'metadata never invokes the model');
});

test('skill commands use owner-built attributed custom prompts with photos in every delivery mode', async (t) => {
  const f = await fixture(t);
  const skill = { name: 'review' };
  const invocation = { name: 'review', args: 'changes', prompt: '/skill:review changes' };
  const built = { message: 'Expanded review instructions', details: { skillName: 'review' } };
  const calls = [];
  f.owner.skillsSettings = { enableSkillCommands: true };
  f.owner.skills = [skill];
  f.host.SKILL_PROMPT_MESSAGE_TYPE = 'skill-prompt';
  f.host.parseSkillInvocation = (text) => {
    assert.equal(text, invocation.prompt);
    return invocation;
  };
  f.host.buildSkillPromptMessage = async (...args) => {
    assert.deepEqual(args, [skill, invocation, 'user']);
    return built;
  };
  f.owner.promptCustomMessage = (message, options) => {
    calls.push({ message, options });
    options.onPromptAdmitted();
    return new Promise(() => {});
  };
  for (const [running, deliverAs, delivery] of [[false, undefined, 'prompt'], [true, 'steer', 'steer'], [true, 'followUp', 'followUp']]) {
    if (running) await f.emit('agent_start');
    const response = await f.request('prompt', {
      text: invocation.prompt, deliverAs, images: [{ data: 'YWJj', mimeType: 'image/png' }],
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.delivery, delivery);
    const { message, options } = calls.at(-1);
    assert.deepEqual(message, {
      customType: 'skill-prompt',
      content: [{ type: 'text', text: built.message }, { type: 'image', data: 'YWJj', mimeType: 'image/png' }],
      display: true, details: built.details, attribution: 'user',
    });
    assert.equal(options.streamingBehavior, deliverAs ?? 'steer');
    assert.equal(options.queueChipText, invocation.prompt);
    assert.equal(options.throwOnDrop, true);
    assert.equal(options.images, undefined, 'photos belong to custom content, not a second delivery');
  }
  assert.equal(calls.length, 3);
  assert.equal(f.sent.length, 0, 'skill invocation never falls through to the plain prompt path');
});

test('image-only prompts and missing skill APIs never fall back to bypass delivery', async (t) => {
  const f = await fixture(t);
  const response = await f.request('prompt', { images: [{ data: 'YWJj', mimeType: 'image/webp' }] });
  assert.equal(response.status, 200);
  assert.deepEqual(f.sent, [{
    text: '', images: [{ type: 'image', data: 'YWJj', mimeType: 'image/webp' }], streamingBehavior: 'steer',
  }]);
  f.owner.skillsSettings = { enableSkillCommands: true };
  const refused = await f.request('prompt', { text: '/skill:review changes' });
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /cannot resolve skill invocations/);
  assert.equal(f.sent.length, 1, 'unsupported skill processing never starts a plain model prompt');
});

test('shared desktop UI forwards real feedback once and reconnects with authoritative current values', async (t) => {
  const f = await fixture(t);
  const first = await f.connect();
  assert.deepEqual(first.hello.feedbackRequests, []);
  await f.emit('session_start'); // Same shared UI must not wrap twice.
  f.ui.setStatus('git', 'old');
  assert.equal((await first.next()).statusText, 'old');
  f.ui.setStatus('git', 'main');
  assert.equal((await first.next()).statusText, 'main');
  const widgetLines = ['ready'];
  f.ui.setWidget('build', widgetLines, { placement: 'aboveEditor' });
  assert.deepEqual((await first.next()).widgetLines, ['ready']);
  widgetLines[0] = 'changed without a UI update';
  f.ui.notify('Review the warning', 'warning');
  const notice = await first.next();
  assert.equal(notice.notifyType, 'warning');
  f.ui.setEditorText('Review me');
  const draft = await first.next();
  f.ui.pasteToEditor(' too');
  const pasted = await first.next();
  assert.equal(pasted.text, 'Review me too');
  await f.emit('agent_end', { messages: [] });
  await first.next();
  assert.equal((await (await f.request('get_state')).json()).data.isStreaming, false);
  await first.reader.cancel();
  const resumed = await f.connect();
  const retained = resumed.hello.feedbackRequests;
  assert.deepEqual(retained.map((frame) => frame.method), ['setStatus', 'setWidget', 'notify', 'set_editor_text']);
  assert.equal(retained[0].statusText, 'main');
  assert.deepEqual(retained[1].widgetLines, ['ready']);
  assert.deepEqual(retained[2], notice);
  assert.deepEqual(retained[3], pasted);
  assert.notEqual(draft.id, pasted.id);
  f.ui.setStatus('git');
  assert.equal((await resumed.next()).statusText, undefined);
  // A terminal custom component replaces text without pretending to render it.
  f.ui.setWidget('build', () => ({}));
  assert.equal((await resumed.next()).widgetLines, undefined);
  await resumed.reader.cancel();
  const cleared = await f.connect();
  assert.deepEqual(cleared.hello.feedbackRequests, [notice, pasted]);
  await f.switchSession();
  assert.equal(await cleared.next(), undefined);
  const switched = await f.connect();
  assert.deepEqual(switched.hello.feedbackRequests, []);
  f.ui.notify('new session', 'info');
  assert.equal((await switched.next()).message, 'new session');
  assert.equal(f.terminalCalls.filter(([method]) => method === 'notify').length, 2);
  await f.emit('session_shutdown');
  assert.equal(f.ui.setStatus, f.originalUI.setStatus);
  assert.equal(await switched.next(), undefined);
});

test('desktop feedback bounds replay and hides internal transport without suppressing terminal calls', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  f.ui.setStatus('omp-pulse:reply', '{\"secret\":true}');
  f.ui.setWidget('omp-pulse-out:output', ['secret']);
  f.ui.notify('omp-pulse:encoded command reply', 'info');
  assert.throws(() => f.ui.setStatus('throws', 'not delivered'), /terminal rejected status/);
  f.ui.notify('visible', 'info');
  assert.equal((await stream.next()).message, 'visible');
  await stream.reader.cancel();
  for (let index = 0; index < 100; index++) f.ui.notify(`notice ${index}`, 'info');
  let resumed = await f.connect();
  assert.equal(resumed.hello.feedbackRequests.length, 32);
  assert.ok(resumed.hello.feedbackRequests.every((frame) => frame.message.startsWith('notice ')));
  await resumed.reader.cancel();
  for (let index = 0; index < 100; index++) f.ui.setStatus(`status-${index}`, 'x'.repeat(10_000));
  f.ui.setStatus('oversized', 'old');
  f.ui.setStatus('oversized', 'x'.repeat(64 * 1024));
  resumed = await f.connect();
  const frames = resumed.hello.feedbackRequests;
  assert.ok(frames.length <= 64);
  assert.ok(Buffer.byteLength(JSON.stringify(frames)) <= 256 * 1024);
  assert.ok(frames.every((frame) => frame.statusKey !== 'oversized'));
  assert.equal(f.terminalCalls[0][1], 'omp-pulse:reply', 'internal feedback still runs in the terminal');
  await resumed.reader.cancel();
});

test('desktop UI object replacement restores old methods and does not invent unsupported methods', async (t) => {
  const f = await fixture(t);
  const stream = await f.connect();
  f.ui.notify('old binding', 'info');
  await stream.next();
  const staleNotify = f.ui.notify;
  const terminal = [];
  const replacement = { notify(...args) { terminal.push(args); } };
  const original = replacement.notify;
  f.setUI(replacement);
  await f.emit('session_start');
  assert.deepEqual(await stream.next(), { type: 'extension_ui_snapshot', requests: [] });
  assert.equal(f.ui.notify, f.originalUI.notify);
  assert.equal('setStatus' in replacement, false);
  assert.equal('setWidget' in replacement, false);
  assert.equal('setEditorText' in replacement, false);
  staleNotify('old retained reference', 'info');
  replacement.notify('real method', 'warning');
  assert.equal((await stream.next()).message, 'real method');
  assert.deepEqual(terminal, [['real method', 'warning']]);
  await f.emit('session_shutdown');
  assert.equal(replacement.notify, original);
  assert.equal(await stream.next(), undefined);
});

test('desktop state reads delivery modes from the active session without defaults', async t => {
  const f = await fixture(t);
  Object.assign(f.owner, { steeringMode: 'one-at-a-time', followUpMode: 'all', interruptMode: 'wait' });
  let state = (await (await f.request('get_state')).json()).data;
  assert.equal(state.steeringMode, 'one-at-a-time');
  assert.equal(state.followUpMode, 'all');
  assert.equal(state.interruptMode, 'wait');
  assert.equal(state.settingsReadOnly, true);
  Object.assign(f.owner, { steeringMode: undefined, followUpMode: 'invalid', interruptMode: undefined });
  state = (await (await f.request('get_state')).json()).data;
  assert.equal(state.steeringMode, null);
  assert.equal(state.followUpMode, null);
  assert.equal(state.interruptMode, null);
});

test('desktop context measurement lower bound belongs to the current state request', async t => {
  const f = await fixture(t);
  const before = Date.now();
  const state = (await (await f.request('get_state')).json()).data;
  const after = Date.now();
  assert.equal(Number.isFinite(state.contextMeasuredAfter), true);
  assert.equal(state.contextMeasuredAfter >= before, true);
  assert.equal(state.contextMeasuredAfter <= after, true);
});

test('desktop input hooks transform text and photos, or consume submissions locally', async (t) => {
  const f = await fixture(t);
  const image = { type: 'image', data: 'replacement', mimeType: 'image/jpeg' };
  const inputs = [];
  f.owner.extensionRunner = {
    hasHandlers: (event) => event === 'input',
    async emitInput(text, images, source) {
      inputs.push({ text, images, source });
      return { text: 'rewritten', images: [image] };
    },
  };
  await f.request('prompt', { text: 'original', images: [{ data: 'old', mimeType: 'image/png' }] });
  assert.equal(inputs[0].source, 'rpc');
  assert.equal(inputs[0].text, 'original');
  assert.deepEqual(f.sent, [{ text: 'rewritten', images: [image], streamingBehavior: 'steer' }]);
  f.owner.extensionRunner.emitInput = async () => ({ handled: true });
  assert.equal((await (await f.request('prompt', { text: 'local' })).json()).data.delivery, 'local');
  f.owner.extensionRunner.emitInput = async () => ({ text: '', images: [] });
  assert.equal((await (await f.request('prompt', { text: 'cleared' })).json()).data.delivery, 'local');
  assert.equal(f.sent.length, 1);
});

test('desktop async input cannot be delivered after native session navigation', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.owner.extensionRunner = {
    hasHandlers: () => true,
    async emitInput() {
      assert.equal(await f.emit('session_before_switch'), undefined);
      await f.switchSession();
      return { text: 'wrong destination' };
    },
  };
  assert.equal((await f.request('prompt', { text: 'original' })).status, 502);
  assert.deepEqual(f.sent, []);
});

test('locally handled input navigation completes without submitting into the new session', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  f.owner.extensionRunner = {
    hasHandlers: () => true,
    async emitInput() {
      assert.equal(await f.emit('session_before_switch'), undefined);
      await f.switchSession();
      return { handled: true };
    },
  };
  const result = await (await f.request('prompt', { text: 'navigate locally' })).json();
  assert.equal(result.data.delivery, 'local');
  assert.deepEqual(f.sent, []);
});

test('desktop speed tier preserves ultrafast and does not invent an unavailable tier', async (t) => {
  const f = await fixture(t);
  const tier = async () => (await (await f.request('get_state')).json()).data.fastModeTier;
  assert.equal(await tier(), undefined);
  f.owner.isFastModeEnabled = () => true;
  assert.equal(await tier(), undefined);
  f.owner.isUltrafastModeEnabled = () => true;
  assert.equal(await tier(), 'ultrafast');
  f.owner.isUltrafastModeEnabled = () => false;
  assert.equal(await tier(), 'fast');
  f.owner.isFastModeEnabled = () => false;
  assert.equal(await tier(), 'off');
});
