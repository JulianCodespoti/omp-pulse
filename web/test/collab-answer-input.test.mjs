import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {CollabDialog} from ${JSON.stringify(resolve(root,'web/src/app/chat/CollabDialog.tsx'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
const calls=[],frames=[],pending=[],controllers=[];
function controller(path='/synthetic/a',online=true){
 const store=createOmpStore();store.setState({sessionPath:path});
 const sink=new OmpSessionController(store,'synthetic-question-token','http://synthetic.invalid');
 sink.runningAgentCount.stop();sink.stopOfflineTicker();sink.activeSession=path;sink.generation=1;
 sink.socket=online?{readyState:1,send:raw=>frames.push(JSON.parse(raw)),close(){this.readyState=3}}:null;
 controllers.push(sink);
 store.subscribe(state=>{const req=state.collabRequest;sink.currentCollabQuestion=req?{sessionPath:state.sessionPath,reqId:req.reqId,generation:'fixture',token:req.pulseQuestionToken}:null});
 return {actual:sink,getStore:()=>store,
   canRetainCollabAnswer:()=>sink.canRetainCollabAnswer(),
   setCollabAnswerDraft:(reqId,value,token)=>sink.setCollabAnswerDraft(reqId,value,token),
   sendCollabUiResponse(reqId,value,token){calls.push({reqId,value,token,path:store.getState().sessionPath});sink.sendCollabUiResponse(reqId,value,token)}};
}
window.fixture={act,calls,frames,pending,controller,dispose(){for(const c of controllers)c.dispose()},mount(c){const r=createRoot(document.getElementById('root'));const render=c=>r.render(h(CollabDialog,{controller:c,onPendingChange:value=>pending.push(value)}));render(c);return {render,unmount:()=>r.unmount()}}};
`,[{name:'controller-fixture-meta',transform(code,id){if(id.endsWith('/omp-session-controller.ts'))return code.replaceAll('import.meta',JSON.stringify({env:{VITE_PROTOCOL_VERSION:1,VITE_RELEASE_ID:'unit'}}));}}]);
const request=(extra={})=>({reqId:7,kind:'text',prompt:'Synthetic question',pulseQuestionToken:'fixture:'+(extra.reqId??7),...extra});
const question={sessionPath:'/synthetic/a',reqId:7,generation:'fixture',token:'fixture:7'};
async function fixture(t,{online=true,req=request()}={}){
 const dom=createDomFixture(code),w=dom.window,{act,calls,frames,pending}=w.fixture;
 w.WebSocket.OPEN=1;w.Element.prototype.getAnimations=()=>[];w.Element.prototype.scrollIntoView=()=>{};
 let c=w.fixture.controller('/synthetic/a',online),mounted;
 c.getStore().getState().setCollabRequest(req);
 await act(async()=>{mounted=w.fixture.mount(c)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());w.fixture.dispose();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const input=()=>w.document.querySelector('#collab-text-input');
 return {w,act,calls,frames,pending,input,store:()=>c.getStore(),controller:()=>c.actual,el:id=>w.document.querySelector(`[data-testid="${id}"]`),
 type:value=>act(async()=>{const proto=input().tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input(),value);input().dispatchEvent(new w.Event('input',{bubbles:true}))}),
 key:flags=>act(async()=>input().dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...flags}))),
 click:selector=>act(async()=>w.document.querySelector(selector).click()),
 update:state=>act(async()=>c.getStore().setState(state)),
 replace:async(path='/synthetic/a')=>act(async()=>{c=w.fixture.controller(path,online);c.getStore().getState().setCollabRequest(request());mounted.render(c)}),
 reopen:event=>act(async()=>w.dispatchEvent(new w.Event(event))),
 // The shared sheet unmounts after its exit animation.
 settle:()=>act(async()=>{await new Promise(r=>w.setTimeout(r,400))})};
}
for(const flags of [{isComposing:true},{keyCode:229}])test(`IME Enter ${JSON.stringify(flags)} keeps answer pending`,async t=>{
 const f=await fixture(t);await f.type('未確定');await f.key(flags);assert.equal(f.calls.length,0);assert.equal(f.input().value,'未確定');assert.ok(f.store().getState().collabRequest);
 await f.key({});assert.equal(f.calls.length,1);assert.equal(f.frames[0].value,'未確定');assert.equal(f.store().getState().collabRequest.reqId,7);assert.equal(f.store().getState().collabAnswer.phase,'sending');
});
for(const mode of ['session','controller'])test(`${mode} identity change clears draft with reused request id`,async t=>{
 const f=await fixture(t);await f.type('Old draft');if(mode==='session')await f.update({sessionPath:'/synthetic/b',collabRequest:request()});else await f.replace();
 assert.equal(f.input().value,'');await f.type('New answer');await f.key({});assert.equal(f.frames[0].value,'New answer');
});
for(const mode of ['session','controller','new-request'])test(`${mode} identity change opens a previously hidden question`,async t=>{
 const f=await fixture(t);await f.click('[data-testid="sheet-close"]');await f.settle();assert.equal(f.input()===null,true,'closing hides the sheet');assert.equal(f.store().getState().collabRequest!==null,true,'the question stays pending');
 if(mode==='session')await f.update({sessionPath:'/synthetic/b',collabRequest:request()});
 if(mode==='controller')await f.replace();
 if(mode==='new-request')await f.update({collabRequest:request({reqId:8})});
 assert.ok(f.input());assert.equal(f.calls.length,0);
});
for(const event of ['collab:show','collab-banner-tap'])test(`hide and ${event} reopen preserves this question's draft`,async t=>{
 const f=await fixture(t);await f.type('Keep draft');await f.click('[data-testid="sheet-close"]');assert.equal(f.calls.length,0);assert.ok(f.store().getState().collabRequest);
 await f.reopen(event);
 assert.equal(f.input().value,'Keep draft');assert.equal(f.calls.length,0);
});
test('same-owner request refresh and unrelated store update preserve draft',async t=>{
 const f=await fixture(t);await f.type('Keep draft');await f.update({collabRequest:request({prompt:'Refreshed question'}),partialLine:null});assert.equal(f.input().value,'Keep draft');
});
test('text button preserves exact value and keeps the online question through handoff',async t=>{
 const f=await fixture(t);await f.type('  Exact answer  ');await f.click('button[aria-label="Send answer"]');assert.equal(f.frames.length,1);assert.equal(f.frames[0].value,'  Exact answer  ');assert.equal(f.frames[0].reqId,7);assert.equal(f.frames[0].type,'collab-ui-response');assert.equal(f.store().getState().collabRequest.reqId,7);assert.equal(f.store().getState().collabAnswer.value,'  Exact answer  ');assert.equal(f.pending.at(-1),true);
});
for(const kind of ['choice','confirm'])test(`${kind} retains exact option value`,async t=>{
 const f=await fixture(t,{req:request({kind,options:[{label:'Yes (Recommended)',value:'yes'}]})});assert.equal(f.el('collab-option').textContent.includes('(Recommended)'),false);assert.ok(f.el('collab-recommended'));await f.click('[data-testid="collab-option"]');assert.equal(f.frames.length,1);assert.equal(f.frames[0].value,'yes');
});
test('a blank text answer cannot be sent by Enter or the button; sending shows its state',async t=>{
 const f=await fixture(t);await f.key({});assert.equal(f.calls.length,0);
 assert.equal(f.w.document.querySelector('button[aria-label="Send answer"]').disabled,true);
 await f.type('   ');await f.key({});assert.equal(f.calls.length,0);assert.equal(f.w.document.querySelector('button[aria-label="Send answer"]').disabled,true);
 await f.type('Real');await f.click('button[aria-label="Send answer"]');assert.equal(f.calls.length,1);
 assert.match(f.w.document.querySelector('button[aria-label="Sending answer"]').textContent,/Sending…/);
});
test('explicit cancellation sends null without pretending transport submission is acceptance',async t=>{
 const f=await fixture(t);await f.click('[data-testid="collab-skip"]');assert.equal(f.frames[0].value === null, true);assert.equal(f.store().getState().collabRequest.reqId,7);assert.equal(f.store().getState().collabAnswer.phase,'sending');
});
test('offline answer stays held and disabled through hide/reopen',async t=>{
 const f=await fixture(t,{online:false});await f.type('Hold this');await f.key({});assert.equal(f.calls.length,1);assert.equal(f.frames.length,0);assert.equal(f.store().getState().heldCollabResponse.value,'Hold this');assert.ok(f.store().getState().collabRequest);assert.ok(f.el('collab-held'));assert.equal(f.input().disabled,true);
 await f.click('[data-testid="sheet-close"]');await f.reopen('collab:show');assert.equal(f.input().value,'Hold this');assert.equal(f.input().disabled,true);await f.click('[data-testid="collab-skip"]');assert.equal(f.calls.length,1);
 // With the question gone the held answer is the track strip's to show.
 await f.update({collabRequest:null});assert.equal(f.el('collab-dialog')===null,true);
});
test('non-Enter input does not submit',async t=>{
 const f=await fixture(t);await f.type('Draft');await f.key({key:'a'});assert.equal(f.calls.length,0);assert.equal(f.input().value,'Draft');
});
test('a new request id resets the previous draft',async t=>{
 const f=await fixture(t);await f.type('Old draft');await f.update({collabRequest:request({reqId:8})});assert.equal(f.input().value,'');await f.type('New');await f.key({});assert.equal(f.frames[0].reqId,8);
});
test('held Enter cannot answer the next question through key repeat',async t=>{
 const f=await fixture(t);await f.type('First answer');await f.key({});assert.equal(f.frames.length,1);assert.equal(f.store().getState().collabRequest.reqId,7);
 await f.update({collabRequest:request({reqId:8,prompt:'Second question'})});await f.key({repeat:true});assert.equal(f.frames.length,1);assert.equal(f.store().getState().collabRequest.reqId,8);
 await f.type('Second answer');await f.key({});assert.equal(f.frames.length,2);assert.equal(f.frames[1].reqId,8);assert.equal(f.frames[1].value,'Second answer');
});
test('temporary request replay gap keeps the same draft and hidden choice',async t=>{
 const f=await fixture(t);await f.type('Keep through reconnect');await f.click('[data-testid="sheet-close"]');
 await f.update({collabRequest:null});await f.update({collabRequest:request()});await f.settle();assert.equal(f.input()===null,true);
 await f.reopen('collab:show');assert.equal(f.input().value,'Keep through reconnect');
});
test('refusal and queued statuses preserve text and disable only outstanding handoffs',async t=>{
 const f=await fixture(t);await f.type('Exact draft');
 await f.update({collabAnswer:{sessionPath:'/synthetic/a',reqId:7,value:'Exact draft',phase:'queued',question}});assert.equal(f.input().disabled,true);assert.ok(f.el('collab-held').textContent.includes('Waiting for the desktop'));
 await f.update({collabAnswer:{sessionPath:'/synthetic/a',reqId:7,value:'Exact draft',phase:'rejected',reason:'view-only link',question}});assert.equal(f.input().disabled,false);assert.equal(f.input().value,'Exact draft');assert.ok(f.el('collab-held').textContent.includes('view-only link'));
 await f.update({collabAnswer:{sessionPath:'/synthetic/a',reqId:7,value:'Exact draft',phase:'unavailable',reason:'that question is no longer waiting',question}});assert.equal(f.input().disabled,true);
});
test('a reused reqId with a new daemon token opens a clean draft and does not inherit an old held lock',async t=>{
 const f=await fixture(t,{online:false});await f.type('Old uncertain draft');await f.key({});
 await f.click('[data-testid="sheet-close"]');await f.settle();
 await f.update({collabRequest:request({pulseQuestionToken:'new-daemon:7'})});
 assert.ok(f.input());assert.equal(f.input().value,'');assert.equal(f.input().disabled,false);
 await f.type('Distinct new answer');await f.key({});
 assert.equal(f.store().getState().collabAnswer.value,'Distinct new answer');
 assert.equal(f.store().getState().collabAnswer.question.token,'new-daemon:7');
});
test('draft capacity disables a new question until exact closure frees a slot without eviction',async t=>{
 const f=await fixture(t);
 for(let id=1;id<=64;id++){
   await f.update({collabRequest:request({reqId:id})});await f.type('Draft '+id);
 }
 assert.equal(f.controller().collabAnswers.size,64);assert.equal(f.calls.length,0);
 await f.update({collabRequest:request({reqId:65})});
 assert.equal(f.input().disabled,true);assert.equal(f.controller().collabAnswers.size,64);
 const raw=id=>({reqId:id,kind:'editor',title:'Question '+id,pulseRoomId:'fixture-room',pulseQuestionToken:'fixture:'+id});
 const event=event=>f.act(async()=>f.controller().handleEventFrame({type:'event',event},f.controller().generation,f.controller().activeSession));
 const lifecycle=revision=>({sessionPath:'/synthetic/a',generation:'fixture',revision});
 await event({type:'collab_ui_snapshot',complete:true,lifecycle:lifecycle(1),requests:Array.from({length:65},(_,index)=>raw(index+1))});
 assert.equal(f.input().disabled,true);
 await event({type:'collab_ui_request_end',reqId:1,pulseQuestionToken:'fixture:1',lifecycle:lifecycle(2)});
 assert.equal(f.input().disabled,false);
 await f.type('New retained draft');assert.equal(f.controller().collabAnswers.size,64);
 await event({type:'collab_ui_request',request:raw(64),lifecycle:lifecycle(3)});
 assert.equal(f.input().value,'Draft 64');assert.equal(f.input().disabled,false);assert.equal(f.frames.length,0);
});

test('desktop editor starts with an editable multiline draft and sends it unchanged',async t=>{
 const f=await fixture(t,{req:request({kind:'editor',initialValue:'First line\nSecond line'})});
 assert.equal(f.input().tagName,'TEXTAREA');assert.equal(f.input().value,'First line\nSecond line');
 await f.key({});assert.equal(f.calls.length,0,'Enter edits rather than submitting');
 await f.click('button[aria-label="Send answer"]');
 assert.equal(f.frames[0].value,'First line\nSecond line');
});
test('cleared editor draft stays empty through hide and replay instead of restoring supplied text',async t=>{
 const req=request({kind:'editor',initialValue:'Supplied draft'});
 const f=await fixture(t,{req});await f.type('');
 await f.click('[data-testid="sheet-close"]');await f.reopen('collab:show');
 await f.update({collabRequest:{...req}});assert.equal(f.input().value,'');
 await f.click('button[aria-label="Send answer"]');assert.equal(f.frames[0].value,'');
});
test('editor cancellation remains null and new question token receives its own supplied draft',async t=>{
 const f=await fixture(t,{req:request({kind:'editor',initialValue:'Old draft'})});
 await f.click('[data-testid="collab-skip"]');assert.equal(f.frames[0].value,null);
 await f.update({collabRequest:request({kind:'editor',initialValue:'New\ntext',pulseQuestionToken:'new-editor-token'})});
 assert.equal(f.input().value,'New\ntext');assert.equal(f.input().disabled,false);
});

test('native checkbox loop shows only host-confirmed toggles and separates trailing actions without label guessing',async t=>{
 const f=await fixture(t);
 const controller=f.controller();
 const event=event=>f.act(async()=>controller.handleEventFrame({type:'event',event},controller.generation,controller.activeSession));
 const lifecycle=revision=>({sessionPath:'/synthetic/a',generation:'fixture',revision});
 // "Done" is deliberately a real selectable option; its text cannot make it an action.
 const raw=(id,checked)=>({reqId:id,pulseQuestionToken:`fixture:${id}`,kind:'select',title:'Which changes? (1/2)',
   selectionMarker:'checkbox',checkedIndices:checked,markableCount:2,
   options:[{label:'Done',description:'A real option'},'Web',...(checked.length?['Continue']:[]),'Other']});
 await event({type:'collab_ui_snapshot',complete:true,lifecycle:lifecycle(1),requests:[raw(7,[])]});
 const toggles=()=>[...f.w.document.querySelectorAll('[data-collab-action="toggle"]')];
 assert.deepEqual(toggles().map(row=>row.getAttribute('aria-checked')),['false','false']);
 assert.equal(toggles()[0].textContent.includes('Done'),true);
 assert.equal(f.el('collab-selection-actions').querySelectorAll('button').length,1);
 await f.act(async()=>{toggles()[0].click();toggles()[0].click()});
 assert.equal(f.frames.length,1);assert.equal(f.frames[0].value,'Done');
 assert.equal(toggles()[0].getAttribute('aria-checked'),'false','no optimistic selected state');
 assert.equal(toggles()[0].disabled,true);
 await event({type:'collab_ui_request_end',reqId:7,pulseQuestionToken:'fixture:7',lifecycle:lifecycle(2)});
 await event({type:'collab_ui_request',request:raw(8,[0]),lifecycle:lifecycle(3)});
 assert.deepEqual(toggles().map(row=>row.getAttribute('aria-checked')),['true','false']);
 assert.equal(f.el('collab-selection-actions').querySelectorAll('button').length,2);
 assert.equal(f.el('collab-selection-actions').querySelector('[role="checkbox"]'),null);
 await f.act(async()=>toggles()[0].click());
 assert.equal(f.frames[1].value,'Done','same native label toggles off');
 await event({type:'collab_ui_request_end',reqId:8,pulseQuestionToken:'fixture:8',lifecycle:lifecycle(4)});
 await event({type:'collab_ui_request',request:raw(9,[]),lifecycle:lifecycle(5)});
 assert.equal(toggles()[0].getAttribute('aria-checked'),'false');
 await f.act(async()=>toggles()[1].click());
 await event({type:'collab_ui_request_end',reqId:9,pulseQuestionToken:'fixture:9',lifecycle:lifecycle(6)});
 await event({type:'collab_ui_request',request:raw(10,[1]),lifecycle:lifecycle(7)});
 await f.act(async()=>f.el('collab-selection-actions').querySelector('button').click());
 assert.equal(f.frames.at(-1).reqId,10);assert.equal(f.frames.at(-1).value,'Continue');
 assert.ok(f.store().getState().collabRequest,'Continue still waits for exact host end');
});
