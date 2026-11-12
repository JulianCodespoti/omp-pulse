import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settleTask } from 'node:timers/promises';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';

const code = await bundleDomFixture(`
import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {syncNativeNotificationToken,clearNativeNotificationToken} from ${JSON.stringify(resolve(root,'web/src/platform/native-notifications.ts'))};
import * as extension from ${JSON.stringify(resolve(root,'web/src/runtime/extension-feedback.ts'))};
window.fixture={queue,extension,OmpSessionController,createOmpStore,syncNativeNotificationToken,clearNativeNotificationToken};
`);
const plain=value=>JSON.parse(JSON.stringify(value));

async function fixture(t, options={}) {
  const dom=createDomFixture(code),w=dom.window,f=w.fixture;
  const memory=memoryIndexedDb(options);
  Object.assign(w,{indexedDB:memory.indexedDB,IDBKeyRange:{bound:(lower,upper,lowerOpen=false,upperOpen=false)=>({lower,upper,lowerOpen,upperOpen})},Headers,Request,Response,TextEncoder,TextDecoder});
  const controllers=[];
  w.localStorage.setItem('omp-remote-token','old-synthetic-credential');
  const old=f.queue.offlineQueueNamespaceForCredential('old-synthetic-credential');
  const next=f.queue.offlineQueueNamespaceForCredential('new-synthetic-credential');
  f.queue.setOfflineQueueNamespace(old);
  await f.queue.maintainPendingSends(old);
  t.after(()=>{controllers.forEach(c=>c.dispose());dom.close()});
  return {w,f,memory,old,next,controller(){const c=new f.OmpSessionController(f.createOmpStore(),'old-synthetic-credential');controllers.push(c);return c}};
}

test('repair keeps prepared editor text without consumed IDs, including newer in-memory text',async t=>{
  const x=await fixture(t),q=x.f.queue;
  const raw=JSON.stringify([{path:'/chat',pending:{id:'prepared-authority-id',text:'prepared editor text'},seen:['consumed-authority-id']}]);
  x.w.localStorage.setItem(`omp-extension-drafts:${x.old}`,raw);
  x.w.localStorage.setItem('omp-extension-drafts:cred-unrelated','unrelated invalid JSON');
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  let page=await q.readPairingRecoveryEntries('new-synthetic-credential');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',page.items[0].key),'prepared editor text');
  assert.equal(JSON.stringify(page).includes('authority-id'),false);
  x.f.extension.prepareExtensionDraft(x.old,'/chat','newer prepared editor text');
  x.w.localStorage.setItem(`omp-extension-drafts:${x.old}`,raw); // A failed background write can leave disk older than the live inbox.
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  page=await q.readPairingRecoveryEntries('new-synthetic-credential');
  const texts=await Promise.all(page.items.filter(row=>!row.browser).map(row=>q.readPairingRecoveryText('new-synthetic-credential',row.key)));
  assert.deepEqual([...texts].sort(),['newer prepared editor text','prepared editor text']);
  assert.equal(x.w.localStorage.getItem(`omp-extension-drafts:${x.old}`),raw,'capture leaves original scope untouched');
});

test('unreadable prepared drafts fail preservation closed and a repaired read can retry',async t=>{
  const x=await fixture(t),q=x.f.queue;
  x.w.localStorage.setItem(`omp-extension-drafts:${x.old}`,'{invalid');
  await assert.rejects(q.capturePairingRecovery(x.old));
  assert.equal(await q.readPairingRecovery('new-synthetic-credential'),null);
  assert.equal(x.w.localStorage.getItem('omp-remote-token'),'old-synthetic-credential');
  x.w.localStorage.setItem(`omp-extension-drafts:${x.old}`,JSON.stringify([{path:'/chat',pending:{id:'never-replay',text:'read recovered'},seen:[]}]));
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  const page=await q.readPairingRecoveryEntries('new-synthetic-credential');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',page.items[0].key),'read recovered');
});

test('repair upgrades an existing v1 outbox without recreating stores or losing photo bytes',async t=>{
  const x=await fixture(t,{initialVersion:1,initialStores:{'commands-v3':'storageKey','draft-attachments-v3':'storageKey'}});
  x.w.localStorage.setItem(`omp-draft:${x.old}:/chat`,'retained');
  x.memory.inject({storageKey:`${x.old}:/chat`,namespace:x.old,sessionPath:'/chat',images:[{data:'b2xkLXBob3Rv',mimeType:'image/png'}]},'draft-attachments-v3');
  const saved=await x.f.queue.capturePairingRecovery(x.old);
  await x.f.queue.bindPairingRecovery(saved,'new-synthetic-credential');
  assert.equal(x.memory.rows('pairing-recovery').length,1);
  const entries=await x.f.queue.readPairingRecoveryEntries('new-synthetic-credential');
  assert.equal(await x.f.queue.readPairingRecoveryText('new-synthetic-credential',entries.items[0].key),'retained');
  assert.equal((await x.f.queue.readPairingRecoveryImage('new-synthetic-credential',entries.items[0].key,0)).data,'b2xkLXBob3Rv');
  const upgrade=x.memory.calls.find(call=>call.type==='open'&&call.name==='omp-pulse-outbox');
  assert.equal(upgrade.oldVersion,1);assert.equal(upgrade.version>1,true);
});

test('repair preserves scoped new/session/file drafts, photos and uncertain/terminal sends as content only',async t=>{
  const x=await fixture(t),q=x.f.queue;
  x.w.localStorage.setItem(`omp-draft:${x.old}:/chat`,'chat draft');
  x.w.localStorage.setItem(`omp-draft:${x.old}:new-session`,JSON.stringify({revision:'never-replay',text:'new-session draft'}));
  const filePath=JSON.stringify(['file',x.w.location.origin,'/chat','notes.txt']);
  x.w.localStorage.setItem(`omp-draft:${x.old}:${filePath}`,JSON.stringify({id:'old-file-edit',content:'unsaved file content',baseline:'original file'}));
  const jsonText='{"text":"keep full JSON","content":"not an editor"}';
  x.w.localStorage.setItem(`omp-draft:${x.old}:/json`,jsonText);
  x.w.localStorage.setItem('omp-draft:cred-unrelated:/chat','unrelated secret');
  await q.saveDraftAttachments('/chat',[{data:'cGhvdG8=',mimeType:'image/png',name:'photo',previewUrl:'blob:old'}],x.old);
  await q.saveDraftAttachments('new-session',[{data:'bmV3',mimeType:'image/png',name:'new',previewUrl:'blob:new'}],x.old);
  for(const state of ['uncertain','failed','completed'])x.memory.inject({storageKey:`${x.old}:${state}`,namespace:x.old,id:state,commandId:state,intentToken:'authority',sessionPath:'/chat',text:state,images:[{data:'c2VuZA==',mimeType:'image/jpeg'}],state,createdAt:Date.now(),updatedAt:Date.now(),imageBytes:8,imageCount:1});
  const before=plain(x.memory.rows());
  const saved=await q.capturePairingRecovery(x.old);
  // Cancellation has neither changed the current credential nor removed work.
  assert.equal(x.w.localStorage.getItem('omp-remote-token'),'old-synthetic-credential');
  assert.deepEqual(plain(x.memory.rows()),before);
  await q.bindPairingRecovery(saved,'new-synthetic-credential');
  await q.bindPairingRecovery(saved,'new-synthetic-credential');
  const recovered=plain(await q.readPairingRecovery('new-synthetic-credential'));
  const page=plain((await q.readPairingRecoveryEntries('new-synthetic-credential')).items);
  const entries=page.filter(item=>!item.browser);
  assert.equal(page.filter(item=>item.browser).length,7,'live source grants are content-only and scoped');
  assert.equal(entries.length,7,'acknowledgement retry does not duplicate the archive');
  const newDraft=entries.find(i=>i.sessionPath==='new-session');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',newDraft.key),'new-session draft');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',entries.find(i=>i.sessionPath===filePath).key),'unsaved file content');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',entries.find(i=>i.sessionPath==='/json').key),jsonText);
  assert.equal((await q.readPairingRecoveryImage('new-synthetic-credential',newDraft.key,0)).data,'bmV3');
  assert.deepEqual(entries.filter(i=>i.kind==='send').map(i=>i.state).sort(),['completed','failed','uncertain']);
  assert.equal(JSON.stringify(entries).includes('bmV3'),false,'metadata never contains photo bytes');
  await assert.rejects(q.readPairingRecoveryText('ordinary-fresh-credential',newDraft.key));
  assert.equal(JSON.stringify(recovered).includes('commandId'),false);
  assert.equal(JSON.stringify(recovered).includes('intentToken'),false);
  assert.equal(JSON.stringify(recovered).includes('old-synthetic-credential'),false);
  assert.equal(JSON.stringify(recovered).includes('unrelated secret'),false);
  assert.equal(await q.readPairingRecovery('ordinary-fresh-credential'),null);
  q.setOfflineQueueNamespace(x.next);await q.maintainPendingSends(x.next);
  let sends=0;await q.flush(async()=>{sends++;throw Error('must not send')},{isTransient:()=>false,namespace:x.next});
  await q.flush(async()=>{sends++;throw Error('mismatched scope must not send')},{isTransient:()=>false,namespace:x.old});
  assert.equal(sends,0,'archive content never becomes replacement-scope outbox authority');
  assert.deepEqual(plain(x.memory.rows()),before);
  await q.clearPairingRecovery(x.next);
  assert.equal(await q.readPairingRecovery('new-synthetic-credential'),null);
  assert.equal(x.memory.rows('pairing-recovery-rows').length,0);
  assert.equal(x.memory.rows('pairing-recovery-chunks').length,0);
  assert.equal(x.w.localStorage.getItem(`omp-draft:${x.old}:/chat`),'chat draft');
});

test('capture and association failures reject before claiming work is preserved',async t=>{
  const x=await fixture(t),q=x.f.queue;
  x.w.localStorage.setItem(`omp-draft:${x.old}:/chat`,'keep me');
  x.memory.control.abortNextPut=true;
  await assert.rejects(q.capturePairingRecovery(x.old));
  assert.equal(x.w.localStorage.getItem('omp-remote-token'),'old-synthetic-credential');
  const saved=await q.capturePairingRecovery(x.old);
  x.memory.control.abortNextPut=true;
  await assert.rejects(q.bindPairingRecovery(saved,'new-synthetic-credential'));
  assert.equal(await q.readPairingRecovery('new-synthetic-credential'),null);
  await q.bindPairingRecovery(saved,'new-synthetic-credential');
  const entries=await q.readPairingRecoveryEntries('new-synthetic-credential');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',entries.items[0].key),'keep me');
});

test('native repair reads old-scope payloads before authorization changes and never imports them',async t=>{
  const x=await fixture(t),calls=[];
  let authorized=x.old;
  x.w.OmpNative={senderRequired:()=>true};
  x.w.OmpOutbox={postMessage(raw){const msg=JSON.parse(raw);calls.push(msg.op);queueMicrotask(()=>{
    const ok=msg.namespace===authorized&&['list','images'].includes(msg.op);
    const value=msg.op==='list'?[{commandId:'old-native-id',sessionPath:'/chat',text:'native retained',state:'uncertain'}]:[{data:'bmF0aXZl',mimeType:'image/png'}];
    x.w.OmpOutbox.onmessage({data:JSON.stringify({id:msg.id,ok,value,code:'scope',error:'old scope is no longer authorized'})});
  })},onmessage:null};
  const saved=await x.f.queue.capturePairingRecovery(x.old);
  await x.f.queue.bindPairingRecovery(saved,'new-synthetic-credential');
  authorized=x.next;
  const read=await x.f.queue.readPairingRecoveryEntries('new-synthetic-credential');
  const native=read.items.find(i=>i.preview==='native retained');
  assert.equal((await x.f.queue.readPairingRecoveryImage('new-synthetic-credential',native.key,0)).data,'bmF0aXZl');
  assert.equal(calls.every(op=>['list','images'].includes(op)),true);
  assert.equal(calls.includes('import'),false);
});

for(const transition of ['replacement-saved','repair-cancelled','disposed-and-resumed'])test(`late 401 cannot reject a different credential/generation: ${transition}`,async t=>{
  const x=await fixture(t),controller=x.controller();let reply;
  x.w.fetch=()=>new Promise(resolve=>{reply=resolve});
  const request=controller.loadSessions().catch(()=>{});
  await settleTask();
  if(transition==='replacement-saved')x.w.localStorage.setItem('omp-remote-token','new-synthetic-credential');
  if(transition==='repair-cancelled'){const cancel=controller.beginPairingRepair();cancel()}
  if(transition==='disposed-and-resumed'){controller.dispose();controller.resume()}
  reply(new Response('{}',{status:401}));await request;
  assert.equal(controller.getStore().getState().authRejected,false);
  if(transition==='replacement-saved')assert.equal(x.w.localStorage.getItem('omp-remote-token'),'new-synthetic-credential');
});

test('a genuine current-credential 401 remains actionable after repair cancellation',async t=>{
  const x=await fixture(t),controller=x.controller();
  const cancel=controller.beginPairingRepair();cancel();
  x.w.fetch=async()=>new Response('{}',{status:401});
  await assert.rejects(controller.loadSessions());
  assert.equal(controller.getStore().getState().authRejected,true);
  assert.equal(controller.rejectedCurrentCredential('old-synthetic-credential'),true);
  assert.equal(controller.rejectedCurrentCredential('new-synthetic-credential'),false);
});

test('an old native revoke queued after replacement is skipped; an in-flight revoke finishes before new acknowledgement',async t=>{
  const x=await fixture(t),events=[];let finishClear;
  x.w.OmpNative={senderRequired:()=>true};
  x.w.Capacitor={Plugins:{OmpNotify:{clearToken:()=>{events.push('clear');return new Promise(resolve=>{finishClear=resolve})},setToken:async({token})=>{events.push(token);return {ok:true}}}}};
  x.w.localStorage.setItem('omp-remote-token','new-synthetic-credential');
  await x.f.clearNativeNotificationToken('old-synthetic-credential');
  assert.deepEqual(events,[]);
  x.w.localStorage.setItem('omp-remote-token','old-synthetic-credential');
  const clearing=x.f.clearNativeNotificationToken('old-synthetic-credential');await settleTask();
  x.w.localStorage.setItem('omp-remote-token','new-synthetic-credential');
  const syncing=x.f.syncNativeNotificationToken('new-synthetic-credential');await settleTask();
  assert.deepEqual(events,['clear']);finishClear({ok:true});await Promise.all([clearing,syncing]);
  assert.deepEqual(events,['clear','new-synthetic-credential']);
});

test('preservation pages every existing draft without an artificial total-work cap or eager content reads',async t=>{
  const x=await fixture(t),q=x.f.queue;
  for(let index=0;index<1005;index++)x.w.localStorage.setItem(`omp-draft:${x.old}:/chat-${index}`,`draft ${index}`);
  x.memory.inject({storageKey:'cred-unrelated:/secret',namespace:'cred-unrelated',sessionPath:'/secret',images:[{data:'unrelated-photo',mimeType:'image/png'}]},'draft-attachments-v3');
  const readKeys=[];
  x.memory.control.beforeGet=(name,key)=>{if(name==='draft-attachments-v3')readKeys.push(key)};
  const saved=await q.capturePairingRecovery(x.old);
  assert.equal(saved.sources.at(-1).count,1005);
  await q.bindPairingRecovery(saved,'new-synthetic-credential');
  const chunksBefore=x.memory.calls.filter(call=>call.name==='pairing-recovery-chunks'&&call.type==='get').length;
  let offset=0,copied=0,latest=0;
  for(;;){const page=await q.readPairingRecoveryEntries('new-synthetic-credential',offset);assert.equal(page.items.length<=20,true);copied+=page.items.filter(item=>!item.browser).length;latest+=page.items.filter(item=>item.browser).length;if(page.next===null)break;offset=page.next}
  assert.equal(copied,1005);assert.equal(latest,1005);
  assert.equal(x.memory.calls.filter(call=>call.name==='pairing-recovery-chunks'&&call.type==='get').length,chunksBefore,'metadata paging reads no text/photo payloads');
  assert.equal(readKeys.some(key=>key.startsWith('cred-unrelated:')),false);
});

test('large saved text is durable in bounded parts without splitting a Unicode character',async t=>{
  const x=await fixture(t),q=x.f.queue;
  const text='a'.repeat(512*1024-1)+'😀'+'tail';
  x.w.localStorage.setItem(`omp-draft:${x.old}:/large`,text);
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  const item=(await q.readPairingRecoveryEntries('new-synthetic-credential')).items.find(item=>!item.browser);
  assert.equal(item.textParts,2);
  const first=await q.readPairingRecoveryText('new-synthetic-credential',item.key,0);
  const second=await q.readPairingRecoveryText('new-synthetic-credential',item.key,1);
  assert.equal(first+second,text);
  assert.equal(first.endsWith('a'),true);
  assert.equal(second.startsWith('😀'),true);
});

test('forget reclaims only unreferenced repair sources and retries interrupted chunk cleanup honestly',async t=>{
  const x=await fixture(t),q=x.f.queue;
  x.w.localStorage.setItem(`omp-draft:${x.old}:/chat`,'shared retained text');
  const saved=await q.capturePairingRecovery(x.old);
  await q.bindPairingRecovery(saved,'new-synthetic-credential');
  await q.bindPairingRecovery(saved,'second-deliberate-repair');
  await q.clearPairingRecovery(x.next);
  const second=(await q.readPairingRecoveryEntries('second-deliberate-repair')).items[0];
  assert.equal(await q.readPairingRecoveryText('second-deliberate-repair',second.key),'shared retained text');
  assert.equal(x.memory.rows('pairing-recovery-chunks').length>0,true);
  x.memory.control.beforeTransaction=(name,mode)=>{if(name==='pairing-recovery-chunks'&&mode==='readwrite')throw Error('synthetic storage denial')};
  const scope=q.offlineQueueNamespaceForCredential('second-deliberate-repair');
  await assert.rejects(q.clearPairingRecovery(scope));
  assert.equal(x.memory.rows('pairing-recovery').some(row=>row.key===`cleanup:${scope}`),true);
  x.memory.control.beforeTransaction=null;
  await q.clearPairingRecovery(scope);
  assert.equal(x.memory.rows('pairing-recovery-chunks').length,0);
  assert.equal(x.memory.rows('pairing-recovery-rows').length,0);
  assert.equal(x.memory.rows('pairing-recovery').some(row=>row.key===`cleanup:${scope}`),false);
  assert.equal(x.w.localStorage.getItem(`omp-draft:${x.old}:/chat`),'shared retained text');
});

test('repair-linked browser sources retain later draft/photo flushes and read-only sends without scope aliasing',async t=>{
  const x=await fixture(t),q=x.f.queue,controller=x.controller();
  x.w.localStorage.setItem(`omp-draft:${x.old}:/chat`,'before repair');
  await q.enqueue({namespace:x.old,sessionPath:'/chat',text:'already retained before cutover',images:[]});
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  x.w.localStorage.setItem('omp-remote-token','new-synthetic-credential');
  controller.fencePairingReplacement('new-synthetic-credential');
  assert.equal(q.getOfflineQueueNamespace(),x.next);
  await assert.rejects(controller.sendPrompt('must stay a draft',[], '/chat'));
  x.w.localStorage.setItem(`omp-draft:${x.old}:/chat`,'latest composer cleanup');
  x.w.localStorage.setItem(`omp-draft:${x.old}:new-session`,JSON.stringify({revision:'old-revision',text:'late new-session draft'}));
  await q.saveDraftAttachments('/late-photo',[{data:'bGF0ZQ==',mimeType:'image/png',name:'late',previewUrl:'blob:old'}],x.old);
  x.memory.inject({storageKey:`${x.old}:old-command-authority`,namespace:x.old,id:'old-command-authority',commandId:'old-command-authority',intentToken:'old-intent-authority',sessionPath:'/chat',text:'late retained send',images:[],state:'completed',createdAt:Date.now(),updatedAt:Date.now()});
  x.w.localStorage.setItem('omp-draft:cred-unrelated:/chat','unrelated text');
  const page=await q.readPairingRecoveryEntries('new-synthetic-credential');
  assert.equal(JSON.stringify(page).includes('old-command-authority'),false);
  assert.equal(JSON.stringify(page).includes('old-intent-authority'),false);
  assert.equal(JSON.stringify(page).includes('unrelated text'),false);
  const latest=page.items.find(item=>item.browser&&item.sessionPath==='/chat');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',latest.key),'latest composer cleanup');
  const fresh=page.items.find(item=>item.browser&&item.sessionPath==='new-session');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',fresh.key),'late new-session draft');
  const photo=page.items.find(item=>item.browser&&item.sessionPath==='/late-photo');
  const detail=await q.readPairingRecoveryEntry('new-synthetic-credential',photo.key);
  assert.equal(detail.images.length,1);assert.equal(JSON.stringify(detail).includes('bGF0ZQ=='),false);
  x.memory.control.beforeGet=(name,key)=>{if(name==='draft-attachments-v3'&&key===`${x.old}:/late-photo`)throw Error('synthetic read failure')};
  await assert.rejects(q.readPairingRecoveryImage('new-synthetic-credential',photo.key,0));
  x.memory.control.beforeGet=null;
  assert.equal((await q.readPairingRecoveryImage('new-synthetic-credential',photo.key,0)).data,'bGF0ZQ==');
  let send;
  for(const candidate of page.items.filter(item=>item.browser&&item.kind==='send')){
    if(await q.readPairingRecoveryText('new-synthetic-credential',candidate.key)==='late retained send')send=candidate;
  }
  assert.ok(send);
  assert.equal((await q.readPairingRecoveryEntry('new-synthetic-credential',send.key)).state,'completed');
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',send.key),'late retained send');
  await assert.rejects(q.readPairingRecoveryText('ordinary-fresh-credential',latest.key));
  let sends=0;await q.flush(async()=>{sends++;throw Error('old scope must not send')},{isTransient:()=>false,namespace:x.old});
  assert.equal(sends,0);
  await q.clearPairingRecovery(x.next);
  assert.equal(x.w.localStorage.getItem(`omp-draft:${x.old}:/chat`),'latest composer cleanup');
  assert.equal((await q.loadDraftAttachments('/late-photo',x.old))[0].data,'bGF0ZQ==');
});

test('a queued native handoff cannot overwrite a newer pairing or Forget',async t=>{
  const x=await fixture(t),events=[];let finishClear;
  x.w.OmpNative={senderRequired:()=>true};
  x.w.Capacitor={Plugins:{OmpNotify:{clearToken:()=>new Promise(resolve=>{finishClear=resolve}),setToken:async({token})=>{events.push(token);return {ok:true}}}}};
  const clearing=x.f.clearNativeNotificationToken();await settleTask();
  x.w.localStorage.setItem('omp-remote-token','new-synthetic-credential');
  const syncing=x.f.syncNativeNotificationToken('new-synthetic-credential');
  x.w.localStorage.removeItem('omp-remote-token');
  finishClear({ok:true});await clearing;
  await assert.rejects(syncing,/Pairing changed/);
  assert.deepEqual(events,[]);
});

test('known unavailable legacy photos retain recoverable text with an explicit missing-photo status',async t=>{
  const x=await fixture(t),q=x.f.queue;
  x.w.localStorage.setItem(`omp-pulse-queue-v3:${x.old}`,JSON.stringify([{commandId:'old-metadata-authority',sessionPath:'/chat',text:'recover this text',imageCount:1,state:'uncertain',createdAt:Date.now()}]));
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  const page=await q.readPairingRecoveryEntries('new-synthetic-credential');
  assert.equal(JSON.stringify(page).includes('old-metadata-authority'),false);
  const copy=page.items.find(item=>!item.browser);
  assert.equal(copy.missingImages,true);
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',copy.key),'recover this text');
  const latest=page.items.find(item=>item.browser);
  assert.equal((await q.readPairingRecoveryEntry('new-synthetic-credential',latest.key)).missingImages,true);
  assert.equal(await q.readPairingRecoveryText('new-synthetic-credential',latest.key),'recover this text');
  await assert.rejects(q.readPairingRecoveryImage('new-synthetic-credential',latest.key,0));
});

test('unexpected missing photo bytes block repair and a complete storage read can retry',async t=>{
  const x=await fixture(t),q=x.f.queue;
  const row={storageKey:`${x.old}:incomplete`,namespace:x.old,id:'incomplete',commandId:'incomplete',sessionPath:'/chat',text:'keep all photos',images:[],imageCount:1,droppedImages:false,state:'uncertain',createdAt:Date.now(),updatedAt:Date.now()};
  x.memory.inject(row);
  await assert.rejects(q.capturePairingRecovery(x.old),/photos could not be read/);
  assert.equal(x.w.localStorage.getItem('omp-remote-token'),'old-synthetic-credential');
  row.images=[{data:'cmVhZA==',mimeType:'image/png'}];x.memory.inject(row);
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  const copy=(await q.readPairingRecoveryEntries('new-synthetic-credential')).items.find(item=>!item.browser);
  assert.equal((await q.readPairingRecoveryImage('new-synthetic-credential',copy.key,0)).data,'cmVhZA==');
});

test('deliberate attachment export saves the original bytes and media type',async t=>{
  const x=await fixture(t),q=x.f.queue;let savedBlob,download;
  await q.saveDraftAttachments('/photo',[{data:'b3JpZ2luYWwgYnl0ZXM=',mimeType:'image/avif',name:'source',previewUrl:'blob:old'}],x.old);
  await q.bindPairingRecovery(await q.capturePairingRecovery(x.old),'new-synthetic-credential');
  const item=(await q.readPairingRecoveryEntries('new-synthetic-credential')).items.find(item=>!item.browser);
  x.w.URL.createObjectURL=blob=>{savedBlob=blob;return 'blob:synthetic-export'};
  x.w.URL.revokeObjectURL=()=>{};
  x.w.HTMLAnchorElement.prototype.click=function(){download=this.download};
  assert.equal(await q.savePairingRecoveryAttachment('new-synthetic-credential',item.key,0),true);
  assert.equal(download,'saved-attachment-1.avif');assert.equal(savedBlob.type,'image/avif');
  const buffer=await new Promise((resolve,reject)=>{const reader=new x.w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(savedBlob)});
  assert.equal(Buffer.from(buffer).toString(),'original bytes');
});
