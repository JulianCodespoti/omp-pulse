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
const requests=[],actions=[],transcriptReads=[],intervals=new Map();let timer=0;
window.setInterval=(fn,ms)=>{intervals.set(++timer,{fn,ms});return timer};
window.clearInterval=id=>intervals.delete(id);
DaemonApi.prototype.getDesktopAgentRoster = async () => { throw Object.assign(new Error('Synthetic no desktop read lease'), { code: 'host_unavailable' }); };
DaemonApi.prototype.getSubagents=session=>new Promise((resolve,reject)=>requests.push({session,resolve,reject}));
DaemonApi.prototype.getSubagentMessages=async(session,options)=>{transcriptReads.push({session,options});return {entries:options.fromByte?[]:[{type:'message',id:'agent-answer',message:{role:'assistant',content:[{type:'text',text:'Retained agent conversation'}]}}],nextByte:100}};
for(const method of ['cancelSubagent','collabAttach'])DaemonApi.prototype[method]=(...args)=>new Promise((resolve,reject)=>actions.push({method,args,resolve,reject}));
const store=createOmpStore(),otherStore=createOmpStore();
for (const fixtureStore of [store,otherStore]) fixtureStore.setState({ connection: 'open', sessionAuthorities: Object.fromEntries(['/synthetic/a','/synthetic/b','/synthetic/steer'].map(path => [path, { owner: { kind: 'child' }, confidence: 'confirmed', connection: 'connected' }])) });
const hosts=[agentsTab.host({getStore:()=>store}),agentsTab.host({getStore:()=>otherStore})];
window.fixture={act,requests,actions,transcriptReads,intervals,store,mount:(strict=false)=>agentsTab.mount({hosts,strict})};
`);
async function fixture(t,strict=false){
 const dom=createDomFixture(code),w=dom.window,{act,requests,actions,intervals}=w.fixture;
 w.Element.prototype.getAnimations=()=>[];
 w.TextEncoder=TextEncoder;
 w.fetch=async url=>{assert.match(String(url),/^\/api\/agents\?/);return{ok:true,json:async()=>({agents:[]})}};
 let mounted,unmounted=false;await act(async()=>{mounted=w.fixture.mount(strict)});
 const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>mounted.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,requests,actions,unmount,render:(...args)=>act(async()=>mounted.render(...args)),
 closePanel:()=>act(async()=>w.agentsTab.close()),
 text:()=>w.document.body.textContent,
 loading:()=>Boolean(w.document.querySelector('[data-testid="agents-loading"]')),
 click:label=>act(async()=>{const b=[...w.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);assert.ok(b,label);b.click()}),
 tick:()=>act(async()=>{for(const {fn,ms} of [...intervals.values()])if(ms===3000)fn()}),
 respond:(i,name='Current agent',status='done')=>act(async()=>requests[i].resolve({agents:[{id:'same',name,status}]})),
 reject:(i,message='Synthetic list failure')=>act(async()=>requests[i].reject(new Error(message))),
 finishAction:i=>act(async()=>actions[i].resolve({})),
 };
}
test('session switch ignores previous success and starts a fresh list',async t=>{
 const f=await fixture(t);await f.render(true,'/synthetic/b');await f.respond(1);await f.respond(0,'Old agent');
 assert.ok(f.text().includes('Current agent'));assert.ok(!f.text().includes('Old agent'));assert.equal(f.requests[1].session,'/synthetic/b');
});
for(const message of ['Synthetic list failure','session_owned_by_terminal'])test('stale '+message+' cannot clear current loading or ownership',async t=>{
 const f=await fixture(t);await f.render(true,'/synthetic/b');await f.reject(0,message);
 assert.ok(f.loading());assert.ok(!f.text().includes(message));await f.respond(1);assert.ok(f.text().includes('Current agent'));
});
test('same-session tab reactivation ignores old completion',async t=>{
 const f=await fixture(t);await f.render(false);await f.render(true);await f.respond(1);await f.respond(0,'Old agent');assert.ok(f.text().includes('Current agent'));
});
test('controller replacement owns a fresh read even on the same session',async t=>{
 const f=await fixture(t);await f.render(true,'/synthetic/a',1);assert.equal(f.requests.length,2);await f.respond(1);await f.respond(0,'Old agent');assert.ok(f.text().includes('Current agent'));
});
test('quiet polls are single flight without starving a slow completion',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.tick();await f.tick();await f.tick();
 assert.equal(f.requests.length,2);await f.respond(1,'Updated agent','running');assert.ok(f.text().includes('Updated agent'));await f.tick();assert.equal(f.requests.length,3);
});
test('action refresh supersedes pending quiet read, whose finally cannot clear loading',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.tick();await f.click('Stop agent');await f.finishAction(0);
 assert.equal(f.requests.length,3);await f.respond(1,'Old poll','running');assert.ok(f.text().includes('Running agent'),'the rows already shown stay while the refresh is pending');assert.ok(!f.text().includes('Old poll'));await f.tick();assert.equal(f.requests.length,3);
 await f.respond(2);assert.ok(f.text().includes('Current agent'));
});
test('older action followup cannot launch reads into a reactivated visit',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.click('Stop agent');await f.render(false);await f.render(true);await f.respond(1);await f.finishAction(0);
 assert.equal(f.requests.length,2);assert.ok(f.text().includes('Current agent'));
});
test('older attach followup cannot launch reads after session change',async t=>{
 const f=await fixture(t);await f.reject(0,'session_owned_by_terminal');await f.click('Ask your computer to share');await f.render(true,'/synthetic/b');await f.respond(1);await f.finishAction(0);assert.equal(f.requests.length,2);
});
test('current failure stays retryable; ownership and successful retry still render',async t=>{
 const f=await fixture(t);await f.reject(0);assert.ok(f.text().includes('Couldn’t load agents.'));assert.ok(f.text().includes('Synthetic list failure'));await f.click('Retry');await f.respond(1);assert.ok(f.text().includes('Current agent'));
});
test('closing the workspace stops list polling',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.tick();await f.closePanel();await f.respond(1,'Old poll','running');await f.tick();assert.equal(f.requests.length,2);
});
test('unmount clears polling and makes pending completion inert',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.tick();await f.unmount();await f.respond(1);await f.tick();assert.equal(f.requests.length,2);
});
for(const message of ['Synthetic list failure','session_owned_by_terminal'])test('old quiet '+message+' cannot erase a newer action refresh',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.tick();await f.click('Stop agent');await f.finishAction(0);await f.respond(2,'Current agent','running');await f.reject(1,message);
 assert.ok(f.text().includes('Current agent'));await f.tick();assert.equal(f.requests.length,4);
});
test('old quiet success cannot overwrite a completed action refresh',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.tick();await f.click('Stop agent');await f.finishAction(0);await f.respond(2);await f.respond(1,'Old poll','running');
 assert.ok(f.text().includes('Current agent'));await f.tick();assert.equal(f.requests.length,3);
});
test('strict effect replay cancels its first passive probe before it can start RPC',async t=>{
 const f=await fixture(t,true);assert.equal(f.requests.length,1);await f.respond(0,'Current agent');assert.ok(f.text().includes('Current agent'));
});
test('current quiet failure stops polling and remains explicitly retryable',async t=>{
 const f=await fixture(t);await f.respond(0,'Running agent','running');await f.tick();await f.reject(1);await f.tick();assert.equal(f.requests.length,2);assert.ok(f.text().includes('Synthetic list failure'));
 await f.click('Retry');await f.respond(2,'Recovered','running');await f.tick();assert.equal(f.requests.length,4);
});
test('current attach followup refreshes ownership into a usable list',async t=>{
 const f=await fixture(t);await f.reject(0,'session_owned_by_terminal');await f.click('Ask your computer to share');await f.finishAction(0);assert.equal(f.requests.length,2);await f.respond(1);assert.ok(f.text().includes('Current agent'));
});

// Structural contracts for the original hosted long-title failure. JSDOM has
// no text geometry; the matched browser capture remains the visual gate.
for (const [status, label] of [['running', 'Running'], ['completed', 'Done'], ['failed', 'Failed']]) test('RPC '+status+' title truncates inside a bounded text element with full accessible identity', async t => {
 const f = await fixture(t);
 const name = 'Agent: investigate the exceptionally long nested-component-name-' + 'x'.repeat(180);
 await f.act(async () => f.requests[0].resolve({agents:[{id:'long-layout',name,status,task:'Long progress '.repeat(30)}]}));
 const row = f.w.document.querySelector('[data-rpc-agent="long-layout"]');
 assert.equal(row.getAttribute('aria-label'), `Open ${name} conversation`);
 const text = [...row.querySelectorAll('[title]')].find(el => el.title === name);
 assert.equal(text?.textContent, name);
 assert.ok(text.className.includes('truncate'));
 assert.ok(row.querySelector('[data-slot="row-body"]').textContent.includes(label));
 const actions = [...row.parentElement.querySelectorAll('button')].map(b => b.textContent);
 // Steering and stopping exist only for a controllable, working agent.
 for (const action of ['Redirect', 'Stop agent']) assert.equal(actions.includes(action), status === 'running', action);
});

test('a phone agent finishing stays open, read-only, and reopenable from the completed roster',async t=>{
 const f=await fixture(t);await f.respond(0,'Finishing agent','running');
 await f.act(async()=>f.w.document.querySelector('[data-rpc-agent="same"]').click());
 assert.equal(f.text().includes('Retained agent conversation'),true);
 await f.tick();await f.respond(1,'Finishing agent','completed');
 assert.equal(!!f.w.document.querySelector('[data-testid="agent-transcript"]'),true);
 assert.equal(f.text().includes('Done · Read only'),true);
 assert.equal(f.w.fixture.transcriptReads.length,2,'one initial read and bounded visible tail');
 await f.click('Back to agents');
 const row=f.w.document.querySelector('[data-rpc-agent="same"]');
 assert.equal(row.textContent.includes('Done'),true);
 assert.equal([...row.parentElement.querySelectorAll('button')].some(b=>b.textContent==='Stop agent'),false);
 await f.act(async()=>row.click());
 assert.equal(f.text().includes('Retained agent conversation'),true);
 assert.equal(f.w.fixture.transcriptReads.at(-1).options.fromByte,0);
});
test('an ownership transition closes the old phone reader with an explicit reopen notice',async t=>{
 const f=await fixture(t);await f.respond(0,'Agent','completed');
 await f.act(async()=>f.w.document.querySelector('[data-rpc-agent="same"]').click());
 await f.act(async()=>f.w.fixture.store.setState({sessionAuthorities:{'/synthetic/a':{owner:{kind:'bridge'},confidence:'confirmed',connection:'connected'}}}));
 assert.equal(!!f.w.document.querySelector('[data-testid="agent-transcript"]'),false);
 assert.equal(f.text().includes('ownership changed'),true);
});

test('hidden roster polling stops, show catches up once and unmount retires the visibility listener', async t => {
 const f=await fixture(t);await f.respond(0,'Working agent','running');
 const timers=f.w.fixture.intervals;
 const stale=[...timers.values()].find(({ms})=>ms===3000).fn;
 const visible=async value=>f.act(async()=>{
  Object.defineProperty(f.w.document,'visibilityState',{configurable:true,value});
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
 });
 await visible('hidden');
 assert.equal([...timers.values()].some(({ms})=>ms===3000),false);
 await f.act(async()=>stale());
 assert.equal(f.requests.length,1);
 await visible('visible');await visible('visible');
 assert.equal(f.requests.length,2,'restore refreshes without waiting for the next interval');
 await f.respond(1,'Current agent','running');
 await f.unmount();
 await visible('hidden');await visible('visible');
 assert.equal(f.requests.length,2);
 assert.equal([...timers.values()].some(({ms})=>ms===3000),false);
});
