import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ChatScreen} from ${JSON.stringify(resolve(root, 'web/src/app/ChatScreen.tsx'))};
import {GlobalPalette} from ${JSON.stringify(resolve(root, 'web/src/app/commands/GlobalPalette.tsx'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {Notices} from ${JSON.stringify(resolve(root, 'web/src/app/Notices.tsx'))};
const store = createOmpStore();
store.setState({sessionPath:'/synthetic/a', connection:'open', sessions:[{path:'/synthetic/a',cwd:'/synthetic'}]});
const forks=[], points=[], branches=[], navigations=[], discoveries=[], commands=[];
const bash=[],compacts=[],state={contextUsage:{percent:45}};
DaemonApi.prototype.bash = (...args) => new Promise((resolve,reject)=>bash.push({args,resolve,reject}));
DaemonApi.prototype.compact = (...args) => new Promise((resolve,reject)=>compacts.push({args,resolve,reject}));
DaemonApi.prototype.getState = async () => state;
DaemonApi.prototype.fork = (...args) => new Promise((resolve,reject)=>forks.push({args,resolve,reject}));
DaemonApi.prototype.getBranchMessages = (...args) => new Promise((resolve,reject)=>points.push({args,resolve,reject}));
DaemonApi.prototype.branch = (...args) => new Promise((resolve,reject)=>branches.push({args,resolve,reject}));
DaemonApi.prototype.runCommand = (...args) => {const request=Promise.withResolvers();commands.push({args,...request});return request.promise};
DaemonApi.prototype.getChangesSummary = async () => ({cwd:'/synthetic',repoRoot:null,branch:null,notRepo:true,files:[],totals:{files:0,additions:0,deletions:0},truncated:false});
DaemonApi.prototype.sessionRow = async () => null;
DaemonApi.prototype.getPromptConfig = async () => ({magicKeywords:[]});
DaemonApi.prototype.listFiles = async () => [];
DaemonApi.prototype.rpc = async () => ({});
DaemonApi.prototype.getAvailableModels = async () => [];
DaemonApi.prototype.getRecentModels = async () => [];
const originalFetch=window.fetch;
window.fetch=(url,...args)=>String(url).startsWith('/api/files?')
 ? Promise.resolve({ok:true,status:200,json:async()=>({ok:true,cwd:'/synthetic',entries:[]})})
 : originalFetch(url,...args);
const controller = {getReceiptScope:()=>'',getStore:()=>store,loadCommands:async()=>[{name:'fork',source:'builtin'},{name:'branch',source:'builtin'},{name:'compact',source:'builtin'},{name:'handoff',source:'builtin'}],
canRetainCollabAnswer:()=>false,
setAtBottom(){},loadSessions:async()=>{discoveries.push(true)},startSessionsPolling(){},stopSessionsPolling(){},prewarm(){},
openSession:async path=>{navigations.push(path);store.setState({sessionPath:path})}};
let r, sink;
const render=()=>r.render(h('div',null,h(ChatScreen,{controller,onBack(){}}),h(GlobalPalette,{store,inChat:true,onOpenSession(){}}),h(Notices)));
window.fixture={act,store,forks,points,branches,navigations,discoveries,commands,bash,compacts,state,mount(){r=createRoot(document.getElementById('root'));render();return r},
ingest(entries){sink??=new OmpSessionController(store,'synthetic-token','http://synthetic.invalid');sink.runningAgentCount.stop();sink.stopOfflineTicker();sink.activeSession=store.getState().sessionPath;sink.mergeHistory(entries)},
native(event){sink??=new OmpSessionController(store,'synthetic-token','http://synthetic.invalid');sink.runningAgentCount.stop();sink.stopOfflineTicker();sink.activeSession=store.getState().sessionPath;sink.handleFrame({type:'event',event},sink.generation,store.getState().sessionPath)},
dispose(){sink?.dispose()},
visit(path){store.setState({sessionPath:path});render()}};
`, [{name:'test-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}}]);

async function fixture(t) {
  const dom=createDomFixture(code),w=dom.window,f=w.fixture;
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.Element.prototype.getAnimations=()=>[];
  let mounted;
  await f.act(async()=>{mounted=f.mount()});
  t.after(async()=>{try {await f.act(async()=>mounted.unmount());f.dispose();assert.deepEqual(dom.blocked,[])} finally {dom.close()}});
  return {...f,w,
    async run(name){
      await f.act(async()=>w.document.querySelector('[data-testid="composer-plus-btn"]').click());
      await f.act(async()=>w.document.querySelector('[data-testid="composer-commands"]').click());
      await f.act(async()=>{
        const row=[...w.document.querySelectorAll('[data-testid="command-row"]')].find(e=>e.querySelector('[data-testid="command-name"]')?.textContent.replace(/^\//,'').toLowerCase()===name);
        assert.equal(!!row,true);row.click();
      });
    },
    visit:path=>f.act(async()=>f.visit(path)),
    finish:(call,value)=>f.act(async()=>call.resolve(value)),
    unmount:()=>f.act(async()=>mounted.unmount()),
    async type(text){
      await f.act(async()=>{
        const input=w.document.querySelector('textarea[name="message"]');
        Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(input,text);
        input.dispatchEvent(new w.Event('input',{bubbles:true}));
      });
    },
    async send(){
      await f.act(async()=>w.document.querySelector('[data-testid="composer-send-btn"]').click());
      for(let i=0;i<4;i++)await f.act(async()=>new Promise(resolve=>w.setTimeout(resolve,0)));
    },
  };
}

test('fork completion opens its copy while the originating visit is current',async t=>{
  const f=await fixture(t);await f.run('fork');await f.finish(f.forks[0],{sessionPath:'/synthetic/copy'});
  assert.deepEqual(Array.from(f.navigations),['/synthetic/copy']);
});
for(const departure of ['switch','return','unmount','credential']) test(`fork completion cannot navigate after ${departure}`,async t=>{
  const f=await fixture(t);await f.run('fork');
  if(departure==='switch'||departure==='return')await f.visit('/synthetic/b');
  if(departure==='return')await f.visit('/synthetic/a');
  if(departure==='unmount')await f.unmount();
  if(departure==='credential')f.w.localStorage.setItem('omp-remote-token','different-fixture-credential');
  await f.finish(f.forks[0],{sessionPath:'/synthetic/stale-copy'});
  assert.deepEqual(Array.from(f.navigations),[]);
  assert.equal(f.discoveries.length,departure==='credential'?0:1,'successful copies remain discoverable without stale navigation');
});
test('leaving while branch points load does not start a stale branch mutation',async t=>{
  const f=await fixture(t);await f.run('branch');await f.visit('/synthetic/b');
  await f.finish(f.points[0],[{entryId:'u1',text:'Old prompt'}]);assert.equal(f.branches.length,0);
});
test('late branch completion cannot seed a draft or navigate after leaving',async t=>{
  const f=await fixture(t);await f.run('branch');await f.finish(f.points[0],[{entryId:'u1',text:'Old prompt'}]);
  assert.equal(f.branches.length,1);await f.visit('/synthetic/b');
  await f.finish(f.branches[0],{sessionPath:'/synthetic/stale-branch',text:'Stale branch draft'});
  assert.deepEqual(Array.from(f.navigations),[]);
  assert.equal(Object.values(f.w.localStorage).some(v=>String(v).includes('Stale branch draft')),false);
});
test('current branch completion retains the returned draft and opens its session',async t=>{
  const f=await fixture(t);await f.run('branch');await f.finish(f.points[0],[{entryId:'u1',text:'Original prompt'}]);
  await f.finish(f.branches[0],{sessionPath:'/synthetic/branch',text:'Original prompt'});
  assert.deepEqual(Array.from(f.navigations),['/synthetic/branch']);
  assert.equal(Object.values(f.w.localStorage).some(v=>String(v).includes('Original prompt')),true);
});

test('native background command admission never claims completion and late output is shown',async t=>{
  const f=await fixture(t);await f.type('/handoff preserve decisions');await f.send();
  assert.equal(f.commands.length,1);
  await f.finish(f.commands[0],{output:'',agentInvoked:false});
  assert.equal(f.w.document.body.textContent.includes('/handoff started.'),true);
  assert.equal(f.w.document.body.textContent.includes('/handoff ran'),false);
  await f.act(async()=>f.w.fixture.native({type:'command_output',text:'Handoff failed: provider unavailable'}));
  assert.equal(f.w.document.body.textContent.includes('Handoff failed: provider unavailable'),true);
  assert.equal(f.store.getState().agentWorking,false);
});

test('busy terminal rejects the second composer command without clearing or scheduling it',async t=>{
  const f=await fixture(t);
  await f.type('!echo first');await f.send();
  assert.equal(f.bash.length,1);
  assert.equal(f.w.document.querySelector('textarea[name="message"]').value,'');
  await f.type('!echo second');await f.send();
  assert.equal(f.bash.length,1);
  assert.equal(f.w.document.querySelector('textarea[name="message"]').value,'!echo second');
  await f.finish(f.bash[0],{result:{output:'First done',exitCode:0}});
  assert.equal(f.bash.length,1,'rejected command must not run later');
  await f.send();
  assert.equal(f.bash.length,2);
  assert.equal(f.bash[1].args[1],'echo second');
  assert.equal(f.w.document.querySelector('textarea[name="message"]').value,'');
  await f.finish(f.bash[1],{result:{output:'Second done',exitCode:0}});
});

test('focused compact uses shared uncertainty and cannot resend while its outcome is unknown',async t=>{
  const f=await fixture(t);
  await f.act(async()=>f.store.setState({sessionModel:{ctxPercent:45}}));
  await f.type('/compact preserve decisions');await f.send();
  assert.equal(f.compacts.length,1);
  assert.equal(f.compacts[0].args[1],'preserve decisions');
  await f.act(async()=>f.compacts[0].reject(new Error('Network response lost')));
  await f.type('/compact preserve decisions');await f.send();
  assert.equal(f.compacts.length,1);
  assert.equal(Boolean(f.w.document.querySelector('[data-testid="compact-pill"]')),true);
});

test('an idle compaction-only history append repaints the open timeline without a new message',async t=>{
  const f=await fixture(t);
  await f.act(async()=>f.w.fixture.ingest([{type:'message',id:'user-before-compact',timestamp:'2026-10-25T10:00:00Z',message:{role:'user',content:[{type:'text',text:'Earlier prompt'}]}}]));
  const messages=f.store.getState().messages;
  assert.equal(f.w.document.body.textContent.includes('Context compacted'),false);
  await f.act(async()=>f.w.fixture.ingest([{type:'compaction',id:'idle-compaction',parentId:'user-before-compact',timestamp:'2026-10-25T10:01:00Z',summary:'Carried-forward deployment constraints',tokensBefore:12000}]));
  assert.equal(f.store.getState().messages===messages,true,'marker-only append does not fabricate a chat message');
  assert.equal(f.w.document.body.textContent.includes('Context compacted'),true);
  const marker=[...f.w.document.querySelectorAll('button')].find(button=>button.textContent.includes('Context compacted'));
  assert.equal(Boolean(marker),true);
  await f.act(async()=>marker.click());
  assert.equal(f.w.document.body.textContent.includes('Carried-forward deployment constraints'),true);
});

test('boot failure keeps its model cause and opens model choice without clearing the current draft or error',async t=>{
  const f=await fixture(t);await f.type('Keep this unsent draft');
  const raw='agent process exited: No default model selected. Use /login.';
  await f.act(async()=>f.store.setState({error:raw}));
  const notice=f.w.document.querySelector('[data-testid="chat-error"]');
  assert.equal(Boolean(notice),true);assert.match(notice.textContent,/model/i);
  const actions=[...notice.querySelectorAll('button')];
  assert.equal(actions.some(b=>b.textContent.trim()==='Reload'),false);
  const choose=actions.find(b=>b.textContent.trim()==='Choose model');assert.equal(Boolean(choose),true);
  await f.act(async()=>choose.click());
  assert.equal(Boolean(f.w.document.querySelector('[role="dialog"]')),true);
  assert.equal(f.w.document.querySelector('textarea[name="message"]').value,'Keep this unsent draft');
  assert.equal(f.store.getState().error,raw);
  assert.equal(f.navigations.length,0);assert.equal(f.commands.length,0);
});
