import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

// Actual controller/store and mounted application Markdown/Copy components.
// Synthetic DOM proves structure and scheduling, not browser paint or geometry.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act, useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {MessageParts} from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import {CopyButton} from ${JSON.stringify(resolve(root, 'web/src/app/parts/CopyButton.tsx'))};
import {visibleStreamingMessage} from ${JSON.stringify(resolve(root, 'web/src/domain/stream-visibility.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {entryToUiMessage} from ${JSON.stringify(resolve(root, 'web/src/domain/messages.ts'))};
const store = createOmpStore();
store.getState().beginSession('/synthetic');
const controller = Object.create(OmpSessionController.prototype);
Object.assign(controller, {store, activeSession: '/synthetic', clockShift: 0, flushHandle: null, pendingDeltas: [], responseChain: null, streamText: ''});
const writes = [];
Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => {writes.push(text)}}});
function Transcript() {
 const messages = useSyncExternalStore(store.subscribe, () => store.getState().messages);
 return h('section', {'data-history': true}, messages.map(m => h('article', {key: m.id, 'data-message-id': m.id},
  h(MessageParts, {message: m, finalReply: true}), h(CopyButton, {text: m.text, label: 'Copy full reply'}))));
}
function Live() {
 const shown = useSyncExternalStore(store.subscribe, () => visibleStreamingMessage(store.getState().messages, store.getState().streamingMessage));
 return shown ? h('section', {'data-live': true}, h(MessageParts, {message: shown, isStreaming: true}), h(CopyButton, {text: shown.text, label: 'Copy live reply'})) : null;
}
const persisted = (message, id = 'persisted') => entryToUiMessage({type: 'message', id, message}, 0);
window.fixture = {act, store, controller, writes, persisted,
 persist(message, id = 'persisted', method = 'mergeMessages') {store.getState()[method]([persisted(message, id)])},
 mount() {const r = createRoot(document.getElementById('root')); r.render(h('main', {}, h(Transcript), h(Live))); return r;}
};
`, [{name: 'test-import-meta', options(options) {return {...options, transform: {...options.transform, define: {...options.transform?.define, 'import.meta': '{}'}}}}}]);

const text = Array.from({length: 16}, (_, i) => `## SECTION_${i}\n\n${'Paragraph. '.repeat(300)}\n\n`).join('');
const wire = (extra = {}) => ({role: 'assistant', responseId: 'r1', timestamp: 1700000000000, content: [{type: 'text', text}], ...extra});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
 const dom = createDomFixture(code), w = dom.window, {act, store, controller, writes} = w.fixture;
 w.HTMLElement.prototype.scrollTo = () => {};
 const frames = new Map(); let next = 0;
 w.requestAnimationFrame = callback => {const id = ++next; frames.set(id, callback); return id};
 w.cancelAnimationFrame = id => frames.delete(id);
 let mounted, unmounted = false;
 await act(async () => {mounted = w.fixture.mount()});
 const settle = async () => {for (let i = 0; i < 8; i++) await act(async () => {await sleep(5)})};
 const unmount = async () => {await act(async () => mounted.unmount()); unmounted = true; assert.equal(frames.size, 0)};
 t.after(async () => {try {if (!unmounted) await unmount(); assert.deepEqual(dom.blocked, [])} finally {dom.close()}});
 return {w, d: w.document, store, controller, frames, writes, settle, unmount,
  change: async fn => {await act(async () => fn()); await settle()},
  copy: async selector => {const button = w.document.querySelector(selector); assert.ok(button); await act(async () => button.click()); await settle()},
  flush: async () => {for (let i = 0; frames.size && i < 32; i++) {const pending = [...frames.values()]; frames.clear(); await act(async () => {for (const callback of pending) callback(0)})} assert.equal(frames.size, 0)},
 };
}
const headings = (f, selector = 'main') => f.d.querySelector(selector)?.querySelectorAll('h2').length ?? 0;
const fullHistory = f => {
 assert.equal(headings(f, '[data-history]'), 16);
 assert.equal(f.d.querySelector('[data-live]') === null, true);
 assert.equal(f.frames.size, 0, 'no progressive replay is queued after handoff');
 assert.equal(f.store.getState().messages.length, 1);
};

test('controller completion keeps all 16 sections immediately; later persisted-id replacement and replay stay eager', async t => {
 const f = await fixture(t), message = wire();
 await f.change(() => f.controller.setStreamingMessage(message));
 assert.equal(headings(f, '[data-live]'), 16);
 await f.copy('[data-live] button[aria-label="Copy live reply"]');
 assert.equal(f.writes.at(-1), text);
 await f.change(() => f.controller.commitStreamingMessage(message));
 fullHistory(f);
 assert.equal(f.store.getState().messages[0].text, text);
 await f.change(() => f.w.fixture.persist(message));
 fullHistory(f);
 assert.equal(f.store.getState().messages[0].id, 'persisted');
 await f.change(() => f.w.fixture.persist(message));
 await f.change(() => f.controller.commitStreamingMessage(message));
 await f.change(() => f.controller.commitStreamingMessage());
 fullHistory(f);
 await f.copy('[data-history] button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), text);
});

for (const method of ['mergeMessages', 'setHistory']) {
 test(`history-first ${method} keeps all sections before and after controller completion`, async t => {
  const f = await fixture(t), message = wire();
  await f.change(() => f.controller.setStreamingMessage(message));
  assert.equal(headings(f, '[data-live]'), 16);
  await f.change(() => f.w.fixture.persist(message, 'persisted', method));
  fullHistory(f);
  assert.ok(f.store.getState().streamingMessage, 'history arrived before the stream-end event');
  await f.change(() => f.controller.commitStreamingMessage(message));
  fullHistory(f);
  assert.equal(f.store.getState().streamingMessage === null, true);
  await f.change(() => f.w.fixture.persist(message, 'persisted', 'setHistory'));
  fullHistory(f);
 });
}

test('a live event after the history row arrived makes its existing progressive row fully available', async t => {
 const f = await fixture(t), message = wire();
 await f.change(() => f.w.fixture.persist(message));
 assert.ok(headings(f, '[data-history]') > 0 && headings(f, '[data-history]') < 16);
 assert.ok(f.frames.size > 0);
 await f.change(() => f.controller.setStreamingMessage(message));
 fullHistory(f);
 await f.change(() => f.controller.commitStreamingMessage());
 fullHistory(f);
});

test('final source changes, tool results and errors survive eager history handoff and Copy remains exact', async t => {
 const f = await fixture(t);
 const tool = {type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {command: 'synthetic'}};
 await f.change(() => f.controller.setStreamingMessage(wire({content: [{type: 'text', text}, tool]})));
 await f.change(() => f.store.getState().applyResults([{callId: 'tool-1', name: 'bash', output: 'synthetic result', isError: false, pruned: false, at: 1700000000100}]));
 const finalText = text.replace('SECTION_15', 'FINAL_SECTION_15') + 'Final exact text.\n\n';
 const final = wire({content: [{type: 'text', text: finalText}, tool], stopReason: 'error', errorMessage: 'Synthetic provider failure'});
 await f.change(() => f.controller.commitStreamingMessage(final));
 fullHistory(f);
 assert.ok(f.d.body.textContent.includes('FINAL_SECTION_15'));
 assert.ok(f.d.body.textContent.includes('Final exact text.'));
 const notice = f.d.querySelector('[data-history] [data-testid="turn-error"]');
 assert.ok(notice, 'provider failure survives handoff as the turn-error notice');
 assert.equal(notice.getAttribute('role'), 'alert');
 assert.ok(notice.textContent.includes("Couldn't get a reply"));
 assert.ok(notice.textContent.includes('Synthetic provider failure'));
 const result = f.store.getState().messages[0];
 assert.equal(result.text, finalText);
 assert.equal(result.errorMessage, final.errorMessage);
 assert.equal(result.parts.find(part => part.kind === 'tool').output, 'synthetic result');
 assert.equal(result.parts.find(part => part.kind === 'tool').state, 'ok');
 await f.change(() => f.w.fixture.persist(final));
 fullHistory(f);
 assert.equal(f.store.getState().messages[0].parts.find(part => part.kind === 'tool').output, 'synthetic result');
 await f.copy('[data-history] button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), finalText);
});

test('unrelated equal-text history stays progressive while the live-owned reply stays fully visible', async t => {
 const f = await fixture(t);
 await f.change(() => f.controller.commitStreamingMessage(wire()));
 fullHistory(f);
 await f.change(() => f.w.fixture.persist(wire({responseId: 'r2'}), 'unrelated'));
 assert.equal(headings(f, '[data-message-id="live:r1"]'), 16);
 assert.ok(headings(f, '[data-message-id="unrelated"]') > 0 && headings(f, '[data-message-id="unrelated"]') < 16);
 assert.ok(f.frames.size > 0);
 await f.flush();
 assert.equal(headings(f, '[data-message-id="unrelated"]'), 16);
});

test('cold reopen strips a supplied history hint, reveals progressively, and cancels frames on unmount', async t => {
 const f = await fixture(t);
 await f.change(() => f.controller.commitStreamingMessage(wire()));
 fullHistory(f);
 const formerlyLive = f.store.getState().messages[0];
 // A cold reopen must actually unmount the old row before restoring history;
 // batching clear + restore with the same key tests an already-visible row.
 await f.change(() => f.store.getState().clearSession());
 assert.equal(f.d.querySelector('[data-history] article') === null, true);
 await f.change(() => {f.store.getState().beginSession('/synthetic'); f.store.getState().setHistory([formerlyLive])});
 assert.equal(f.store.getState().messages[0].eagerMarkdown, undefined);
 assert.ok(headings(f, '[data-history]') > 0 && headings(f, '[data-history]') < 16);
 assert.ok(f.frames.size > 0);
 await f.copy('[data-history] button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), text);
 await f.unmount();
});

const fencedText = '```ts\nconst HELLO = 123;\n```\n\n' + text;
for (const reveal of ['partial', 'full']) {
 test(`replay makes a ${reveal} history row eager without replacing visible nodes, focus or code Copy feedback`, async t => {
  const f = await fixture(t), message = wire({content: [{type: 'text', text: fencedText}]});
  await f.change(() => f.w.fixture.persist(message));
  assert.ok(headings(f, '[data-history]') > 0 && headings(f, '[data-history]') < 16);
  assert.ok(f.frames.size > 0);
  if (reveal === 'full') {await f.flush(); assert.equal(headings(f, '[data-history]'), 16)}
  const article = f.d.querySelector('[data-message-id="persisted"]');
  const nodes = [...article.querySelectorAll('h2, pre, button[data-streamdown="code-block-copy-button"]')];
  const button = article.querySelector('button[data-streamdown="code-block-copy-button"]');
  assert.ok(button);
  assert.ok(article.querySelector('pre span[style]'), 'real code plugin has highlighted the fence');
  await f.change(() => {button.focus(); button.click()});
  const feedback = article.querySelector('output[aria-live="polite"]');
  assert.equal(feedback?.textContent, 'Copied');
  assert.equal(f.d.activeElement === button, true);
  assert.equal(f.writes.at(-1), 'const HELLO = 123;\n');
  const assertStable = () => {
   fullHistory(f);
   assert.equal(f.d.querySelector('[data-message-id="persisted"]'), article);
   assert.equal(f.store.getState().messages[0].text, fencedText);
   assert.equal(f.store.getState().messages[0].eagerMarkdown, true);
   for (const node of nodes) assert.ok(node.isConnected && article.contains(node), 'every already-visible heading/code/control retains its DOM identity');
   assert.equal(article.querySelector('button[data-streamdown="code-block-copy-button"]'), button);
   assert.equal(article.querySelector('output[aria-live="polite"]'), feedback);
   assert.equal(feedback.textContent, 'Copied');
   assert.equal(f.d.activeElement === button, true);
  };
  await f.change(() => f.controller.setStreamingMessage(message));
  assertStable();
  await f.change(() => f.controller.setStreamingMessage(message));
  assertStable();
  await f.change(() => f.controller.commitStreamingMessage(message));
  assertStable();
  assert.equal(f.store.getState().streamingMessage === null, true);
  assert.equal(f.writes.length, 1, 'replay never reissues Copy');
 });
}

test('a newly mounted warm history row renders all grouped prose and code immediately', async t => {
 const f = await fixture(t), message = wire({content: [{type: 'text', text: fencedText}]});
 await f.change(() => f.controller.setStreamingMessage(message));
 assert.equal(headings(f, '[data-live]'), 16);
 await f.change(() => f.controller.commitStreamingMessage(message));
 fullHistory(f);
 assert.ok(f.d.querySelector('[data-history] pre span[style]'));
 assert.ok(f.d.querySelectorAll('[data-history] [style*="contain-intrinsic-size: auto 400px"]').length > 1, 'eager reveal retains progressive grouped block mode');
 await f.copy('[data-history] button[data-streamdown="code-block-copy-button"]');
 assert.equal(f.writes.at(-1), 'const HELLO = 123;\n');
 await f.copy('[data-history] button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), fencedText);
});
