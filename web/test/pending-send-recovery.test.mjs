import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Actual controller cadence and durable queue. No network/native/model access.
const code = await bundleDomFixture(`
import { OmpSessionController } from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import { createOmpStore } from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
const store=createOmpStore(), controller=new OmpSessionController(store,'synthetic-recovery');
const namespace=queue.offlineQueueNamespaceForCredential('synthetic-recovery');
const calls=[];
controller.request=async(path,init)=>{calls.push({path,method:init?.method??'GET'});throw Error('Synthetic network unavailable')};
controller.fetchAuthed=async(path,init)=>{calls.push({path,method:init?.method??'GET'});return {status:404,ok:false}};
controller.refreshSessions=async()=>{};controller.reviveSocket=()=>{};controller.catchUpWithResult=async()=>false;
controller.flushHeldCollabResponse=()=>{};
window.fixture={controller,store,queue,namespace,calls,
 seed:(id='recover',images=[])=>queue.enqueue({commandId:id,sessionPath:'/synthetic/raw-alias',text:'Exact \\n  retained 🔒',images,namespace}),
 get:()=>queue.getQueued('recover',namespace),
 async dispatch(){await queue.update('recover',{state:'dispatching',error:'Prior preflight failure'},namespace)},
 snapshot:()=>queue.getSnapshot(namespace),
 raw:()=>window.idb?window.idb.rows():JSON.parse(localStorage.getItem('omp-pulse-queue-v3:'+namespace)),
 async rehydrate(){queue.setOfflineQueueNamespace('temporary');queue.setOfflineQueueNamespace(namespace);return queue.getQueued('recover',namespace)},
};
`);
async function fixture(t,{indexedDB=false}={}){
 const setup=`window.now=100000;Date.now=()=>window.now;window.WebSocket.OPEN=1;
 const ticks=new Map();let timerId=0;window.setInterval=(fn,ms)=>{const id=++timerId;ticks.set(id,{fn,ms});return id};window.clearInterval=id=>ticks.delete(id);
 window.runTick=()=>{for(const t of ticks.values())if(t.ms===1000)t.fn()};
 Object.defineProperty(navigator,'onLine',{value:false,configurable:true});
 `+(indexedDB?'window.idb=('+memoryIndexedDb.toString()+')();window.indexedDB=window.idb.indexedDB;':'');
 const dom=createDomFixture(setup+code),w=dom.window,f=w.fixture;
 t.after(()=>{assert.deepEqual(dom.blocked,[]);dom.close()});
 await f.queue.getQueued('absent',f.namespace);
 const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0))};
 return {w,f,settle,tick:async()=>{w.runTick();await settle()}};
}
const deadline=row=>row.updatedAt+60000+Math.ceil((row.text.length*2+row.imageBytes)*1000/(32*1024));
const plain=x=>JSON.parse(JSON.stringify(x));

for(const indexedDB of [false,true])test('young hydrated claim expires on existing offline visible tick, without replay '+(indexedDB?'IDB':'fallback'),async t=>{
 const {w,f,tick}=await fixture(t,{indexedDB});await f.seed();await f.dispatch();await f.rehydrate();const before=plain(await f.get());
 w.now=deadline(before);await tick();assert.deepEqual(plain(await f.get()),before);
 w.now++;await tick();const after=plain(await f.get());
 assert.equal(after.state,'uncertain');assert.equal(after.updatedAt,w.now);
 assert.deepEqual({...after,state:before.state,updatedAt:before.updatedAt},before);
 assert.equal(f.snapshot()[0].state,'uncertain');assert.equal(f.calls.length,0);
});

test('already expired hydration retains absence of receipt and updates only local state and timestamp',async t=>{
 const {w,f}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const before=plain(f.raw()[0]);
 w.now=deadline(before)+1;await f.rehydrate();const after=plain(f.raw()[0]);
 assert.equal(after.state,'uncertain');assert.equal(after.updatedAt,w.now);assert.equal(after.receipt,undefined);
 assert.deepEqual({...after,state:before.state,updatedAt:before.updatedAt},before);
});

test('hydrate-time expiry cannot overwrite receipt that wins before row transaction',async t=>{
 const {w,f}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const before=plain(f.raw()[0]);w.now=deadline(before)+1;
 const receipt={commandId:before.commandId,sessionPath:'/synthetic/canonical',state:'completed',createdAt:1,updatedAt:2};
 let raced=false;w.idb.control.beforeTransaction=(name,mode)=>{if(name!=='commands-v3'||mode!=='readwrite')return;w.idb.control.beforeTransaction=null;raced=true;w.idb.inject({...before,state:'completed',receipt,receiptBinding:{version:1,requestedSessionPath:before.sessionPath,canonicalSessionPath:receipt.sessionPath},updatedAt:w.now});assert.equal(f.raw()[0].state,'completed')};
 await f.rehydrate();assert.equal(raced,true);assert.equal((await f.get()).state,'completed');assert.equal(f.snapshot()[0].state,'completed');
});

test('failed hydrate-time persistence never publishes an uncommitted uncertain row; next pass retries',async t=>{
 const {w,f,tick}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const before=plain(f.raw()[0]);w.now=deadline(before)+1;
 w.idb.control.abortNextPut=true;try { await f.rehydrate(); } catch(error) { assert.match(error.message,/storage/i); }
 assert.deepEqual(plain(f.raw()[0]),before);assert.notEqual(f.snapshot()[0]?.state,'uncertain');
 await tick();assert.equal((await f.get()).state,'uncertain');assert.equal(f.snapshot()[0].state,'uncertain');
});

test('two-image payload allowance and raw intent survive strict deadline crossing',async t=>{
 const {w,f,tick}=await fixture(t,{indexedDB:true});
 const images=[{data:'x'.repeat(32768),mimeType:'image/png'},{data:'y'.repeat(65536),mimeType:'image/jpeg'}];
 await f.seed('recover',images);await f.dispatch();const before=plain(f.raw()[0]);
 w.now=before.updatedAt+60001;await tick();assert.equal((await f.get()).state,'dispatching');
 w.now=deadline(before);await tick();assert.equal((await f.get()).state,'dispatching');
 w.now++;await tick();const after=plain(f.raw()[0]);assert.equal(after.state,'uncertain');
 assert.deepEqual({...after,state:before.state,updatedAt:before.updatedAt},before);
 assert.deepEqual(plain(await f.queue.getImages('recover',f.namespace)),images);assert.equal(f.calls.length,0);
});

test('hidden tick waits; visible resume expires locally even offline',async t=>{
 const {w,f,tick,settle}=await fixture(t);await f.seed();await f.dispatch();const before=plain(await f.get());
 Object.defineProperty(w.document,'visibilityState',{value:'hidden',configurable:true});
 w.document.dispatchEvent(new w.Event('visibilitychange'));w.now=deadline(before)+1;await tick();assert.equal((await f.get()).state,'dispatching');
 Object.defineProperty(w.document,'visibilityState',{value:'visible',configurable:true});
 w.document.dispatchEvent(new w.Event('visibilitychange'));await settle();assert.equal((await f.get()).state,'uncertain');
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

for(const [label,change] of [
 ['renewed lease',r=>({...r,updatedAt:r.updatedAt+120000})],
 ['replacement token',r=>({...r,intentToken:'replacement-incarnation'})],
 ['changed immutable payload',r=>({...r,text:'Different intent'})],
 ['new evidence without state change',r=>({...r,receipt:{commandId:r.commandId,sessionPath:'/canonical',state:'accepted',createdAt:1,updatedAt:2},receiptBinding:{version:1,requestedSessionPath:r.sessionPath,canonicalSessionPath:'/canonical'}})],
])test('expiry rechecks '+label+' in the row transaction',async t=>{
 const {w,f,tick}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const before=plain(f.raw()[0]);w.now=deadline(before)+1;
 const replacement=change(before);let exercised=false;
 w.idb.control.beforeTransaction=(name,mode)=>{if(name!=='commands-v3'||mode!=='readwrite')return;w.idb.control.beforeTransaction=null;exercised=true;w.idb.inject(replacement)};
 await tick();assert.equal(exercised,true);assert.deepEqual(plain(f.raw()[0]),replacement);assert.deepEqual(plain(f.snapshot()[0]),plain(await f.get()));
 assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
});

test('404 observation before deadline is unchanged; independent local expiry does not resend',async t=>{
 const {w,f,tick}=await fixture(t);await f.seed();await f.dispatch();const before=plain(await f.get());
 await f.controller.reconcileReceipts();assert.deepEqual(plain(await f.get()),before);
 w.now=deadline(before)+1;await tick();assert.equal((await f.get()).state,'uncertain');
 await f.controller.reconcileReceipts();await f.controller.flushQueue();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 assert.ok(f.calls.every(c=>c.path==='/api/receipts/recover?session=%2Fsynthetic%2Fraw-alias'&&c.method==='GET'));
});

for(const indexedDB of [false,true])test('maintenance storage failure leaves durable state truthful and retries '+(indexedDB?'IDB':'fallback'),async t=>{
 const {w,f,tick}=await fixture(t,{indexedDB});await f.seed();await f.dispatch();const before=plain(f.raw()[0]);w.now=deadline(before)+1;
 let restore=()=>{};
 if(indexedDB)w.idb.control.abortNextPut=true;
 else {const original=w.Storage.prototype.setItem;let failed=false;w.Storage.prototype.setItem=function(key,value){if(!failed&&key==='omp-pulse-queue-v3:'+f.namespace){failed=true;throw Error('Synthetic storage full')}return original.call(this,key,value)};restore=()=>w.Storage.prototype.setItem=original}
 await tick();assert.deepEqual(plain(f.raw()[0]),before);assert.equal(f.snapshot()[0].state,'dispatching');assert.match(f.store.getState().error,/saved prompt was kept/);
 restore();await tick();assert.equal((await f.get()).state,'uncertain');assert.equal(f.snapshot()[0].state,'uncertain');assert.equal(f.calls.length,0);
});

for(const binding of [undefined,{version:1,requestedSessionPath:'/synthetic/raw-alias',canonicalSessionPath:'/canonical'},false,{version:99}])test('expiry preserves legacy token absence and prior evidence '+JSON.stringify(binding),async t=>{
 const {w,f,tick}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const stored=plain(f.raw()[0]);
 delete stored.intentToken;stored.receipt={commandId:'recover',sessionPath:'/canonical',state:'accepted',createdAt:1,updatedAt:2};if(binding!==undefined)stored.receiptBinding=binding;
 w.idb.inject(stored);await f.rehydrate();const before=plain(f.raw()[0]);w.now=deadline(before)+1;await tick();const after=plain(f.raw()[0]);
 assert.equal(after.state,'uncertain');assert.equal(after.intentToken,undefined);assert.deepEqual({...after,state:before.state,updatedAt:before.updatedAt},before);
});

for(const retirement of ['namespace','controller','session-generation'])test('queued expiry cannot commit after '+retirement+' retirement',async t=>{
 const {w,f,settle}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const before=plain(f.raw()[0]);w.now=deadline(before)+1;
 let release;let first=true;
 Object.defineProperty(w.navigator,'locks',{value:{request(_name,_options,run){if(first){first=false;return new Promise((resolve,reject)=>{release=()=>Promise.resolve().then(run).then(resolve,reject)})}return run()}},configurable:true});
 const pending=f.controller.maintainLocalPendingSends();await settle();assert.equal(typeof release,'function');
 if(retirement==='namespace')f.queue.setOfflineQueueNamespace('replacement-credential');
 else if(retirement==='controller')f.controller.disposed=true;
 else f.controller.generation++;
 release();await pending;await settle();assert.deepEqual(plain(f.raw()[0]),before);assert.equal(f.calls.length,0);
});

test('overlapping maintenance expires once and repeated ineligible pass writes nothing',async t=>{
 const {w,f}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const before=plain(await f.get());w.now=deadline(before)+1;
 const puts=()=>w.idb.calls.filter(c=>c.type==='put').length,beforePuts=puts();
 await Promise.all([f.queue.maintainPendingSends(f.namespace),f.queue.maintainPendingSends(f.namespace)]);
 assert.equal(puts()-beforePuts,1);const stable=f.snapshot(),calls=w.idb.calls.length;await f.queue.maintainPendingSends(f.namespace);
 assert.equal(puts()-beforePuts,1);assert.equal(w.idb.calls.length,calls);assert.equal(f.snapshot(),stable);
});

test('late preflight failure cannot roll expired uncertainty back to saved',async t=>{
 const {w,f,tick,settle}=await fixture(t);await f.seed();let reject;let sends=0;
 const drain=f.queue.flush(async()=>{sends++;return new Promise((_resolve,fail)=>{reject=fail})},{namespace:f.namespace,isTransient:()=>false});
 await settle();const claimed=plain(await f.get());assert.equal(claimed.state,'dispatching');w.now=deadline(claimed)+1;await tick();assert.equal((await f.get()).state,'uncertain');
 reject(new f.queue.UndispatchedError('unsupported preflight'));await drain;await f.controller.flushQueue();assert.equal((await f.get()).state,'uncertain');assert.equal(sends,1);assert.equal(f.calls.length,0);
});

test('late handoff is fenced after expiry; a valid original POST receipt may still reconcile',async t=>{
 const {w,f,tick,settle}=await fixture(t);await f.seed();let resolve;let sends=0;
 const drain=f.queue.flush(async()=>{sends++;return new Promise(done=>{resolve=done})},{namespace:f.namespace,isTransient:()=>false});
 await settle();const claimed=plain(await f.get());w.now=deadline(claimed)+1;await tick();
 await assert.rejects(f.queue.assertDispatchCurrent(claimed,f.namespace,()=>true),/intent changed/);
 const receipt={commandId:'recover',sessionPath:'/canonical',state:'completed',createdAt:1,updatedAt:2};
 resolve({ok:true,receipt,receiptBinding:{version:1,requestedSessionPath:claimed.sessionPath,canonicalSessionPath:receipt.sessionPath}});await drain;
 assert.equal((await f.get()).state,'completed');assert.equal(sends,1);assert.equal(f.calls.length,0);
});

test('native local maintenance is a strict no-op without native wake or storage write',async t=>{
 const {w,f}=await fixture(t,{indexedDB:true});await f.seed();await f.dispatch();const before=plain(f.raw()[0]);w.now=deadline(before)+1;
 const nativeCalls=[];w.OmpNative={senderRequired:()=>true};w.OmpOutbox={postMessage:value=>{nativeCalls.push(value);throw Error('Native bridge prohibited')}};
 const calls=w.idb.calls.length;await f.queue.maintainPendingSends(f.namespace);await f.controller.maintainLocalPendingSends();
 assert.equal(w.idb.calls.length,calls);assert.deepEqual(nativeCalls,[]);assert.deepEqual(plain(f.raw()[0]),before);
});

test('update recovery targets the pending conversation instead of an unrelated open chat',async t=>{
 const {f}=await fixture(t);
 f.store.setState({sessionPath:'/synthetic/idle-chat'});
 await f.seed();
 const blocked=f.controller.getUpdateSafety();
 assert.equal(blocked.pendingWork,true);
 assert.equal(blocked.pendingSessionPath,'/synthetic/raw-alias');
 await f.controller.clearOutbox();
 assert.equal(f.controller.getUpdateSafety().pendingWork,false);
 assert.equal(f.controller.getUpdateSafety().pendingSessionPath,null);
 assert.equal(f.calls.length,0);
});
