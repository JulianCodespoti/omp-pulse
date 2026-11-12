import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {AnswerSheet} from ${JSON.stringify(resolve(root,'web/src/app/sessions/AnswerSheet.tsx'))};
 const requests=[],closed=[];window.fixture={act,requests,closed,sent:0,mount:session=>{
 const r=createRoot(document.getElementById('root'));const render=(session,open=true,onOpenSession)=>r.render(h(AnswerSheet,{open,session,onOpenSession,onOpenChange:v=>closed.push(v),onSent:()=>window.fixture.sent++}));render(session);return {unmount:()=>r.unmount(),render};}};
`,[{name:'synthetic-answer-transport',resolveId:id=>id.endsWith('runtime/rpc-client')?'\0answer-api':null,
 load:id=>id==='\0answer-api'?`export const answerPane=(path,text,identity)=>new Promise((resolve,reject)=>window.fixture.requests.push({path,text,identity,resolve,reject})); export const isOwnershipError=()=>false;`:null}]);
const session=(extra={})=>({path:'/synthetic/session',title:'Recovery',pendingAsk:{id:'q1',index:0,total:1,question:'Which recovery path?',options:['Keep current draft','Start a new session','Stay offline'],recommended:0},...extra});
async function fixture(t,value=session()){
 const dom=createDomFixture(code),w=dom.window,{act,requests,closed}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(value)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const el=id=>w.document.querySelector(`[data-testid="${id}"]`);
 return {w,act,requests,closed,el,mounted,click:id=>act(async()=>el(id).click()),type:async(text,id='answer-text-input')=>act(async()=>{const input=el(id);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,text);input.dispatchEvent(new w.Event('input',{bubbles:true}));})};
}
test('Open session appears only when the opener supplies a way into the conversation',async t=>{
 const f=await fixture(t);assert.equal(f.el('answer-open-session')===null,true,'only when the opener supplies it');
});
test('option click dispatches exact text and index once even with repeated clicks',async t=>{
 const f=await fixture(t);await f.act(async()=>{f.el('answer-option-2').click();f.el('answer-option-2').click()});assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'Start a new session');assert.equal(f.requests[0].identity.optionIndex,1);assert.equal(f.requests[0].path,'/synthetic/session');assert.equal(f.el('answer-option-1').disabled,true);
 await f.act(async()=>f.requests[0].resolve({delivery:'handoff'}));assert.deepEqual(Array.from(f.closed),[]);assert.equal(f.el('answer-option-1').disabled,true);
});
test('custom answer has an accessible label and retains normal submit behavior',async t=>{
 const f=await fixture(t);assert.equal(f.el('answer-text-input').getAttribute('aria-label'),'Your answer');await f.type('  Use a different approach  ');await f.click('answer-send-button');assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'Use a different approach');assert.equal(f.requests[0].identity.optionIndex,undefined);
});
test('failed answer keeps the draft and enables retry without a close',async t=>{
 const f=await fixture(t);await f.type('My answer');await f.click('answer-send-button');await f.act(async()=>f.requests[0].reject(Object.assign(new Error('Answer refused'),{status:400})));
 assert.equal(f.el('answer-text-input').value,'My answer');assert.equal(f.el('answer-send-button').disabled,false);assert.ok(f.el('answer-error'));assert.deepEqual(Array.from(f.closed),[]);
});
test('next question is still gated until its fresh identity arrives',async t=>{
 const initial=session({pendingAsk:{...session().pendingAsk,total:2}}),f=await fixture(t,initial);await f.click('answer-option-1');await f.act(async()=>f.requests[0].resolve());assert.equal(f.el('answer-option-2').disabled,true);assert.match(f.el('answer-progress').textContent,/Waiting for question 2 of 2/);
 await f.act(async()=>f.mounted.render({...initial,pendingAsk:{...initial.pendingAsk,index:1,question:'Next question'}}));assert.equal(f.el('answer-option-2').disabled,false);assert.deepEqual(Array.from(f.closed),[]);
});
test('close/reopen keeps draft and in-flight lock instead of dispatching again',async t=>{
 const initial=session(),f=await fixture(t,initial);await f.type('Keep my draft');await f.click('answer-send-button');
 await f.act(async()=>f.mounted.render(initial,false));await f.act(async()=>f.mounted.render(initial,true));
 assert.equal(f.el('answer-text-input').value,'Keep my draft');assert.equal(f.el('answer-send-button').disabled,true);await f.click('answer-send-button');assert.equal(f.requests.length,1);
 await f.act(async()=>f.requests[0].reject(new Error('Network lost')));assert.equal(f.el('answer-text-input').value,'Keep my draft');assert.equal(f.el('answer-send-button').disabled,true);assert.ok(f.el('answer-error').textContent.includes('Delivery is unknown'));
});
test('session and question changes isolate drafts and stale completions',async t=>{
 const initial=session(),f=await fixture(t,initial);await f.type('First answer');await f.click('answer-send-button');
 const other=session({path:'/other'});await f.act(async()=>f.mounted.render(other));await f.type('Other draft');
 await f.act(async()=>f.requests[0].resolve({delivery:'handoff'}));assert.equal(f.el('answer-text-input').value,'Other draft');assert.equal(f.el('answer-send-button').disabled,false);assert.equal(f.w.fixture.sent,0);
 await f.act(async()=>f.mounted.render(initial));assert.equal(f.el('answer-text-input').value,'First answer');assert.equal(f.el('answer-send-button').disabled,true);
});
test('stale-question refusal keeps the answer but offers no retry',async t=>{
 const f=await fixture(t);await f.type('Keep for recovery');await f.click('answer-send-button');
 await f.act(async()=>f.requests[0].reject(Object.assign(new Error('that question is no longer waiting'),{status:409})));
 assert.equal(f.el('answer-text-input').value,'Keep for recovery');assert.equal(f.el('answer-send-button').disabled,true);assert.ok(f.el('answer-error').textContent.includes('no longer waiting'));
});
test('retained answer editors have a fixed bound and authoritative question end releases a slot',async t=>{
 const initial=session({path:'/owner/0'}),f=await fixture(t,initial);
 for(let i=0;i<64;i++){await f.act(async()=>f.mounted.render(session({path:'/owner/'+i})));await f.type('Draft '+i);}
 await f.act(async()=>f.mounted.render(session({path:'/overflow'})));assert.equal(f.el('answer-text-input').disabled,true);assert.ok(f.el('answer-error').textContent.includes('64'));
 await f.act(async()=>f.mounted.render(initial));assert.equal(f.el('answer-text-input').value,'Draft 0');assert.equal(f.el('answer-text-input').disabled,false);
 await f.act(async()=>f.mounted.render({...initial,pendingAsk:undefined}));
 await f.act(async()=>f.mounted.render(session({path:'/overflow'})));assert.equal(f.el('answer-text-input').disabled,false);await f.type('New draft');
 await f.act(async()=>f.mounted.render(session({path:'/owner/63'})));assert.equal(f.el('answer-text-input').value,'Draft 63');
});
test('question progression retires held state and a late completion cannot recreate it',async t=>{
 const initial=session({pendingAsk:{...session().pendingAsk,total:2}}),f=await fixture(t,initial);
 await f.type('First answer');await f.click('answer-send-button');
 await f.act(async()=>f.mounted.render({...initial,pendingAsk:{...initial.pendingAsk,index:1}}));await f.type('Next answer');
 await f.act(async()=>f.requests[0].reject(Object.assign(new Error('Refused old question'),{status:400})));assert.equal(f.el('answer-text-input').value,'Next answer');assert.equal(f.el('answer-error')===null,true);
 await f.act(async()=>f.mounted.render(initial));assert.equal(f.el('answer-text-input').value,'');assert.equal(f.el('answer-option-1').disabled,false);
});
test('new pairing cannot inherit a reused session/question answer or late completion',async t=>{
 const initial=session(),f=await fixture(t,initial);await f.type('Private old answer');await f.click('answer-send-button');
 f.w.localStorage.setItem('omp-remote-token','replacement-pairing');await f.act(async()=>f.mounted.render(initial));
 assert.equal(f.el('answer-text-input').value,'');await f.type('New pairing answer');
 await f.act(async()=>f.requests[0].resolve({delivery:'handoff'}));assert.equal(f.el('answer-text-input').value,'New pairing answer');assert.equal(f.el('answer-send-button').disabled,false);assert.equal(f.w.fixture.sent,0);
});
test('unidentified native/collab and terminal prompts route to exact dialog UI without retaining a shared lock',async t=>{
 const generic=session({pendingAsk:undefined}),f=await fixture(t,generic);let opened=0;
 await f.act(async()=>f.mounted.render(generic,true,()=>{opened++}));
 assert.equal(f.el('answer-text-input')===null,true);assert.equal(f.el('answer-send-button')===null,true);
 await f.click('answer-open-session');assert.equal(opened,1);assert.equal(f.requests.length,0);
 for(let i=0;i<70;i++){
   const next={...generic,title:'Later generic prompt '+i};
   await f.act(async()=>f.mounted.render(next,false));
   await f.act(async()=>f.mounted.render(next,true));
   assert.equal(f.el('answer-text-input')===null,true);
 }
 // Generic visits consume none of the 64 retained-answer slots. A later real
 // ask identity remains answerable instead of inheriting session/null/0.
 await f.act(async()=>f.mounted.render(session()));
 await f.type('An identified later answer');await f.click('answer-send-button');
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].identity.id,'q1');
 assert.equal(f.requests[0].text,'An identified later answer');
});
test('terminal submissions preserve remote typing without inventing a shared question lifecycle',async t=>{
 const generic=session({pendingAsk:undefined}),f=await fixture(t,generic);
 await f.click('terminal-response-start');await f.type('First terminal answer','terminal-response-input');
 await f.act(async()=>{f.el('terminal-response-send').click();f.el('terminal-response-send').click()});
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].identity.terminalOnly,true);assert.equal(f.requests[0].identity.id,undefined);
 await f.act(async()=>f.requests[0].resolve({delivery:'handoff'}));
 assert.equal(f.el('terminal-response-input').disabled,true);
 await f.act(async()=>f.mounted.render(generic,false));await f.act(async()=>f.mounted.render(generic,true));
 assert.equal(f.el('terminal-response-input').value,'First terminal answer');assert.equal(f.el('terminal-response-send').disabled,true);
 await f.click('terminal-response-new');assert.equal(f.el('terminal-response-input').value,'');assert.equal(f.el('terminal-response-input').disabled,false);
 assert.match(f.el('terminal-response-saved').textContent,/First terminal answer/);
 await f.type('A distinct later response','terminal-response-input');await f.click('terminal-response-send');
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].text,'A distinct later response');assert.equal(f.requests[1].identity.terminalOnly,true);
});
test('uncertain terminal submission stays locked across reopen and only an explicit distinct response can send again',async t=>{
 const generic=session({pendingAsk:undefined}),f=await fixture(t,generic);
 await f.click('terminal-response-start');await f.type('Possibly typed','terminal-response-input');await f.click('terminal-response-send');
 await f.act(async()=>f.requests[0].reject(new Error('Network lost')));
 await f.act(async()=>f.mounted.render(generic,false));await f.act(async()=>f.mounted.render(generic,true));
 assert.equal(f.el('terminal-response-input').value,'Possibly typed');assert.equal(f.el('terminal-response-send').disabled,true);
 await f.click('terminal-response-send');assert.equal(f.requests.length,1);
 await f.click('terminal-response-new');
 assert.match(f.el('terminal-response-saved').textContent,/Possibly typed/);
 await f.type('Explicit new response','terminal-response-input');await f.click('terminal-response-send');assert.equal(f.requests.length,2);
});
test('new pairing cannot display or resurrect an older terminal submission',async t=>{
 const generic=session({pendingAsk:undefined}),f=await fixture(t,generic);
 await f.click('terminal-response-start');await f.type('Private old response','terminal-response-input');await f.click('terminal-response-send');
 f.w.localStorage.setItem('omp-remote-token','new-terminal-pairing');await f.act(async()=>f.mounted.render(generic));
 assert.equal(f.el('terminal-response-input')===null,true);assert.equal(f.el('terminal-response-saved')===null,true);
 await f.click('terminal-response-start');await f.type('New private response','terminal-response-input');
 await f.act(async()=>f.requests[0].resolve({delivery:'handoff'}));
 assert.equal(f.el('terminal-response-input').value,'New private response');assert.equal(f.el('terminal-response-input').disabled,false);assert.equal(f.el('terminal-response-saved')===null,true);
});
