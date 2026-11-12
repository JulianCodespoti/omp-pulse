import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';

// Real queue consumers, Composer, session owner and durable storage operations.
// Only HTTP/native delivery and IndexedDB's engine are synthetic boundaries.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act,useState,useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Composer} from ${JSON.stringify(resolve(root,'web/src/app/composer/Composer.tsx'))};
import {Notices} from ${JSON.stringify(resolve(root,'web/src/app/Notices.tsx'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {DaemonApi,sendPromptDurably} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
import {getAttachmentDraft} from ${JSON.stringify(resolve(root,'web/src/runtime/attachment-draft.ts'))};
import {getDraftNamespace,readDraft,seedDraft,flushAllDraftWrites} from ${JSON.stringify(resolve(root,'web/src/app/composer/use-draft.ts'))};
import {parseWithdrawnQueue} from ${JSON.stringify(resolve(root,'web/src/runtime/withdrawn-queue.ts'))};
import {restoreWithdrawnDraft} from ${JSON.stringify(resolve(root,'web/src/app/composer/withdrawn-draft.ts'))};
import {pendingIntentActions} from ${JSON.stringify(resolve(root,'web/src/runtime/browser-pending-actions.ts'))};
import {projectPendingIntents} from ${JSON.stringify(resolve(root,'web/src/runtime/browser-pending-presentation.ts'))};
import {usesNativeOutbox,acknowledgeNativeSave} from ${JSON.stringify(resolve(root,'web/src/runtime/native-outbox.ts'))};
import {MessageParts} from ${JSON.stringify(resolve(root,'web/src/app/parts/MessageParts.tsx'))};
import {bindUserRowStatus} from ${JSON.stringify(resolve(root,'web/src/runtime/user-row-status.ts'))};
DaemonApi.prototype.getPromptConfig=async()=>({magicKeywords:[]});
DaemonApi.prototype.transcribe=()=>new Promise(resolve=>window.fixture.finishTranscription=resolve);
DaemonApi.prototype.warmTranscriber=async()=>{};
const store=createOmpStore(), controller=Object.create(OmpSessionController.prototype);
Object.assign(controller,{store,activeSession:'/a',queueNamespace:getDraftNamespace(),generation:1,disposed:false,baseUrl:'http://synthetic.invalid',queueSeedTicket:null,queueRecoveryInFlight:new Set()});
queue.setOfflineQueueNamespace(getDraftNamespace());store.getState().beginSession('/a');
const requests=[],sends=[],commands=[],pickers=[];let setView;
controller.request=(path,init)=>new Promise((resolve,reject)=>requests.push({path,body:JSON.parse(init.body),resolve,reject}));
function App(){const [view,update]=useState({path:controller.activeSession,namespace:controller.queueNamespace});setView=update;
const entries=useSyncExternalStore(queue.subscribe,queue.getSnapshot,queue.getServerSnapshot);
const state=useSyncExternalStore(store.subscribe,store.getState,store.getState);
const projection=projectPendingIntents(state.messages,entries,view.path,view.namespace,controller,usesNativeOutbox()?'native':'browser',state.queuedMessages);
const statuses=bindUserRowStatus(projection.messages,entries,view.path,!usesNativeOutbox());
return h('div',null,h('section',{'data-testid':'projected-transcript'},projection.messages.map(message=>h(MessageParts,{key:message.id,message,sessionPath:view.path,rowStatus:statuses.get(message.id),localPendingEntry:projection.localEntries.get(message)}))),h(Composer,{key:view.namespace+view.path,sessionPath:view.path,controller,pendingSends:projection.pending,busy:true,
commands:[{name:'compact',description:'Compact conversation',source:'builtin',shape:'immediate'},{name:'model',description:'Choose model',source:'builtin',shape:'pick',picker:'model'}],
onRunCommand:command=>commands.push(command.name),onOpenPicker:picker=>pickers.push(picker),
onSend:async(...args)=>{sends.push(args);if(window.fixture.nativeSave){const [text,images,sessionPath,onSaved]=args;const entry=await queue.enqueue({text,images,sessionPath,namespace:getDraftNamespace()});if(await onSaved())acknowledgeNativeSave(entry,getDraftNamespace());}},onStop:()=>{}}),h(Notices));}
window.fixture={act,queue,controller,store,requests,sends,commands,pickers,getDraftNamespace,readDraft,seedDraft,flushAllDraftWrites,parseWithdrawnQueue,pendingIntentActions,projectPendingIntents,acknowledgeNativeSave,
durable:(path='/a',options={})=>sendPromptDurably(path,'recovered',[],{token:localStorage.getItem('omp-remote-token'),...options}),
owner:(path='/a',namespace=getDraftNamespace())=>getAttachmentDraft(namespace,path),
restore:(path,withdrawn,namespace=getDraftNamespace(),id)=>restoreWithdrawnDraft(path,withdrawn,namespace,id),
stop:()=>controller.abortTurn(controller.activeSession,(withdrawn,destination)=>restoreWithdrawnDraft(destination.sessionPath,withdrawn,destination.namespace)),
switch(path,token){flushAllDraftWrites();if(token!==undefined)localStorage.setItem('omp-remote-token',token);controller.activeSession=path;controller.queueNamespace=getDraftNamespace();controller.generation++;queue.setOfflineQueueNamespace(controller.queueNamespace);store.getState().beginSession(path);setView({path,namespace:controller.queueNamespace});},
mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r;}};
`);
const plain = value => JSON.parse(JSON.stringify(value));
const PHOTO = {data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==',mimeType:'image/png'};
const content = (texts=[],images=[],flags={}) => ({
  messages: (texts.length ? texts : images.length ? [''] : []).map((text,index)=>({text,images:index===0?images:[]})),
  imagesDropped:false,truncated:false,...flags,
});
const attachment = (id='existing') => ({...PHOTO,data:PHOTO.data+id,previewUrl:'data:image/png;base64,'+PHOTO.data,name:id+'.png',width:1,height:1});
async function fixture(t,{text='',images=[],native=false,storage=[],drafts=[],records=[],nativeEntries=[]}={}) {
  const dom=createDomFixture(code),w=dom.window,f=w.fixture;
  Object.assign(w,{Headers,TextEncoder,TextDecoder});
  w.Element.prototype.getAnimations=()=>[];w.HTMLElement.prototype.scrollIntoView=()=>{};
  const db=memoryIndexedDb();w.indexedDB=db.indexedDB;
  w.localStorage.setItem('omp-remote-token','synthetic-credential');
  for(const [key,value] of storage)w.localStorage.setItem(key,value);
  const namespace=f.getDraftNamespace();
  await f.queue.loadDraftAttachments('/fixture-schema',namespace);
  for(const row of drafts)db.inject(row,'draft-attachments-v3');
  for(const row of records)db.inject(row);
  f.controller.queueNamespace=namespace;f.queue.setOfflineQueueNamespace(namespace);
  if(text)f.seedDraft('/a',text,namespace);
  await f.queue.getQueued('absent',namespace);
  if(records.length)await f.queue.flush(()=>{throw Error('Reserved records must not dispatch')},{namespace,isTransient:()=>false});
  if(images.length)await f.queue.saveDraftAttachments('/a',images,namespace);
  const nativeRows=new Map(nativeEntries),bridgeCalls=[];let failFinish=false,holdFinish=false,finish;
  if(native){w.OmpOutbox={onmessage:null,postMessage(raw){const call=JSON.parse(raw);bridgeCalls.push(call);let value;
    const row=nativeRows.get(call.commandId);
    if(call.namespace!==namespace)value=call.op==='list'?[]:null;
    else if(call.op==='list')value=[...nativeRows.values()].map(({images,...entry})=>entry);
    else if(call.op==='wake')value=true;
    else if(call.op==='enqueue'){const command=call.command,images=command.images??[];const entry={...command,id:command.commandId,imageCount:images.length,imageBytes:images.reduce((n,image)=>n+image.data.length,0),droppedImages:false,createdAt:Date.now(),updatedAt:Date.now()};nativeRows.set(entry.commandId,{...entry,images});value=entry;}
    else if(call.op==='get')value=row?(({images,...entry})=>entry)(row):null;
    else if(call.op==='images')value=row?.images??[];
    else if(call.op==='edit_begin'){
      if(!row||row.state!=='saved'||row.updatedAt!==call.expected.updatedAt)value=null;
      else {row.editToken??='reservation:'+row.commandId;const {images,...entry}=row;value={editToken:row.editToken,entry,images};}
    }else if(call.op==='edit_finish'){
      const finalize=()=>{
        if(failFinish){failFinish=false;w.queueMicrotask(()=>w.OmpOutbox.onmessage({data:JSON.stringify({id:call.id,ok:false,error:'Synthetic acknowledgement failure',code:'unconfirmed'})}));return;}
        const value={finished:!!row&&row.editToken===call.editToken};if(value.finished)nativeRows.delete(call.commandId);
        w.queueMicrotask(()=>w.OmpOutbox.onmessage({data:JSON.stringify({id:call.id,ok:true,value})}));
      };
      if(holdFinish){holdFinish=false;finish=finalize;}else finalize();
      return;
    }else if(call.op==='remove'){
      value={removed:!!row&&row.state===call.expected.state&&row.updatedAt===call.expected.updatedAt&&row.editToken===call.expected.editToken};
      if(value.removed)nativeRows.delete(call.commandId);
    }else throw Error('Unexpected native operation '+call.op);
    w.queueMicrotask(()=>w.OmpOutbox.onmessage({data:JSON.stringify({id:call.id,ok:true,value})}));
  }};}
  Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
  w.MediaRecorder=class{state='inactive';mimeType='audio/webm';start(){this.state='recording'}stop(){this.state='inactive';this.ondataavailable?.({data:new w.Blob(['synthetic audio'],{type:this.mimeType})});this.onstop?.(new w.Event('stop'))}};
  w.fixture.finishTranscription=null;
  w.fixture.transcribe=words=>{assert.equal(typeof w.fixture.finishTranscription,'function');w.fixture.finishTranscription(words)};
  let mounted;
  const act=async run=>{await f.act(async()=>{await run?.()});await f.act(async()=>{await new Promise(resolve=>w.setTimeout(resolve,0))})};
  await act(()=>{mounted=f.mount()});
  const input=()=>w.document.querySelector('textarea[name="message"]');
  const type=(text,dispatch=true)=>act(()=>{Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(input(),text);if(dispatch)input().dispatchEvent(new w.Event('input',{bubbles:true}))});
  const click=label=>act(()=>{const button=w.document.querySelector('button[aria-label="'+label+'"]');assert.ok(button,label);button.click()});
  const photos=()=>[...w.document.querySelectorAll('[data-testid="attachment-strip"] img')].map(image=>image.getAttribute('src'));
  const seed=async(id,text,images=[])=>{
    if(!native)return f.queue.enqueue({commandId:id,sessionPath:'/a',text,images,namespace});
    const row={id,commandId:id,sessionPath:'/a',text,imageCount:images.length,imageBytes:images.reduce((n,image)=>n+image.data.length,0),droppedImages:false,createdAt:1,updatedAt:1,state:'saved',images};nativeRows.set(id,row);
    await f.queue.getQueued(id,namespace);await f.queue.flush(()=>{throw Error('Native must not use browser dispatch')},{namespace,isTransient:()=>false});return f.queue.getQueued(id,namespace);
  };
  t.after(async()=>{try{await f.act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  return {w,f,db,namespace,act,input,type,click,photos,seed,nativeRows,bridgeCalls,failFinish:()=>{failFinish=true},
    holdFinish:()=>{holdFinish=true},releaseFinish:()=>{assert.equal(typeof finish,'function');const release=finish;finish=null;release()},
    savedImages:(path='/a',scope=namespace)=>f.queue.loadDraftAttachments(path,scope),
    remount:()=>act(()=>{mounted.unmount();mounted=f.mount()}),
    exportStorage:()=>Array.from({length:w.localStorage.length},(_,index)=>{const key=w.localStorage.key(index);return [key,w.localStorage.getItem(key)]}),
  };
}

test('withdrawn contract keeps whitespace, photo-only entries and only actual loss flags',async t=>{
  const c=await fixture(t);
  const raw=content([' exact \n  ','',3],[PHOTO,{bad:true}]);
  const parsed=plain(c.f.parseWithdrawnQueue(raw));
  assert.deepEqual(parsed.messages,content([' exact \n  ',''],[PHOTO]).messages);
  assert.equal(parsed.imagesDropped,false);
  assert.equal(parsed.truncated,false);
});

test('owner recovery is acknowledged after durable photos and duplicate replay does not duplicate a draft',async t=>{
  const c=await fixture(t,{text:'Saved'});
  const record={id:'1'.repeat(32),kind:'message',sessionPath:'/a',itemId:'item-1',data:{removed:true,text:'Withdrawn [Image 1]',images:[PHOTO]}};
  let replay;await c.act(()=>{replay=c.f.controller.recoverWithdrawnQueue('/a')});
  assert.equal(c.f.requests[0].body.command,'get_queue_recovery');
  await c.act(()=>c.f.requests[0].resolve({ok:true,data:{recoveries:[record],hasMore:false}}));
  assert.equal(c.input().value,'Withdrawn [Image 1]\n\nSaved');
  assert.equal((await c.savedImages())[0].data,PHOTO.data);
  assert.equal(c.f.requests[1].body.command,'acknowledge_queue_recovery');
  assert.equal(c.f.requests[1].body.params.recoveryId,record.id);
  await c.act(async()=>{c.f.requests[1].reject(Error('Lost acknowledgement'));await replay});
  await c.act(()=>{replay=c.f.controller.recoverWithdrawnQueue('/a')});
  await c.act(()=>c.f.requests[2].resolve({ok:true,data:{recoveries:[record],hasMore:false}}));
  await c.act(async()=>{c.f.requests[3].resolve({ok:true,data:{acknowledged:true}});await replay});
  await c.remount();
  assert.equal(c.input().value,'Withdrawn [Image 1]\n\nSaved');
  assert.deepEqual(Array.from(await c.savedImages(),image=>image.data),[PHOTO.data]);
  assert.equal(c.f.sends.length,0);
});

test('failed photo persistence keeps the owner recovery unacknowledged until a successful retry',async t=>{
  const c=await fixture(t);
  const record={id:'2'.repeat(32),kind:'message',sessionPath:'/a',itemId:'item-2',data:{removed:true,text:'Keep [Image 1]',images:[PHOTO]}};
  c.db.control.beforeTransaction=(name,mode)=>{if(name==='draft-attachments-v3'&&mode==='readwrite')throw Error('Storage unavailable')};
  let replay;await c.act(()=>{replay=c.f.controller.recoverWithdrawnQueue('/a')});
  await c.act(async()=>{c.f.requests[0].resolve({ok:true,data:{recoveries:[record],hasMore:false}});await replay});
  assert.equal(c.f.requests.some(request=>request.body.command==='acknowledge_queue_recovery'),false);
  c.db.control.beforeTransaction=undefined;
  await c.act(()=>{replay=c.f.controller.recoverWithdrawnQueue('/a')});
  await c.act(()=>c.f.requests[1].resolve({ok:true,data:{recoveries:[record],hasMore:false}}));
  assert.equal((await c.savedImages())[0].data,PHOTO.data);
  assert.equal(c.f.requests[2].body.command,'acknowledge_queue_recovery');
  await c.act(async()=>{c.f.requests[2].resolve({ok:true,data:{acknowledged:true}});await replay});
  assert.equal(c.input().value,'Keep [Image 1]');
  assert.equal(c.f.sends.length,0);
});

test('queued Edit acknowledges its journal record only once the draft is saved',async t=>{
  const c=await fixture(t,{text:'My draft'});
  await c.act(()=>c.f.store.getState().setQueuedMessages({steering:['x'],followUp:[],liveSteered:0,steeringIds:['edit-source'],followUpIds:[]}));
  await c.click('Edit');
  assert.equal(c.f.requests[0].body.params.itemId,'edit-source');
  await c.act(()=>c.f.requests[0].resolve({data:{removed:true,text:'back',images:[PHOTO],recoveryId:'3'.repeat(32)}}));
  assert.equal(c.input().value,'back\n\nMy draft');
  assert.equal((await c.savedImages())[0].data,PHOTO.data);
  assert.equal(c.f.requests[1].body.command,'acknowledge_queue_recovery');
  assert.equal(c.f.requests[1].body.params.recoveryId,'3'.repeat(32));
});

test('a discarded queued message whose record overflowed the reply is acknowledged without restoring',async t=>{
  const c=await fixture(t);
  let removal;await c.act(()=>{removal=c.f.controller.removeQueuedMessage('steering','x','item-9',false)});
  assert.equal(c.f.requests[0].body.params.itemId,'item-9');
  await c.act(()=>c.f.requests[0].resolve({data:{recoveryId:'4'.repeat(32),recoveryPending:true}}));
  assert.equal(c.f.requests[1].body.command,'acknowledge_queue_recovery');
  assert.equal(c.f.requests[1].body.params.recoveryId,'4'.repeat(32));
  await c.act(async()=>{c.f.requests[1].resolve({ok:true,data:{acknowledged:true}});await removal});
  assert.equal(c.input().value,'');assert.equal(c.f.sends.length,0);
});

for(const texts of [[],[' queued \n exact  ']])test('Stop restores original photos and current native input, text='+texts.length,async t=>{
  const c=await fixture(t,{text:'saved',images:[attachment()]});
  await c.type('IME not yet delivered',false);
  let stopped;await c.act(()=>{stopped=c.f.stop()});
  assert.equal(c.f.requests[0].path,'/api/abort');
  await c.act(async()=>{c.f.requests[0].resolve({stopped:true,withdrawn:content(texts,[PHOTO])});await stopped});
  assert.equal(c.input().value,texts.length?texts[0]+'\n\nIME not yet delivered':'IME not yet delivered');
  assert.equal(c.photos().length,2);assert.equal(c.photos()[1],'data:image/png;base64,'+PHOTO.data);
  const saved=plain(await c.savedImages());assert.equal(saved[1].data,PHOTO.data);assert.equal(saved[1].width,undefined);assert.equal(saved[1].height,undefined);
  await c.remount();assert.equal(c.photos().length,2);assert.equal(c.f.sends.length,0);
});

for(const credentialSwitch of [false,true])test('late Stop restores original saved scope, credential switch='+credentialSwitch,async t=>{
  const c=await fixture(t,{text:'Draft A'}),original=c.namespace;
  let stopped;await c.act(()=>{stopped=c.f.stop()});
  await c.act(()=>c.f.switch('/b',credentialSwitch?'different-credential':undefined));await c.type('Draft B');
  await c.act(async()=>{c.f.requests[0].resolve({stopped:true,withdrawn:content(['For A'],[PHOTO])});await stopped});
  assert.equal(c.input().value,'Draft B');assert.equal(c.photos().length,0);
  assert.equal(c.f.readDraft('/a',original),'For A\n\nDraft A');assert.equal((await c.savedImages('/a',original))[0].data,PHOTO.data);
  assert.equal(c.f.readDraft('/a',c.f.getDraftNamespace()),credentialSwitch?'':'For A\n\nDraft A');assert.equal(c.f.sends.length,0);
});

for(const text of ['', 'selector'])test('native queue Edit consumes original response photos and transformed text, displayed='+JSON.stringify(text),async t=>{
  const c=await fixture(t,{text:'My draft'});
  await c.act(()=>c.f.store.getState().setQueuedMessages({steering:[text],followUp:[],liveSteered:0,steeringIds:['edit-source'],followUpIds:[]}));
  await c.click('Edit');
  await c.act(()=>c.f.requests[0].resolve({data:{removed:true,text:' original transformed ',images:[PHOTO]}}));
  assert.equal(c.input().value,' original transformed \n\nMy draft');assert.equal(c.photos().length,1);assert.equal((await c.savedImages())[0].data,PHOTO.data);assert.equal(c.f.sends.length,0);
});

test('late queued Edit saves the source draft after navigation instead of overwriting the current composer',async t=>{
  const c=await fixture(t,{text:'A'});
  await c.act(()=>c.f.store.getState().setQueuedMessages({steering:[],followUp:['selector'],liveSteered:0,steeringIds:[],followUpIds:['edit-source']}));
  await c.click('Edit');await c.act(()=>c.f.switch('/b'));await c.type('B');
  await c.act(()=>c.f.requests[0].resolve({data:{removed:true,images:[PHOTO]}}));
  assert.equal(c.input().value,'B');assert.equal(c.photos().length,0);assert.equal(c.f.readDraft('/a',c.namespace),'selector\n\nA');assert.equal((await c.savedImages('/a'))[0].data,PHOTO.data);
});

for(const native of [false,true])test('saved photo outbox Edit transfers durably and never dispatches, native='+native,async t=>{
  const c=await fixture(t,{text:'Existing',images:[attachment()],native});
  await c.act(()=>c.seed('saved-photo','  saved exact  ',[PHOTO]));
  await c.click('Edit');
  assert.equal(c.input().value,'  saved exact  \n\nExisting');assert.equal(c.photos().length,2);assert.equal(await c.f.queue.getQueued('saved-photo',c.namespace),null);
  assert.equal((await c.savedImages())[1].data,PHOTO.data);assert.equal(c.f.sends.length,0);
  await c.remount();assert.equal(c.photos().length,2);
});

test('photo-only saved browser outbox Edit merges without introducing text',async t=>{
  const c=await fixture(t,{text:'kept'});await c.act(()=>c.seed('image-only','',[PHOTO]));await c.click('Edit');
  assert.equal(c.input().value,'kept');assert.equal(c.photos().length,1);assert.equal(await c.f.queue.getQueued('image-only',c.namespace),null);assert.equal(c.f.sends.length,0);
});

test('a failed send is edited back into the composer with its photos, and its row goes',async t=>{
  const c=await fixture(t,{text:'kept',native:true});let entry;
  await c.act(async()=>{entry=await c.seed('failed-native','Lost words',[PHOTO]);Object.assign(c.nativeRows.get(entry.commandId),{state:'failed',error:'agent_rejected: Synthetic refusal'});await c.f.queue.flush(()=>{throw Error('No browser dispatch')},{namespace:c.namespace,isTransient:()=>false})});
  assert.match(c.w.document.body.textContent,/This message wasn’t sent\./);
  await c.click('Edit');
  assert.equal(c.input().value,'Lost words\n\nkept');assert.equal(c.photos().length,1);
  assert.equal(c.nativeRows.has(entry.commandId),false);assert.equal(c.f.sends.length,0);
});

test('over-capacity recovery retains every photo through remount and blocks Send until reduced',async t=>{
  const c=await fixture(t,{images:Array.from({length:8},(_,i)=>attachment(String(i)))});
  await c.act(()=>c.f.restore('/a',content([],[PHOTO])));assert.equal(c.photos().length,9);
  assert.match(c.w.document.body.textContent,/too large to send/);await c.click('Send');assert.equal(c.f.sends.length,0);assert.equal((await c.savedImages()).length,9);
  await c.remount();assert.equal(c.photos().length,9);assert.equal(c.f.sends.length,0);
});

test('failed draft persistence keeps original outbox bytes reserved and visible; retry is idempotent',async t=>{
  const c=await fixture(t,{text:'kept'});await c.act(()=>c.seed('retry','queued',[PHOTO]));
  let failed=false;c.db.control.beforeTransaction=(name,mode)=>{if(name==='draft-attachments-v3'&&mode==='readwrite'&&!failed){failed=true;c.db.control.abortNextPut=true}};
  await c.click('Edit');assert.equal(failed,true);assert.equal(c.photos().length,1);assert.equal(c.input().value,'queued\n\nkept');
  const reserved=await c.f.queue.getQueued('retry',c.namespace);assert.ok(reserved.editToken);assert.equal((await c.f.queue.getImages('retry',c.namespace))[0].data,PHOTO.data);
  assert.match(c.w.document.body.textContent,/storage|transaction|abort/i);
  let sends=0;await c.f.queue.flush(()=>{sends++;throw Error('Reserved must not dispatch')},{namespace:c.namespace,isTransient:()=>false});assert.equal(sends,0);
  await c.click('Edit');assert.equal(c.photos().length,1);assert.equal(c.input().value,'queued\n\nkept');assert.equal(await c.f.queue.getQueued('retry',c.namespace),null);assert.equal((await c.savedImages()).length,1);
});

test('failed browser source removal fences cleanup and survives a fresh owner registry',async t=>{
  const c=await fixture(t,{text:'kept'});await c.act(()=>c.seed('browser-finish','queued',[PHOTO]));
  let failed=false;
  c.db.control.beforeTransaction=(name,mode)=>{
    if(!failed&&name==='commands-v3'&&mode==='readwrite'&&c.db.rows('draft-attachments-v3').some(row=>row.images.some(image=>image.recoveryId))){
      failed=true;throw Error('Synthetic source deletion failure');
    }
  };
  await c.click('Edit');assert.equal(failed,true);assert.equal(c.input().value,'queued\n\nkept');assert.equal(c.photos().length,1);
  assert.ok((await c.f.queue.getQueued('browser-finish',c.namespace)).editToken);
  await c.click('Send');assert.equal(c.f.sends.length,0);assert.equal(c.input().value,'queued\n\nkept');assert.equal(c.photos().length,1);
  await assert.rejects(c.f.durable(),/edit|finish|recover|reserv/i);
  const d=await fixture(t,{storage:c.exportStorage(),drafts:c.db.rows('draft-attachments-v3'),records:c.db.rows()});
  await d.click('Send');assert.equal(d.f.sends.length,0);
  await d.click('Edit');assert.equal(d.input().value,'queued\n\nkept');assert.equal(d.photos().length,1);assert.equal(await d.f.queue.getQueued('browser-finish',d.namespace),null);
  await d.click('Send');assert.equal(d.f.sends.length,1);assert.equal(d.input().value,'');assert.equal(d.photos().length,0);
  await d.remount();assert.equal(d.f.sends.length,1);assert.equal(d.input().value,'');assert.equal(d.photos().length,0);
});

for(const native of [false,true])test('canceling a reserved source leaves its recovered draft sendable, native='+native,async t=>{
  const c=await fixture(t,{text:'kept',native});await c.act(()=>c.seed('cancel-reservation','queued',[PHOTO]));
  if(native)c.failFinish();
  else {
    let failed=false;
    c.db.control.beforeTransaction=(name,mode)=>{if(name==='draft-attachments-v3'&&mode==='readwrite'&&!failed){failed=true;c.db.control.abortNextPut=true}};
  }
  await c.click('Edit');await c.click('Send');assert.equal(c.f.sends.length,0);
  const actions=c.f.pendingIntentActions(await c.f.queue.getQueued('cancel-reservation',c.namespace));
  await c.act(async()=>{assert.equal(await actions.cancel(),true)});
  assert.equal(await c.f.queue.getQueued('cancel-reservation',c.namespace),null);
  await c.click('Send');assert.equal(c.f.sends.length,1);assert.equal(c.f.sends[0][0],'queued\n\nkept');assert.equal(c.f.sends[0][1].length,1);
  assert.equal(c.input().value,'');assert.equal(c.photos().length,0);
});

test('failed native finalization fences send cleanup through reload until Edit finishes once',async t=>{
  const c=await fixture(t,{text:'kept',native:true});await c.act(()=>c.seed('ack','queued',[PHOTO]));c.failFinish();await c.click('Edit');
  assert.ok(c.nativeRows.get('ack').editToken);assert.equal(c.photos().length,1);
  await c.click('Send');assert.equal(c.f.sends.length,0);assert.equal(c.input().value,'queued\n\nkept');
  assert.equal((await c.savedImages()).length,1);
  await assert.rejects(c.f.durable(),/edit|finish|recover|reserv/i);
  await assert.rejects(c.f.durable('/a',{commandId:'ack'}),/edit|finish|recover|reserv/i);
  // A new JS owner registry sees only persisted text/photos and native source.
  const d=await fixture(t,{native:true,storage:c.exportStorage(),drafts:c.db.rows('draft-attachments-v3'),nativeEntries:[['ack',plain(c.nativeRows.get('ack'))]]});
  await d.act(()=>d.f.queue.flush(()=>{throw Error('No browser dispatch')},{namespace:d.namespace,isTransient:()=>false}));
  await d.click('Send');assert.equal(d.f.sends.length,0);assert.equal(d.input().value,'queued\n\nkept');assert.equal(d.photos().length,1);
  const stale=d.f.pendingIntentActions(await d.f.queue.getQueued('ack',d.namespace));
  await d.click('Edit');assert.equal(d.photos().length,1);assert.equal(d.input().value,'queued\n\nkept');assert.equal(d.nativeRows.has('ack'),false);
  await d.click('Send');assert.equal(d.f.sends.length,1);assert.equal(d.f.sends[0][0],'queued\n\nkept');assert.equal(d.f.sends[0][1].length,1);
  assert.equal(d.input().value,'');assert.equal(d.photos().length,0);assert.equal((await d.savedImages()).length,0);
  let transfers=0;assert.equal(await stale.edit(async()=>{transfers++}),false);assert.equal(transfers,0);
  await d.remount();assert.equal(d.input().value,'');assert.equal(d.photos().length,0);assert.equal(d.f.sends.length,1);
});

test('delayed native finalization blocks the recovered draft, not another session',async t=>{
  const c=await fixture(t,{text:'kept',native:true});await c.act(()=>c.seed('delayed','queued',[PHOTO]));c.holdFinish();await c.click('Edit');
  assert.equal(c.f.owner().getSnapshot().pending,0);assert.ok(c.nativeRows.get('delayed').editToken);
  await c.click('Send');assert.equal(c.f.sends.length,0);assert.equal(c.input().value,'queued\n\nkept');assert.equal(c.photos().length,1);
  await c.act(()=>c.f.switch('/b'));await c.type('unrelated');await c.click('Send');
  assert.equal(c.f.sends.length,1);assert.equal(c.f.sends[0][2],'/b');assert.equal(c.input().value,'');
  await c.act(()=>c.f.switch('/a'));assert.equal(c.input().value,'queued\n\nkept');
  await c.click('Send');assert.equal(c.f.sends.length,1);
  await c.act(()=>c.releaseFinish());assert.equal(c.nativeRows.has('delayed'),false);
  await c.click('Send');assert.equal(c.f.sends.length,2);assert.equal(c.f.sends[1][0],'queued\n\nkept');assert.equal(c.f.sends[1][1].length,1);
  await c.remount();assert.equal(c.input().value,'');assert.equal(c.photos().length,0);
});

test('dictation Insert and send cannot clear a reserved recovered draft',async t=>{
  const c=await fixture(t,{text:'kept',native:true});await c.act(()=>c.seed('spoken','queued',[PHOTO]));c.failFinish();await c.click('Edit');
  await c.act(()=>c.w.document.querySelector('[data-testid="voice-button"]').click());
  assert.ok(c.w.document.querySelector('[data-testid="dictation-send"]'));
  await c.act(()=>c.w.document.querySelector('[data-testid="dictation-send"]').click());
  await c.act(()=>c.f.transcribe('spoken words'));
  assert.equal(c.f.sends.length,0);assert.equal(c.input().value,'queued\n\nkept spoken words');assert.equal(c.photos().length,1);
  await c.click('Edit');assert.equal(c.input().value,'queued\n\nkept spoken words');assert.equal(c.photos().length,1);
  await c.click('Send');assert.equal(c.f.sends.length,1);assert.equal(c.f.sends[0][0],'queued\n\nkept spoken words');assert.equal(c.input().value,'');assert.equal(c.photos().length,0);
});

test('dispatch and stale intent fences forbid editing or deleting a claimed/replaced send',async t=>{
  const c=await fixture(t);let row;await c.act(async()=>{row=await c.seed('claim','queued',[PHOTO])});const actions=c.f.pendingIntentActions(row);
  await c.act(()=>c.f.queue.update('claim',{state:'dispatching'},c.namespace));assert.equal(c.w.document.querySelector('button[aria-label="Edit"]'),null);
  let transfers=0;assert.equal(await actions.edit(async()=>{transfers++}),false);assert.equal(await actions.cancel(),false);assert.equal(transfers,0);assert.equal((await c.f.queue.getImages('claim',c.namespace))[0].data,PHOTO.data);
});

test('upstream loss flags stay visible, including a flags-only Stop reply',async t=>{
  const c=await fixture(t);const notice=await c.f.restore('/a',content([],[],{imagesDropped:true,truncated:true}));assert.match(notice,/photos could not be recovered/);assert.match(notice,/too large/);assert.equal(c.f.sends.length,0);
});

test('identical queued and drafted text remain distinct; only the same recovery ID is a replay',async t=>{
  const c=await fixture(t,{text:'same'});
  await c.act(()=>c.f.restore('/a',content(['same'],[PHOTO]),c.namespace,'same-transfer'));
  assert.equal(c.input().value,'same\n\nsame');
  await c.act(()=>c.f.restore('/a',content(['same'],[PHOTO]),c.namespace,'same-transfer'));
  assert.equal(c.input().value,'same\n\nsame');assert.equal(c.photos().length,1);
});

test('credential retirement while edit reservation waits preserves the sole saved photo copy',async t=>{
  const c=await fixture(t);let row;await c.act(async()=>{row=await c.seed('retired','queued',[PHOTO])});
  const actions=c.f.pendingIntentActions(row);let release,transfers=0,held=false;
  // Delay the reservation acquisition only. Later hydration/inspection uses
  // the same Web Locks API and must not become a second unreleased gate.
  Object.defineProperty(c.w.navigator,'locks',{configurable:true,value:{request(_name,_options,run){
    if(held)return run();
    held=true;return new Promise((resolve,reject)=>{release=()=>Promise.resolve().then(run).then(resolve,reject)});
  }}});
  let editing;await c.act(()=>{editing=actions.edit(async()=>{transfers++})});assert.equal(typeof release,'function');
  await c.act(()=>c.f.switch('/b','other-credential'));await c.type('B draft');release();
  assert.equal(await editing,false);assert.equal(transfers,0);assert.equal(c.input().value,'B draft');
  assert.equal((await c.f.queue.getImages('retired',c.namespace))[0].data,PHOTO.data);assert.equal((await c.f.queue.getQueued('retired',c.namespace)).editToken,undefined);assert.equal(c.f.sends.length,0);
});

test('a declined queued Edit leaves the current text and photo draft untouched',async t=>{
  const c=await fixture(t,{text:'kept',images:[attachment()]});
  await c.act(()=>c.f.store.getState().setQueuedMessages({steering:['delivered'],followUp:[],liveSteered:0,steeringIds:['edit-source'],followUpIds:[]}));
  await c.click('Edit');await c.type('kept plus typing');
  await c.act(()=>c.f.requests[0].resolve({data:{removed:false}}));
  assert.equal(c.input().value,'kept plus typing');assert.equal(c.photos().length,1);assert.equal((await c.savedImages())[0].name,'existing.png');assert.equal(c.f.sends.length,0);
});

test('text storage failure keeps the merged text and photos visible and the original outbox reserved',async t=>{
  const c=await fixture(t,{text:'kept'});await c.act(()=>c.seed('text-failure','queued',[PHOTO]));
  const original=c.w.Storage.prototype.setItem;
  c.w.Storage.prototype.setItem=function(key,value){if(key.startsWith('omp-draft:'))throw new c.w.Error('Synthetic draft text storage full');return original.call(this,key,value)};
  t.after(()=>{c.w.Storage.prototype.setItem=original});
  await c.click('Edit');assert.equal(c.input().value,'queued\n\nkept');assert.equal(c.photos().length,1);
  assert.ok((await c.f.queue.getQueued('text-failure',c.namespace)).editToken);assert.equal((await c.f.queue.getImages('text-failure',c.namespace))[0].data,PHOTO.data);
  assert.match(c.w.document.body.textContent,/Could not save|storage full/);
  c.w.Storage.prototype.setItem=original;
  await c.click('Edit');assert.equal(c.input().value,'queued\n\nkept');assert.equal(c.photos().length,1);assert.equal(await c.f.queue.getQueued('text-failure',c.namespace),null);assert.equal(c.f.readDraft('/a',c.namespace),'queued\n\nkept');
});

test('queued Edit remaps owned image/video labels and links without changing existing draft references',async t=>{
  const c=await fixture(t,{text:'Existing [Image #1]',images:[attachment()]});
  await c.act(()=>c.f.store.getState().setQueuedMessages({steering:['queued'],followUp:[],liveSteered:0,steeringIds:['edit-source'],followUpIds:[]}));
  await c.click('Edit');
  const second={data:PHOTO.data+'second',mimeType:'image/jpeg'};
  await c.act(()=>c.f.requests[0].resolve({data:{removed:true,
    text:' [Image #1, 12x34] attachment://1 then [Video #2] attachment://2; earlier [Image #9] and [Paste #1] ',
    images:[PHOTO,second]}}));
  const expected=' [Image #2, 12x34] attachment://2 then [Video #3] attachment://3; earlier [Image #9] and [Paste #1] \n\nExisting [Image #1]';
  assert.equal(c.input().value,expected);
  assert.deepEqual(plain(await c.savedImages()).map(image=>image.data),[attachment().data,PHOTO.data,second.data]);
  await c.click('Send');
  assert.equal(c.f.sends[0][0],expected);
  assert.deepEqual(plain(c.f.sends[0][1]).map(image=>image.data),[attachment().data,PHOTO.data,second.data]);
});

test('Stop retains per-message numbering across photo-only and text-only queued entries',async t=>{
  const c=await fixture(t,{text:'Draft [Image #1]',images:[attachment()]});
  const first={data:PHOTO.data+'first',mimeType:'image/png'};
  let stopped;await c.act(()=>{stopped=c.f.stop()});
  await c.act(async()=>{
    c.f.requests[0].resolve({stopped:true,withdrawn:{messages:[
      {text:'',images:[first]},
      {text:'Compare [Image #1] attachment://1 and prior [Image #2]',images:[PHOTO]},
      {text:'Earlier conversation [Image #1]',images:[]},
    ],imagesDropped:false,truncated:false}});
    await stopped;
  });
  assert.equal(c.input().value,'\n\nCompare [Image #3] attachment://3 and prior [Image #2]\n\nEarlier conversation [Image #1]\n\nDraft [Image #1]');
  assert.deepEqual(plain(await c.savedImages()).map(image=>image.data),[attachment().data,first.data,PHOTO.data]);
  await c.remount();
  assert.equal(c.input().value.includes('Compare [Image #3] attachment://3'),true);
  assert.equal(c.f.sends.length,0);
});

for(const native of [false,true])test('numbered saved recovery survives source-finalization failure and reload, native='+native,async t=>{
  const c=await fixture(t,{text:'Draft [Image #1]',images:[attachment()],native});
  await c.act(()=>c.seed('numbered','Queued [Image #1] attachment://1',[PHOTO]));
  if(native)c.failFinish();
  else {
    let failed=false;
    c.db.control.beforeTransaction=(name,mode)=>{
      if(!failed&&name==='commands-v3'&&mode==='readwrite'&&c.db.rows('draft-attachments-v3').some(row=>row.images.some(image=>image.recoveryId))){
        failed=true;throw Error('Synthetic source deletion failure');
      }
    };
  }
  await c.click('Edit');
  const expected='Queued [Image #2] attachment://2\n\nDraft [Image #1]';
  assert.equal(c.input().value,expected);
  const d=await fixture(t,{native,storage:c.exportStorage(),drafts:c.db.rows('draft-attachments-v3'),
    records:native?[]:c.db.rows(),nativeEntries:native?[['numbered',plain(c.nativeRows.get('numbered'))]]:[]});
  if(native)await d.act(()=>d.f.queue.flush(()=>{throw Error('No browser dispatch')},{namespace:d.namespace,isTransient:()=>false}));
  await d.click('Edit');
  assert.equal(d.input().value,expected);
  assert.deepEqual(plain(await d.savedImages()).map(image=>image.data),[attachment().data,PHOTO.data]);
  await d.click('Send');
  assert.equal(d.f.sends.length,1);
  assert.equal(d.f.sends[0][0],expected);
  assert.deepEqual(plain(d.f.sends[0][1]).map(image=>image.data),[attachment().data,PHOTO.data]);
});

for(const nativeInput of [false,true])test('removing an earlier photo renumbers only recovered references through input and remount, native input='+nativeInput,async t=>{
  const c=await fixture(t,{text:'Prior conversation [Image #2] attachment://2',images:[attachment('A')]});
  await c.act(()=>c.f.restore('/a',content(['Recovered [Image #1, 12x34] attachment://1; prior [Image #9]'],[PHOTO]),c.namespace,'owned-B'));
  const before='Recovered [Image #2, 12x34] attachment://2; prior [Image #9]\n\nPrior conversation [Image #2] attachment://2';
  assert.equal(c.input().value,before);
  await c.type('Manual prefix\n'+before+' native suffix',!nativeInput);
  await c.click('Remove A.png');
  const expected='Manual prefix\nRecovered [Image #1, 12x34] attachment://1; prior [Image #9]\n\nPrior conversation [Image #2] attachment://2 native suffix';
  assert.equal(c.input().value,expected);
  assert.deepEqual(plain(await c.savedImages()).map(image=>image.data),[PHOTO.data]);
  await c.remount();assert.equal(c.input().value,expected);
  await c.click('Send');assert.equal(c.f.sends[0][0],expected);
  assert.deepEqual(plain(c.f.sends[0][1]).map(image=>image.data),[PHOTO.data]);
});

test('recovered reference ownership survives fresh storage hydration, merges, removal and replay',async t=>{
  const c=await fixture(t,{text:'Prior [Image #2] attachment://2',images:[attachment('A')]});
  const recovered=content(['B [Image #1] attachment://1'],[PHOTO]);
  await c.act(()=>c.f.restore('/a',recovered,c.namespace,'B'));
  const d=await fixture(t,{storage:c.exportStorage(),drafts:c.db.rows('draft-attachments-v3')});
  const C={...PHOTO,data:PHOTO.data+'C'};
  await d.act(()=>d.f.restore('/a',content(['C [Video #1] attachment://1'],[C]),d.namespace,'C'));
  await d.click('Remove A.png');
  assert.equal(d.input().value,'C [Video #2] attachment://2\n\nB [Image #1] attachment://1\n\nPrior [Image #2] attachment://2');
  await d.click('Remove Recovered photo 1');
  assert.equal(d.input().value,'C [Video #1] attachment://1\n\nB [Image removed]\n\nPrior [Image #2] attachment://2');
  const e=await fixture(t,{storage:d.exportStorage(),drafts:d.db.rows('draft-attachments-v3')});
  await e.act(()=>e.f.restore('/a',recovered,e.namespace,'B'));
  assert.equal(e.photos().length,1);assert.equal(e.input().value,d.input().value);
  await e.click('Send');assert.deepEqual(plain(e.f.sends[0][1]).map(image=>image.data),[C.data]);
  assert.equal(e.f.sends[0][0],'C [Video #1] attachment://1\n\nB [Image removed]\n\nPrior [Image #2] attachment://2');
});

test('manually replacing a generated reference retires its ownership without rewriting equal prior references',async t=>{
  const c=await fixture(t,{images:[attachment('A')]});
  await c.act(()=>c.f.restore('/a',content(['B [Image #1] attachment://1'],[PHOTO]),c.namespace,'manual'));
  await c.type('B [Image #9] attachment://9; manual [Image #2] attachment://2');
  await c.click('Remove A.png');
  await c.click('Send');
  assert.equal(c.f.sends[0][0],'B [Image #9] attachment://9; manual [Image #2] attachment://2');
  assert.deepEqual(plain(c.f.sends[0][1]).map(image=>image.data),[PHOTO.data]);
});

for(const photos of [[],[PHOTO]])for(const newer of ['', ' plus newer typing'])test('failed recovery text becomes durable before Send and never replays after flush/remount, photos='+photos.length+', newer='+JSON.stringify(newer),async t=>{
  const c=await fixture(t,{text:'kept'});
  c.f.seedDraft('/b','other conversation',c.namespace);
  c.f.seedDraft('/a','other credential','different-namespace');
  const original=c.w.Storage.prototype.setItem;
  c.w.Storage.prototype.setItem=function(key,value){if(key.startsWith('omp-draft:'))throw new c.w.Error('Synthetic draft text storage full');return original.call(this,key,value)};
  t.after(()=>{c.w.Storage.prototype.setItem=original});
  await c.act(()=>assert.rejects(c.f.restore('/a',content(['recovered'],photos),c.namespace,'failed-Stop'),/Could not save/));
  assert.equal(c.input().value,'recovered\n\nkept');assert.equal(c.photos().length,photos.length);
  if(newer)await c.type(c.input().value+newer);
  await c.click('Send');assert.equal(c.f.sends.length,0);
  c.w.Storage.prototype.setItem=original;
  await c.click('Send');
  assert.equal(c.f.sends.length,1);assert.equal(c.f.sends[0][0],'recovered\n\nkept'+newer);
  assert.deepEqual(plain(c.f.sends[0][1]).map(image=>image.data),photos.map(image=>image.data));
  assert.equal(c.input().value,'');assert.equal(c.photos().length,0);
  await c.act(()=>c.f.owner().flush());await c.remount();
  assert.equal(c.input().value,'');assert.equal(c.photos().length,0);assert.equal(c.f.readDraft('/a',c.namespace),'');
  assert.equal(c.f.readDraft('/b',c.namespace),'other conversation');
  assert.equal(c.f.readDraft('/a','different-namespace'),'other credential');
  const d=await fixture(t,{storage:c.exportStorage(),drafts:c.db.rows('draft-attachments-v3')});
  assert.equal(d.input().value,'');assert.equal(d.photos().length,0);
});

for(const native of [false,true])test('outbox reservation retries preserve renumbered references after a draft photo removal, native='+native,async t=>{
  const c=await fixture(t,{text:'Prior [Image #2]',images:[attachment('A')],native});
  await c.act(()=>c.seed('numbered-removal','Recovered [Image #1] attachment://1',[PHOTO]));
  if(native)c.failFinish();
  else {
    let failed=false;
    c.db.control.beforeTransaction=(name,mode)=>{
      if(!failed&&name==='commands-v3'&&mode==='readwrite'&&c.db.rows('draft-attachments-v3').some(row=>row.images.some(image=>image.recoveryId))){
        failed=true;throw Error('Synthetic source deletion failure');
      }
    };
  }
  await c.click('Edit');await c.click('Remove A.png');
  const expected='Recovered [Image #1] attachment://1\n\nPrior [Image #2]';
  assert.equal(c.input().value,expected);
  await c.click('Send');assert.equal(c.f.sends.length,0);
  assert.ok((await c.f.queue.getQueued('numbered-removal',c.namespace)).editToken);
  await c.click('Edit');assert.equal(c.input().value,expected);assert.equal(c.photos().length,1);
  assert.equal(await c.f.queue.getQueued('numbered-removal',c.namespace),null);
  await c.click('Send');assert.equal(c.f.sends.length,1);assert.equal(c.f.sends[0][0],expected);
  assert.deepEqual(plain(c.f.sends[0][1]).map(image=>image.data),[PHOTO.data]);
});

for(const photoOnly of [false,true])test('native acknowledged text/photo save remains actionable after A/B/A and a fresh WebView, photoOnly='+photoOnly,async t=>{
  const c=await fixture(t,{native:true,text:photoOnly?'':'retained native prompt',images:[attachment()]});
  c.f.nativeSave=true;
  await c.click('Send');
  assert.equal(c.input().value,'');assert.equal(c.photos().length,0);assert.equal(c.nativeRows.size,1);
  assert.equal(c.exportStorage().some(([key])=>key.startsWith('omp-native-save-attempt:')),false);
  const row=[...c.nativeRows.values()][0],id=row.commandId;
  const retained=()=>c.w.document.querySelector('[data-command-id="'+id+'"]');
  assert.ok(retained());assert.match(retained().textContent,/Saved on device/);
  await c.act(()=>c.f.switch('/b'));assert.equal(retained(),null);
  await c.act(()=>c.f.switch('/a'));assert.ok(retained());assert.equal(c.input().value,'');
  await c.click('Try again');
  assert.equal(c.nativeRows.size,1);assert.equal(c.bridgeCalls.filter(call=>call.op==='enqueue').length,1);
  const d=await fixture(t,{native:true,storage:c.exportStorage(),nativeEntries:[[id,plain(row)]]});
  await d.act(()=>d.f.queue.flush(()=>{throw Error('No browser dispatch')},{namespace:d.namespace,isTransient:()=>false}));
  assert.ok(d.w.document.querySelector('[data-command-id="'+id+'"]'));
  await d.click('Edit');assert.equal(d.input().value,row.text);assert.equal(d.photos().length,1);assert.equal(d.nativeRows.size,0);
});

test('native uncertain/refused retained status, canonical reconciliation and credential fencing use native actions',async t=>{
  const c=await fixture(t,{native:true});let entry;
  await c.act(async()=>{entry=await c.seed('uncertain-native','native only',[PHOTO]);c.nativeRows.get(entry.commandId).state='uncertain';await c.f.queue.flush(()=>{throw Error('No browser dispatch')},{namespace:c.namespace,isTransient:()=>false})});
  assert.match(c.w.document.body.textContent,/Not confirmed/);
  assert.equal(c.w.document.querySelector('button[aria-label="Edit"]')===null,true);
  const stale=c.f.pendingIntentActions(await c.f.queue.getQueued(entry.commandId,c.namespace));
  await c.click('Check');assert.ok(c.bridgeCalls.some(call=>call.op==='wake'));assert.equal(c.bridgeCalls.some(call=>call.op==='enqueue'),false);
  await c.act(()=>c.f.store.getState().setHistory([{id:'canonical',sourceEntryId:'canonical',role:'user',text:entry.text,createdAt:new c.w.Date(2),parts:[{kind:'image',src:null,mimeType:'image/png'}]}]));
  assert.equal(c.w.document.querySelector('[data-command-id="uncertain-native"]')===null,true);
  assert.equal(c.w.document.querySelectorAll('[data-testid="send-status"]').length,1);
  await c.act(async()=>{const row=c.nativeRows.get(entry.commandId);row.state='completed';row.receipt={state:'completed',code:'agent_refused',error:'Refused this request'};await c.f.queue.flush(()=>{throw Error('No browser dispatch')},{namespace:c.namespace,isTransient:()=>false})});
  assert.equal(c.w.document.querySelector('[data-command-id="uncertain-native"]'),null);
  await c.act(()=>c.f.store.getState().setHistory([]));assert.match(c.w.document.body.textContent,/Refused/);
  await c.act(()=>c.f.switch('/a','another-native-credential'));
  const before=c.bridgeCalls.length;
  assert.equal(c.w.document.querySelector('[data-command-id="uncertain-native"]'),null);
  assert.equal(await stale.retry(),null);assert.equal(await stale.cancel(),false);assert.equal(c.bridgeCalls.length,before);
});

const undoButton=c=>[...c.w.document.querySelectorAll('button')].find(button=>button.textContent==='Undo');
test('native rowless Discard hides at once and cancels only the captured retained intent after the undo window',async t=>{
  const c=await fixture(t,{native:true});await c.act(()=>c.seed('remove-native','remove me',[PHOTO]));
  await c.click('Discard message');
  assert.equal(c.w.document.querySelector('[data-command-id="remove-native"]'),null);
  assert.equal(c.nativeRows.has('remove-native'),true);assert.equal(c.bridgeCalls.some(call=>call.op==='remove'),false);
  assert.ok(undoButton(c));
  await c.act(()=>new Promise(resolve=>c.w.setTimeout(resolve,5200)));
  assert.equal(c.nativeRows.has('remove-native'),false);
  assert.equal(c.w.document.querySelector('[data-command-id="remove-native"]'),null);
  const removal=c.bridgeCalls.find(call=>call.op==='remove');
  assert.equal(removal.expected.commandId,'remove-native');assert.equal(removal.namespace,c.namespace);
  assert.equal(c.f.sends.length,0);
});

test('Undo after Discard restores the row with its photos and never removes it',async t=>{
  const c=await fixture(t,{native:true});await c.act(()=>c.seed('undo-native','keep me',[PHOTO]));
  await c.click('Discard message');
  assert.equal(c.w.document.querySelector('[data-command-id="undo-native"]'),null);
  await c.act(()=>undoButton(c).click());
  assert.ok(c.w.document.querySelector('[data-command-id="undo-native"]'));
  await c.act(()=>new Promise(resolve=>c.w.setTimeout(resolve,5200)));
  assert.equal(c.nativeRows.get('undo-native').images.length,1);
  assert.equal(c.bridgeCalls.some(call=>call.op==='remove'),false);
  assert.ok(c.w.document.querySelector('[data-command-id="undo-native"]'));
});

test('native held intent has only its daemon chip; canonical delivery removes the stale local echo',async t=>{
  const c=await fixture(t,{native:true});await c.act(()=>c.seed('held-native','held native',[PHOTO]));
  await c.act(async()=>{
    c.nativeRows.get('held-native').state='accepted';
    c.f.store.getState().setHistory([{id:'local:held-native',role:'user',text:'held native',parts:[]}]);
    c.f.store.getState().setQueuedMessages({steering:[],followUp:['held native'],liveSteered:0});
    await c.f.queue.flush(()=>{throw Error('No browser dispatch')},{namespace:c.namespace,isTransient:()=>false});
  });
  assert.equal(c.w.document.querySelectorAll('[data-testid="queued-message"]').length,1);
  assert.equal(c.w.document.querySelector('[data-command-id="held-native"]'),null);
  assert.equal(c.w.document.querySelector('[data-testid="projected-transcript"]').textContent,'');
  await c.act(()=>{
    c.f.store.getState().setQueuedMessages({steering:[],followUp:[],liveSteered:0});
    c.f.store.getState().setHistory([{id:'local:held-native',role:'user',text:'held native',parts:[]},
      {id:'entry-native',sourceEntryId:'entry-native',createdAt:new c.w.Date(2),role:'user',text:'held native',parts:[{kind:'text',text:'held native'},{kind:'image',src:null,mimeType:'image/png'}]}]);
  });
  assert.equal(c.w.document.querySelectorAll('[data-testid="queued-message"]').length,0);
  assert.equal(c.w.document.querySelector('[data-testid="projected-transcript"]').textContent.split('held native').length-1,1);
});
