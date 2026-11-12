import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';
import { pluginHostStub } from './support/plugin-host-stub.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Actual UI and controller, with only transport/platform boundaries isolated.
// Node's test runner treats escaped promise rejections as test failures.
const code = await bundleDomFixture(`
import {createElement as h, act, StrictMode, Fragment} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {App} from ${JSON.stringify(resolve(root, 'web/src/app/App.tsx'))};
import {ChatScreen} from ${JSON.stringify(resolve(root, 'web/src/app/ChatScreen.tsx'))};
import {Notices} from ${JSON.stringify(resolve(root, 'web/src/app/Notices.tsx'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {openSwitcher} from ${JSON.stringify(resolve(root, 'web/src/app/nav/panels.ts'))};
const requests=[], answers=[], controllers=[];
const originalGetStore=OmpSessionController.prototype.getStore;
OmpSessionController.prototype.getStore=function(){if(!controllers.includes(this))controllers.push(this);return originalGetStore.call(this)};
OmpSessionController.prototype.fetchAuthed=function(url,init){
 if(!url.startsWith('/api/sessions?'))throw Error('Unexpected controller request '+url);
 return new Promise((resolve,reject)=>requests.push({url,init,resolve,reject}));
};
// No socket, model, live daemon or native notification is opened by this fixture.
OmpSessionController.prototype.connectSessionsSocket=function(){};
OmpSessionController.prototype.loadCommands=async()=>[];
OmpSessionController.prototype.prewarm=async()=>{};
OmpSessionController.prototype.openSession=async function(path){this.store.setState({sessionPath:path,connection:'open'})};
window.fixture={act,requests,answers,controllers,openSwitcher,mount({chat=false,strict=false}={}){
 const r=createRoot(document.getElementById('root'));
 let controller;
 if(chat){const store=createOmpStore();controller=new OmpSessionController(store,'synthetic-token');
 const pendingAsk={id:'q1',total:1,index:0,question:'Choose a direction?',options:['First','Second']};
 store.setState({sessionPath:'/synthetic/a',connection:'open',sessionsUpdatedAt:Date.now(),sessions:[{path:'/synthetic/a',title:'Synthetic A',status:'waiting',pendingAsk}],
 messages:[{id:'ask-message',sourceEntryId:'ask-message',role:'assistant',text:'',parts:[{kind:'tool',callId:'q1',name:'ask',state:'running',args:{questions:[{question:pendingAsk.question,options:[{label:'First'},{label:'Second'}]}]}}]}]});window.fixture.rows=store.getState().sessions;}
 // App mounts <Notices/> beside the chat; the chat's error portals into it.
 const child=chat?h(Fragment,null,h(Notices),h(ChatScreen,{controller,onBack(){}})):h(App);
 r.render(strict?h(StrictMode,null,child):child);
 return {unmount(){r.unmount();controller?.dispose()}};
}};
`, [pluginHostStub, {
  name: 'session-refresh-platform-boundaries',
  transform(code, id) {
    if (id.endsWith('/omp-session-controller.ts') || id.endsWith('/service-worker.ts')) return code.replaceAll('import.meta', JSON.stringify({env:{VITE_PROTOCOL_VERSION:1,VITE_RELEASE_ID:'unit'}}));
  },
  resolveId(id, importer) {
    if (importer?.endsWith('/QuickReplies.tsx') && id === '@/runtime/rpc-client'
      || importer?.endsWith('/AnswerSheet.tsx') && id === '../../runtime/rpc-client') return '\0answer-service';
    return null;
  },
  load(id) {
    if (id === '\0answer-service') return `export const answerPane=(...args)=>new Promise((resolve,reject)=>window.fixture.answers.push({args,resolve,reject}));`;
  },
}]);

async function fixture(t, options = {}) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  // The new-chat home (the screen under the page) keeps drafts in IndexedDB.
  const memory = memoryIndexedDb();
  Object.assign(w, {Headers, Response, Request, TextEncoder, TextDecoder, indexedDB: memory.indexedDB, IDBKeyRange: {bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({lower, upper, lowerOpen, upperOpen})}});
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.localStorage.setItem('omp-remote-token', 'synthetic-token');
  w.fetch = async url => {
    // The search field also searches messages (/api/search) once a query has two letters;
    // home reads the folder list, model catalogue and usage for its project pill and model chip.
    assert.match(String(url), /^\/api\/(awaiting|agents\?|search\?|browse|rpc|model-usage|version)/);
    return new Response(JSON.stringify({sessions:[], agents:[], hits:[], ok:true, path:'/', parent:null, dirs:[], data:{models:[]}, usage:[]}), {headers:{'Content-Type':'application/json'}});
  };
  // Own the polling clock so slow CI cannot add unrelated timed requests.
  const pollTimers=new Map();let timerId=-1;
  const setTimeout=w.setTimeout.bind(w),clearTimeout=w.clearTimeout.bind(w);
  w.setTimeout=(callback,delay,...args)=>{
    if(delay===3000){const id=timerId--;pollTimers.set(id,()=>callback(...args));return id;}
    return setTimeout(callback,delay,...args);
  };
  w.clearTimeout=id=>{if(!pollTimers.delete(id))clearTimeout(id);};
  const poll=()=>{const next=pollTimers.entries().next().value;assert.ok(next,'controller polling remains scheduled');pollTimers.delete(next[0]);next[1]();};
  let mounted, unmounted = false;
  await f.act(async () => { mounted = f.mount(options); });
  const act = async fn => {
    await f.act(async () => { await fn?.(); });
    await f.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  };
  const unmount = async () => { if (!unmounted) {unmounted = true; await act(() => mounted.unmount());} };
  t.after(async () => {
    try { await unmount(); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const reply = async (i, status=503, body={error:'Synthetic session listing unavailable'}) => act(() => {
    assert.ok(f.requests[i], 'request '+i);
    f.requests[i].resolve(new Response(JSON.stringify(body), {status,headers:{'Content-Type':'application/json'}}));
  });
  // Retry is found by its visible label (its accessible name), not by markup.
  const get = selector => selector === RETRY
    ? [...w.document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Retry') ?? null
    : w.document.querySelector(selector);
  const click = selector => act(() => {const el=get(selector);assert.ok(el, selector);el.click();});
  if (!options.chat) {
    // The app opens on home. Startup and the launch decision share one listing
    // request: answer it with one old chat (not fresh, so home stays) so the
    // page has a search field, then open the All chats page. Its own request is
    // request 0 from here on.
    await reply(0, 200, {sessions:[], nextCursor:null});
    f.requests.splice(0);
    await act(() => f.openSwitcher());
  }
  return {w,f,get,act,click,reply,unmount,poll,controller:()=>f.controllers.at(-1),text:()=>w.document.body.textContent};
}

const RETRY = 'retry-button';
for (const strict of [false,true]) test(`actual App drawer initial failure keeps visible Retry without escaped rejection (StrictMode=${strict})`, async t => {
  const f=await fixture(t,{strict});
  assert.equal(f.f.requests.length,1,'the drawer issues one listing request');
  await f.reply(0);
  assert.match(f.get('[data-testid="switcher-error"]').textContent,/Synthetic session listing unavailable/);
  assert.ok(f.get(RETRY));
  assert.equal(f.f.requests.length,1,'handling failure does not issue a retry');
  await f.click(RETRY);
  const retryIdx=f.f.requests.findLastIndex(r=>r.url.includes('limit=12')&&!r.init?.signal?.aborted);
  await f.reply(retryIdx,503,{error:'Retry also unavailable'});
  assert.match(f.get('[data-testid="switcher-error"]').textContent,/Retry also unavailable/);
  await f.click(RETRY);
  const okIdx=f.f.requests.findLastIndex(r=>r.url.includes('limit=12')&&!r.init?.signal?.aborted);
  await f.reply(okIdx,200,{sessions:[{path:'/synthetic/recovered',title:'Recovered session'}],nextCursor:null});
  assert.match(f.text(),/Recovered session/);
  assert.equal(f.get('[data-testid="switcher-error"]') === null, true);
});

for (const mode of ['navigation', 'unmount', 'newer-query']) test(`pending failed Retry after ${mode} cannot overwrite a newer view`, async t => {
  const f=await fixture(t);await f.reply(0);await f.click(RETRY);
  const retryIdx=f.f.requests.findLastIndex(r=>r.url.includes('limit=12')&&!r.init?.signal?.aborted);
  const c=f.controller();
  if(mode==='unmount')await f.unmount();
  else if(mode==='navigation')await f.act(()=>{
    f.w.history.replaceState({},'', '#s='+encodeURIComponent('/synthetic/new-view'));
    f.w.dispatchEvent(new f.w.Event('hashchange'));
  });
  else {
    await f.click('[data-testid="switcher-search-toggle"]');
    await f.act(()=>{
      const input=f.get('[data-testid="session-search"]');assert.ok(input);
      Object.getOwnPropertyDescriptor(f.w.HTMLInputElement.prototype,'value').set.call(input,'newer');
      input.dispatchEvent(new f.w.Event('input',{bubbles:true}));
    });
    await f.act(()=>new Promise(resolve=>setTimeout(resolve,300)));
    const searchIdx=f.f.requests.findLastIndex(r=>r.url.includes('q=newer'));
    assert.ok(searchIdx>=0);
    await f.reply(searchIdx,200,{sessions:[{path:'/synthetic/newer',title:'Newer search result'}],nextCursor:null});
  }
  for(let i=0;i<f.f.requests.length;i++){
    if(i===retryIdx)await f.reply(i,503,{error:'Obsolete retry failure'});
  }
  assert.equal(c.getStore().getState().error === null, true);
  assert.ok(!f.text().includes('Obsolete retry failure'));
  if(mode==='navigation')assert.equal(c.getStore().getState().sessionPath,'/synthetic/new-view');
  if(mode==='newer-query')assert.match(f.text(),/Newer search result/);
});

test('awaited controller callers still receive the original rejection',async t=>{
  const f=await fixture(t);await f.reply(0,200,{sessions:[],nextCursor:null});
  const idx=f.f.requests.length;
  let pending, rejected; await f.act(()=>{pending=f.controller().loadSessions(); rejected=assert.rejects(pending,/Direct caller unavailable/);});
  await f.reply(idx,503,{error:'Direct caller unavailable'});await rejected;
});

test('old startup failure cannot replace a newer search result',async t=>{
  const f=await fixture(t),c=f.controller();
  let current;await f.act(()=>{current=c.loadSessions({query:'newer'});});
  await f.reply(1,200,{sessions:[{path:'/synthetic/new',title:'Newer result'}],nextCursor:null});await current;
  // Remove the old UI owner as real navigation does, before its failure lands.
  await f.unmount();
  await f.reply(0);
  assert.equal(c.getStore().getState().sessions[0].title,'Newer result');
  assert.equal(c.getStore().getState().error === null, true);
  assert.equal(f.f.requests.length,2);
});

test('startup rejection after unmount has no stale UI write or retry',async t=>{
  const f=await fixture(t),c=f.controller();await f.unmount();await f.reply(0);
  assert.equal(c.getStore().getState().error === null, true);
  assert.equal(f.f.requests.length,1);
});

async function answered(t, sheet=false) {
  const f=await fixture(t,{chat:true});
  assert.equal(f.f.requests.length,1,'question polling kickoff');
  const rows=f.f.rows;
  await f.reply(0,200,{sessions:rows,nextCursor:null});
  if(sheet){await f.click('[data-testid="quick-reply-other"]');
    const option=[...f.w.document.querySelectorAll('[role="dialog"] button')].find(n=>n.textContent.includes('First'));
    assert.ok(option,'actual AnswerSheet option');await f.act(()=>option.click());
  }else await f.click('[data-testid="quick-reply-option"]');
  assert.equal(f.f.answers.length,1);
  await f.act(()=>f.f.answers[0].resolve());
  assert.equal(f.f.requests.length,2,'one post-answer refresh');
  return f;
}

for(const sheet of [false,true])test(`${sheet?'AnswerSheet':'quick reply'} refresh rejection is consumed; polling still reports failures`,async t=>{
  const f=await answered(t,sheet);
  await f.reply(1);
  assert.equal(f.f.answers.length,1,'accepted answer never resent');
  assert.equal(f.controller().getStore().getState().error === null, true, 'observer does not fabricate a second error state');
  // Advance the actual controller-owned polling callback without wall-clock delay.
  await f.act(f.poll);
  assert.equal(f.f.requests.length,3);
  await f.reply(2,503,{error:'Background listing unavailable'});
  assert.match(f.get('[data-testid="chat-error"]').textContent,/Background listing unavailable/);
  await f.act(f.poll);
  await f.reply(3,200,{sessions:f.controller().getStore().getState().sessions,nextCursor:null});
  assert.equal(f.get('[data-testid="chat-error"]') === null, true);
});

for(const mode of ['navigation','unmount'])for(const sheet of [false,true])test(`${sheet?'sheet':'quick reply'} late refresh rejection after ${mode} adds no stale error`,async t=>{
  const f=await answered(t,sheet),c=f.controller();
  if(mode==='unmount')await f.unmount();else await f.act(()=>c.getStore().setState({sessionPath:'/synthetic/b',sessions:[],messages:[],error:null}));
  await f.reply(1);
  assert.equal(c.getStore().getState().error === null, true);
  assert.equal(f.f.answers.length,1);assert.equal(f.f.requests.length,2);
});
