import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
import {agentsTabHarness} from './support/agents-tab.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(agentsTabHarness(require)+`
import {act} from ${JSON.stringify(require.resolve('react'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
const requests=[],actions=[],intervals=new Map();let timer=0;
window.setInterval=(fn,ms)=>{intervals.set(++timer,{fn,ms});return timer};
window.clearInterval=id=>intervals.delete(id);
DaemonApi.prototype.getDesktopAgentRoster = async () => { throw Object.assign(new Error('Synthetic no desktop read lease'), { code: 'host_unavailable' }); };
DaemonApi.prototype.getSubagents=session=>new Promise((resolve,reject)=>requests.push({session,resolve,reject}));
for(const method of ['steerSubagent','cancelSubagent','collabAttach'])DaemonApi.prototype[method]=(...args)=>new Promise((resolve,reject)=>actions.push({method,args,resolve,reject}));
const store=createOmpStore(),otherStore=createOmpStore();
for (const fixtureStore of [store,otherStore]) fixtureStore.setState({ connection: 'open', sessionAuthorities: Object.fromEntries(['/synthetic/a','/synthetic/b','/synthetic/steer'].map(path => [path, { owner: { kind: 'child' }, confidence: 'confirmed', connection: 'connected' }])) });
const hosts=[agentsTab.host({getStore:()=>store}),agentsTab.host({getStore:()=>otherStore})];
window.fixture={act,requests,actions,intervals,store,mount:(strict=false)=>agentsTab.mount({hosts,strict})};
`);
const SHARE='Ask your computer to share';
async function fixture(t,strict=false){
 const dom=createDomFixture(code),w=dom.window,{act,requests,actions,intervals}=w.fixture;
 w.Element.prototype.getAnimations=()=>[];
 w.fetch=async url=>{assert.match(String(url),/^\/api\/agents\?/);return{ok:true,json:async()=>({agents:[]})}};
 let mounted,unmounted=false;await act(async()=>{mounted=w.fixture.mount(strict)});
 const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>mounted.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,requests,actions,unmount,render:(...args)=>act(async()=>mounted.render(...args)),
 closePanel:()=>act(async()=>w.agentsTab.close()),
 text:()=>w.document.body.textContent,
 button:label=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label),
 input:()=>w.document.querySelector('input[placeholder="Redirect the agent…"]'),
 type:text=>act(async()=>{const input=w.document.querySelector('input[placeholder="Redirect the agent…"]');assert.ok(input);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,text);input.dispatchEvent(new w.Event('input',{bubbles:true}));}),
 failAction:(i,message='Synthetic action failure')=>act(async()=>actions[i].reject(new Error(message))),
 click:label=>act(async()=>{const b=[...w.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);assert.ok(b,label);b.click()}),
 tick:()=>act(async()=>{for(const {fn,ms} of [...intervals.values()])if(ms===3000)fn()}),
 respond:(i,name='Current agent',status='done')=>act(async()=>requests[i].resolve({agents:[{id:'same',name,status}]})),
 reject:(i,message='Synthetic list failure')=>act(async()=>requests[i].reject(new Error(message))),
 finishAction:i=>act(async()=>actions[i].resolve({})),
 };
}
const transition = async (f, kind) => {
 if(kind==='session') await f.render(true,'/synthetic/b');
 else if(kind==='controller') await f.render(true,'/synthetic/a',1);
 else { await f.render(false); await f.render(true); }
};
async function start(f,method) {
 if(method==='collabAttach') { await f.reject(f.requests.length-1,'session_owned_by_terminal'); await f.click(SHARE); }
 else { await f.respond(f.requests.length-1,'Running agent','running');
  if(method==='steerSubagent') { await f.click('Redirect'); await f.type('Old direction'); await f.click('Send'); }
  else await f.click('Stop agent');
 }
}
for(const method of ['steerSubagent','cancelSubagent','collabAttach']) {
 for(const kind of ['session','reopen','controller']) {
  for(const message of ['Synthetic action failure','session_owned_by_terminal']) test(`${method}: ${kind} rejects stale ${message} feedback`,async t=>{
   const f=await fixture(t);await start(f,method);await transition(f,kind);
   if(method==='collabAttach') await f.reject(1,'session_owned_by_terminal'); else await f.respond(1,'New running agent','running');
   const before=f.text();
   await f.failAction(0,message);
   assert.equal(f.text(),before);
   if(method==='collabAttach') {assert.ok(f.button(SHARE));assert.ok(!f.text().includes('Synthetic action failure'));}
   else {assert.ok(f.button('Redirect'));assert.ok(f.text().includes('New running agent'));assert.ok(!f.text().includes('Synthetic action failure'));}
  });
  test(`${method}: ${kind} resets pending and obsolete finally cannot unlock new work`,async t=>{
   const f=await fixture(t);await start(f,method);await transition(f,kind);await start(f,method);
   assert.equal(f.actions.length,2,'new visit must allow an operation');
   await f.finishAction(0);
   const pending=method==='collabAttach'?f.button('Asking…'):method==='steerSubagent'?f.button('Send'):f.button('Stop agent');
   assert.ok(pending);assert.equal(pending.disabled,true);
   if(method==='collabAttach')assert.ok(!f.text().includes('Sharing requested.'));
   if(method==='steerSubagent')assert.equal(f.input().value,'Old direction');
   assert.equal(f.requests.length,2,'obsolete success must not refresh');
  });
 }
 test(`${method}: same-turn duplicate activation issues only one RPC`,async t=>{
  const f=await fixture(t);
  if(method==='collabAttach')await f.reject(0,'session_owned_by_terminal');
  else {await f.respond(0,'Running agent','running');if(method==='steerSubagent'){await f.click('Redirect');await f.type('Direction');}}
  const label=method==='collabAttach'?SHARE:method==='steerSubagent'?'Send':'Stop agent';
  await f.act(async()=>{const b=f.button(label);b.click();b.click();});
  assert.equal(f.actions.length,1);
 });
 test(`${method}: closing the workspace makes completions inert`,async t=>{
  const f=await fixture(t);await start(f,method);await f.closePanel();await f.failAction(0);
  assert.ok(!f.text().includes('Synthetic action failure'));assert.equal(f.requests.length,1);await f.unmount();
 });
 test(`${method}: current failure releases guard and remains retryable`,async t=>{
  const f=await fixture(t);await start(f,method);await f.failAction(0);
  assert.ok(f.text().includes('Synthetic action failure'));
  await f.click(method==='collabAttach'?SHARE:method==='steerSubagent'?'Send':'Stop agent');assert.equal(f.actions.length,2);
 });
}
test('new visit clears steering draft and previous action error',async t=>{
 const f=await fixture(t);await start(f,'steerSubagent');await f.failAction(0);await f.render(true,'/synthetic/b');await f.respond(1,'New agent','running');
 assert.equal(f.input() === null, true);assert.ok(!f.text().includes('Synthetic action failure'));await f.click('Redirect');assert.equal(f.input().value,'');
});
test('current steer success clears editor and stop refresh releases pending',async t=>{
 const f=await fixture(t);await start(f,'steerSubagent');await f.finishAction(0);assert.equal(f.input() === null, true);
 await f.click('Stop agent');await f.finishAction(1);assert.equal(f.requests.length,2);await f.respond(1,'Still running','running');assert.equal(f.button('Stop agent').disabled,false);
});
for(const method of ['steerSubagent','cancelSubagent','collabAttach']) {
 test(`${method}: unmounted operation cannot launch followup work`,async t=>{
  const f=await fixture(t);await start(f,method);await f.unmount();await f.finishAction(0);assert.equal(f.requests.length,1);
 });
 test(`${method}: StrictMode replay permits current action completion`,async t=>{
  const f=await fixture(t,true);await start(f,method);assert.equal(f.actions.length,1);await f.failAction(0);assert.ok(f.text().includes('Synthetic action failure'));
 });
}
test('share success keeps feedback and pending through its list refresh',async t=>{
 const f=await fixture(t);await start(f,'collabAttach');await f.finishAction(0);assert.equal(f.requests.length,2);
 await f.reject(1,'session_owned_by_terminal');assert.ok(f.text().includes('Sharing requested. Agents appear when your computer sends its list.'));assert.equal(f.button(SHARE).disabled,false);
});
for(const method of ['cancelSubagent','collabAttach'])test(`${method}: old refresh completion cannot unlock a new operation`,async t=>{
 const f=await fixture(t);await start(f,method);await f.finishAction(0);assert.equal(f.requests.length,2);
 await f.render(true,'/synthetic/b');await start(f,method);assert.equal(f.actions.length,2);
 await f.respond(1,'Old refresh','running');assert.equal(f.button(method==='collabAttach'?'Asking…':'Stop agent').disabled,true);
});
test('same-turn steer and stop share one synchronous guard',async t=>{
 const f=await fixture(t);await f.act(async()=>f.requests[0].resolve({agents:[{id:'first',name:'First',status:'running'},{id:'second',name:'Second',status:'running'}]}));
 await f.click('Redirect');await f.type('Direction');await f.act(async()=>{f.button('Send').click();f.button('Stop agent').click();});
 assert.equal(f.actions.length,1);assert.equal(f.actions[0].method,'steerSubagent');
});
for(const method of ['steerSubagent','cancelSubagent'])test(`${method}: current ownership failure still disables control`,async t=>{
 const f=await fixture(t);await start(f,method);await f.failAction(0,'session_owned_by_terminal');
 assert.ok(f.text().includes('This session is open on your computer'));assert.equal(f.button('Redirect'),undefined);assert.equal(f.button('Stop agent'),undefined);
});
