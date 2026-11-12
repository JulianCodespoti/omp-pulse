import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {MessageParts} from ${JSON.stringify(resolve(root,'web/src/app/parts/MessageParts.tsx'))};
import {createUserMessage} from ${JSON.stringify(resolve(root,'web/src/domain/messages.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
const namespace=queue.offlineQueueNamespaceForCredential('synthetic-count');queue.setOfflineQueueNamespace(namespace);
const path='/synthetic/count',store=createOmpStore();store.getState().beginSession(path);
const controller=Object.assign(Object.create(OmpSessionController.prototype),{queueNamespace:namespace,activeSession:path,generation:1,store,flushQueue:async()=>{},recordSuccess(){}});
let renderer;window.fixture={act,createUserMessage,controller,store,queue,namespace,path,
 mount(){renderer=createRoot(document.getElementById('root'))},
 render(message=store.getState().messages.at(-1)){renderer.render(message?h(MessageParts,{message,sessionPath:store.getState().sessionPath}):null)},
 unmount(){renderer.unmount()},
};
`);
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;
 await f.act(async()=>f.mount());
 t.after(async()=>{try{await f.act(async()=>f.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const run=fn=>f.act(async()=>{await fn?.();f.render()});
 return{f,w,run,summary:()=>w.document.querySelector('[data-testid="message-attachment-count"]')?.textContent,
 render:message=>f.act(async()=>f.render(message)),send:(text,images=[])=>run(()=>f.controller.sendPrompt(text,images,f.path)),text:()=>w.document.body.textContent};
}
const photo={data:'c3ludGhldGlj',mimeType:'image/png'};
for(const [count,label] of [[0,undefined],[1,'1 image attached'],[2,'2 images attached'],[8,'8 images attached']]){
 test(`admitted count ${count} is composition only`,async t=>{
  const ui=await fixture(t);await ui.send('Caption',Array.from({length:count},()=>photo));
  assert.equal(ui.summary(),label);
  const message=ui.f.store.getState().messages.at(-1);
  assert.equal(message.text,'Caption');assert.equal(message.parts.length,1);
  assert.equal(JSON.stringify(message).includes(photo.data),false);
  assert.equal(message.localAttachmentCount,count||undefined);
 });
}
test('image-only prompt has a visible count and unchanged empty copy text',async t=>{
 const ui=await fixture(t);await ui.send('',[photo]);assert.equal(ui.summary(),'1 image attached');assert.equal(ui.f.store.getState().messages[0].text,'');
});
for(const state of ['accepted','forwarded','completed','failed','uncertain']){
 test(`${state} receipt cannot erase or rewrite submitted count`,async t=>{
  const ui=await fixture(t);await ui.send('First',[photo]);const message=ui.f.store.getState().messages[0],id=message.id.slice(6);
  await ui.run(()=>ui.f.queue.update(id,{state,receipt:{commandId:id,sessionPath:ui.f.path,state,createdAt:1,updatedAt:2}},ui.f.namespace));
  assert.equal(ui.summary(),'1 image attached');
  assert.equal(ui.f.store.getState().messages[0],message);
 });
}
test('queue removal and namespace rehydration do not borrow another command count',async t=>{
 const ui=await fixture(t);await ui.send('First',[photo]);const message=ui.f.store.getState().messages[0];
 await ui.run(()=>ui.f.queue.removeAsync(message.id.slice(6),ui.f.namespace));assert.equal(ui.summary(),'1 image attached');
 await ui.run(async()=>{ui.f.queue.setOfflineQueueNamespace(ui.f.namespace+'-other');await ui.f.queue.enqueue({sessionPath:ui.f.path,text:'First',images:[photo,photo],namespace:ui.f.namespace+'-other'})});
 assert.equal(ui.summary(),'1 image attached');
});
for(const method of ['setHistory','mergeMessages']){
 test(`${method} canonical image replaces local annotation without duplication`,async t=>{
  const ui=await fixture(t);await ui.send('Caption',[photo]);
  await ui.run(()=>ui.f.store.getState()[method]([{id:'canonical',role:'user',text:'Caption',parts:[{kind:'text',text:'Caption'},{kind:'image',src:'data:image/png;base64,'+photo.data,mimeType:photo.mimeType}]}]));
  assert.equal(ui.summary(),undefined);assert.equal(ui.w.document.querySelectorAll('img').length,1);assert.equal(ui.f.store.getState().messages.length,1);
 });
}
test('session navigation never restores local count from retained outbox alone',async t=>{
 const ui=await fixture(t);await ui.send('Caption',[photo]);
 await ui.run(()=>ui.f.store.getState().beginSession('/synthetic/other'));assert.equal(ui.summary(),undefined);
 await ui.run(()=>ui.f.store.getState().beginSession(ui.f.path));assert.equal(ui.summary(),undefined);
 assert.equal((await ui.f.queue.getSnapshot()).length,1);
});
test('invalid counts, canonical messages and real image parts cannot double count',async t=>{
 const ui=await fixture(t);
 for(const count of [0,-1,NaN,Infinity,1.5]){const message=ui.f.createUserMessage('Text','id',1,count);assert.equal(message.localAttachmentCount,undefined);await ui.render(message);assert.equal(ui.summary(),undefined)}
 const message=ui.f.createUserMessage('Text','id',1,2);
 await ui.render({...message,id:'canonical'});assert.equal(ui.summary(),undefined);
 await ui.render({...message,role:'assistant'});assert.equal(ui.summary(),undefined);
 await ui.render({...message,parts:[{kind:'image',src:'data:image/png;base64,'+photo.data,mimeType:photo.mimeType}]});assert.equal(ui.summary(),undefined);
 await ui.render({...message,text:'',parts:[]});assert.equal(ui.summary(),'2 images attached');
});

test('admitted count snapshots the saved entry before composer cleanup mutates input',async t=>{
 const ui=await fixture(t),images=[{...photo}];
 await ui.run(()=>ui.f.controller.sendPrompt('Original',images,ui.f.path,()=>{images.splice(0,1,{...photo},{...photo});}));
 assert.equal(images.length,2);assert.equal(ui.summary(),'1 image attached');
 assert.equal(ui.f.store.getState().messages[0].text,'Original');
});
