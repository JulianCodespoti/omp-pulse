import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
// Real React, TasksTab, ConfirmSheet and workspace host; only the daemon edges are stubbed.
const code=await bundleDomFixture(`
import {createElement as h,Fragment,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {TasksTab} from ${JSON.stringify(resolve(root,'web/src/app/tools/TasksTab.tsx'))};
import {useProvideWorkspaceHost} from ${JSON.stringify(resolve(root,'web/src/app/tools/workspace-host.ts'))};
import {openWorkspace,usePanels} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import {readDraft,seedDraft} from ${JSON.stringify(resolve(root,'web/src/app/composer/use-draft.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
const jumped=[],branched=[],panel={workspace:null};const store=createOmpStore();store.setState({sessionPath:'/synthetic/a'});
// One stable host, published the way ChatScreen does.
const host={controller:{getStore:()=>store},jumpTo:id=>jumped.push(id),onBranched:path=>branched.push(path)};
function Harness(props){useProvideWorkspaceHost(host);return h(TasksTab,{focused:props.active,...props})}
function PanelProbe(){panel.workspace=usePanels().workspace;return null}
const setMessages=messages=>store.setState({messages});
const mountTasks=()=>{openWorkspace('tasks');const r=createRoot(document.getElementById('root'));const render=(active=true,sessionPath='/synthetic/a')=>{store.setState({sessionPath});r.render(h(Fragment,null,h(PanelProbe),h(Harness,{active,sessionPath})))};render();return{render,unmount:()=>r.unmount()}};
const branchCalls=[];DaemonApi.prototype.branch=(...args)=>new Promise((resolve,reject)=>branchCalls.push({args,resolve,reject}));
window.fixture={act,jumped,branched,panel,branchCalls,readDraft,setMessages,mount(active=true){seedDraft('/synthetic/a','Unsent original');const m=mountTasks();if(!active)m.render(false);return m}};
`);
const tree=(ids=['u1','u2','u9'],nextBefore=null)=>({ok:true,rows:ids.map(id=>({id,text:'Turn '+id,active:id!=='u9'})),nextBefore});
const branchResult={sessionPath:'/synthetic/new-branch',text:'Restored prompt',cancelled:false};
const todoMessage=tasks=>({id:'m1',role:'assistant',parts:[{kind:'tool',todo:[{name:'Plan',tasks}]}]});
async function fixture(t,{active=true}={}){
  const dom=createDomFixture(code),w=dom.window,x=w.fixture,requests=[];
  w.Element.prototype.getAnimations=()=>[];
  // The todo board's peek at live state is not a timeline read: no live session answers it.
  w.fetch=(url,options)=>String(url).startsWith('/api/rpc')?Promise.reject(new Error('Synthetic: no live session'))
    :new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
  let r,dead=false;await x.act(async()=>{r=x.mount(active)});
  const unmount=async()=>{if(!dead){dead=true;await x.act(async()=>r.unmount())}};
  t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const act=fn=>x.act(async()=>fn());
  const get=s=>w.document.querySelector(s);
  const respond=(i,body=tree(),status=200)=>act(()=>requests[i].resolve({ok:status>=200&&status<300,status,json:async()=>body}));
  // Each row's ⋯ opens its actions sheet; "Rewind into a new chat" asks to confirm.
  const branchButton=id=>get(`[data-timeline-row-id="${id}"] [data-testid="timeline-row-menu"]`);
  const rewindItem=()=>get('[data-testid="timeline-rewind-new"]');
  const confirmButton=()=>get('[data-testid="confirm-sheet-confirm"]');
  return{w,x,act,get,requests,respond,unmount,branchButton,rewindItem,confirmButton,
    render:(...a)=>act(()=>r.render(...a)),
    rows:()=>[...w.document.querySelectorAll('[data-timeline-row-id]')].map(e=>e.dataset.timelineRowId),
    panelOpen:()=>x.panel.workspace==='tasks',
    confirm:async(id='u2')=>{await act(()=>branchButton(id).click());await act(()=>rewindItem().click());await act(()=>confirmButton().click())},
    finishBranch:(i=0,result=branchResult)=>act(()=>x.branchCalls[i].resolve(result)),
    text:()=>w.document.body.textContent};
}

test('an inactive Tasks tab issues no timeline reads',async t=>{
  const f=await fixture(t,{active:false});
  assert.equal(f.requests.length,0);
  await f.render(true);
  assert.equal(f.requests.length,1);
  assert.ok(f.requests[0].url.startsWith('/api/tree?'));
  assert.ok(f.get('[data-testid="timeline-loading"]'));
});

test('a timeline row closes the panel and jumps to its exact entry through the host',async t=>{
  const f=await fixture(t);await f.respond(0);
  await f.act(()=>f.get('[data-timeline-row-id="u2"] button').click());
  assert.deepEqual(Array.from(f.x.jumped),['u2']);
  assert.equal(f.panelOpen(),false);
  assert.equal(f.x.branchCalls.length,0);
});

test('rewind confirms one exact branch, seeds its draft, opens it and closes the panel',async t=>{
  const f=await fixture(t);await f.respond(0);
  await f.act(()=>f.branchButton('u9').click());
  assert.equal(f.x.branchCalls.length,0,'opening the row menu starts nothing');
  await f.act(()=>f.rewindItem().click());
  assert.equal(f.x.branchCalls.length,0,'the rewind item only asks for confirmation');
  assert.ok(f.text().includes('Rewind to this turn?'));
  await f.act(()=>{f.confirmButton().click();f.confirmButton().click()});
  assert.equal(f.x.branchCalls.length,1);
  assert.deepEqual(Array.from(f.x.branchCalls[0].args),['/synthetic/a','u9']);
  assert.equal(f.branchButton('u2').disabled,true);
  await f.finishBranch();
  assert.equal(f.x.readDraft(branchResult.sessionPath),branchResult.text);
  assert.deepEqual(Array.from(f.x.branched),[branchResult.sessionPath]);
  assert.equal(f.panelOpen(),false);
});

test('cancelled rewind keeps the draft and panel and notes it under its row',async t=>{
  const f=await fixture(t);await f.respond(0);await f.confirm();
  await f.finishBranch(0,{sessionPath:'/synthetic/a',text:'',cancelled:true});
  assert.equal(f.x.readDraft('/synthetic/a'),'Unsent original');
  assert.equal(f.x.branched.length,0);
  assert.equal(f.panelOpen(),true);
  assert.equal(f.get('[data-timeline-row-id="u2"] [role="status"]').textContent,'Rewind cancelled.');
  assert.equal(f.get('[data-slot="notice"]'),null,'a cancel is not an error');
});

test('rewind failure shows inline danger text under its row',async t=>{
  const f=await fixture(t);await f.respond(0);await f.confirm();
  await f.act(()=>f.x.branchCalls[0].reject(Error('Synthetic branch failure')));
  const note=f.get('[data-timeline-row-id="u2"] [role="status"]');
  assert.ok(note.textContent.includes('Synthetic branch failure'));
  assert.match(note.className,/text-danger/);
  assert.equal(f.branchButton('u2').disabled,false);
});

for(const departure of ['hide','reshow','session','unmount'])test(`branch completion is fenced after ${departure}`,async t=>{
  const f=await fixture(t);await f.respond(0);await f.confirm();
  if(departure==='hide')await f.render(false);
  else if(departure==='reshow'){await f.render(false);await f.render(true);await f.respond(1,tree(['new-visit']))}
  else if(departure==='session'){await f.render(true,'/synthetic/b');await f.respond(1,tree(['new-session']))}
  else await f.unmount();
  await f.finishBranch();
  assert.equal(f.x.readDraft(branchResult.sessionPath),'','stale result did not seed another draft');
  assert.equal(f.x.branched.length,0,'stale result did not navigate');
  assert.equal(f.panelOpen(),true,'stale result did not close the panel');
  if(departure==='reshow')assert.deepEqual(f.rows(),['new-visit']);
  if(departure==='session')assert.deepEqual(f.rows(),['new-session']);
});

for(const departure of ['hide','unmount'])test(`tree response after ${departure} cannot start a fallback read`,async t=>{
  const f=await fixture(t);
  if(departure==='hide')await f.render(false);else await f.unmount();
  await f.respond(0,{ok:true});
  assert.equal(f.requests.length,1,'stale malformed tree cannot issue a turns fallback');
});

test('a new visit cannot be overwritten by the previous pending tree response',async t=>{
  const f=await fixture(t);
  await f.render(false);await f.render(true);
  assert.equal(f.requests.length,2);
  await f.respond(1,tree(['new-visit']));
  await f.respond(0,tree(['old-visit']));
  assert.deepEqual(f.rows(),['new-visit']);
});

test('late branch failure cannot replace the current session or release its pending branch',async t=>{
  const f=await fixture(t);await f.respond(0);await f.confirm();
  await f.render(true,'/synthetic/b');
  await f.respond(1);await f.confirm('u9');
  await f.act(()=>f.x.branchCalls[0].reject(Error('Stale branch failure')));
  assert.equal(f.text().includes('Stale branch failure'),false);
  assert.equal(f.branchButton('u1').disabled,true);
  await f.finishBranch(1,{...branchResult,sessionPath:'/synthetic/newer-branch'});
  assert.deepEqual(Array.from(f.x.branched),['/synthetic/newer-branch']);
});

test('the todo list comes from the host controller and stays above the timeline',async t=>{
  const f=await fixture(t);
  await f.act(()=>f.x.setMessages([todoMessage([{content:'Write tests',status:'completed'},{content:'Ship',status:'in_progress'}])]));
  await f.respond(0);
  const list=f.get('[data-testid="todo-list"]');
  assert.ok(list);
  assert.ok(list.textContent.includes('1 of 2 done'));
  assert.deepEqual([...list.querySelectorAll('[data-testid="todo-task"]')].map(e=>e.dataset.status),['completed','in_progress']);
  assert.ok(f.text().includes('Timeline'));
  assert.equal(list.compareDocumentPosition(f.get('[data-timeline-row-id="u1"]'))&f.w.Node.DOCUMENT_POSITION_FOLLOWING,f.w.Node.DOCUMENT_POSITION_FOLLOWING);
});

test('no todo list and no turns shows one empty state',async t=>{
  const f=await fixture(t);await f.respond(0,tree([]));
  assert.ok(f.text().includes('No tasks yet'));
  assert.equal(f.get('[data-testid="todo-list"]'),null);
  assert.equal(f.rows().length,0);
});

test('rows render without ASCII tree gutters',async t=>{
  const f=await fixture(t);await f.respond(0,{ok:true,rows:[{id:'u1',text:'Turn',connector:'branch',active:false},{id:'u2',text:'Latest turn',active:true,current:true}],nextBefore:null});
  assert.equal(/[│├└─]/.test(f.text()),false);
  assert.ok(f.text().includes('Other branch'));
});

test('a turn shows when it was sent, how long and fast it ran, its tools and cost; a stopped turn says so',async t=>{
  const f=await fixture(t);
  // Keep both turns on today's date even when the suite runs just after midnight.
  const at=new Date().setHours(12,0,0,0)-10*60_000;
  await f.respond(0,{ok:true,total:2,nextBefore:null,rows:[
    {id:'u1',text:'Fix the bug',active:true,at,lastAt:at+252_000,replies:4,tools:3,outputTokens:9000,tps:37.6,cost:0.42,model:'claude-opus-4-5',stop:'stop'},
    {id:'u2',text:'Try again',active:true,current:true,at:at+300_000,lastAt:at+300_000,replies:1,tools:0,outputTokens:0,tps:null,cost:0,model:null,stop:'aborted'},
  ]});
  const facts=id=>f.get(`[data-timeline-row-id="${id}"] [data-testid="turn-facts"]`).textContent;
  for(const part of ['4m 12s','38 tok/s','3 tools','$0.42'])assert.ok(facts('u1').includes(part),part+' in '+facts('u1'));
  assert.equal(/tok\/s|tools|\$/.test(facts('u2')),false,'unknown or zero figures are left out');
  // The newest turn is where the tab lands, so it reads as viewed; its stop still shows.
  assert.match(facts('u2'),/^Viewing · stopped/);
  assert.match(facts('u1'),/^\d/,'an ordinary turn names no exception, only its facts');
  assert.equal(f.w.document.querySelectorAll('[data-testid="timeline-day"]').length,1);
  assert.equal(f.get('[data-testid="timeline-day"]').textContent,'Today');
});

test('the current plan distinguishes blocked work and shows its waiting reason',async t=>{
  const f=await fixture(t);
  await f.act(()=>f.x.setMessages([todoMessage([{content:'Release',status:'blocked',blocker:'Waiting for signing access'},{content:'Review',status:'pending'}])]));
  await f.respond(0);
  const list=f.get('[data-testid="todo-list"]');
  assert.match(list.textContent,/0 of 2 done/);
  assert.match(list.textContent,/Blocked: Waiting for signing access/);
  assert.equal(list.querySelector('[aria-label="Blocked"]')!==null,true);
});

for(const action of ['done','drop','rm'])test(`duplicate later task refuses ${action} without a command or optimistic mutation`,async t=>{
  const f=await fixture(t);
  await f.act(()=>f.x.setMessages([todoMessage([{content:'Same task',status:'pending'},{content:'Same task',status:'pending'}])]));
  await f.respond(0);
  const before=f.requests.length;
  const tasks=()=>[...f.w.document.querySelectorAll('[data-testid="todo-task"]')];
  await f.act(()=>tasks()[1].querySelector('button').click());
  await f.act(()=>f.get(`[data-testid="todo-action-${action}"]`).click());
  assert.equal(f.requests.length,before);
  assert.deepEqual(tasks().map(task=>task.dataset.status),['pending','pending']);
});
