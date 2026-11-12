import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const test = (name, fn) => nodeTest(name, {timeout: 10000}, fn);
// Real controller, store, selector, Markdown and Copy controls; network-blocked
// synthetic DOM only. This suite makes no browser-paint or geometry claim.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act, useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {MessageParts} from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import {CopyButton} from ${JSON.stringify(resolve(root, 'web/src/app/parts/CopyButton.tsx'))};
import {visibleStreamingMessage} from ${JSON.stringify(resolve(root, 'web/src/domain/stream-visibility.ts'))};
import {getRawAssistantText, getAssistantDisplayBoundaries} from ${JSON.stringify(resolve(root, 'web/src/domain/message-provenance.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {getOfflineQueueNamespace} from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
import {RunningAgentCountTracker} from ${JSON.stringify(resolve(root, 'web/src/runtime/running-agent-count.ts'))};
const countReads = [];
const store = createOmpStore();
store.getState().beginSession('/synthetic');
const controller = Object.create(OmpSessionController.prototype);
Object.assign(controller, {
 store, activeSession: '/synthetic', generation: 1, disposed: false,
 queueNamespace: getOfflineQueueNamespace(),
 // This prototype fixture bypasses the controller constructor; keep its real
 // count lifecycle present while forbidding reads without desktop authority.
 runningAgentCount: new RunningAgentCountTracker(store, async path => { countReads.push(path); throw Error('Unexpected count read without desktop authority'); }),
 stateIngressSequence: 0, clockShift: 0, flushHandle: null, flushKind: null,
 pendingDeltas: [], responseChain: null, streamText: '', atBottom: true,
 modelEntryAt: 0, thinkingEntryAt: 0, openingHistory: null,
 historyAbort: new AbortController(), reconnectTimer: null, socket: null,
 watchdogTimer: null, livenessProbe: null, catchUpTimer: null,
 recordSuccess() {}, reconcileReceipts: async () => {}, reloads: 0,
 reloadHistory: async function() { this.reloads++ },
 syncOffline() {}, syncQueuedCount() {}, startOfflineTicker() {},
 startLivenessProbe() {}, platformOffline: () => false,
 // Exercise openSession's real reset and first-bundle lifecycle without a socket.
 connectSocket(generation, path) {
  this.handleFrame({type: 'bundle', history: {entries: [], nextBefore: null, endOffset: 0}, running: false}, generation, path);
 },
});
const writes = [];
Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => { writes.push(text) }}});
function Transcript() {
 const messages = useSyncExternalStore(store.subscribe, () => store.getState().messages);
 return h('section', {'data-history': true}, messages.map(message => h('article', {key: message.id, 'data-row': message.id},
  h(MessageParts, {message, finalReply: true}),
  h(CopyButton, {text: message.text, label: 'Copy full reply'}))));
}
function Live() {
 const shown = useSyncExternalStore(store.subscribe, () => visibleStreamingMessage(store.getState().messages, store.getState().streamingMessage));
 return shown ? h('section', {'data-live': true}, h(MessageParts, {message: shown, isStreaming: true}),
  h(CopyButton, {text: shown.text, label: 'Copy live reply'})) : null;
}
window.fixture = {act, store, controller, writes, countReads, getRawAssistantText, getAssistantDisplayBoundaries,
 visible: () => visibleStreamingMessage(store.getState().messages, store.getState().streamingMessage),
 mount() { const r = createRoot(document.getElementById('root')); r.render(h('main', {}, h(Transcript), h(Live))); return r },
};
`, [{name: 'test-import-meta', options(options) {
 return {...options, transform: {...options.transform, define: {...options.transform?.define, 'import.meta': '{}'}}};
}}]);

const prose = 'The final answer should appear once.';
const wire = (responseId = 'r1', value = prose, extra = {}) => ({
 role: 'assistant', responseId, timestamp: 1700000000000,
 content: [{type: 'text', text: value}], ...extra,
});
const entry = (message, id = 'persisted') => ({type: 'message', id, message});
const multipart = (responseId, first, last, extra = {}) => wire(responseId, first, {
 content: [{type: 'text', text: first}, {type: 'text', text: last}], ...extra,
});
const tool = {type: 'toolCall', id: 't1', name: 'bash', arguments: {command: 'synthetic command'}};
const startEntry = {type: 'custom', customType: 'tool_execution_start', data: {
 toolCallId: 't1', toolName: 'bash', args: tool.arguments, startedAt: 1700000000000,
}};
const resultEntry = {type: 'message', id: 'result1', message: {
 role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{type: 'text', text: 'synthetic result'}],
}};

async function fixture(t) {
 const dom = createDomFixture(code), w = dom.window;
 const {act, store, controller, writes, visible} = w.fixture;
 w.HTMLElement.prototype.scrollTo = () => {};
 const frames = new Map(); let next = 0;
 w.requestAnimationFrame = callback => { const id = ++next; frames.set(id, callback); return id };
 w.cancelAnimationFrame = id => frames.delete(id);
 let mounted;
 await act(async () => { mounted = w.fixture.mount() });
 const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) });
 const change = async fn => { await act(async () => fn()); await settle() };
 t.after(async () => {
  try {
   await act(async () => { controller.closeSession(); mounted.unmount() });
   assert.equal(frames.size, 0, 'controller and React cleanup cancel every scheduled frame');
   assert.deepEqual(dom.blocked, [], 'no fixture attempted network access');
   assert.equal(w.fixture.countReads.length, 0, 'no passive count read without confirmed desktop authority');
  } finally { dom.close() }
 });
 const frame = value => change(() => controller.handleFrame(value, controller.generation, controller.activeSession));
 return {
  w, d: w.document, store, controller, frames, writes, visible, change, frame,
  event: event => frame({type: 'event', event}), history: entries => frame({type: 'entries', entries}),
  live: () => store.getState().streamingMessage,
  count: (value = prose) => w.document.querySelector('main').textContent.split(value).length - 1,
  async copy(selector) {
   const button = w.document.querySelector(selector);
   assert.ok(button, `Copy control exists: ${selector}`);
   await change(() => button.click());
   return writes.at(-1);
  },
  async flush() {
   for (let i = 0; frames.size && i < 32; i++) {
    const pending = [...frames.values()]; frames.clear();
    await change(() => { for (const callback of pending) callback(0) });
   }
   assert.equal(frames.size, 0, 'synthetic frame drain is bounded');
  },
 };
}

function assertCovered(f, expectedLive) {
 assert.equal(f.count(), 1, 'history-before-end renders the same response prose once');
 assert.ok(f.live(), 'the stream has not ended');
 assert.equal(f.live().text, expectedLive, 'comparison never rewrites the live display accumulator');
 assert.equal(f.visible() === null, true);
 assert.equal(f.d.querySelector('[data-live]') === null, true);
}

// These exact fixtures were also run against the pre-fix source. Keep
// them independent of the new helper module so the negative control can bundle.
test('transient append boundary: raw delta and normalized multipart history render prose once', async t => {
 const f = await fixture(t), initial = wire(), suffix = '```text\nSYNTHETIC_BLOCK\n```';
 const final = multipart('r1', prose, suffix);
 await f.event({type: 'message_start', message: initial});
 await f.event({type: 'message_update', message: initial});
 await f.frame({type: 'md', id: 'r1', a: suffix}); await f.flush();
 const liveDisplay = prose + suffix, historyDisplay = prose + '\n' + suffix;
 assert.equal(f.live().text, liveDisplay);
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'), liveDisplay);
 const beforeHistory = f.live();
 await f.history([entry(final)]);
 assert.equal(f.store.getState().messages[0].text, historyDisplay);
 assert.equal(f.live().responseKey, f.store.getState().messages[0].responseKey);
 assert.equal(f.live(), beforeHistory, 'coverage does not replace transport state');
 assertCovered(f, liveDisplay);
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'), historyDisplay);
 await f.event({type: 'message_end', message: final});
 assert.equal(f.count(), 1);
 assert.equal(f.live() === null, true);
 assert.equal(f.store.getState().messages[0].text, historyDisplay);
});

test('transient raw-k replacement: repaired live display and raw-equivalent history render prose once', async t => {
 const f = await fixture(t), oldFence = '```text\nOLD\n```', nextFence = '```text\nNEW\n```';
 const initial = multipart('r1', prose, oldFence), final = multipart('r1', prose, nextFence);
 const rawInitial = prose + oldFence, repairedInitial = prose + '\n' + oldFence;
 await f.event({type: 'message_start', message: initial});
 await f.event({type: 'message_update', message: initial});
 assert.equal(f.live().text, repairedInitial);
 const delta = {type: 'md', id: 'r1', k: rawInitial.indexOf('OLD'), a: 'NEW\n```'};
 await f.frame(delta); await f.flush();
 // k=44 is raw UTF-16; the display-only newline is not a wire unit.
 assert.equal(delta.k, 44);
 const existingDisplay = prose + '\n' + nextFence;
 const historyDisplay = prose + '\n' + nextFence;
 assert.equal(f.live().text, existingDisplay);
 assert.equal(existingDisplay, historyDisplay);
 assert.notEqual(existingDisplay, prose + nextFence);
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'), existingDisplay);
 const beforeHistory = f.live();
 await f.history([entry(final)]);
 assert.equal(f.store.getState().messages[0].text, historyDisplay);
 assert.equal(f.live(), beforeHistory);
 assertCovered(f, existingDisplay);
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'), historyDisplay);
 await f.event({type: 'message_end', message: final});
 assert.equal(f.count(), 1);
 assert.equal(f.store.getState().messages[0].text, historyDisplay);
});

for (const order of ['history-first', 'commit-first']) {
 test(`multi-response tool turn, final, combined history and replay: ${order}`, async t => {
  const f = await fixture(t);
  const first = wire('r0', 'I will check the result.', {content: [{type: 'text', text: 'I will check the result.'}, tool]});
  const final = wire();
  await f.event({type: 'agent_start'});
  await f.event({type: 'message_start', message: first});
  await f.event({type: 'message_end', message: first});
  for (const event of [
   {type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: tool.arguments},
   {type: 'tool_execution_update', toolCallId: 't1', partialResult: 'synthetic result'},
   {type: 'tool_execution_end', toolCallId: 't1', result: 'synthetic result'},
  ]) await f.event(event);
  await f.event({type: 'message_start', message: wire('r1', 'The final')});
  await f.frame({type: 'md', id: 'r1', a: ' answer should appear once.'}); await f.flush();
  assert.equal(f.count(), 1);
  const entries = [entry(first, 'p0'), startEntry, resultEntry, entry(final, 'p1')];
  if (order === 'history-first') { await f.history(entries); assertCovered(f, prose) }
  await f.event({type: 'message_end', message: final});
  if (order === 'commit-first') await f.history(entries);
  await f.event({type: 'agent_end'});
  assert.equal(f.count(), 1); assert.equal(f.count('I will check the result.'), 1);
  assert.equal(f.store.getState().messages.length, 2);
  await f.frame({type: 'bundle', history: {entries, nextBefore: null, endOffset: 200}, running: false});
  for (const message of [first, final]) {
   await f.event({type: 'message_start', message}); assert.equal(f.count(), 1);
   await f.event({type: 'message_end', message}); assert.equal(f.count(), 1);
  }
  await f.history(entries);
  assert.equal(f.store.getState().messages.length, 2);
  const calls = f.store.getState().messages.flatMap(m => m.parts).filter(p => p.kind === 'tool' && p.callId === 't1');
  assert.equal(calls.length, 1); assert.equal(calls[0].state, 'ok'); assert.equal(calls[0].output, 'synthetic result');
 });
}

test('sequential persisted-id replacements and stale old-id replay keep one response', async t => {
 const f = await fixture(t), message = wire();
 await f.event({type: 'message_end', message});
 for (const id of ['p1', 'p2', 'p1', 'p2']) {
  await f.history([entry(message, id)]);
  assert.equal(f.count(), 1); assert.equal(f.store.getState().messages.length, 1);
  assert.equal(f.store.getState().messages[0].id, id);
 }
});

test('equal text across a tool boundary remains two distinct response identities', async t => {
 const f = await fixture(t), first = wire('r0', prose, {content: [{type: 'text', text: prose}, tool]}), final = wire();
 await f.event({type: 'message_end', message: first});
 await f.event({type: 'tool_execution_end', toolCallId: 't1', result: 'synthetic result'});
 await f.event({type: 'message_start', message: final}); assert.equal(f.count(), 2);
 await f.event({type: 'message_end', message: final});
 await f.history([entry(first, 'p0'), resultEntry, entry(final, 'p1')]);
 assert.equal(f.count(), 2); assert.equal(f.store.getState().messages.length, 2);
});

for (const [kind, liveText] of [
 ['longer', prose + ' Still streaming.'],
 ['revised', prose.replace('once', 'twice')],
 ['trailing-newline', prose + '\n'],
]) {
 test(`same-response ${kind} raw source remains visible with exact Copy`, async t => {
  const f = await fixture(t);
  await f.history([entry(wire())]);
  await f.event({type: 'message_start', message: wire('r1', liveText)});
  assert.equal(f.visible(), f.live()); assert.ok(f.d.querySelector('[data-live]'));
  assert.equal(f.live().text, liveText);
  assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'), liveText);
  // Existing persisted rows are authoritative at commit. Deliver their final
  // revision before testing completion, rather than changing that policy here.
  await f.history([entry(wire('r1', liveText))]);
  assert.equal(f.visible() === null, true);
  await f.event({type: 'message_end', message: wire('r1', liveText)});
  assert.equal(f.live() === null, true); assert.equal(f.store.getState().messages.length, 1);
  assert.equal(f.store.getState().messages[0].text, liveText);
 });
}

test('repaired full snapshot plus append remains covered without changing display', async t => {
 const f = await fixture(t), fence = '```text\nOLD\n```';
 await f.event({type: 'message_start', message: multipart('r1', prose, fence)});
 await f.frame({type: 'md', id: 'r1', a: '\ncontinued'}); await f.flush();
 const expected = prose + '\n' + fence + '\ncontinued';
 assert.equal(f.live().text, expected);
 await f.history([entry(multipart('r1', prose, fence + '\ncontinued'))]);
 assertCovered(f, expected);
});

test('full update replaces queued deltas and reseeds raw comparison before subsequent replacements', async t => {
 const f = await fixture(t), oldFence = '```text\nOLD\n```', replacementFence = '```text\nSNAPSHOT\n```';
 await f.event({type: 'message_start', message: multipart('r1', prose, oldFence)});
 await f.frame({type: 'md', id: 'r1', a: 'MUST_NOT_SURVIVE'});
 assert.equal(f.controller.pendingDeltas.length, 1);
 await f.event({type: 'message_update', message: multipart('r1', prose, replacementFence)});
 assert.equal(f.controller.pendingDeltas.length, 0);
 const raw = prose + replacementFence, k = raw.indexOf('SNAPSHOT');
 assert.equal(f.controller.streamRawText, raw);
 await f.frame({type: 'md', id: 'r1', k, a: 'RESEEDED\n```'}); await f.flush();
 const expectedDisplay = prose + '\n```text\nRESEEDED\n```';
 assert.equal(f.live().text, expectedDisplay); assert.ok(!f.live().text.includes('MUST_NOT_SURVIVE'));
 await f.history([entry(multipart('r1', prose, '```text\nRESEEDED\n```'))]);
 assertCovered(f, expectedDisplay);
});

test('message_end full snapshot wins over unflushed delta data', async t => {
 const f = await fixture(t), fence = '```text\nFINAL\n```';
 await f.event({type: 'message_start', message: wire('r1', 'obsolete')});
 await f.frame({type: 'md', id: 'r1', a: 'MUST_NOT_SURVIVE'});
 await f.event({type: 'message_end', message: multipart('r1', prose, fence)});
 assert.equal(f.frames.size, 0); assert.equal(f.controller.pendingDeltas.length, 0);
 assert.equal(f.controller.streamRawText === null, true);
 assert.equal(f.store.getState().messages[0].text, prose + '\n' + fence);
 await f.event({type: 'message_start', message: multipart('r1', prose, fence)});
 assertCovered(f, prose + '\n' + fence);
});

test('same-display full update replaces the raw origin before a following delta', async t => {
 const f=await fixture(t), fence='```text\nSAME_DISPLAY\n```';
 await f.event({type:'message_start',message:multipart('r1',prose,fence)});
 const display=prose+'\n'+fence;
 assert.equal(f.live().text,display);assert.equal(f.controller.streamRawText,prose+fence);
 await f.event({type:'message_update',message:wire('r1',display)});
 assert.equal(f.live().text,display);assert.equal(f.controller.streamRawText,display);
 await f.frame({type:'md',id:'r1',a:'\ncontinued'});await f.flush();
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'),display+'\ncontinued');
 await f.history([entry(wire('r1',display+'\ncontinued'))]);
 assertCovered(f,display+'\ncontinued');
});

test('covered raw prose preserves fresh tool, thinking, image and provider error details', async t => {
 const f = await fixture(t), fence = '```text\nSYNTHETIC_BLOCK\n```';
 const fresh = wire('r1', prose, {
  content: [{type: 'text', text: prose}, {type: 'thinking', thinking: 'Fresh synthetic reasoning'},
   {type: 'image', data: 'AA==', mimeType: 'image/png'}, tool],
  errorMessage: 'Fresh synthetic failure', stopReason: 'error',
 });
 await f.event({type: 'message_start', message: fresh});
 await f.frame({type: 'md', id: 'r1', a: fence}); await f.flush();
 await f.history([entry(multipart('r1', prose, fence))]);
 const projected = f.visible();
 assert.equal(f.count(), 1); assert.ok(projected); assert.equal(projected.text, '');
 assert.deepEqual(Array.from(projected.parts, part => part.kind).sort(), ['image', 'thinking', 'tool']);
 assert.equal(projected.errorMessage, 'Fresh synthetic failure');
 assert.ok(f.d.querySelector('[data-live]')); assert.equal(f.live().text, prose + fence);
 await f.event({type: 'tool_execution_update', toolCallId: 't1', partialResult: 'fresh output'});
 assert.equal(f.count(), 1, 'tool-only immutable update preserves comparison provenance');
 assert.equal(f.visible().parts.find(part => part.kind === 'tool').output, 'fresh output');
 await f.event({type: 'tool_execution_end', toolCallId: 't1', result: 'fresh final', isError: true});
 assert.equal(f.count(), 1);
 assert.equal(f.visible().parts.find(part => part.kind === 'tool').state, 'error');
 const final = {...fresh, content: [{type: 'text', text: prose}, {type: 'text', text: fence}, ...fresh.content.slice(1)]};
 await f.history([entry(final)]);
 await f.event({type: 'agent_end'});
 const committed = f.store.getState().messages[0];
 assert.equal(f.count(), 1); assert.equal(committed.errorMessage, 'Fresh synthetic failure');
 assert.equal(committed.parts.find(part => part.kind === 'tool').output, 'fresh final');
});

test('UTF-16 replacement coordinates fold raw source separately from repaired display', async t => {
 const f = await fixture(t), prefix = prose + ' 🧪', fence = '```text\nOLD🦄\n```';
 await f.event({type: 'message_start', message: multipart('r1', prefix, fence)});
 // k is JavaScript/daemon UTF-16 units, not code points; queued append and
 // replacement share one flush, including a second keep into buffered text.
 const raw = prefix + fence, k = raw.indexOf('OLD');
 const deltas = [{a: '\nunused'}, {k, a: 'NEW🚀discard'}, {k: k + 'NEW🚀'.length, a: '\n```'}];
 const expectedDisplay = prefix + '\n```text\nNEW🚀\n```';
 for (const delta of deltas) {
  await f.frame({type: 'md', id: 'r1', ...delta});
 }
 await f.flush(); assert.equal(f.live().text, expectedDisplay);
 assert.equal(f.controller.streamRawText, prefix + '```text\nNEW🚀\n```');
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'), expectedDisplay);
 await f.history([entry(multipart('r1', prefix, '```text\nNEW🚀\n```'))]);
 assertCovered(f, expectedDisplay);
});

for (const reset of ['close-and-reopen', 'switch-directly']) {
 test(`session ${reset} cancels queued data and isolates next raw response`, async t => {
  const f = await fixture(t), fence = '```text\nOLD\n```';
  await f.event({type: 'message_start', message: multipart('old-response', 'Old session.', fence)});
  await f.frame({type: 'md', id: 'old-response', a: 'DO_NOT_LEAK'});
  const stale = [...f.frames.values()];
  if (reset === 'close-and-reopen') {
   await f.change(() => f.controller.closeSession());
   assert.equal(f.controller.streamRawText === null, true);
  }
  await f.change(() => f.controller.openSession('/synthetic-next'));
  assert.equal(f.controller.responseChain === null, true); assert.equal(f.controller.streamText, '');
  assert.equal(f.controller.streamRawText === null, true);
  assert.equal(f.controller.pendingDeltas.length, 0); assert.equal(f.live() === null, true);
  const suffix = '```text\nNEW SESSION\n```';
  await f.event({type: 'message_start', message: wire()});
  await f.change(() => { for (const callback of stale) callback(0) });
  assert.equal(f.live().text, prose, 'already-dispatched old-generation callback is inert');
  await f.frame({type: 'md', id: 'r1', a: suffix}); await f.flush();
  await f.history([entry(multipart('r1', prose, suffix))]);
  assertCovered(f, prose + suffix);
 });
}

test('late md after commit triggers bounded reload without restoring obsolete live prose', async t => {
 const f = await fixture(t), final = wire();
 await f.event({type: 'message_start', message: final});
 await f.event({type: 'message_end', message: final});
 await f.frame({type: 'md', id: 'r1', a: 'LATE'}); await f.flush();
 assert.equal(f.controller.reloads, 1); assert.equal(f.live() === null, true); assert.equal(f.count(), 1);
 assert.equal(f.controller.pendingDeltas.length, 0); assert.equal(f.controller.streamRawText === null, true);
 const suffix = '```text\nNEXT\n```';
 await f.event({type: 'message_start', message: wire('r2', 'Next response.')});
 await f.frame({type: 'md', id: 'r2', a: suffix}); await f.flush();
 await f.history([entry(multipart('r2', 'Next response.', suffix), 'next')]);
 assert.equal(f.visible() === null, true); assert.equal(f.count('Next response.'), 1);
 assert.ok(!f.live().text.includes('LATE'));
});


test('at-cut opener deactivates and append reactivates the existing boundary with exact live Copy', async t => {
 const f=await fixture(t),fence='```text\nOLD\n```';
 await f.event({type:'message_start',message:multipart('r1',prose,fence)});
 await f.frame({type:'md',id:'r1',k:prose.length,a:'`'});await f.flush();
 assert.equal(f.live().text,prose+'`');
 assert.deepEqual(Array.from(f.w.fixture.getAssistantDisplayBoundaries(f.live())),[prose.length]);
 assert.equal(f.w.fixture.getRawAssistantText(f.live()),prose+'`');
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'),prose+'`');
 await f.frame({type:'md',id:'r1',a:'`'});await f.flush();assert.equal(f.live().text,prose+'``');
 await f.frame({type:'md',id:'r1',a:'`text\nNEW\n```'});await f.flush();
 const expected=prose+'\n```text\nNEW\n```';
 assert.equal(f.live().text,expected);assert.equal(f.controller.streamRawText,prose+'```text\nNEW\n```');
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'),expected);
 await f.history([entry(multipart('r1',prose,'```text\nNEW\n```'))]);assertCovered(f,expected);
 await f.event({type:'message_end',message:multipart('r1',prose,'```text\nNEW\n```')});
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'),expected);
});

test('identical raw and display full snapshot removes an inactive last-known boundary', async t => {
 const f=await fixture(t);await f.event({type:'message_start',message:multipart('r1',prose,'```text')});
 await f.frame({type:'md',id:'r1',k:prose.length,a:'ordinary'});await f.flush();
 const identical=f.live().text;assert.equal(identical,prose+'ordinary');
 assert.deepEqual(Array.from(f.controller.streamDisplay.anchors),[prose.length]);
 await f.event({type:'message_update',message:wire('r1',identical)});
 assert.equal(f.live().text,identical);assert.equal(f.controller.streamRawText,identical);
 assert.deepEqual(Array.from(f.controller.streamDisplay.anchors),[]);
 await f.frame({type:'md',id:'r1',k:prose.length,a:'```text\nNEW\n```'});await f.flush();
 const expected=prose+'```text\nNEW\n```';
 assert.equal(f.live().text,expected,'md cannot rediscover the discarded producer boundary');
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'),expected);
});

test('same-raw full snapshots move and remove multiple boundaries before another replacement', async t => {
 const f=await fixture(t),a='A',b='```oneB',c='~~~two',aggregate=a+b+c;
 const message=content=>wire('r1',aggregate,{content:content.map(value=>({type:'text',text:value}))});
 await f.event({type:'message_start',message:message([a,b,c])});
 assert.deepEqual(Array.from(f.controller.streamDisplay.anchors),[1,8]);
 await f.event({type:'message_update',message:message([a+b,c])});
 assert.equal(f.controller.streamRawText,aggregate);assert.deepEqual(Array.from(f.controller.streamDisplay.anchors),[8]);
 await f.frame({type:'md',id:'r1',k:8,a:'~~~changed'});await f.flush();
 assert.equal(f.live().text,a+b+'\n~~~changed');
 await f.event({type:'message_update',message:message([aggregate])});
 assert.deepEqual(Array.from(f.controller.streamDisplay.anchors),[]);
 await f.frame({type:'md',id:'r1',k:8,a:'~~~final'});await f.flush();
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'),a+b+'~~~final');
});

test('raw replacement preserves retained part order and repaired suffix across final normalization', async t => {
 const f=await fixture(t),reason={type:'thinking',thinking:'Inspecting'},image={type:'image',data:'AA==',mimeType:'image/png'};
 const message=value=>wire('r1',prose,{content:[{type:'text',text:prose},reason,tool,image,
  {type:'text',text:'Following.'},{type:'unknown'},{type:'text',text:'```text\n'+value+'\n```'}]});
 await f.event({type:'message_start',message:message('OLD')});
 const before=Array.from(f.live().parts),k=f.controller.streamRawText.indexOf('OLD');
 await f.frame({type:'md',id:'r1',k,a:'NEW\n```'});await f.flush();
 const expected=prose+'Following.\n```text\nNEW\n```';
 assert.equal(f.live().text,expected);assert.equal(f.w.fixture.getRawAssistantText(f.live()),prose+'Following.```text\nNEW\n```');
 assert.deepEqual(Array.from(f.live().parts,p=>p.kind),['text','thinking','tool','image','text']);
 for(let i=0;i<4;i++)assert.equal(f.live().parts[i],before[i]);
 assert.equal(f.live().parts.filter(p=>p.kind==='text').map(p=>p.text).join(''),expected);
 assert.equal(await f.copy('[data-live] button[aria-label="Copy live reply"]'),expected);
 await f.event({type:'message_end',message:message('NEW')});
 const final=f.store.getState().messages[0];assert.equal(final.text,expected);
 assert.deepEqual(Array.from(final.parts,p=>p.kind),['text','thinking','tool','image','text']);
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'),expected);
});

test('external prose mutation cannot mint comparison proof while private transport coordinates remain exact', async t => {
 const f=await fixture(t),fence='```text\nOLD\n```';
 await f.event({type:'message_start',message:multipart('r1',prose,fence)});
 const old=f.live();await f.change(()=>f.store.getState().setStreamingMessage({...old,text:'external',parts:[{kind:'text',text:'external'}]}));
 assert.equal(f.w.fixture.getRawAssistantText(f.live()) === null, true);
 const k=(prose+fence).indexOf('OLD');await f.frame({type:'md',id:'r1',k,a:'NEW\n```'});await f.flush();
 const expected=prose+'\n```text\nNEW\n```';assert.equal(f.live().text,expected);
 assert.equal(f.controller.streamRawText === null, true);assert.equal(f.w.fixture.getRawAssistantText(f.live()) === null, true);
 assert.deepEqual(Array.from(f.w.fixture.getAssistantDisplayBoundaries(f.live())),[]);
 await f.frame({type:'md',id:'r1',a:'!'});await f.flush();assert.equal(f.live().text,expected+'!');
 assert.equal(f.w.fixture.getRawAssistantText(f.live()) === null, true);
 await f.event({type:'message_update',message:multipart('r1',prose,'```text\nNEW\n```')});
 assert.equal(f.w.fixture.getRawAssistantText(f.live()),prose+'```text\nNEW\n```');
 assert.deepEqual(Array.from(f.w.fixture.getAssistantDisplayBoundaries(f.live())),[prose.length]);
});

test('terminal agent_end retains queued output before the next animation frame', async t => {
 const f = await fixture(t);
 await f.event({type: 'message_start', message: wire('r1', 'Initial')});
 await f.frame({type: 'md', id: 'r1', a: ' final output', g: 9});
 assert.equal(f.controller.pendingDeltas.length, 1);
 await f.event({type: 'agent_end'});
 assert.equal(f.store.getState().messages[0].text, 'Initial final output');
 assert.equal(f.store.getState().messages[0].generated, 9);
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'), 'Initial final output');
 assert.equal(f.live() === null, true);
 assert.equal(f.frames.size, 0);
});

for (const terminal of ['agent_end', 'legacy idle', 'authoritative idle']) {
 test(`${terminal} folds queued UTF-16 replacement and append while retaining tool details`, async t => {
  const f = await fixture(t), prefix = 'Answer 🧪', fence = '```text\nOLD\n```';
  await f.event({type: 'message_start', message: multipart('r1', prefix, fence, {
   content: [{type: 'text', text: prefix}, {type: 'text', text: fence}, tool],
  })});
  await f.event({type: 'tool_execution_end', toolCallId: 't1', result: 'tool result'});
  const raw = prefix + fence;
  await f.frame({type: 'md', id: 'r1', k: raw.indexOf('OLD'), a: 'NEW🚀', g: 10});
  await f.frame({type: 'md', id: 'r1', a: '\n```', g: 12});
  const callbacks = [...f.frames.values()];
  if (terminal === 'agent_end') await f.event({type: 'agent_end'});
  else await f.change(() => f.controller.reconcileSessionState('/synthetic', terminal === 'legacy idle'
   ? {running: false}
   : {sessionState: {
    daemonInstanceId: 'synthetic-daemon', revision: 1, bindingEpoch: 1,
    owner: {kind: 'child', pid: 123, processStart: 10}, turn: 'idle', confidence: 'confirmed',
    connection: 'connected', observedAt: Date.now(), activity: null,
    capabilities: {read: true, stream: true, control: true, send: true, stop: true, answer: true, settings: true, bash: true},
   }}));
  const expected = prefix + '\n```text\nNEW🚀\n```';
  const final = f.store.getState().messages[0];
  assert.equal(final.text, expected);
  assert.equal(final.generated, 12);
  assert.equal(final.parts.find(part => part.kind === 'tool').output, 'tool result');
  assert.equal(f.w.fixture.getRawAssistantText(final), prefix + '```text\nNEW🚀\n```');
  assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'), expected);
  assert.equal(f.live() === null, true); assert.equal(f.frames.size, 0);
  await f.event({type: 'message_start', message: wire('r2', expected)});
  await f.change(() => { for (const callback of callbacks) callback(0) });
  assert.equal(f.live().text, expected);
  await f.event({type: 'message_end', message: wire('r2', expected)});
  assert.equal(f.store.getState().messages.length, 2, 'equal-content response keeps its distinct identity');
  await f.history([entry(multipart('r1', prefix, '```text\nNEW🚀\n```'), 'first'), entry(wire('r2', expected), 'second')]);
  assert.equal(f.store.getState().messages.length, 2, 'persisted replay reconciles each identity once');
 });
}

test('hidden-page terminal completion drains and cancels the queued timer', async t => {
 const f = await fixture(t), timers = new Map();
 const originalSet = f.w.setTimeout.bind(f.w), originalClear = f.w.clearTimeout.bind(f.w);
 Object.defineProperty(f.w.document, 'visibilityState', {configurable: true, value: 'hidden'});
 f.w.setTimeout = (callback, delay, ...args) => {
  if (delay !== 1000) return originalSet(callback, delay, ...args);
  const id = originalSet(() => {}, 60000); timers.set(id, callback); return id;
 };
 f.w.clearTimeout = id => { timers.delete(id); originalClear(id) };
 t.after(() => { for (const id of timers.keys()) originalClear(id) });
 await f.event({type: 'message_start', message: wire('r1', 'Hidden')});
 await f.frame({type: 'md', id: 'r1', a: ' final', g: 6});
 assert.equal(timers.size, 1); assert.equal(f.controller.flushKind, 'timer');
 await f.event({type: 'agent_end', isTerminal: false});
 assert.equal(f.controller.pendingDeltas.length, 1, 'non-terminal events do not commit');
 await f.event({type: 'agent_end', bridgeLost: true});
 assert.equal(f.controller.pendingDeltas.length, 1, 'bridge loss does not commit');
 await f.event({type: 'agent_end'});
 assert.equal(f.store.getState().messages[0].text, 'Hidden final');
 assert.equal(f.store.getState().messages[0].generated, 6);
 assert.equal(timers.size, 0); assert.equal(f.live() === null, true);
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'), 'Hidden final');
});

test('terminal drain preserves the existing persisted-response authority', async t => {
 const f = await fixture(t);
 await f.event({type: 'message_start', message: wire('r1', 'Initial')});
 await f.frame({type: 'md', id: 'r1', a: ' queued'});
 await f.history([entry(wire('r1', 'Persisted final'), 'canonical')]);
 await f.event({type: 'agent_end'});
 assert.equal(f.store.getState().messages.length, 1);
 assert.equal(f.store.getState().messages[0].id, 'canonical');
 assert.equal(f.store.getState().messages[0].text, 'Persisted final');
 assert.equal(f.controller.pendingDeltas.length, 0); assert.equal(f.frames.size, 0);
 assert.equal(f.live() === null, true);
});
