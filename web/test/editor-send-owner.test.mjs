import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json')),rpc=resolve(root,'web/src/runtime/rpc-client.ts');
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {EditResendSheet} from ${JSON.stringify(resolve(root,'web/src/app/chat/EditResendSheet.tsx'))};
import {DaemonApi} from ${JSON.stringify(rpc)};
window.sends=[];window.notices=[];const branches=[],navigated=[],closed=[];
DaemonApi.prototype.branch=(...args)=>new Promise((resolve,reject)=>branches.push({args,resolve,reject}));
window.fixture={act,branches,navigated,closed,mount(){
 const r=createRoot(document.getElementById('root'));
 let props={open:true,initialText:'Original',sessionPath:'/synthetic/a',branchFromEntryId:'raw-a',rewind:false,onOpenChange:x=>closed.push(x),onBranched:x=>navigated.push(x)};
 const render=(change={})=>{props={...props,...change};r.render(h(EditResendSheet,props))};render();
 return {render,unmount:()=>r.unmount()}
}};
`,[{name:'deferred-edit',resolveId(id,importer){if(!importer?.endsWith('/EditResendSheet.tsx'))return null;if(id.endsWith('runtime/rpc-client'))return '\0edit-rpc';if(id.endsWith('Notices'))return '\0edit-notices';return null},load(id){if(id==='\0edit-rpc')return `export{DaemonApi,isOwnershipError}from ${JSON.stringify(rpc)};export const sendPromptDurably=(path,text,images,options)=>new Promise((resolve,reject)=>window.sends.push({path,text,images,options,resolve:value=>{options.onSaved?.();resolve(value)},reject}));`;if(id==='\0edit-notices')return 'export const showToast=(...args)=>window.notices.push(args);export const showBanner=(...args)=>window.notices.push(args);';return null}}]);
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,{act,branches,navigated,closed}=w.fixture;
 w.Element.prototype.getAnimations=()=>[];let r,dead=false;
 await act(async()=>{r=w.fixture.mount()});
 const unmount=async()=>{if(!dead){dead=true;await act(async()=>r.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===text);
 return {w,act,branches,navigated,closed,button,unmount,sends:w.sends,notices:w.notices,
 render:props=>act(async()=>r.render(props)),
 click:text=>act(async()=>{assert.ok(button(text),text);button(text).click()}),
 finishSend:(i,value={state:'queued'})=>act(async()=>w.sends[i].resolve(value)),
 finishBranch:(i,value={sessionPath:'/synthetic/branch',text:'Original',cancelled:false})=>act(async()=>branches[i].resolve(value)),
 type:text=>act(async()=>{const a=w.document.querySelector('textarea');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(a,text);a.dispatchEvent(new w.Event('input',{bubbles:true}))})};
}
test('repeat edit Send issues one prompt',async t=>{const f=await fixture(t);await f.act(async()=>{const b=f.button('Send');b.click();b.click()});assert.equal(f.sends.length,1)});
test('dismissed rewind cannot issue its next prompt',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.click('Send');await f.render({open:false});await f.finishBranch(0);assert.equal(f.sends.length,0);assert.equal(f.navigated.length,0)});
test('unmounted rewind cannot issue its next prompt',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.click('Send');await f.unmount();await f.finishBranch(0);assert.equal(f.sends.length,0)});
test('old send cannot close reopened editor',async t=>{const f=await fixture(t);await f.click('Send');await f.render({open:false});await f.render({open:true});await f.finishSend(0);assert.equal(f.closed.length,0)});
test('pending submitted text is read only',async t=>{const f=await fixture(t);await f.type('Edited');await f.click('Send');assert.equal(f.w.document.querySelector('textarea').readOnly,true);assert.equal(f.sends[0].text,'Edited')});
test('repeated rewind confirmation issues one branch',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.act(async()=>{const b=f.button('Send');b.click();b.click()});assert.equal(f.branches.length,1)});
test('changed session rejects old branch completion',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.click('Send');await f.render({sessionPath:'/synthetic/b'});await f.finishBranch(0);assert.equal(f.sends.length,0);assert.equal(f.navigated.length,0);assert.equal(f.button('Send').disabled,false)});
test('changed entry rejects old branch completion',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.click('Send');await f.render({branchFromEntryId:'raw-b'});await f.finishBranch(0);assert.equal(f.sends.length,0)});
test('old rejection cannot show feedback in a new editor',async t=>{const f=await fixture(t);await f.click('Send');await f.render({open:false});await f.render({open:true});await f.act(async()=>f.sends[0].reject(new Error('Synthetic old failure')));assert.equal(f.notices.length,0);assert.equal(f.closed.length,0)});
test('old finally cannot unlock a newer submission',async t=>{const f=await fixture(t);await f.click('Send');await f.render({open:false});await f.render({open:true,initialText:'Newer'});await f.click('Send');await f.finishSend(0);assert.equal(f.button('Sending…').disabled,true);assert.equal(f.w.document.querySelector('textarea').readOnly,true);await f.finishSend(1);assert.deepEqual(Array.from(f.closed),[false])});
test('pre-save failure retains edit and permits explicit retry',async t=>{const f=await fixture(t);await f.type('Edited');await f.click('Send');await f.act(async()=>f.sends[0].reject(new Error('Synthetic save failure')));assert.equal(f.closed.length,0);assert.equal(f.w.document.querySelector('textarea').value,'Edited');assert.equal(f.w.document.querySelector('textarea').readOnly,false);assert.equal(f.sends.length,1);await f.click('Send');assert.equal(f.sends.length,2)});
test('current cancelled branch releases pending without sending',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.click('Send');await f.finishBranch(0,{sessionPath:'/synthetic/a',text:'',cancelled:true});assert.equal(f.sends.length,0);assert.equal(f.button('Send').disabled,false);assert.equal(f.closed.length,0)});
test('current rewind sends captured text to exact branch then navigates once',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.type(' Edited ');await f.click('Send');assert.deepEqual(Array.from(f.branches[0].args),['/synthetic/a','raw-a']);await f.finishBranch(0);assert.equal(f.sends[0].path,'/synthetic/branch');assert.equal(f.sends[0].text,'Edited');await f.finishSend(0);assert.deepEqual(Array.from(f.navigated),['/synthetic/branch']);assert.deepEqual(Array.from(f.closed),[false])});
test('saved delivery hands recovery to outbox and closes without a new send',async t=>{const f=await fixture(t);await f.click('Send');await f.finishSend(0,{state:'uncertain'});assert.equal(f.notices.length,0);assert.deepEqual(Array.from(f.closed),[false]);assert.equal(f.sends.length,1);assert.equal(f.w.document.querySelector('textarea').value,'');assert.equal(f.button('Send').disabled,true)});
test('header Close immediately invalidates a pending branch',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.click('Send');await f.act(async()=>{f.w.document.querySelector('button[aria-label="Close"]').click();f.branches[0].resolve({sessionPath:'/synthetic/branch',cancelled:false})});assert.equal(f.sends.length,0);assert.deepEqual(Array.from(f.closed),[false])});
test('harmless rerender retains edit and its pending lifetime',async t=>{const f=await fixture(t);await f.type('Kept');await f.render({});assert.equal(f.w.document.querySelector('textarea').value,'Kept');await f.click('Send');await f.render({});await f.finishSend(0);assert.deepEqual(Array.from(f.closed),[false])});
test('retry after branch creation and failed save reuses that branch',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.type('Edited');await f.click('Send');await f.finishBranch(0);await f.act(async()=>f.sends[0].reject(new Error('Synthetic save failure')));await f.click('Send');assert.equal(f.branches.length,1);assert.equal(f.sends.length,2);assert.equal(f.sends[1].path,'/synthetic/branch');assert.equal(f.w.document.querySelector('textarea').value,'Edited')});
test('credential change while branching cannot enqueue or navigate',async t=>{const f=await fixture(t);await f.render({rewind:true});await f.click('Send');f.w.localStorage.setItem('omp-remote-token','synthetic-replacement');await f.finishBranch(0);assert.equal(f.sends.length,0);assert.equal(f.navigated.length,0)});
