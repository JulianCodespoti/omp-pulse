import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
import {saveTail, loadTail} from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-cache.ts'))};
import {entryToUiMessage} from ${JSON.stringify(resolve(root, 'web/src/domain/messages.ts'))};

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
window.fixture = {act, store, controller, createOmpStore, writes, countReads, getRawAssistantText, getAssistantDisplayBoundaries, saveTail, loadTail, entryToUiMessage,
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

const saved = JSON.parse(readFileSync(new URL('./fixtures/signed-response-alias.json', import.meta.url), 'utf8'));


test('signed producer-shaped replay replaces committed provisional with canonical exactly once', async t => {
 const f = await fixture(t);
 for (const frame of saved.frames) await f.frame(frame);
 assert.equal(f.store.getState().messages.length, 1);
 assert.equal(f.count(), 1);
 assert.equal(f.live() === null, true);
 assert.equal(f.store.getState().messages[0].id, 'canonical-entry');
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'), prose);
});

const basePartial = saved.frames[2].event.message;
const baseCanonical = saved.frames[3].history.entries[0];
const authority = (turn, revision, patch = {}) => ({...saved.frames[0].sessionState, turn, revision, ...patch});
const clone = value => JSON.parse(JSON.stringify(value));
const partial = (patch = {}) => ({...clone(basePartial), ...patch});
const canonical = (patch = {}, id = 'canonical-entry') => ({...clone(baseCanonical), id, message: {...clone(baseCanonical.message), ...patch}});
async function start(f, message = partial()) {
 await f.frame(saved.frames[0]);
 await f.frame(saved.frames[1]);
 await f.event({type:'message_update', message});
}
async function finish(f, entries = [canonical()], route = 'agent_end') {
 if (route === 'idle_bundle') await f.frame({type:'bundle',history:{entries,nextBefore:null,endOffset:200},sessionState:authority('idle',2)});
 else {
  if (route === 'idle_activity') await f.frame({type:'activity',path:'/synthetic',now:null,sessionState:authority('idle',2)});
  else await f.event({type:'agent_end'});
  await f.history(entries);
 }
}
const single = f => {
 assert.equal(f.store.getState().messages.length,1);
 assert.equal(f.store.getState().messages[0].id,'canonical-entry');
 assert.equal(f.count(),1);
};
for (const route of ['agent_end','idle_bundle','idle_activity']) test(`signed recovery: ${route} and canonical replay`, async t => {
 const f=await fixture(t);await start(f);await finish(f,[canonical()],route);single(f);
 await f.history([canonical()]);single(f);
 await f.event({type:'message_update',message:partial()});
 assert.equal(f.count(),1,'delayed provisional replay does not repeat canonical prose');
 await f.event({type:'agent_end'});single(f);
});
test('canonical arrives before idle and replaces text without a prefix relationship', async t => {
 const f=await fixture(t);await start(f);
 const replacement='Canonical corrected answer.';
 await f.history([canonical({content:[{...basePartial.content[0],text:replacement}]})]);
 assert.equal(f.count(),0);assert.equal(f.count(replacement),1);
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'),replacement);
 assert.equal(f.w.fixture.getRawAssistantText(f.store.getState().messages[0]),replacement);
 await f.event({type:'agent_end'});
 assert.equal(f.store.getState().messages.length,1);assert.equal(f.count(replacement),1);
});
test('canonical replacement preserves fresh tools, thinking, images and error through idle', async t => {
 const f=await fixture(t);await start(f,partial({errorMessage:'synthetic failure',content:[...basePartial.content,
  {type:'thinking',thinking:'fresh thought'}, {type:'image',mimeType:'image/png',data:'synthetic'}, tool]}));
 await f.event({type:'tool_execution_end',toolCallId:'t1',result:'fresh tool output'});
 await finish(f);
 const row=f.store.getState().messages[0];single(f);
 assert.ok(row.parts.some(p=>p.kind==='thinking'&&p.text==='fresh thought'));
 assert.ok(row.parts.some(p=>p.kind==='image'));
 assert.ok(row.parts.some(p=>p.kind==='tool'&&p.output==='fresh tool output'));
 assert.equal(row.errorMessage,'synthetic failure');
});
test('canonical-only same-signature responses and duplicate canonical entries remain independent',async t=>{
 const f=await fixture(t);await f.history([canonical(),canonical({responseId:'other-response'},'second')]);
 assert.equal(f.store.getState().messages.length,2);assert.equal(f.count(),2);
});
for (const variant of ['different-response','duplicate-response','same-entry-conflict']) test(`multiple canonical claims veto before mutation: ${variant}`,async t=>{
 const f=await fixture(t);await start(f);
 const second=canonical({responseId:variant==='duplicate-response'?baseCanonical.message.responseId:'different'},variant==='same-entry-conflict'?'canonical-entry':'second-entry');
 await finish(f,[canonical(),second]);
 assert.ok(f.store.getState().messages.some(m=>m.id.startsWith('live:')),'ambiguous provisional must remain');
 assert.ok(f.store.getState().messages.length>=2);
});
test('retained canonical plus conflicting incoming canonical veto before replacing provisional',async t=>{
 const f=await fixture(t);await f.history([canonical()]);await start(f,partial({content:[]}));
 // Acquire witness only once both retained and incoming canonical claims exist.
 await f.history([canonical({responseId:'other'},'second')]);
 await f.event({type:'message_update',message:partial()});await f.event({type:'agent_end'});
 assert.equal(f.store.getState().messages.length,3);
});
for (const patch of [
 {api:'other-api'}, {api:''}, {provider:'other-provider'}, {provider:''}, {model:'other-model'}, {model:''},
]) test(`namespace mismatch fails closed: ${JSON.stringify(patch)}`,async t=>{
 const f=await fixture(t);await start(f);await finish(f,[canonical(patch)]);
 assert.equal(f.store.getState().messages.length,2);
});
const signatureCases = [undefined,'legacy-id','{broken','"string"','null','[]',
 JSON.stringify({v:2,id:'synthetic-output-item'}), JSON.stringify({v:1,id:''}), JSON.stringify({v:1,id:'   '}),
 JSON.stringify({v:1,id:'synthetic-output-item',phase:'unsupported'}),
 JSON.stringify({v:1,id:'synthetic-output-item',extra:true}),
];
for (const signature of signatureCases) test(`invalid signature fails closed: ${String(signature)}`,async t=>{
 const f=await fixture(t);await start(f);await finish(f,[canonical({content:[{...basePartial.content[0],textSignature:signature}]})]);
 assert.equal(f.store.getState().messages.length,2);
});
for (const content of [
 [basePartial.content[0],{type:'text',text:''}],
 [basePartial.content[0],basePartial.content[0]],
 [basePartial.content[0],{type:'text',text:'mixed unsigned'}],
]) test(`raw multi-item signatures remain unresolved even if coalescing hides blocks: ${content[1].text}`,async t=>{
 const f=await fixture(t);await start(f,partial({content}));await finish(f,[canonical({content})]);
 assert.equal(f.store.getState().messages.length,2);
});
for(const changed of [
 partial({content:[{...basePartial.content[0],textSignature:'{broken'}]}),
 partial({content:[{...basePartial.content[0],textSignature:JSON.stringify({v:1,id:'changed-item'})}]}),
 partial({content:[]}),
 partial({responseId:'conflicting-known-response'}),
]) test(`conflicting full live snapshot permanently vetoes recovery: ${JSON.stringify(changed.content)} ${changed.responseId??''}`,async t=>{
 const f=await fixture(t);await start(f);
 await f.event({type:'message_update',message:changed});await f.event({type:'message_update',message:partial()});
 await finish(f);assert.equal(f.store.getState().messages.length,2);
});
test('defined phase conflict fails closed',async t=>{
 const f=await fixture(t);await start(f,partial({content:[{...basePartial.content[0],textSignature:JSON.stringify({v:1,id:'synthetic-output-item',phase:'commentary'})}]}));
 await finish(f,[canonical({content:[{...basePartial.content[0],textSignature:JSON.stringify({v:1,id:'synthetic-output-item',phase:'final_answer'})}]})]);
 assert.equal(f.store.getState().messages.length,2);
});
test('known distinct response IDs sharing signature, text and tuple never merge',async t=>{
 const f=await fixture(t);
 await f.event({type:'message_start',message:{...partial(),responseId:'known-one'}});
 await f.event({type:'message_end',message:{...partial(),responseId:'known-one'}});
 await f.history([canonical()]);assert.equal(f.store.getState().messages.length,2);assert.equal(f.count(),2);
});
test('new explicit message_start cannot reuse resolved alias with a different known response ID',async t=>{
 const f=await fixture(t);await start(f);await finish(f);
 await f.event({type:'message_start',message:partial({responseId:'independent-response'})});
 await f.event({type:'message_end',message:partial({responseId:'independent-response'})});
 assert.equal(f.store.getState().messages.length,2);assert.equal(f.count(),2);
});
test('two explicit no-ID lifecycles sharing one item cannot borrow the former alias',async t=>{
 const f=await fixture(t);await start(f);await finish(f);
 await f.event({type:'message_start',message:partial({timestamp:1700000000001})});
 await f.event({type:'agent_end'});await f.history([canonical()]);
 assert.equal(f.store.getState().messages.length,2);
});
test('new unrelated message_start invalidates earlier committed provisional evidence',async t=>{
 const f=await fixture(t);await start(f);await f.event({type:'agent_end'});
 await f.event({type:'message_start',message:partial({content:[]})});
 await f.history([canonical()]);assert.equal(f.store.getState().messages.length,2);
});
for(const patch of [{daemonInstanceId:'next-daemon'},{bindingEpoch:2},{owner:{kind:'foreign',pid:1234}}]) test(`accepted source lifetime change vetoes former recovery: ${JSON.stringify(patch)}`,async t=>{
 const f=await fixture(t);await start(f);
 await f.frame({type:'bundle',history:{entries:[canonical()],nextBefore:null,endOffset:200},sessionState:authority('idle',2,patch)});
 assert.equal(f.store.getState().messages.length,2);
});
test('stale authority cannot poison current signed recovery',async t=>{
 const f=await fixture(t);await start(f);
 await f.frame({type:'event',event:{type:'message_update',message:partial({content:[{type:'text',text:'stale',textSignature:'invalid'}]})},sessionState:authority('running',0)});
 await finish(f);single(f);
});
test('session switch and reopening the same path cannot resurrect old provenance',async t=>{
 const f=await fixture(t);await start(f);await f.event({type:'agent_end'});
 const rows=f.store.getState().messages.map(m=>JSON.parse(JSON.stringify(m)));
 await f.change(()=>{f.store.getState().beginSession('/other');f.store.getState().beginSession('/synthetic');f.store.getState().setHistory(rows)});
 await f.history([canonical()]);assert.equal(f.store.getState().messages.length,2);
});
test('identity-changing UI projection cannot reuse normalized source witness',async t=>{
 const f=await fixture(t);await start(f);
 await f.change(()=>f.store.getState().setStreamingMessage({...f.live(),id:'projected-other-response'}));
 await finish(f);assert.equal(f.store.getState().messages.length,2);
});
test('serialized forged metadata cannot mint live or canonical provenance',async t=>{
 const f=await fixture(t);await start(f);await f.event({type:'agent_end'});
 const canonicalUi=f.w.fixture.entryToUiMessage(canonical(),0);
 const forged={...JSON.parse(JSON.stringify(canonicalUi)),textSignature:basePartial.content[0].textSignature,responseItem:{id:'synthetic-output-item'}};
 await f.change(()=>f.store.getState().mergeMessages([forged]));
 assert.equal(f.store.getState().messages.length,2);
});
test('unsigned original producer route remains explicitly unresolved',async t=>{
 const f=await fixture(t);await start(f,partial({content:[{type:'text',text:prose}]}));
 await finish(f,[canonical({content:[{type:'text',text:prose}]})]);
 assert.equal(f.store.getState().messages.length,2);assert.equal(f.count(),2);
});

test('canonical replay retains current recovered nontext details after provisional is removed',async t=>{
 const f=await fixture(t);await start(f,partial({errorMessage:'fresh error',content:[...basePartial.content,
  {type:'thinking',thinking:'fresh retained thought'}, {type:'image',mimeType:'image/png',data:'synthetic'},tool]}));
 await finish(f);await f.history([canonical()]);
 const row=f.store.getState().messages[0];single(f);
 assert.ok(row.parts.some(p=>p.kind==='thinking'&&p.text==='fresh retained thought'));
 assert.ok(row.parts.some(p=>p.kind==='image'));assert.equal(row.errorMessage,'fresh error');
});
test('structural signature parsing accepts whitespace and key order without altering the item ID',async t=>{
 const f=await fixture(t);await start(f);
 await finish(f,[canonical({content:[{...basePartial.content[0],textSignature:'{ "id": "synthetic-output-item", "v": 1 }'}]})]);single(f);
});
test('matching supported phase is metadata and may first appear canonically',async t=>{
 const f=await fixture(t);await start(f);
 await finish(f,[canonical({content:[{...basePartial.content[0],textSignature:JSON.stringify({v:1,id:'synthetic-output-item',phase:'final_answer'})}]})]);single(f);
});
test('raw single empty signed item can acquire text through normal delta ingress',async t=>{
 const f=await fixture(t);await start(f,partial({content:[{...basePartial.content[0],text:''}]}));
 await f.frame({type:'md',id:'live',a:prose});await f.flush();
 await finish(f);single(f);
});
test('token updates after signed alias preserve history references and expose fresh live details',async t=>{
 const f=await fixture(t);await start(f);await f.history([canonical()]);
 const before=f.store.getState().messages,row=before[0];
 await f.frame({type:'md',id:'live',a:' newer text'});await f.flush();
 assert.equal(f.store.getState().messages,before);assert.equal(f.store.getState().messages[0],row);
 assert.equal(f.count(),1,'canonical remains the sole prose owner after proven recovery');
});
test('ambiguous history-first claim cannot be ignored when the live witness arrives later',async t=>{
 const f=await fixture(t);
 await f.history([canonical(),canonical({responseId:'conflicting'},'canonical-entry'),canonical({responseId:'other'},'second-entry')]);
 await start(f);await f.event({type:'agent_end'});
 assert.equal(f.store.getState().messages.length,3);
 assert.ok(f.store.getState().messages.some(m=>m.id.startsWith('live:')));
});
test('defined live phase cannot be forgotten by a later omitted phase',async t=>{
 const f=await fixture(t);await start(f,partial({content:[{...basePartial.content[0],textSignature:JSON.stringify({v:1,id:'synthetic-output-item',phase:'commentary'})}]}));
 await f.event({type:'message_update',message:partial()});
 await finish(f,[canonical({content:[{...basePartial.content[0],textSignature:JSON.stringify({v:1,id:'synthetic-output-item',phase:'final_answer'})}]})]);
 assert.equal(f.store.getState().messages.length,2);
});
test('proven recovery carries live Markdown ownership onto canonical through replay',async t=>{
 const f=await fixture(t);await start(f);await finish(f);
 assert.equal(f.store.getState().messages[0].eagerMarkdown,true);
 await f.history([canonical()]);assert.equal(f.store.getState().messages[0].eagerMarkdown,true);
});
for(const route of ['agent_end','idle_activity']) test(`same-lifecycle full final after ${route} constrains later canonical identity`,async t=>{
 const f=await fixture(t);await start(f);
 if(route==='idle_activity') await f.frame({type:'activity',path:'/synthetic',now:null,sessionState:authority('idle',2)});
 else await f.event({type:'agent_end'});
 await f.event({type:'message_end',message:canonical().message});
 await f.history([canonical()]);single(f);
});

test('two different observed known response IDs permanently veto same-lifecycle recovery',async t=>{
 const f=await fixture(t);await start(f);await f.event({type:'agent_end'});
 await f.event({type:'message_update',message:partial({responseId:'first-known'})});
 await f.event({type:'message_update',message:partial({responseId:'second-known'})});
 await f.event({type:'agent_end'});await f.history([canonical({responseId:'second-known'})]);
 assert.equal(f.store.getState().messages.length,2);
 assert.ok(f.store.getState().messages.some(m=>m.id.startsWith('live:started:')));
});
test('discarded duplicate entry cannot conceal a matching signed claim behind an unsigned survivor',async t=>{
 const f=await fixture(t);await start(f);
 await finish(f,[canonical({content:[{type:'text',text:'unsigned first'}]}),canonical({responseId:'competing'},'canonical-entry'),canonical({},'second-entry')]);
 assert.ok(f.store.getState().messages.some(m=>m.id.startsWith('live:')));
 assert.equal(f.store.getState().messages.length,3);
});
test('two committed provisional claims with one apparent row ID veto recovery',async t=>{
 const f=await fixture(t);await start(f);
 // A deliberately corrupt store-only input must not rely on React's behavior
 // for duplicate element keys to establish the alias cardinality contract.
 const other=f.w.fixture.createOmpStore();other.getState().beginSession('/synthetic');
 other.getState().beginResponseLifecycle();other.getState().setStreamingMessage(f.live());other.getState().commitStreamingMessage();
 other.getState().appendMessage({...other.getState().messages[0]});
 other.getState().mergeMessages([f.w.fixture.entryToUiMessage(canonical(),0)]);
 assert.equal(other.getState().messages.length,3);
});
test('canonical provenance lost after recovery cannot be reminted by later history replay',async t=>{
 const f=await fixture(t);await start(f);await finish(f);
 await f.change(()=>f.store.getState().setHistory(f.store.getState().messages.map(m=>JSON.parse(JSON.stringify(m)))));
 await f.history([canonical()]);
 await f.event({type:'message_update',message:partial()});await f.event({type:'agent_end'});
 assert.equal(f.store.getState().messages.length,2);
});

test('only-unseen history filtering cannot erase an ambiguous raw batch before witness acquisition',async t=>{
 const f=await fixture(t);await f.history([canonical()]);await start(f,partial({content:[]}));
 await f.change(()=>f.controller.mergeHistory([canonical({content:[{type:'text',text:'unsigned survivor'}]}),canonical({responseId:'competing'})],true));
 await f.event({type:'message_update',message:partial()});await f.event({type:'agent_end'});
 assert.equal(f.store.getState().messages.length,2);
});
test('prepend known-ID filtering cannot erase a competing signed canonical claim',async t=>{
 const f=await fixture(t);await start(f);await f.event({type:'agent_end'});
 await f.change(()=>f.store.getState().appendMessage(f.w.fixture.entryToUiMessage(canonical(),0)));
 await f.change(()=>f.store.getState().prependMessages([f.w.fixture.entryToUiMessage(canonical({responseId:'competing'}),0)]));
 await f.history([canonical()]);assert.equal(f.store.getState().messages.length,2);
});
test('exact original unsigned saved fixture remains an unresolved two-row backlog case',async t=>{
 const f=await fixture(t),unsigned=JSON.parse(readFileSync(new URL('./fixtures/unsigned-response-promotion.json',import.meta.url),'utf8'));
 for(const frame of unsigned.frames) await f.frame(frame);
 assert.equal(f.store.getState().messages.length,2);
 assert.equal(f.count(),2);
 assert.equal(f.live() === null, true);
});
test('existing by-ID merge cannot hide multiple provisional claims before recovery preflight',async t=>{
 const f=await fixture(t);await start(f);
 const other=f.w.fixture.createOmpStore();other.getState().beginSession('/synthetic');
 other.getState().beginResponseLifecycle();other.getState().setStreamingMessage(f.live());other.getState().commitStreamingMessage();
 other.getState().appendMessage({...other.getState().messages[0]});
 const user={id:'retained-user',role:'user',text:'user row',parts:[{kind:'text',text:'user row'}]};
 other.getState().appendMessage(user);
 other.getState().mergeMessages([f.w.fixture.entryToUiMessage(canonical(),0),{...user}]);
 assert.equal(other.getState().messages.length,3);
 assert.ok(other.getState().messages.some(m=>m.id.startsWith('live:')),'pre-merge duplicate provenance must veto the alias');
});
test('known response ID on empty start cannot be forgotten before signed witness acquisition',async t=>{
 const f=await fixture(t);await f.frame(saved.frames[0]);
 await f.event({type:'message_start',message:partial({responseId:'known-before-text',content:[]})});
 await f.event({type:'message_update',message:partial()});
 await finish(f);assert.equal(f.store.getState().messages.length,2);
});
for(const discarded of [
 {type:'custom',id:'canonical-entry',customType:'unrendered-marker',data:{}},
 {...resultEntry,id:'canonical-entry'},
 canonical({id:'independent-message',responseId:'independent-response',content:[{type:'text',text:'Independent reply.'}]}),
]) test(`duplicate raw entry IDs veto recovery before role filtering: ${discarded.message?.role??discarded.type} ${discarded.message?.id??''}`,async t=>{
 const f=await fixture(t);await start(f);
 await finish(f,[canonical(),discarded]);
 assert.ok(f.store.getState().messages.some(m=>m.id.startsWith('live:')),'raw ID ambiguity must retain the provisional reply');
 await f.history([canonical()]);
 assert.ok(f.store.getState().messages.some(m=>m.id.startsWith('live:')),'a later clean replay cannot repair the ambiguous lifecycle');
});
test('late known-ID live snapshot before canonical recovery keeps canonical prose and fresh details',async t=>{
 const f=await fixture(t);await start(f);await f.event({type:'agent_end'});
 const late='Revised provisional prose.';
 await f.event({type:'message_update',message:partial({responseId:baseCanonical.message.responseId,errorMessage:'late error',content:[
  {...basePartial.content[0],text:late},{type:'thinking',thinking:'late thought'},{type:'image',mimeType:'image/png',data:'synthetic'},
 ]})});
 await f.history([canonical()]);single(f);
 assert.equal(f.count(late),0,'a known ID alone must not make live prose canonical');
 assert.equal(await f.copy('[data-history] button[aria-label="Copy full reply"]'),prose);
 const row=f.store.getState().messages[0];
 assert.ok(row.parts.some(p=>p.kind==='thinking'&&p.text==='late thought'));
 assert.ok(row.parts.some(p=>p.kind==='image'));assert.equal(row.errorMessage,'late error');
 await f.event({type:'agent_end'});single(f);
 assert.ok(f.store.getState().messages[0].parts.some(p=>p.kind==='thinking'&&p.text==='late thought'));
});
