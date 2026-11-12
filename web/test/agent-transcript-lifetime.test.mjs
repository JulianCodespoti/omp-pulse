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
const requests=[], intervals=new Map();let timer=0;
window.setInterval=(fn,ms)=>{intervals.set(++timer,{fn,ms});return timer};
window.clearInterval=id=>intervals.delete(id);
DaemonApi.prototype.getDesktopAgentRoster=async()=>{const error=new Error('Synthetic passive host unavailable');error.code='host_unavailable';throw error};
DaemonApi.prototype.getSubagents=async()=>({agents:[{id:'same',name:'Synthetic agent',status:'done'},{id:'other',name:'Other agent',status:'done'}]});
DaemonApi.prototype.getSubagentMessages=(session,options,signal)=>new Promise((resolve,reject)=>requests.push({session,options,signal,resolve,reject}));
DaemonApi.prototype.getDesktopAgentTranscript=()=>{throw new Error('RPC row must not call desktop transcript transport')};
const rpcAuthority={owner:{kind:'child'},confidence:'confirmed',connection:'connected'};
const state={messages:[],collabAgents:[],connection:'open',sessionAuthorities:{'/synthetic/a':rpcAuthority,'/synthetic/b':rpcAuthority}};const store={subscribe:()=>()=>{},getState:()=>state};
const hosts=[agentsTab.host({getStore:()=>store})];
window.fixture={act,requests,intervals,mount:()=>agentsTab.mount({hosts})};
`);
const reply=(texts,nextByte=100,batch='initial')=>({entries:texts.map((text,i)=>({type:'message',id:'entry-'+batch+'-'+i,message:{role:'assistant',content:[{type:'text',text}]}})),nextByte});
async function fixture(t){
  const dom=createDomFixture(code),w=dom.window,{act,requests,intervals}=w.fixture;
  w.Element.prototype.getAnimations=()=>[];
  w.TextEncoder=TextEncoder;
  // Only the unrelated read-only agent catalogue scan is stubbed here.
  w.fetch=async url=>{assert.match(String(url),/^\/api\/agents\?/);return{ok:true,json:async()=>({agents:[]})}};
  let mounted,unmounted=false;await act(async()=>{mounted=w.fixture.mount()});
  const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>mounted.unmount())}};
  t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const buttons=label=>[...w.document.querySelectorAll('button')].filter(b=>b.textContent===label||b.getAttribute('aria-label')===label);
  return {w,act,requests,intervals,unmount,render:(...args)=>act(async()=>mounted.render(...args)),
    workspace:()=>w.agentsTab.workspace(),
    closePanel:()=>act(async()=>w.agentsTab.close()),
    click:(label='same')=>act(async()=>{
      const row=w.document.querySelector('button[data-rpc-agent="'+label+'"]');
      const button=row ?? buttons(label)[0]; assert.ok(button,label);
      if(row)assert.equal(w.document.querySelector('[data-testid="agent-roster"]').hidden,false);
      button.click();
    }),
    back:()=>act(async()=>{const b=w.document.querySelector('button[aria-label="Back to agents"]');assert.ok(b,'Back to agents');b.click();}),
    tick:()=>act(async()=>{for(const {fn,ms} of [...intervals.values()])if(ms===3000)fn()}),
    respond:(index,texts,nextByte)=>act(async()=>requests[index].resolve(reply(texts,nextByte,index))),
    reject:(index,message='Synthetic read failure')=>act(async()=>requests[index].reject(new w.Error(message))),
    visibility:value=>act(async()=>{Object.defineProperty(w.document,'visibilityState',{configurable:true,value});w.document.dispatchEvent(new w.Event('visibilitychange'))}),
    lines:()=>[...w.document.querySelectorAll('[data-testid="agent-transcript"] [data-agent-message] [data-testid="reply-text"]')].map(p=>p.textContent),
  };
}
test('slow initial read cannot race a from-zero poll into duplicate output',async t=>{
  const f=await fixture(t);await f.click();await f.tick();
  await f.respond(0,['initial']);
  // On the old implementation the already-issued from-zero tail appends a duplicate.
  if(f.requests.length>1)await f.respond(1,['initial']);
  assert.deepEqual(f.lines(),['initial']);assert.equal(f.requests.length,1);
});
test('slow tail is single-flight and appends its range exactly once',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['initial']);
  await f.tick();await f.tick();await f.tick();
  for(let i=1;i<f.requests.length;i++)await f.respond(i,['tail'],200);
  assert.deepEqual(f.lines(),['initial','tail']);assert.equal(f.requests.length,2);
});
test('same-ID Back/reopen rejects older initial success',async t=>{
  const f=await fixture(t);await f.click();await f.back();await f.click();
  assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.requests[1].signal.aborted,false);
  await f.respond(1,['current']);await f.respond(0,['old']);assert.deepEqual(f.lines(),['current']);
});
test('same-ID Back/reopen rejects older initial error while current read loads',async t=>{
  const f=await fixture(t);await f.click();await f.back();await f.click();
  await f.reject(0);assert.ok(f.w.document.body.textContent.includes('Loading messages'));
  assert.equal(f.w.document.body.textContent.includes('Synthetic read failure'),false);
  await f.respond(1,['current']);assert.deepEqual(f.lines(),['current']);
});
test('same-ID tab reactivation rejects older tail success',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['initial']);await f.tick();
  await f.render(false);await f.render(true);await f.click();await f.respond(2,['current']);
  await f.respond(1,['old tail']);assert.deepEqual(f.lines(),['current']);
});
test('session switch resets the conversation and rejects previous same-ID read',async t=>{
  const f=await fixture(t);await f.click();await f.render(true,'/synthetic/b');
  assert.equal(Boolean(f.w.document.querySelector('[data-testid="agent-transcript"]')),false);
  await f.click();await f.respond(1,['session b']);await f.respond(0,['session a']);
  assert.deepEqual(f.lines(),['session b']);assert.equal(f.requests[1].session,'/synthetic/b');
});
test('ordinary tails and empty cursor progress remain ordered and capped',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,Array.from({length:205},(_,i)=>'line '+i),100);
  assert.equal(f.lines().length,200);assert.equal(f.lines()[0],'line 5');
  assert.match(f.w.document.querySelector('[data-testid="agent-history-limit"]').textContent,/Earlier history isn’t shown/);
  assert.match(f.w.document.querySelector('[data-testid="agent-history-limit"]').title,/200 messages and 8 MiB/);
  await f.tick();assert.equal(f.requests[1].options.fromByte,100);await f.respond(1,[],150);
  await f.tick();assert.equal(f.requests[2].options.fromByte,150);await f.respond(2,['tail'],200);
  assert.equal(f.lines().length,200);assert.equal(f.lines()[0],'line 6');assert.equal(f.lines().at(-1),'tail');
  await f.tick();assert.equal(f.requests[3].options.fromByte,200);await f.respond(3,[],200);
  await f.tick();assert.equal(f.requests[4].options.fromByte,200);
});
test('current initial failure remains retryable and polling starts after retry succeeds',async t=>{
  const f=await fixture(t);await f.click();await f.reject(0);await f.tick();assert.equal(f.requests.length,1);
  await f.click('Retry');assert.equal(f.requests[1].options.fromByte,0);await f.respond(1,['recovered']);await f.tick();assert.equal(f.requests.length,3);
});
test('current tail failure stops polling without losing readable output',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['initial']);await f.tick();await f.reject(1);
  await f.tick();assert.equal(f.requests.length,2);assert.deepEqual(f.lines(),['initial']);
  await f.click('Retry');assert.equal(f.requests[2].options.fromByte,100);
  await f.respond(2,['recovered tail'],240);assert.deepEqual(f.lines(),['initial','recovered tail']);
  await f.tick();assert.equal(f.requests[3].options.fromByte,240);
});
test('unmount invalidates pending read and removes interval',async t=>{
  const f=await fixture(t);await f.click();await f.unmount();assert.equal(f.requests[0].signal.aborted,true);assert.equal(f.intervals.size,0);await f.respond(0,['old']);await f.tick();assert.equal(f.requests.length,1);
});

test('old tail failure cannot stop the reopened visit polling',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['initial']);await f.tick();
  await f.back();await f.click();await f.respond(2,['current'],500);
  await f.reject(1);await f.tick();assert.equal(f.requests.length,4);
  assert.equal(f.requests[3].options.fromByte,500);await f.respond(3,['new tail'],600);
  assert.deepEqual(f.lines(),['current','new tail']);
});
test('switching agents through Back rejects the previous pending tail',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['first agent']);await f.tick();
  await f.back();await f.click('other');assert.equal(f.requests[2].options.subagentId,'other');
  await f.respond(2,['other agent']);await f.respond(1,['old tail']);
  assert.deepEqual(f.lines(),['other agent']);
});
test('closing the workspace invalidates reads and leaves the conversation',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['initial']);await f.tick();
  await f.closePanel();
  assert.equal(f.workspace(),null);assert.equal(f.requests[1].signal.aborted,true);await f.respond(1,['old tail']);await f.tick();
  assert.deepEqual(f.lines(),[]);assert.equal(f.requests.length,2);
});
test('a poll between response settlement and React commit cannot replay the completed range',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['initial']);await f.tick();
  await f.act(async()=>{
    f.requests[1].resolve(reply(['tail'],200,'tail'));await Promise.resolve();
    for(const {fn,ms} of [...f.w.fixture.intervals.values()])if(ms===3000)fn();
  });
  assert.deepEqual(f.lines(),['initial','tail']);
  if(f.requests.length===2)await f.tick();
  assert.equal(f.requests.length,3);assert.equal(f.requests[2].options.fromByte,200);
  await f.respond(2,[],200);assert.deepEqual(f.lines(),['initial','tail']);
});


test('RPC row is the conversation affordance and Back restores its focus and roster scroll',async t=>{
  const f=await fixture(t);
  const row=f.w.document.querySelector('button[data-rpc-agent="same"]');
  const roster=f.w.document.querySelector('[data-testid="agent-roster"]');
  const viewport=roster.closest('[data-slot="scroll-area-viewport"]');
  assert.equal(row.type,'button');assert.equal(row.getAttribute('aria-label'),'Open Synthetic agent conversation');
  assert.doesNotMatch(roster.textContent,/Transcript|Hide transcript/);
  viewport.scrollTop=281;await f.act(async()=>row.focus());await f.click();
  assert.equal(roster.hidden,true);assert.equal(viewport.scrollTop,0);
  const back=f.w.document.querySelector('button[aria-label="Back to agents"]');
  assert.match(back.parentElement.textContent,/^Synthetic agent.*Done · Read only$/);
  assert.equal(f.w.document.activeElement === back, true);
  assert.equal(f.requests[0].session,'/synthetic/a');
  assert.equal(f.requests[0].options.subagentId,'same');assert.equal(f.requests[0].options.fromByte,0);
  await f.respond(0,['read-only RPC content']);
  assert.deepEqual(f.lines(),['read-only RPC content']);
  const transcript=f.w.document.querySelector('[data-testid="agent-transcript"]');
  assert.equal(transcript.querySelector('textarea, form, [role="textbox"], [contenteditable="true"]') === null, true);
  await f.back();assert.equal(roster.hidden,false);assert.equal(viewport.scrollTop,281);
  assert.equal(f.w.document.querySelector('button[data-rpc-agent="same"]') === row, true);assert.equal(f.w.document.activeElement === row, true);
  assert.equal(row.getAttribute('aria-current'),'true','Back retains the selected RPC roster row');
  assert.equal(f.w.document.querySelector('[data-testid="agent-transcript"]') === null, true);
  assert.equal(f.w.document.querySelector('button[aria-label="Back to agents"]') === null, true);
  assert.equal(f.workspace(),'agents','Back leaves the conversation, not the workspace');
});

test('RPC refresh stops in a hidden document and after Back',async t=>{
  const f=await fixture(t);await f.click();await f.respond(0,['initial'],420);
  await f.visibility('hidden');await f.tick();await f.tick();assert.equal(f.requests.length,1);
  await f.visibility('visible');assert.equal(f.requests.length,2);assert.equal(f.requests[1].options.fromByte,420);
  await f.visibility('visible');await f.tick();assert.equal(f.requests.length,2);
  await f.back();assert.equal(f.requests[1].signal.aborted,true);
  await f.visibility('visible');await f.tick();assert.equal(f.requests.length,2);
  await f.respond(1,['stale tail'],700);assert.deepEqual(f.lines(),[]);
});
