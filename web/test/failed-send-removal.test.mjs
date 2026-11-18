import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Removing or editing a failed send must take its optimistic `local:` echo with
// it, and a removal that did not happen must say so. Real store, real queue and
// the real composer queue stack; only the network is blocked.
const require = createRequire(resolve(root, 'web/package.json'));
const source = path => JSON.stringify(resolve(root, 'web/src', path));
const code = await bundleDomFixture(`
import {createElement as h,act,useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {QueuedMessagesBar} from ${source('app/chat/QueuedMessagesBar.tsx')};
import {ChatMessageRow} from ${source('app/chat/TranscriptRows.tsx')};
import {TranscriptActionsContext} from ${source('app/parts/TurnNotices.tsx')};
import {Notices} from ${source('app/Notices.tsx')};
import {createOmpStore} from ${source('runtime/omp-store.ts')};
import {createUserMessage} from ${source('domain/messages.ts')};
import * as queue from ${source('runtime/offline-queue.ts')};
const path='/synthetic/removal',namespace=queue.offlineQueueNamespaceForCredential('synthetic-removal');
queue.setOfflineQueueNamespace(namespace);
const store=createOmpStore();store.setState({sessionPath:path});
const controller={getStore:()=>store};
let entry;
window.fixture={act,store,queue,namespace,createUserMessage,
 async seed(text='Hello') {
  await queue.enqueue({commandId:'failed-hello',sessionPath:path,text,images:[],namespace});
  await queue.update('failed-hello',{state:'failed',error:'agent_rejected: Agent is already processing.'},namespace);
  entry=await queue.getQueued('failed-hello',namespace);
  store.getState().appendMessage(createUserMessage(text,'failed-hello',entry.createdAt));
 },
 // The captured entry goes stale: the intent moved on after the row rendered.
 async moveOn() { await new Promise(resolve=>setTimeout(resolve,5));await queue.update('failed-hello',{error:'Changed.'},namespace); },
 entry:()=>queue.getQueued('failed-hello',namespace),
 // 'live' follows the queue as the app does, so a removed send's row goes;
 // 'turn' draws the transcript turn that owns the send's echo.
 mount(mode='static'){const r=createRoot(document.getElementById('root'));
  const useEntries=()=>useSyncExternalStore(queue.subscribe,queue.getSnapshot,queue.getServerSnapshot);
  function Live(){return h(QueuedMessagesBar,{controller,pending:useEntries().filter(e=>e.sessionPath===path)});}
  function Turn(){const e=useEntries().find(x=>x.commandId==='failed-hello');const state=useSyncExternalStore(store.subscribe,store.getState,store.getState);
   const message=state.messages.find(m=>m.id==='local:failed-hello');
   return e&&message?h(TranscriptActionsContext.Provider,{value:{switchModel(){},editPrompt(){},stopTurn:async()=>{},dropOptimisticEcho:id=>store.getState().dropOptimisticEcho(id)}},
    h(ChatMessageRow,{message,animate:false,bindings:{},sessionPath:path,rowStatus:{pills:[e],refused:null},localPendingEntry:e,toolsLive:false,finalReply:false,latestThought:false})):null;}
  r.render(h('div',null,mode==='turn'?h(Turn):mode==='live'?h(Live):h(QueuedMessagesBar,{controller,pending:[entry]}),h(Notices)));return r;}};
`);

async function fixture(t, { mode = 'static' } = {}) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  await f.seed();
  let mounted;
  await f.act(async () => { mounted = f.mount(mode); });
  t.after(async () => { try { await f.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const button = label => w.document.querySelector(`button[aria-label="${label}"]`);
  return {
    w, f, button,
    row: () => w.document.querySelector('[data-command-id="failed-hello"]'),
    turn: () => w.document.querySelector('[data-testid="chat-message"]'),
    undo: () => f.act(async () => { const undo = [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Undo'); assert.ok(undo, 'Undo'); undo.click(); }),
    toasts: () => [...w.document.querySelectorAll('[data-slot="toast"]')].map(toast => toast.textContent),
    echoIds: () => Array.from(f.store.getState().messages, message => message.id),
    click: label => f.act(async () => { assert.ok(button(label), label); button(label).click(); }),
    // A WebView going away inside the undo window commits the discard at once.
    hidePage: () => f.act(async () => { w.dispatchEvent(new w.Event('pagehide')); await new Promise(resolve => w.setTimeout(resolve, 0)); }),
  };
}

const canonical = (f, text) => ({ ...f.createUserMessage(text, 'canonical', Date.now() + 1000), id: 'entry-1', sourceEntryId: 'entry-1' });
const userRows = (f, text) => f.store.getState().messages.filter(message => message.role === 'user' && message.text === text);

test('removing a send drops its echo by command id, not by text', async t => {
  const f = await fixture(t);
  f.f.store.getState().appendMessage(f.f.createUserMessage('Hello', 'other-send', Date.now()));
  assert.deepEqual(f.echoIds(), ['local:failed-hello', 'local:other-send']);
  await f.click('Discard');
  assert.equal(f.row(), null, 'the row hides at once');
  assert.deepEqual(f.echoIds(), ['local:failed-hello', 'local:other-send'], 'nothing is removed until the undo window ends');
  await f.hidePage();
  assert.equal(await f.f.entry(), null);
  assert.deepEqual(f.echoIds(), ['local:other-send']);
});

test('a discarded failed send leaves no ghost echo to swallow the next identical send', async t => {
  const f = await fixture(t);
  await f.click('Discard');
  await f.hidePage();
  assert.equal(await f.f.entry(), null);
  // The user sends the same words again; its canonical row arrives.
  f.f.store.getState().appendMessage(f.f.createUserMessage('Hello', 'second-send', Date.now()));
  f.f.store.getState().mergeMessages([canonical(f.f, 'Hello')]);
  assert.equal(userRows(f.f, 'Hello').length, 1);
  assert.equal(userRows(f.f, 'Hello')[0].id, 'entry-1');
});

test('a discard commits when the page is hidden, not only when the timer ends', async t => {
  const f = await fixture(t);
  await f.click('Discard');
  assert.ok(await f.f.entry(), 'still retained inside the undo window');
  Object.defineProperty(f.w.document, 'visibilityState', { configurable: true, value: 'hidden' });
  await f.f.act(async () => { f.w.document.dispatchEvent(new f.w.Event('visibilitychange')); await new Promise(resolve => f.w.setTimeout(resolve, 0)); });
  assert.equal(await f.f.entry(), null);
  assert.deepEqual(f.echoIds(), []);
});

test('a Discard that could not remove the send says so and the row stays', async t => {
  const f = await fixture(t);
  await f.f.moveOn();
  await f.click('Discard');
  assert.equal(f.row(), null);
  await f.hidePage();
  assert.ok(f.row(), 'the row is back');
  assert.ok(await f.f.entry(), 'the send is retained');
  assert.deepEqual(f.echoIds(), ['local:failed-hello'], 'the echo stays with its send');
  assert.ok(f.toasts().includes('This message changed, so it was kept.'), f.toasts().join('|'));
});

test('an Edit that could not remove the send keeps the row and says the draft is back', async t => {
  const f = await fixture(t);
  await f.f.moveOn();
  await f.click('Edit');
  assert.ok(f.row());
  assert.ok(await f.f.entry());
  assert.deepEqual(f.echoIds(), ['local:failed-hello']);
  assert.ok(f.toasts().some(text => text.startsWith('Your message is back in the composer')), f.toasts().join('|'));
});

test('an Edit that removes the send drops its echo', async t => {
  const f = await fixture(t, { mode: 'live' });
  await f.click('Edit');
  await f.f.act(async () => { await new Promise(resolve => f.w.setTimeout(resolve, 50)); });
  assert.equal(f.row(), null);
  assert.equal(await f.f.entry(), null);
  assert.deepEqual(f.echoIds(), []);
});

test('Discard under its own bubble hides the whole turn at once, Undo restores it, the commit drops the echo', async t => {
  const f = await fixture(t, { mode: 'turn' });
  assert.match(f.turn().textContent, /Hello/);
  assert.match(f.turn().textContent, /Not sent/);
  await f.click('Discard');
  assert.equal(f.turn(), null, 'bubble and pill are gone before any timer fires');
  assert.ok(await f.f.entry(), 'the send is retained inside the undo window');
  assert.deepEqual(f.echoIds(), ['local:failed-hello']);
  await f.undo();
  assert.match(f.turn().textContent, /Hello/, 'Undo brings the turn back');
  assert.match(f.turn().textContent, /Not sent/);
  assert.ok(await f.f.entry());
  await f.click('Discard');
  assert.equal(f.turn(), null);
  await f.hidePage();
  assert.equal(await f.f.entry(), null);
  assert.deepEqual(f.echoIds(), []);
  assert.equal(f.turn(), null);
});

test('a turn Discard that could not remove the send brings the turn back with a notice', async t => {
  const f = await fixture(t, { mode: 'turn' });
  await f.click('Discard');
  assert.equal(f.turn(), null);
  await f.f.moveOn();
  await f.hidePage();
  assert.match(f.turn().textContent, /Hello/);
  assert.ok(await f.f.entry());
  assert.deepEqual(f.echoIds(), ['local:failed-hello']);
  assert.ok(f.toasts().includes('This message changed, so it was kept.'), f.toasts().join('|'));
});
