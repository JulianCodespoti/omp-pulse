import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {ExtensionDialogSheet} from ${JSON.stringify(resolve(root,'web/src/app/chat/ExtensionDialogSheet.tsx'))};
 import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {reduceExtensionUiRequest,reduceExtensionDialogSnapshot,EMPTY_EXTENSION_DIALOGS} from ${JSON.stringify(resolve(root,'web/src/runtime/extension-dialogs.ts'))};
 const store=createOmpStore(),requests=[];
 const controller={getStore:()=>store,answerExtensionDialog:(id,response,path)=>new Promise((resolve,reject)=>requests.push({id,response,path,resolve,reject}))};
 let mountedRoot;
 const snapshot=requests=>store.getState().setExtensionDialogs(state=>reduceExtensionDialogSnapshot(state,{type:'extension_dialog_snapshot',requests},Date.now()));
 window.fixture={act,requests,store,snapshot,show:(path,request)=>store.setState({sessionPath:path,extensionDialogs:reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS,request,0)}),replaceController:()=>mountedRoot.render(h(ExtensionDialogSheet,{controller:{...controller}})),mount(){mountedRoot=createRoot(document.getElementById('root'));mountedRoot.render(h(ExtensionDialogSheet,{controller}));return ()=>mountedRoot.unmount()}};
`);
const ask=(extra={})=>({id:'ask',method:'ask',questions:[{id:'q',question:'Optional extras?',multi:true,options:[{label:'Auth',description:'Sign in',preview:'Example:\n  signIn(user)\n'.repeat(20)},{label:'Cache'}]}],...extra});
async function fixture(t,request=ask()){
 const dom=createDomFixture(code),w=dom.window,{act,requests,store}=w.fixture;let unmount;
 w.Element.prototype.getAnimations=()=>[];w.Element.prototype.scrollIntoView=()=>{};
 await act(async()=>{w.fixture.show('/a',request);unmount=w.fixture.mount()});
 t.after(async()=>{try{await act(async()=>unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const el=id=>w.document.querySelector(`[data-testid="${id}"]`);
 return {w,act,requests,store,el,click:id=>act(async()=>el(id).click()),show:(path,request)=>act(async()=>w.fixture.show(path,request)),type:(id,value)=>act(async()=>{const input=el(id);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}))})};
}
test('multi-select can deliberately submit none; toggling the last choice off remains valid',async t=>{
 const f=await fixture(t);assert.equal(f.el('extension-dialog-submit').disabled,false);
 await f.click('extension-dialog-ask-option');await f.click('extension-dialog-ask-option');
 assert.equal(f.el('extension-dialog-ask-option').getAttribute('aria-checked'),'false');
 await f.act(async()=>{f.el('extension-dialog-submit').click();f.el('extension-dialog-submit').click()});
 assert.equal(f.requests.length,1);assert.equal(JSON.stringify(f.requests[0].response),JSON.stringify({answers:[{id:'q',selectedOptions:[]}]}));
});
test('single-choice still requires one choice or custom text',async t=>{
 const f=await fixture(t,ask({questions:[{...ask().questions[0],multi:false}]}));assert.equal(f.el('extension-dialog-submit').disabled,true);
 await f.type('extension-dialog-ask-custom','Other');assert.equal(f.el('extension-dialog-submit').disabled,false);
});
test('opening supplied preview neither selects nor submits and works while sending',async t=>{
 const f=await fixture(t);const details=f.el('extension-option-preview');
 await f.act(async()=>details.querySelector('summary').click());assert.equal(details.open,true);assert.ok(details.textContent.includes('signIn(user)'));
 assert.equal(f.el('extension-dialog-ask-option').getAttribute('aria-checked'),'false');assert.equal(f.requests.length,0);
 await f.click('extension-dialog-submit');await f.act(async()=>details.querySelector('summary').click());assert.equal(details.open,false);assert.equal(f.requests.length,1);
});
test('ask cancellation is a quiet, confirmed Stop turn; declining an unrelated input only skips it',async t=>{
 const f=await fixture(t);assert.equal(f.el('extension-dialog-stop').textContent.trim(),'Stop turn');assert.equal(f.el('extension-dialog-skip'),null);
 await f.click('extension-dialog-stop');assert.equal(f.requests.length,0,'the first tap only asks');
 await f.click('extension-dialog-stop-confirm');assert.equal(f.requests[0].response.cancelled,true);
 await f.show('/a',{id:'input',method:'input',title:'Extension prompt'});assert.equal(f.el('extension-dialog-skip').textContent.trim(),'Skip question');assert.equal(f.el('extension-dialog-stop'),null);
});
test('hide/reopen and session round-trip keep the draft; stale failure cannot alter another owner',async t=>{
 const request={id:'reused',method:'input',title:'Type an answer'},f=await fixture(t,request);await f.type('extension-dialog-input','Keep this');
 await f.click('sheet-close');await f.act(async()=>f.w.dispatchEvent(new f.w.Event('extension-dialog:show')));assert.equal(f.el('extension-dialog-input').value,'Keep this');
 await f.click('extension-dialog-send');await f.show('/b',request);await f.type('extension-dialog-input','Other owner');
 await f.act(async()=>f.requests[0].reject(Object.assign(new Error('refused old answer'),{status:400})));
 assert.equal(f.el('extension-dialog-input').value,'Other owner');assert.equal(f.el('extension-dialog-error')===null,true);
 await f.show('/a',request);assert.equal(f.el('extension-dialog-input').value,'Keep this');assert.match(f.el('extension-dialog-error').textContent,/refused old answer/i);assert.equal(f.el('extension-dialog-send').disabled,false);
});
test('uncertain send preserves the draft but never enables duplicate dispatch',async t=>{
 const f=await fixture(t,{id:'input',method:'input',title:'Answer'});await f.type('extension-dialog-input','Exact draft');await f.click('extension-dialog-send');
 await f.act(async()=>f.requests[0].reject(new Error('Network lost')));assert.equal(f.el('extension-dialog-input').value,'Exact draft');assert.equal(f.el('extension-dialog-send').disabled,true);
 await f.click('sheet-close');await f.act(async()=>f.w.dispatchEvent(new f.w.Event('extension-dialog:show')));await f.click('extension-dialog-send');assert.equal(f.requests.length,1);
});
test('native handoff keeps entered value visible and cannot be submitted twice',async t=>{
 const f=await fixture(t,{id:'native',method:'input',title:'Answer'});await f.type('extension-dialog-input','Keep after handoff');await f.click('extension-dialog-send');
 await f.act(async()=>f.requests[0].resolve({ok:true}));assert.equal(f.store.getState().extensionDialogs.pending.length,1);assert.equal(f.el('extension-dialog-input').value,'Keep after handoff');assert.equal(f.el('extension-dialog-send').disabled,true);
 await f.click('sheet-close');await f.act(async()=>f.w.dispatchEvent(new f.w.Event('extension-dialog:show')));assert.equal(f.el('extension-dialog-input').value,'Keep after handoff');await f.click('extension-dialog-send');assert.equal(f.requests.length,1);
});
test('a retained handoff does not block a different unsent extension dialog',async t=>{
 const f=await fixture(t,{id:'first',method:'input',title:'First'});await f.type('extension-dialog-input','First answer');await f.click('extension-dialog-send');await f.act(async()=>f.requests[0].resolve({ok:true}));
 await f.act(async()=>f.store.getState().setExtensionDialogs(state=>({...state,pending:[...state.pending,{id:'next',method:'input',title:'Next',expiresAt:null}]})));
 assert.equal(f.el('extension-dialog-input').value,'');assert.equal(f.el('extension-dialog-input').disabled,false);await f.type('extension-dialog-input','Second answer');await f.click('extension-dialog-send');assert.equal(f.requests.length,2);assert.equal(f.requests[1].id,'next');
});
test('replacing credentials clears retained native drafts and fences old completion',async t=>{
 const f=await fixture(t,{id:'same',method:'input',title:'Answer'});await f.type('extension-dialog-input','Private old draft');await f.click('extension-dialog-send');
 await f.act(async()=>f.w.fixture.replaceController());assert.equal(f.el('extension-dialog-input').value,'');assert.equal(f.el('extension-dialog-input').disabled,false);await f.type('extension-dialog-input','New owner draft');assert.equal(f.el('extension-dialog-send').disabled,false);
 await f.act(async()=>f.requests[0].resolve({ok:true}));assert.equal(f.el('extension-dialog-input').value,'New owner draft');assert.equal(f.el('extension-dialog-send').disabled,false);
});
test('native retained editors are bounded without evicting drafts; exact closure releases capacity',async t=>{
 const request={id:'retained',method:'input',title:'Answer'},f=await fixture(t,request);
 for(let i=0;i<64;i++){await f.show('/owner/'+i,request);await f.type('extension-dialog-input','Draft '+i);}
 await f.show('/overflow',request);assert.ok(f.el('extension-dialog-capacity'));assert.equal(f.el('extension-dialog-input').disabled,true);
 await f.show('/owner/0',request);assert.equal(f.el('extension-dialog-input').value,'Draft 0');assert.equal(f.el('extension-dialog-input').disabled,false);
 await f.act(async()=>f.store.getState().setExtensionDialogs(()=>({pending:[],closed:['retained']})));
 await f.show('/overflow',request);assert.equal(f.el('extension-dialog-capacity')===null,true);assert.equal(f.el('extension-dialog-input').disabled,false);await f.type('extension-dialog-input','New draft');
 await f.show('/owner/63',request);assert.equal(f.el('extension-dialog-input').value,'Draft 63');
});
test('native authoritative closure prevents an old completion recreating a retired attempt',async t=>{
 const request={id:'reused',method:'input',title:'Answer'},f=await fixture(t,request);await f.type('extension-dialog-input','Old draft');await f.click('extension-dialog-send');
 await f.act(async()=>f.store.getState().setExtensionDialogs(()=>({pending:[],closed:['reused']})));
 await f.show('/a',request);assert.equal(f.el('extension-dialog-input').value,'');await f.type('extension-dialog-input','Replacement draft');
 await f.act(async()=>f.requests[0].reject(Object.assign(new Error('Old refusal'),{status:400})));
 assert.equal(f.el('extension-dialog-input').value,'Replacement draft');assert.equal(f.el('extension-dialog-error')===null,true);assert.equal(f.el('extension-dialog-send').disabled,false);
});

test('same-socket snapshots keep exact ask drafts and handoffs until authoritative closure',async t=>{
 const request=ask(),f=await fixture(t,request);
 await f.click('extension-dialog-ask-option');
 await f.type('extension-dialog-ask-custom','  Keep this answer\nexactly  ');
 await f.act(async()=>f.w.fixture.snapshot([request]));
 assert.equal(f.el('extension-dialog-ask-option').getAttribute('aria-checked'),'true');
 // Input controls normalise line breaks, but snapshot replacement must not alter the retained value.
 const retained=f.el('extension-dialog-ask-custom').value;
 assert.equal(retained.includes('Keep this answer'),true);
 await f.click('extension-dialog-submit');
 await f.act(async()=>f.requests[0].resolve({ok:true}));
 await f.act(async()=>f.w.fixture.snapshot([{...request,pulseDelivery:'handoff'}]));
 assert.equal(f.el('extension-dialog-ask-custom').value,retained);
 assert.equal(f.el('extension-dialog-submit').disabled,true);
 await f.act(async()=>f.w.fixture.snapshot([]));
 assert.equal(f.el('extension-dialog'),null);
 assert.equal(f.store.getState().extensionDialogs.closed.includes('ask'),true);
 assert.equal(f.requests.length,1);
});
