import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {useMessageActions} from ${JSON.stringify(resolve(root,'web/src/app/parts/MessageActions.tsx'))};
import {DaemonApi,sendPromptDurably} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
import {writePairingToken} from ${JSON.stringify(resolve(root,'web/src/platform/browser-storage.ts'))};
const token='synthetic-message-actions';writePairingToken(token);
queue.setOfflineQueueNamespace(queue.offlineQueueNamespaceForCredential(token));
const calls=[],branches=[],navigated=[],blobs=[],notices=[],overrides=[];
const receipt=body=>({ok:true,receiptBinding:{version:1,requestedSessionPath:body.sessionPath,canonicalSessionPath:body.sessionPath},receipt:{commandId:body.commandId,sessionPath:body.sessionPath,state:'accepted',createdAt:1,updatedAt:2}});
DaemonApi.prototype.fetchJson=async function(path,init){
 const body=init?.body?JSON.parse(init.body):undefined;calls.push({path,body});
 if(path==='/api/version')return{protocolVersion:1,minClientProtocolVersion:1,capabilities:['receipt-session-binding-v1']};
 if(path==='/api/prompt'){if(window.failReceipt)window.idb.control.abortNextPut=true;return receipt(body)}
 if(path.startsWith('/api/receipts/')){const body=calls.find(c=>c.path==='/api/prompt').body;return receipt(body)}
 throw Error('Unexpected synthetic route '+path);
};
DaemonApi.prototype.dedupedFetch=DaemonApi.prototype.fetchJson;
DaemonApi.prototype.branch=async(path,entry)=>{branches.push({path,entry});return{sessionPath:'/synthetic/branch',text:'Original',cancelled:false}};
window.fetch=async(path,options)=>{blobs.push({path,options});if(window.holdBlob)return new Promise(resolve=>window.finishBlob=()=>resolve({ok:true,arrayBuffer:async()=>new Uint8Array([98,108,111,98]).buffer}));return{ok:!window.missingBlob,arrayBuffer:async()=>new Uint8Array([98,108,111,98]).buffer}};
let message={id:'ui-selected',sourceEntryId:'raw-selected',role:'user',text:'Original',parts:[]};
function App({path}){window.actions=useMessageActions({sessionPath:path,messages:[message],onBranched:p=>navigated.push(p),onSendPrompt:window.customSend?async(...args)=>{overrides.push(args);return sendPromptDurably(...args)}:undefined});return window.actions.sheet}
window.fixture={act,calls,branches,navigated,blobs,notices,overrides,queue,
 recover:body=>sendPromptDurably(body.sessionPath,'',[],{commandId:body.commandId,token}),
 mount(){const r=createRoot(document.getElementById('root'));const render=(path='/synthetic/original')=>r.render(h(App,{path}));render();return{render,unmount:()=>r.unmount()}},
 open:extra=>window.actions.open({...message,...extra}),replaceCredential:()=>writePairingToken('synthetic-replacement')};
`, [{name:'capture-notices',resolveId(id,importer){return /\/(MessageActions|EditResendSheet)\.tsx$/.test(importer??'')&&id.endsWith('Notices')?'\0notices':null},load(id){return id==='\0notices'?'export const showToast=(...args)=>window.fixture.notices.push(args);export const showBanner=(...args)=>window.fixture.notices.push(args);':null}}]);

const plain = value => JSON.parse(JSON.stringify(value));
const imageParts = [
  {kind:'image',src:'data:image/png;base64,aW5saW5l',mimeType:'image/png'},
  {kind:'image',src:'blob:sha256:aaaaaaaa',mimeType:'image/jpeg'},
];
const images = [{data:'aW5saW5l',mimeType:'image/png'},{data:'YmxvYg==',mimeType:'image/jpeg'}];
async function fixture(t,{customSend=false}={}) {
  const dom=createDomFixture(`window.idb=(${memoryIndexedDb.toString()})();window.indexedDB=window.idb.indexedDB;window.customSend=${customSend};`+code);
  const w=dom.window,f=w.fixture,{act}=f;w.Element.prototype.getAnimations=()=>[];
  const timers=new Map(),set=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);let seq=9000;
  w.setTimeout=(cb,ms,...args)=>{if(ms===120){const id=seq++;timers.set(id,cb);return id}return set(cb,ms,...args)};
  w.clearTimeout=id=>{timers.delete(id);clear(id)};
  let mounted;await act(async()=>{mounted=f.mount()});
  t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===text);
  const click=text=>act(async()=>{assert.ok(button(text),text);button(text).click()});
  return {...f,w,act,button,click,prompts:()=>f.calls.filter(c=>c.path==='/api/prompt'),editor:()=>w.document.querySelector('textarea'),
    render:path=>act(async()=>mounted.render(path)),
    open:extra=>act(async()=>f.open(extra)),
    edit:async(mode='Edit & resend')=>{await click(mode);await act(async()=>{const ready=[...timers.values()];timers.clear();ready.forEach(cb=>cb())})},
    type:text=>act(async()=>{const input=w.document.querySelector('textarea');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new w.Event('input',{bubbles:true}))}),
  };
}

for (const action of ['Edit & resend','Edit & rewind from here','Send again']) {
  for (const text of ['Caption','']) {
    test(`${action} includes inline and blob photos exactly once${text?'':' without text'}`,async t=>{
      const f=await fixture(t,{customSend:action==='Send again'});await f.open({text,parts:imageParts});
      if(action==='Send again')await f.click(action);else await f.edit(action);
      await f.click('Send');
      assert.equal(f.prompts().length,1);assert.deepEqual(plain(f.prompts()[0].body.images),images);
      assert.equal(f.prompts()[0].body.text,text);assert.equal(f.blobs.length,1);
      assert.equal(f.blobs[0].path,'/api/blob/aaaaaaaa');assert.equal(f.blobs[0].options.headers.Authorization,'Bearer synthetic-message-actions');
      if(action==='Edit & rewind from here'){assert.deepEqual(plain(f.branches),[{path:'/synthetic/original',entry:'raw-selected'}]);assert.equal(f.prompts()[0].body.sessionPath,'/synthetic/branch')}
      if(action==='Send again'){assert.equal(f.overrides.length,1);assert.deepEqual(plain(f.overrides[0][2]),images);assert.equal(typeof f.overrides[0][3].onSaved,'function')}
    });
  }
  test(`${action} refuses a partial prompt when a photo is unavailable`,async t=>{
    const f=await fixture(t);f.w.missingBlob=true;await f.open({text:'Do not send alone',parts:imageParts});
    if(action==='Send again')await f.click(action);else await f.edit(action);
    await f.click('Send');assert.equal(f.prompts().length,0);assert.equal(f.branches.length,0);
    assert.equal(f.notices.length,1);assert.match(f.notices[0][0],/photo.*no longer available/);
    if(action!=='Send again')assert.equal(f.editor()?.value,'Do not send alone');
  });
}

for (const action of ['Edit & resend','Edit & rewind from here','Send again']) {
  test(`${action} relinquishes a saved payload even if the accepted receipt cannot persist`,async t=>{
    const f=await fixture(t);f.w.failReceipt=true;await f.open({text:'Only once',parts:imageParts});
    if(action==='Send again')await f.click(action);else await f.edit(action);
    await f.click('Send');assert.equal(f.prompts().length,1);assert.equal(f.editor()===null,true);
    const original=f.prompts()[0].body;
    assert.equal(f.w.idb.rows().length,1);assert.equal(f.w.idb.rows()[0].commandId,original.commandId);
    f.w.failReceipt=false;
    await f.act(async()=>f.recover(original));
    assert.equal(f.prompts().length,1,'recovery checks status, never creates or reposts a command');
    assert.equal(f.w.idb.rows().length,1);assert.equal(f.branches.length,action==='Edit & rewind from here'?1:0);
    assert.equal(f.calls.filter(c=>c.path.startsWith('/api/receipts/')).length,1);
  });
}

test('failed enqueue retains editable text/photos and retry reuses the created rewind branch',async t=>{
  const f=await fixture(t);await f.open({parts:imageParts});await f.edit('Edit & rewind from here');await f.type('Edited');
  f.w.idb.control.abortNextPut=true;await f.click('Send');
  assert.equal(f.prompts().length,0);assert.equal(f.branches.length,1);assert.equal(f.editor()?.value,'Edited');assert.equal(f.editor()?.readOnly,false);
  await f.click('Send');assert.equal(f.branches.length,1);assert.equal(f.prompts().length,1);assert.deepEqual(plain(f.prompts()[0].body.images),images);
});

for(const change of ['session','credential','selection']) {
  test(`obsolete ${change} during image loading cannot enqueue, branch or close a newer view`,async t=>{
    const f=await fixture(t);f.w.holdBlob=true;await f.open({parts:imageParts});await f.edit('Edit & rewind from here');await f.click('Send');
    if(change==='session')await f.render('/synthetic/other');
    else if(change==='credential')f.replaceCredential();
    else await f.open({id:'ui-newer',text:'Newer',parts:[]});
    await f.act(async()=>f.w.finishBlob());assert.equal(f.prompts().length,0);assert.equal(f.branches.length,0);assert.equal(f.navigated.length,0);assert.equal(f.notices.length,0);
  });
}

test('missing local attachment bytes prevent a text-only resend',async t=>{
  const f=await fixture(t);await f.open({parts:[],localAttachmentCount:1});await f.edit();await f.click('Send');
  assert.equal(f.prompts().length,0);assert.match(f.notices[0][0],/photo.*no longer available/);
});
