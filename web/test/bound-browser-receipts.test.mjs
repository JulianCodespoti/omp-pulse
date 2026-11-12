import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Actual API, controller and durable queue, with deny-all-network synthetic transport.
const code = await bundleDomFixture(`
import { DaemonApi, sendPromptDurably } from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import { OmpSessionController } from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
const namespace=queue.offlineQueueNamespaceForCredential('synthetic-bound');
queue.setOfflineQueueNamespace(namespace);
let body, capabilities=['receipt-session-binding-v1'], status=200, protocol=1, deferred=false, failure=null, deferVersion=false, badJson=false, receiptResponse=null;
const originalFetchJson=DaemonApi.prototype.fetchJson;
const originalDedupedFetch=DaemonApi.prototype.dedupedFetch;
const calls=[],waiting=[];
const response=async(path,init)=>{
 calls.push({path,method:init?.method??'GET',body:init?.body});
 if(path==='/api/version'){if(deferVersion)return new Promise((resolve,reject)=>waiting.push({resolve,reject}));return {protocolVersion:protocol,minClientProtocolVersion:1,capabilities}};
 if(failure)throw new Error(failure);
 if(deferred)return new Promise((resolve,reject)=>waiting.push({resolve,reject}));
 return body;
};
DaemonApi.prototype.fetchJson=async function(path,init){const result=await response(path,init);if(path!=='/api/version'&&status!==200)throw Object.assign(new Error('Synthetic status unavailable'),{status});return result};
DaemonApi.prototype.dedupedFetch=DaemonApi.prototype.fetchJson;
const controller=Object.assign(Object.create(OmpSessionController.prototype),{
 queueNamespace:namespace,baseUrl:'http://synthetic.invalid',activeSession:'/synthetic/alias',generation:1,reconcilingReceipts:false,
 store:{getState:()=>({setQueuedCount(){},setError(){}})},checkHeartbeatVersion(){},request:response,
 fetchAuthed:async(path,init)=>{const data=await response(path,init);if(receiptResponse)return receiptResponse;return {ok:status===200,status,json:async()=>{if(badJson)throw new SyntaxError("Synthetic malformed JSON");return data}}},
 failureDetail:async()=> 'Synthetic status unavailable'
});
window.fixture={queue,namespace,controller,
 realControllerTransport(){controller.request=OmpSessionController.prototype.request},
 realApiTransport(){
   DaemonApi.prototype.fetchJson=originalFetchJson;DaemonApi.prototype.dedupedFetch=originalDedupedFetch;
   window.fetch=async(path,init)=>{if(path!=='/api/version'&&path!=='/api/prompt'&&!path.startsWith('/api/receipts/'))throw Error('Unexpected synthetic route '+path);const result=await response(path,init);return {ok:status===200,status,json:async()=>{if(badJson)throw new SyntaxError("Synthetic malformed JSON");return result}}};
 },calls,waiting,api:new DaemonApi('synthetic-bound'),
 configure(value,options={}){body=value;capabilities=Object.hasOwn(options,'capabilities')?options.capabilities:['receipt-session-binding-v1'];status=options.status??200;protocol=options.protocol??1;deferred=options.deferred??false;failure=options.failure??null;deferVersion=options.deferVersion??false;badJson=options.badJson??false;receiptResponse=options.receiptResponse??null},
 seed:(id='bound-id',sessionPath='/synthetic/alias',text='Exact text')=>queue.enqueue({commandId:id,sessionPath,text,namespace}),
 get:(id='bound-id')=>queue.getQueued(id,namespace),
 savedSend:()=>sendPromptDurably('/synthetic/alias','Exact text',[],{token:'synthetic-bound',commandId:'bound-id'}),
 status:(id='bound-id')=>sendPromptDurably('/ignored/new-active-session','ignored',[],{token:'synthetic-bound',commandId:id}),
 resolve(value){waiting.shift().resolve(value)},
 flush:(send,options={})=>queue.flush(send,{namespace,isTransient:error=>/network|lost/i.test(String(error)),...options}),
 storage:()=>localStorage.getItem('omp-pulse-queue-v3:'+namespace),
 writeStorage:raw=>localStorage.setItem('omp-pulse-queue-v3:'+namespace,raw),
 freezeTime(){const now=Date.now();Date.now=()=>now},
 async restore(raw){queue.setOfflineQueueNamespace('temporary');localStorage.setItem('omp-pulse-queue-v3:'+namespace,raw);queue.setOfflineQueueNamespace(namespace);return queue.getQueued('bound-id',namespace)},
};
`);
const receipt=(extra={})=>({commandId:'bound-id',sessionPath:'/synthetic/canonical-a',state:'completed',createdAt:1,updatedAt:2,...extra});
const envelope=(extra={},binding={})=>({ok:true,receipt:receipt(extra),receiptBinding:{version:1,requestedSessionPath:'/synthetic/alias',canonicalSessionPath:extra.sessionPath??'/synthetic/canonical-a',...binding}});
function fixture(t,raw,{indexedDB=false}={}){
 const key='omp-pulse-queue-v3:cred-'+createHash('sha256').update('synthetic-bound').digest('hex');
 const prefix=(raw?'localStorage.setItem('+JSON.stringify(key)+','+JSON.stringify(raw)+');':'')+
   (indexedDB?'window.idb=('+memoryIndexedDb.toString()+')();window.indexedDB=window.idb.indexedDB;':'');
 const dom=createDomFixture(prefix+code);t.after(()=>{assert.deepEqual(dom.blocked,[]);dom.close()});
 const f=dom.window.fixture;f.idb=dom.window.idb;
 const configure=f.configure;f.configure=(value,options={})=>configure(value,{...options,
  ...(options.status===404&&!Object.hasOwn(options,'receiptResponse')?{receiptResponse:new Response('{"ok":false,"error":"receipt not found"}',{status:404})}:{})});
 return f;
}

test('old server lacks binding capability: controller retains saved and never POSTs',async t=>{
 const f=fixture(t);await f.seed();f.configure(envelope(),{capabilities:[]});await f.controller.flushQueue();
 assert.equal((await f.get()).state,'saved');assert.deepEqual(Array.from(f.calls,c=>c.path),['/api/version']);
});
test('same-ID initial response with mismatched binding remains uncertain after one POST',async t=>{
 const f=fixture(t);await f.seed();f.configure(envelope({sessionPath:'/synthetic/canonical-b'},{canonicalSessionPath:'/synthetic/canonical-a'}));
 await f.controller.flushQueue();await f.controller.flushQueue();assert.equal((await f.get()).state,'uncertain');assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,1);
});
test('status never replaces previously bound canonical evidence',async t=>{
 const f=fixture(t);await f.seed();const prior=envelope({state:'accepted'});
 await f.queue.update('bound-id',{state:'uncertain',receipt:prior.receipt,receiptBinding:prior.receiptBinding},f.namespace);
 const before=JSON.stringify(await f.get());f.configure(envelope({sessionPath:'/synthetic/canonical-b'}));
 await f.controller.reconcileReceipts();assert.equal(JSON.stringify(await f.get()),before);assert.equal(f.calls.length,1);
});
test('404 preserves entire prior row instead of manufacturing uncertainty evidence',async t=>{
 const f=fixture(t);await f.seed();const prior=envelope({state:'accepted'});
 await f.queue.update('bound-id',{state:'accepted',receipt:prior.receipt,receiptBinding:prior.receiptBinding},f.namespace);
 const before=JSON.stringify(await f.get());f.configure(null,{status:404});await f.controller.reconcileReceipts();assert.equal(JSON.stringify(await f.get()),before);
});

for(const state of ['accepted','dispatching','forwarded','received','running','completed','failed','uncertain']){
 test('bound alias works through controller, direct API, status and Details: '+state,async t=>{
  const f=fixture(t),value=envelope({state});await f.seed();f.configure(value);await f.controller.flushQueue();
  let row=await f.get();assert.equal(row.state,state);assert.equal(row.sessionPath,'/synthetic/alias');assert.equal(row.text,'Exact text');
  assert.deepEqual(JSON.parse(JSON.stringify(row.receiptBinding)),value.receiptBinding);
  assert.equal((await f.api.prompt('/synthetic/alias','Exact text',[],'bound-id')).receipt,value.receipt);
  assert.equal((await f.api.getReceipt(row)).receipt,value.receipt);
  assert.equal((await f.controller.inspectCommandReceipt(row)).receipt,value.receipt);
  assert.ok(f.calls.filter(c=>c.path.startsWith('/api/receipts/')).every(c=>c.path==='/api/receipts/bound-id?session=%2Fsynthetic%2Falias'&&c.method==='GET'));
 });
}
for(const capabilities of [[],null,{},'receipt-session-binding-v1',['receipt-session-binding-v2'],['RECEIPT-SESSION-BINDING-V1'],['receipt-session-binding-v1',42]]){
 for(const path of ['controller','secondary'])test(path+' refuses unsupported capability '+JSON.stringify(capabilities),async t=>{
  const f=fixture(t);await f.seed();f.configure(envelope(),{capabilities});
  if(path==='controller')await f.controller.flushQueue();else await f.flush(e=>f.api.prompt(e.sessionPath,e.text,[],e.commandId));
  assert.equal((await f.get()).state,'saved');assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,0);
 });
}
const invalidEnvelopes=[
 ['missing binding',{ok:true,receipt:receipt()}],['false ok',{...envelope(),ok:false}],['missing ok',{...envelope(),ok:undefined}],
 ['array response',[]],['null binding',{...envelope(),receiptBinding:null}],['array binding',{...envelope(),receiptBinding:[]}],
 ['future binding',envelope({}, {version:2})],['string version',envelope({}, {version:'1'})],
 ['wrong raw echo',envelope({}, {requestedSessionPath:'/synthetic/other'})],
 ['canonical mismatch',envelope({}, {canonicalSessionPath:'/synthetic/canonical-b'})],
 ['empty canonical',envelope({}, {canonicalSessionPath:''})],
 ['wrong ID',envelope({commandId:'other-id'})],['unknown state',envelope({state:'future'})],
];
for(const [label,value] of invalidEnvelopes){
 test('initial '+label+' is uncertain with original intent and one POST',async t=>{
  const f=fixture(t);await f.seed();const original=await f.get();f.configure(value);await f.controller.flushQueue();await f.controller.flushQueue();
  const row=await f.get();assert.equal(row.state,'uncertain');for(const key of ['commandId','sessionPath','text','intentToken'])assert.equal(row[key],original[key]);
  assert.equal(row.receiptBinding,undefined);assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,1);
 });
 test('failed '+label+' status preserves full persisted row through every observation path',async t=>{
  const f=fixture(t);await f.seed();const prior=envelope({state:'accepted'});
  await f.queue.update('bound-id',{state:'uncertain',receipt:prior.receipt,receiptBinding:prior.receiptBinding},f.namespace);
  const before=f.storage(),intent=await f.get();f.configure(value);await f.controller.reconcileReceipts();
  await assert.rejects(f.status());await assert.rejects(f.controller.inspectCommandReceipt(intent));await assert.rejects(f.api.getReceipt(intent));
  assert.equal(f.storage(),before);assert.equal(f.calls.length,4);assert.ok(f.calls.every(c=>c.method==='GET'&&c.path.includes('?session=%2Fsynthetic%2Falias')));
 });
}
test('final queue boundary rejects an unwrapped valid receipt and cannot invent witness',async t=>{
 const f=fixture(t);await f.seed();let sends=0;await f.flush(async()=>{sends++;return receipt()});await f.flush(async()=>{sends++;return envelope()});
 assert.equal((await f.get()).state,'uncertain');assert.equal((await f.get()).receiptBinding,undefined);assert.equal(sends,1);
});
test('synthetic local uncertainty is not a canonical witness; first scoped proof may bind',async t=>{
 const f=fixture(t);await f.seed();await f.flush(async()=>{throw Error('Lost acknowledgement')});const local=await f.get();
 assert.equal(local.receipt.sessionPath,local.sessionPath);assert.equal(local.receiptBinding,undefined);
 f.configure(envelope());await f.controller.reconcileReceipts();assert.equal((await f.get()).receiptBinding.canonicalSessionPath,'/synthetic/canonical-a');
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
for(const binding of [{version:2},'invalid',false,[],{version:1,requestedSessionPath:'/other',canonicalSessionPath:'/synthetic/canonical-a'}]){
 test('malformed persisted binding is retained and cannot become legacy absence '+JSON.stringify(binding),async t=>{
  const f=fixture(t);await f.seed();await f.queue.update('bound-id',{state:'uncertain',receipt:receipt({state:'accepted'}),receiptBinding:binding},f.namespace);
  const raw=f.storage();await f.restore(raw);assert.deepEqual(JSON.parse(JSON.stringify((await f.get()).receiptBinding)),binding);
  f.configure(envelope({sessionPath:'/synthetic/canonical-b'}));const before=f.storage();await f.controller.reconcileReceipts();await assert.rejects(f.status());assert.equal(f.storage(),before);
 });
}
test('legacy tokenless binding-less row can acquire first valid scoped proof without backfill',async t=>{
 const f=fixture(t);await f.seed();const raw=JSON.parse(f.storage());delete raw[0].intentToken;raw[0].state='uncertain';raw[0].receipt=receipt({sessionPath:'/old/unproven'});await f.restore(JSON.stringify(raw));
 assert.equal((await f.get()).intentToken,undefined);f.configure(envelope());await f.controller.reconcileReceipts();const row=await f.get();assert.equal(row.intentToken,undefined);assert.equal(row.receiptBinding.canonicalSessionPath,'/synthetic/canonical-a');
});
test('expired dispatch hydration preserves existing acknowledgement and bound evidence',async t=>{
 const f=fixture(t);await f.seed();const raw=JSON.parse(f.storage()),prior=envelope({state:'accepted'});Object.assign(raw[0],{state:'dispatching',updatedAt:1,receipt:prior.receipt,receiptBinding:prior.receiptBinding});
 const row=await f.restore(JSON.stringify(raw));assert.equal(row.state,'uncertain');assert.deepEqual(JSON.parse(JSON.stringify(row.receipt)),prior.receipt);assert.deepEqual(JSON.parse(JSON.stringify(row.receiptBinding)),prior.receiptBinding);
});
async function waiting(f,count=1){for(let i=0;i<100&&f.waiting.length<count;i++)await new Promise(r=>setTimeout(r,1));assert.equal(f.waiting.length,count)}
test('overlapping unbound status reads atomically pin first canonical witness',async t=>{
 const f=fixture(t);await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);f.configure(null,{deferred:true});
 const first=f.status(),second=f.status();await waiting(f,2);f.resolve(envelope({state:'accepted'}));await first;const before=f.storage();
 f.resolve(envelope({sessionPath:'/synthetic/canonical-b'}));await assert.rejects(second,/receipt/i);assert.equal(f.storage(),before);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});
for(const mode of ['status','reconnect','dispatch','details'])test('same-millisecond identical intent recreation fences delayed '+mode,async t=>{
 const f=fixture(t);f.freezeTime();await f.seed();const original=await f.get();if(mode!=='dispatch')await f.queue.update('bound-id',{state:'uncertain'},f.namespace);
 f.configure(null,{deferred:true});const pending=mode==='status'?f.status():mode==='reconnect'?f.controller.reconcileReceipts():mode==='dispatch'?f.controller.flushQueue():f.controller.inspectCommandReceipt(await f.get());
 await waiting(f);await f.queue.removeAsync('bound-id',f.namespace);await f.seed();const recreated=await f.get();assert.equal(recreated.createdAt,original.createdAt);assert.notEqual(recreated.intentToken,original.intentToken);const before=f.storage();
 f.resolve(envelope());if(mode==='status'||mode==='details')await assert.rejects(pending);else await pending;assert.equal(f.storage(),before);
});
test('another-context token replacement fences pending status without resetting storage',async t=>{
 const f=fixture(t);await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);f.configure(null,{deferred:true});const pending=f.status();await waiting(f);
 const rows=JSON.parse(f.storage());rows[0].intentToken='another-context-token';f.writeStorage(JSON.stringify(rows));const before=f.storage();f.resolve(envelope());await assert.rejects(pending);assert.equal(f.storage(),before);
});
test('scope departure and return cannot apply earlier status',async t=>{
 const f=fixture(t);await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);f.configure(null,{deferred:true});const pending=f.status();await waiting(f);
 f.queue.setOfflineQueueNamespace('other');f.queue.setOfflineQueueNamespace(f.namespace);await f.get();const before=f.storage();f.resolve(envelope());await assert.rejects(pending);assert.equal(f.storage(),before);
});
test('Details revalidates canonical evidence established during its GET and stays read-only',async t=>{
 const f=fixture(t);await f.seed();f.configure(null,{deferred:true});const pending=f.controller.inspectCommandReceipt(await f.get());await waiting(f);const prior=envelope({state:'accepted'});
 await f.queue.update('bound-id',{state:'accepted',receipt:prior.receipt,receiptBinding:prior.receiptBinding},f.namespace);const before=f.storage();f.resolve(envelope({sessionPath:'/synthetic/canonical-b'}));await assert.rejects(pending,/receipt/i);assert.equal(f.storage(),before);
});
test('fresh module reconstruction retains token and binding, then rejects canonical substitution',async t=>{
 const first=fixture(t);await first.seed();first.configure(envelope({state:'accepted'}));await first.controller.flushQueue();const saved=await first.get(),raw=first.storage();
 const second=fixture(t,raw);const loaded=await second.get();assert.equal(loaded.intentToken,saved.intentToken);assert.deepEqual(JSON.parse(JSON.stringify(loaded.receiptBinding)),JSON.parse(JSON.stringify(saved.receiptBinding)));
 second.configure(envelope({sessionPath:'/synthetic/canonical-b'}));const before=second.storage();await second.controller.reconcileReceipts();assert.equal(second.storage(),before);
});

test('IndexedDB final apply reads current witness and commits receipt/binding together',async t=>{
 const f=fixture(t,undefined,{indexedDB:true});await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);
 f.configure(envelope());await f.status();const row=await f.get();assert.equal(row.state,'completed');assert.equal(row.receiptBinding.canonicalSessionPath,'/synthetic/canonical-a');
 const writes=f.idb.calls.filter(c=>c.type==='put');assert.ok(writes.some(write=>f.idb.calls.some(read=>read.id===write.id&&read.type==='get')),'same readwrite transaction revalidates and writes');
 const before=JSON.stringify(f.idb.rows());f.configure(envelope({sessionPath:'/synthetic/canonical-b'}));await assert.rejects(f.status(),/receipt/i);assert.equal(JSON.stringify(f.idb.rows()),before);
});
test('IndexedDB transaction abort leaves prior receipt and witness unchanged',async t=>{
 const f=fixture(t,undefined,{indexedDB:true});await f.seed();const prior=envelope({state:'accepted'});await f.queue.update('bound-id',{state:'uncertain',receipt:prior.receipt,receiptBinding:prior.receiptBinding},f.namespace);
 const before=JSON.stringify(f.idb.rows());f.configure(envelope());f.idb.control.abortNextPut=true;await assert.rejects(f.status(),/storage/i);assert.equal(JSON.stringify(f.idb.rows()),before);assert.ok(f.idb.calls.some(c=>c.type==='abort'));
});
test('IndexedDB revalidates a canonical witness changed at final transaction read',async t=>{
 const f=fixture(t,undefined,{indexedDB:true});await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);const expected=await f.get();
 const prior=envelope({state:'accepted'});f.idb.control.beforeGet=(name,key,rows)=>{if(name!=='commands-v3')return;f.idb.control.beforeGet=null;const current=rows.get(key);Object.assign(current,{receipt:prior.receipt,receiptBinding:prior.receiptBinding})};
 await assert.rejects(f.queue.applyReceipt(expected,envelope({sessionPath:'/synthetic/canonical-b'}),f.namespace),/receipt/i);
 assert.equal((await f.get()).receiptBinding.canonicalSessionPath,'/synthetic/canonical-a');
});
test('IndexedDB exact images and raw text survive lost acknowledgement and scoped recovery',async t=>{
 const f=fixture(t,undefined,{indexedDB:true}),images=[{data:'c3ludGhldGlj',mimeType:'image/png'},{data:'ZXhhY3Q=',mimeType:'image/jpeg'}];
 await f.queue.enqueue({commandId:'bound-id',sessionPath:'/synthetic/alias',text:'  Exact\ntext  ',images,namespace:f.namespace});
 let sends=0;await f.flush(async()=>{sends++;throw Error('Lost acknowledgement')});assert.equal((await f.get()).state,'uncertain');
 assert.deepEqual(JSON.parse(JSON.stringify(await f.queue.getImages('bound-id',f.namespace))),images);f.configure(envelope());await f.controller.reconcileReceipts();
 assert.equal((await f.get()).text,'  Exact\ntext  ');assert.deepEqual(JSON.parse(JSON.stringify(await f.queue.getImages('bound-id',f.namespace))),images);assert.equal(sends,1);assert.ok(f.calls.every(c=>c.method==='GET'));
});
for(const mode of ['reconnect','details'])test('controller '+mode+' fences changed-away-and-back scope',async t=>{
 const f=fixture(t);await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);f.configure(null,{deferred:true});const promise=mode==='reconnect'?f.controller.reconcileReceipts():f.controller.inspectCommandReceipt(await f.get());await waiting(f);
 f.queue.setOfflineQueueNamespace('other');f.queue.setOfflineQueueNamespace(f.namespace);await f.get();const before=f.storage();f.resolve(envelope());if(mode==='details')await assert.rejects(promise);else await promise;assert.equal(f.storage(),before);
});
test('Details observation continuity rejects later self-consistent canonical B',async t=>{
 const f=fixture(t);await f.seed();const intent=await f.get();f.configure(envelope({state:'accepted'}));const first=await f.controller.inspectCommandReceipt(intent),before=f.storage();
 f.configure(envelope({sessionPath:'/synthetic/canonical-b'}));await assert.rejects(f.controller.inspectCommandReceipt(intent,first),/receipt/i);assert.equal(f.storage(),before);
});
for(const mode of ['controller','api'])test('real '+mode+' HTTP helper cannot turn contradictory receipt envelope into terminal failure',async t=>{
 const f=fixture(t);await f.seed();f.configure({...envelope(),ok:false});
 if(mode==='controller'){f.realControllerTransport();await f.controller.flushQueue()}
 else {f.realApiTransport();await f.flush(e=>f.api.prompt(e.sessionPath,e.text,[],e.commandId))}
 assert.equal((await f.get()).state,'uncertain');assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,1);
});
for(const status of [400,404,409,500])test('HTTP '+status+' preserves entire prior status row on reconnect and secondary',async t=>{
 const f=fixture(t);await f.seed();const prior=envelope({state:'accepted'});await f.queue.update('bound-id',{state:'accepted',receipt:prior.receipt,receiptBinding:prior.receiptBinding},f.namespace);
 f.configure(null,{status});const before=f.storage();await f.controller.reconcileReceipts();await assert.rejects(f.status());assert.equal(f.storage(),before);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('transport failure preserves whole prior status row without POST',async t=>{
 const f=fixture(t);await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);f.configure(null,{failure:'Network lost'});const before=f.storage();
 await f.controller.reconcileReceipts();await assert.rejects(f.status());assert.equal(f.storage(),before);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('preflight failure cannot rearm a concurrently acknowledged command',async t=>{
 const f=fixture(t);await f.seed();let sends=0;
 await f.flush(async entry=>{sends++;await f.queue.applyReceipt(entry,envelope(),f.namespace);throw new f.queue.UndispatchedError('Preflight unavailable')});
 const before=f.storage();assert.equal((await f.get()).state,'completed');await f.flush(async()=>{sends++;return envelope()});assert.equal(sends,1);assert.equal(f.storage(),before);
});

for(const mode of ['controller','secondary']){
 test(mode+' deferred preflight scope change preserves saved intent and sends zero POSTs',async t=>{
  const f=fixture(t);await f.seed();await f.seed('next');f.configure(envelope(),{deferVersion:true});const pending=mode==='controller'?f.controller.flushQueue():f.savedSend();await waiting(f);
  f.queue.setOfflineQueueNamespace('another-credential');f.resolve({protocolVersion:1,minClientProtocolVersion:1,capabilities:['receipt-session-binding-v1']});await pending;
  assert.equal((await f.get()).state,'saved');assert.equal((await f.get('next')).state,'saved');assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,0);assert.equal(f.calls.length,1);
 });
 test(mode+' deferred successful preflight cannot POST an intent concurrently confirmed by status',async t=>{
  const f=fixture(t);await f.seed();f.configure(envelope(),{deferVersion:true});const pending=mode==='controller'?f.controller.flushQueue():f.savedSend();await waiting(f);
  await f.queue.applyReceipt(await f.get(),envelope(),f.namespace);const before=f.storage();f.resolve({protocolVersion:1,minClientProtocolVersion:1,capabilities:['receipt-session-binding-v1']});await pending;
  assert.equal((await f.get()).state,'completed');assert.equal(f.storage(),before);assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,0);
 });
}
test('disposed controller before handoff preserves saved rows without another POST',async t=>{
 const f=fixture(t);await f.seed();await f.seed('next');f.configure(envelope(),{deferVersion:true});const pending=f.controller.flushQueue();await waiting(f);const later=JSON.stringify(await f.get('next'));f.controller.disposed=true;f.resolve({protocolVersion:1,minClientProtocolVersion:1,capabilities:['receipt-session-binding-v1']});await pending;
 assert.equal((await f.get()).state,'saved');assert.equal(JSON.stringify(await f.get('next')),later);assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,0);
});

test('real status HTTP readers reject malformed JSON and retain the prior row',async t=>{
 const f=fixture(t);await f.seed();await f.queue.update('bound-id',{state:'uncertain'},f.namespace);f.configure(envelope(),{badJson:true});f.realApiTransport();const before=f.storage();
 await f.controller.reconcileReceipts();await assert.rejects(f.status());assert.equal(f.storage(),before);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('direct API requires known raw intent before any status request',async t=>{
 const f=fixture(t);f.configure(envelope());await assert.rejects(f.api.getReceipt({commandId:'bound-id'}),/receipt/i);await assert.rejects(f.api.getReceipt('bound-id'),/receipt/i);assert.equal(f.calls.length,0);
});
test('existing enqueue preserves row-incarnation token and exact images',async t=>{
 const f=fixture(t,undefined,{indexedDB:true});const images=[{data:'c3ludGhldGlj',mimeType:'image/png'}],input={commandId:'bound-id',sessionPath:'/synthetic/alias',text:'Exact text',images,namespace:f.namespace};
 const first=await f.queue.enqueue(input),again=await f.queue.enqueue(input);assert.equal(again.intentToken,first.intentToken);assert.deepEqual(JSON.parse(JSON.stringify(await f.queue.getImages('bound-id',f.namespace))),images);
});
test('lost POST acknowledgement recovers after text-only storage reconstruction using only exact scoped GET',async t=>{
 const first=fixture(t);await first.seed();first.configure(null,{failure:'Network lost after handoff'});
 // Let the version preflight complete, then lose the one prompt response.
 first.controller.ensureReceiptProtocol=async()=>{};await first.controller.flushQueue();assert.equal((await first.get()).state,'uncertain');assert.equal(first.calls.filter(c=>c.method==='POST').length,1);
 const raw=first.storage(),second=fixture(t,raw);await second.get();second.configure(envelope());await second.controller.reconcileReceipts();let row=await second.get();assert.equal(row.state,'completed');assert.equal(row.text,'Exact text');assert.equal(row.sessionPath,'/synthetic/alias');
 const observed=await second.controller.inspectCommandReceipt(row);await second.controller.inspectCommandReceipt(row,observed);await second.status();assert.equal(second.calls.filter(c=>c.method==='POST').length,0);assert.ok(second.calls.every(c=>c.path==='/api/receipts/bound-id?session=%2Fsynthetic%2Falias'));
});

test('late dispatch failure cannot report a dropped command after concurrent bound acknowledgement',async t=>{
 const f=fixture(t);await f.seed();let dropped=0;
 await f.flush(async entry=>{await f.queue.applyReceipt(entry,envelope(),f.namespace);throw Error('Network lost')},{onDropped:()=>{dropped++}});
 assert.equal((await f.get()).state,'completed');assert.equal(dropped,0);
});

for(const mode of ['dispatch','reconnect'])test('controller already disposed at '+mode+' start performs no I/O or mutation',async t=>{
 const f=fixture(t);await f.seed();if(mode==='reconnect')await f.queue.update('bound-id',{state:'uncertain'},f.namespace);f.configure(envelope());const before=f.storage();f.controller.disposed=true;
 if(mode==='dispatch')await f.controller.flushQueue();else await f.controller.reconcileReceipts();assert.equal(f.calls.length,0);assert.equal(f.storage(),before);
});

test('hydration cannot turn orphaned binding into a witness by synthesizing its receipt',async t=>{
 const f=fixture(t);await f.seed();const raw=JSON.parse(f.storage());Object.assign(raw[0],{state:'dispatching',updatedAt:1,receiptBinding:{version:1,requestedSessionPath:'/synthetic/alias',canonicalSessionPath:'/synthetic/alias'}});delete raw[0].receipt;
 await f.restore(JSON.stringify(raw));const row=await f.get();assert.equal(row.state,'uncertain');assert.equal(row.receipt,undefined);
 f.configure(envelope({sessionPath:'/synthetic/alias'}));const before=f.storage();await f.controller.reconcileReceipts();await assert.rejects(f.status());assert.equal(f.storage(),before);
});
test('post-handoff uncertainty cannot turn orphaned binding into a witness',async t=>{
 const f=fixture(t);await f.seed();await f.queue.update('bound-id',{receiptBinding:{version:1,requestedSessionPath:'/synthetic/alias',canonicalSessionPath:'/synthetic/alias'}},f.namespace);
 await f.flush(async()=>{throw Error('Network lost')});assert.equal((await f.get()).receipt,undefined);f.configure(envelope({sessionPath:'/synthetic/alias'}));await assert.rejects(f.status());assert.equal((await f.get()).state,'uncertain');
});

// Real Response streams expose the completion that headers-only mocks omitted.
function heldAbsence() {
 let controller;
 const body=new ReadableStream({start(value){controller=value;}});
 return {response:new Response(body,{status:404}),
  chunk:value=>controller.enqueue(value),end:()=>controller.close(),fail:error=>controller.error(error)};
}
async function retainedAbsenceFixture(t) {
 const f=fixture(t,undefined,{indexedDB:true});
 const images=[{data:'c3ludGhldGlj',mimeType:'image/png'},{data:'ZXhhY3Q=',mimeType:'image/jpeg'}];
 await f.queue.enqueue({commandId:'bound-id',sessionPath:'/synthetic/alias',text:'  Exact\ntext  ',images,namespace:f.namespace});
 const prior=envelope({state:'accepted'});
 await f.queue.update('bound-id',{state:'uncertain',receipt:prior.receipt,receiptBinding:prior.receiptBinding},f.namespace);
 const unchanged=JSON.stringify(f.idb.rows());
 return {f,images,unchanged};
}
function assertReadOnlyAbsence(f,images,unchanged) {
 assert.equal(JSON.stringify(f.idb.rows()),unchanged);
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].path,'/api/receipts/bound-id?session=%2Fsynthetic%2Falias');
 assert.equal(f.calls[0].method,'GET');
}
for(const mode of ['inspection','reconciliation'])test('404 body '+mode+' waits for EOF and preserves exact retained payload',async t=>{
 const {f,images,unchanged}=await retainedAbsenceFixture(t),stream=heldAbsence();
 f.configure(null,{status:404,receiptResponse:stream.response});
 stream.chunk(new TextEncoder().encode('{"ok":false,'));
 let settled=false;
 const operation=mode==='inspection'?f.controller.inspectCommandReceipt(await f.get()):f.controller.reconcileReceipts();
 const pending=operation.then(value=>{settled=true;return value},error=>{settled=true;throw error});
 try {
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,1);
  assert.equal(settled,false,'headers and initial bytes are not body completion');
  assert.equal(JSON.stringify(f.idb.rows()),unchanged);
  if(mode==='reconciliation') {
   assert.equal(f.controller.reconcilingReceipts,true);
   await f.controller.reconcileReceipts();assert.equal(f.calls.length,1,'single-flight held through body read');
  }
 } finally {
  stream.chunk(new TextEncoder().encode('"error":"receipt not found"}'));stream.end();
  await pending;
 }
 if(mode==='inspection')assert.equal(await pending === null, true);
 else assert.equal(f.controller.reconcilingReceipts,false);
 assert.equal(stream.response.bodyUsed,true);
 assertReadOnlyAbsence(f,images,unchanged);
 assert.deepEqual(JSON.parse(JSON.stringify(await f.queue.getImages('bound-id',f.namespace))),images);
});

for(const mode of ['inspection','reconciliation'])test('404 body failure keeps '+mode+' read-only and releases its resources',async t=>{
 const {f,images,unchanged}=await retainedAbsenceFixture(t),stream=heldAbsence();
 f.configure(null,{status:404,receiptResponse:stream.response});
 stream.chunk(new TextEncoder().encode('partial'));
 const failure=new DOMException('Synthetic body cancellation','AbortError');
 const operation=mode==='inspection'?f.controller.inspectCommandReceipt(await f.get()):f.controller.reconcileReceipts();
 const observed=operation.then(value=>({value}),error=>({error}));
 await new Promise(resolve=>setImmediate(resolve));stream.fail(failure);
 const result=await observed;
 if(mode==='inspection')assert.equal(result.error,failure);
 else {assert.deepEqual(result,{value:undefined});assert.equal(f.controller.reconcilingReceipts,false);}
 assert.equal(stream.response.body.locked,false);
 assertReadOnlyAbsence(f,images,unchanged);
 assert.deepEqual(JSON.parse(JSON.stringify(await f.queue.getImages('bound-id',f.namespace))),images);
 // A later explicit observation remains possible; it is not an automatic retry.
 f.configure(null,{status:404});
 assert.equal(await f.controller.inspectCommandReceipt(await f.get()) === null, true);
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.method==='GET'));
 assert.equal(JSON.stringify(f.idb.rows()),unchanged);
});
for(const movement of ['namespace-away-back','generation','intent-replacement','disposed'])test('404 body EOF cannot cross '+movement+' inspection scope',async t=>{
 const {f}=await retainedAbsenceFixture(t),stream=heldAbsence();
 f.configure(null,{status:404,receiptResponse:stream.response});
 const operation=f.controller.inspectCommandReceipt(await f.get());
 const observed=operation.then(value=>({value}),error=>({error}));
 await new Promise(resolve=>setImmediate(resolve));
 if(movement==='namespace-away-back'){f.queue.setOfflineQueueNamespace('another');f.queue.setOfflineQueueNamespace(f.namespace);await f.get();}
 if(movement==='generation')f.controller.generation++;
 if(movement==='intent-replacement'){await f.queue.removeAsync('bound-id',f.namespace);await f.seed();}
 if(movement==='disposed')f.controller.disposed=true;
 const before=JSON.stringify(f.idb.rows());stream.end();const result=await observed;
 assert.match(String(result.error),/scope changed/);
 assert.equal(JSON.stringify(f.idb.rows()),before);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');
 assert.equal(stream.response.body.locked,false);
});
for(const [label,body] of [['null',null],['empty',''],['non-JSON','not JSON']])test('404 '+label+' completed body remains absence without delivery evidence',async t=>{
 const {f,images,unchanged}=await retainedAbsenceFixture(t);
 f.configure(null,{status:404,receiptResponse:new Response(body,{status:404})});
 assert.equal(await f.controller.inspectCommandReceipt(await f.get()) === null, true);
 assertReadOnlyAbsence(f,images,unchanged);
 assert.equal((await f.get()).state,'uncertain');
});
for(const mode of ['inspection','reconciliation'])test('404 oversized body fails '+mode+' without replacing the retained row',async t=>{
 const {f,images,unchanged}=await retainedAbsenceFixture(t),response=new Response(new Uint8Array(65_537),{status:404});
 f.configure(null,{status:404,receiptResponse:response});
 if(mode==='inspection')await assert.rejects(f.controller.inspectCommandReceipt(await f.get()),/limit|large|size|bound/i);
 else {await f.controller.reconcileReceipts();assert.equal(f.controller.reconcilingReceipts,false);}
 assert.equal(response.body.locked,false);assertReadOnlyAbsence(f,images,unchanged);
});
