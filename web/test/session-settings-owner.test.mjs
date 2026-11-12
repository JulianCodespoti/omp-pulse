import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {SessionSettingsSheet} from ${JSON.stringify(resolve(root,'web/src/app/tools/SessionSettingsSheet.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import {useCompaction} from ${JSON.stringify(resolve(root,'web/src/app/chat/CompactPill.tsx'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
const reads=[],writes=[],compacts=[],states=[];
DaemonApi.prototype.getState=(path)=>new Promise((resolve,reject)=>reads.push({path,resolve,reject}));
DaemonApi.prototype.setFastMode=(...args)=>new Promise((resolve,reject)=>writes.push({args,resolve,reject}));
DaemonApi.prototype.compact=(path,instructions)=>new Promise((resolve,reject)=>compacts.push({path,instructions,resolve,reject}));
const modeWrites=[];
for(const name of ['setSteeringMode','setFollowUpMode','setInterruptMode'])DaemonApi.prototype[name]=function(...args){return new Promise((resolve,reject)=>modeWrites.push({name,args,resolve,reject}))};
const store=createOmpStore();store.setState({sessionPath:'/synthetic/a',sessionModel:{model:'m',contextWindow:1000,ctxPercent:45}});
function Focused(){const compaction=useCompaction(store,store.getState().sessionPath);window.runFocused=compaction.run;window.focusedPhase=compaction.phase;return null}
window.fixture={act,reads,writes,compacts,states,modeWrites,mount(){
 const r=createRoot(document.getElementById('root'));
 let props={open:true,sessionPath:'/synthetic/a',onOpenChange:()=>{},onStateChanged:s=>states.push(s)};
 const render=(change={})=>{props={...props,...change};store.setState({sessionPath:props.sessionPath});r.render(h('div',null,h(SessionSettingsSheet,props),props.focused?h(Focused):null))};render();
 return{render,unmount:()=>r.unmount()}
}};
`);
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,{act,reads,writes,compacts,states}=w.fixture;w.Element.prototype.getAnimations=()=>[];
 // The 12 s settings bound is captured instead of armed; other timers run normally.
 const bounds=[],polls=new Map(),setTimer=w.setTimeout.bind(w),clearTimer=w.clearTimeout.bind(w);let nextPoll=-1000;
 w.setTimeout=(fn,ms,...rest)=>ms===12000?(bounds.push(fn),-bounds.length):ms===4000?(polls.set(--nextPoll,fn),nextPoll):setTimer(fn,ms,...rest);
 w.clearTimeout=id=>{if(!polls.delete(id))clearTimer(id)};
 let r,dead=false;await act(async()=>{r=w.fixture.mount()});
 const unmount=async()=>{if(!dead){dead=true;await act(async()=>r.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===text);
 const respond=(i,data={thinkingLevel:'medium',fastModeEnabled:false,autoRetryEnabled:true})=>act(async()=>reads[i].resolve(data));
 const {modeWrites}=w.fixture;
 return{w,act,bounds,reads,writes,compacts,states,button,unmount,respond,
 tick:()=>act(async()=>{const callbacks=[...polls.values()];polls.clear();for(const fn of callbacks)fn()}),
 render:p=>act(async()=>r.render(p)),
 click:text=>act(async()=>{assert.ok(button(text),text);button(text).click()}),
 fast:()=>act(async()=>w.document.querySelector('#fast-mode').click()),
 finishWrite:i=>act(async()=>writes[i].resolve()),
 finishCompact:i=>act(async()=>compacts[i].resolve({tokensBefore:123})),
 text:()=>w.document.body.textContent,
 modeWrites,
 picked:id=>w.document.querySelector(`[data-testid="setting-${id}"] [aria-checked="true"]`)?.textContent};
}
test('old settings read cannot replace new session or report its model state',async t=>{const f=await fixture(t);await f.render({sessionPath:'/synthetic/b'});await f.respond(1,{thinkingLevel:'high',steeringMode:'one-at-a-time'});await f.respond(0,{thinkingLevel:'low',steeringMode:'all'});assert.equal(f.states.length,1);assert.equal(f.states[0].thinkingLevel,'high');assert.equal(f.picked('steering'),'One by one')});
test('old read error cannot replace current loading state',async t=>{const f=await fixture(t);await f.render({sessionPath:'/synthetic/b'});await f.act(async()=>f.reads[0].reject(new Error('Old failure')));assert.ok(f.text().includes('Loading settings'));assert.equal(f.text().includes('Old failure'),false)});
test('same session close reopen rejects previous read',async t=>{const f=await fixture(t);await f.render({open:false});await f.render({open:true});await f.respond(1);await f.respond(0);assert.equal(f.states.length,1)});
test('repeated compact confirmation issues one request',async t=>{const f=await fixture(t);await f.respond(0);await f.click('Compact now');await f.act(async()=>{const b=f.button('Compact');b.click();b.click()});assert.equal(f.compacts.length,1)});
test('compaction disables competing setting writes',async t=>{const f=await fixture(t);await f.respond(0);await f.click('Compact now');await f.click('Compact');await f.fast();assert.equal(f.writes.length,0)});
test('late setting completion cannot refresh or publish into another session',async t=>{const f=await fixture(t);await f.respond(0);f.states.length=0;await f.fast();await f.render({sessionPath:'/synthetic/b'});await f.respond(1);await f.finishWrite(0);assert.equal(f.reads.length,2);assert.equal(f.states.length,1)});
test('dismissed compaction cannot start another state read',async t=>{const f=await fixture(t);await f.respond(0);await f.click('Compact now');await f.click('Compact');await f.render({open:false});await f.finishCompact(0);assert.equal(f.reads.length,1)});
test('unmounted setting write cannot publish or refresh',async t=>{const f=await fixture(t);await f.respond(0);f.states.length=0;await f.fast();await f.unmount();await f.finishWrite(0);assert.equal(f.states.length,0);assert.equal(f.reads.length,1)});
test('current setting write refreshes once and publishes acknowledged state',async t=>{const f=await fixture(t);await f.respond(0);f.states.length=0;await f.fast();assert.deepEqual(Array.from(f.writes[0].args),['/synthetic/a',true]);await f.finishWrite(0);assert.equal(f.reads.length,2);await f.respond(1,{fastModeEnabled:true,thinkingLevel:'high'});assert.equal(f.states.length,2);assert.equal(f.w.document.querySelector('#fast-mode').checked,true)});
test('current failed setting write releases controls without retry',async t=>{const f=await fixture(t);await f.respond(0);await f.fast();await f.act(async()=>f.writes[0].reject(new Error('Synthetic failure')));assert.equal(f.writes.length,1);assert.equal(f.w.document.querySelector('#fast-mode').disabled,false);assert.ok(f.text().includes('Synthetic failure'))});
test('old finally cannot unlock current session mutation',async t=>{const f=await fixture(t);await f.respond(0);await f.fast();await f.render({sessionPath:'/synthetic/b'});await f.respond(1);await f.fast();await f.finishWrite(0);assert.equal(f.w.document.querySelector('#fast-mode').disabled,true);assert.equal(f.reads.length,2);await f.finishWrite(1);await f.respond(2);assert.equal(f.w.document.querySelector('#fast-mode').disabled,false)});
test('repeated setting toggle in same event batch issues one request',async t=>{const f=await fixture(t);await f.respond(0);await f.act(async()=>{const b=f.w.document.querySelector('#fast-mode');b.click();b.click()});assert.equal(f.writes.length,1)});
test('header close prevents late read from publishing state',async t=>{const f=await fixture(t);await f.act(async()=>{f.w.document.querySelector('button[aria-label="Close"]').click();f.reads[0].resolve({thinkingLevel:'high'})});assert.equal(f.states.length,0)});
test('callback replacement does not restart loading and receives current result',async t=>{const f=await fixture(t);const changed=[];await f.render({onStateChanged:s=>changed.push(s)});assert.equal(f.reads.length,1);await f.respond(0);assert.equal(changed.length,1);assert.equal(f.states.length,0)});
test('current compact refreshes and releases controls once',async t=>{const f=await fixture(t);await f.respond(0);await f.click('Compact now');await f.click('Compact');await f.finishCompact(0);assert.equal(f.reads.length,2);assert.ok(f.text().includes('123 tokens before'));await f.respond(1);assert.equal(f.button('Compact now').disabled,false)});
test('a settings read past its 12 s bound shows the load Notice and Retry issues a new read',async t=>{const f=await fixture(t);assert.ok(f.text().includes('Loading settings'));assert.equal(f.bounds.length,1);await f.act(async()=>f.bounds[0]());assert.equal(f.text().includes('Loading settings'),false);assert.ok(f.text().includes('Couldn’t load settings.'));assert.ok(f.text().includes('Your computer didn’t answer. The session may still be starting.'));await f.respond(0,{thinkingLevel:'high'});assert.equal(f.states.length,0,'abandoned read stays ignored');assert.ok(f.text().includes('Couldn’t load settings.'));await f.click('Retry');assert.equal(f.reads.length,2);assert.ok(f.text().includes('Loading settings'));await f.respond(1,{thinkingLevel:'high',interruptMode:'wait'});assert.equal(f.states.length,1);assert.equal(f.picked('interrupt'),'Wait for step')});

test('settings and focused compaction share an uncertain mutation until an authoritative context drop',async t=>{
 const f=await fixture(t);await f.respond(0,{contextUsage:{percent:45,tokens:450},fastModeEnabled:false});
 await f.render({focused:true});await f.click('Compact now');await f.click('Compact');
 await f.act(async()=>f.compacts[0].reject(new Error('network request timed out')));
 assert.equal(f.w.focusedPhase.kind,'uncertain');
 assert.equal(f.button('Compact now').disabled,true);
 assert.equal(f.w.document.querySelector('[data-testid="settings-compact-outcome"]').getAttribute('data-tone'),'info');
 await f.act(async()=>{await f.w.runFocused('Must not issue another mutation')});
 assert.equal(f.compacts.length,1);
 await f.tick();await f.respond(1,{contextUsage:{percent:45,tokens:450}});
 assert.equal(f.w.focusedPhase.kind,'uncertain');
 await f.tick();await f.respond(2,{contextUsage:{percent:9,tokens:90},fastModeEnabled:false});
 assert.equal(f.w.focusedPhase.kind,'done');assert.equal(f.w.focusedPhase.after,9);
 assert.equal(f.button('Compact now').disabled,false);assert.equal(f.compacts.length,1);
});

test('focused instructions use the same settings outcome and survive a lost acknowledgement without rerunning',async t=>{
 const f=await fixture(t);await f.respond(0,{contextUsage:{percent:45},fastModeEnabled:false});await f.render({focused:true});
 await f.act(async()=>{void f.w.runFocused('Keep the deployment constraints')});
 assert.equal(f.compacts[0].instructions,'Keep the deployment constraints');
 assert.equal(f.button('Compact now').disabled,true);
 await f.act(async()=>f.compacts[0].reject(new Error('Failed to fetch')));
 assert.equal(f.w.focusedPhase.kind,'uncertain');
 await f.click('Compact now');assert.equal(f.compacts.length,1);
 await f.tick();await f.respond(1,{contextUsage:{percent:0,tokens:0}});
 assert.equal(f.w.focusedPhase.kind,'done');assert.equal(f.w.focusedPhase.after,0);
 assert.equal(f.w.document.querySelector('[data-testid="settings-compact-outcome"]').getAttribute('data-tone'),'success');
});

test('uncertain settings operation survives dismissal and resumes by reading, not repeating compact',async t=>{
 const f=await fixture(t);await f.respond(0,{contextUsage:{percent:45},fastModeEnabled:false});
 await f.click('Compact now');await f.click('Compact');await f.act(async()=>f.compacts[0].reject(new Error('Network error')));
 await f.render({open:false});await f.tick();assert.equal(f.reads.length,1);
 await f.render({open:true});await f.respond(1,{contextUsage:{percent:45},fastModeEnabled:false});
 assert.equal(f.button('Compact now').disabled,true);await f.click('Compact now');assert.equal(f.compacts.length,1);
 await f.tick();await f.respond(2,{contextUsage:{percent:5},fastModeEnabled:false});
 assert.equal(f.button('Compact now').disabled,false);assert.equal(f.compacts.length,1);
});

test('missing initial fill still reconciles observed compaction end instead of allowing a duplicate',async t=>{
 const f=await fixture(t);await f.respond(0,{fastModeEnabled:false});
 await f.click('Compact now');await f.click('Compact');await f.act(async()=>f.compacts[0].reject(new Error('Timed out')));
 await f.tick();await f.respond(1,{isCompacting:true});
 assert.equal(f.button('Compact now').disabled,true);
 await f.tick();await f.respond(2,{isCompacting:false,contextUsage:{percent:8}});
 assert.equal(f.button('Compact now').disabled,false);assert.equal(f.compacts.length,1);
 assert.equal(f.w.document.querySelector('[data-testid="settings-compact-outcome"]').getAttribute('data-tone'),'success');
});

test('a real compaction refusal releases controls and is not an uncertain operation',async t=>{
 const f=await fixture(t);await f.respond(0);await f.render({focused:true});
 await f.act(async()=>{void f.w.runFocused('Focus')});
 await f.act(async()=>f.compacts[0].reject(new Error('Nothing to compact (too small)')));
 assert.equal(f.w.focusedPhase.kind,'refused');assert.equal(f.button('Compact now').disabled,false);
 await f.tick();assert.equal(f.reads.length,1);assert.equal(f.compacts.length,1);
});

test('a late compact refresh cannot replace the new generation after A → B → A',async t=>{
 const f=await fixture(t);await f.respond(0,{contextUsage:{percent:45},fastModeEnabled:false});
 await f.click('Compact now');await f.click('Compact');await f.finishCompact(0);
 assert.equal(f.reads.length,2);
 await f.render({sessionPath:'/synthetic/b'});await f.respond(2,{fastModeEnabled:false});
 await f.render({sessionPath:'/synthetic/a'});await f.respond(3,{contextUsage:{percent:40},fastModeEnabled:false});
 await f.click('Compact now');await f.click('Compact');assert.equal(f.compacts.length,2);
 await f.respond(1,{contextUsage:{percent:1},fastModeEnabled:true});
 assert.equal(f.w.document.querySelector('#fast-mode').checked,false);
 assert.equal(f.button('Compact now').disabled,true);
});

test('credential replacement fences compaction completion and its refresh from the current settings visit',async t=>{
 const f=await fixture(t);await f.respond(0,{contextUsage:{percent:45},fastModeEnabled:false});
 await f.click('Compact now');await f.click('Compact');f.states.length=0;
 f.w.localStorage.setItem('omp-remote-token','replacement-credential');
 await f.finishCompact(0);
 assert.equal(f.reads.length,1);assert.equal(f.states.length,0);
 await f.render({});await f.respond(1,{contextUsage:{percent:70},fastModeEnabled:false});
 assert.equal(f.button('Compact now').disabled,false);
 assert.equal(f.w.document.querySelector('[data-testid="settings-compact-outcome"]')===null,true);
 assert.equal(f.states.length,1);
});

test('desktop message modes show exact owner values without enabling changes',async t=>{
 const f=await fixture(t);
 await f.respond(0,{settingsReadOnly:true,steeringMode:'one-at-a-time',followUpMode:'all',interruptMode:'wait'});
 for(const [id,label] of [['steering','One by one'],['follow-up','All at once'],['interrupt','Wait for step']]){
  assert.equal(f.picked(id),label);
  for(const radio of f.w.document.querySelectorAll(`[data-testid="setting-${id}"] button`))assert.equal(radio.disabled,true);
 }
 assert.equal(f.text().includes('set on your computer'),true);
});
test('unreported and invalid delivery modes are explicitly unavailable, never defaulted',async t=>{
 const f=await fixture(t);await f.respond(0,{steeringMode:null,followUpMode:'unknown'});
 for(const id of ['steering','follow-up','interrupt']){
  assert.equal(f.picked(id),undefined,id+' shows no selected segment');
  for(const radio of f.w.document.querySelectorAll(`[data-testid="setting-${id}"] button`))assert.equal(radio.disabled,true);
 }
 assert.equal(f.text().includes('Not reported for this session.'),true);
});
test('a Messages choice changes through its inline control and sends omp’s own value',async t=>{
 const f=await fixture(t);
 await f.respond(0,{steeringMode:'one-at-a-time',followUpMode:'one-at-a-time',interruptMode:'immediate'});
 assert.equal(f.w.document.querySelector('[data-testid="setting-options"]'),null,'no nested option sheet');
 for(const [i,[id,label,value]] of [['steering','All at once','all'],['follow-up','All at once','all'],['interrupt','Wait for step','wait']].entries()){
  await f.act(async()=>f.w.document.querySelector(`[data-testid="setting-${id}"] [data-value="${value}"]`).click());
  assert.equal(f.w.document.querySelector('[data-testid="setting-options"]'),null);
  assert.deepEqual(Array.from(f.modeWrites[i].args),['/synthetic/a',value],id);
  await f.act(async()=>f.modeWrites[i].resolve());
  await f.respond(i+1,{steeringMode:id==='steering'?value:'one-at-a-time',followUpMode:id==='follow-up'?value:'one-at-a-time',interruptMode:id==='interrupt'?value:'immediate'});
  assert.equal(f.picked(id),label);
 }
 assert.deepEqual(Array.from(f.modeWrites,w=>w.name),['setSteeringMode','setFollowUpMode','setInterruptMode']);
});
test('Compact asks in place, never in a second sheet',async t=>{
 const f=await fixture(t);await f.respond(0,{contextUsage:{percent:45}});
 await f.click('Compact now');
 assert.ok(f.w.document.querySelector('[data-testid="settings-compact-confirm"]'));
 assert.equal(f.w.document.querySelectorAll('[role="dialog"]').length,1);
 await f.click('Cancel');
 assert.ok(f.button('Compact now'));assert.equal(f.compacts.length,0);
});
