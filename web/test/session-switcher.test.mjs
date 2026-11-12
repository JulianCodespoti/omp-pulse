import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
// Exercise the real controller listing transport/validation and real React UI,
// with only the authenticated HTTP boundary replaced by a synthetic catalogue.
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {SessionSwitcher} from ${JSON.stringify(resolve(root,'web/src/app/nav/SessionSwitcher.tsx'))};
 import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
 import {usePanels} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
 import {togglePin} from ${JSON.stringify(resolve(root,'web/src/app/session-format.ts'))};
 const calls={switch:[],switcherProject:null,projects:false};
 function Probe(){const p=usePanels();calls.switcherProject=p.switcherProject;calls.projects=p.projects;return null;}
 OmpSessionController.prototype.connectSessionsSocket=function(){};
 window.fixture={act,calls,togglePin,mount:(sessions,currentPath,options)=>{
  const store=createOmpStore();
  store.getState().setSessionPage(options.main??sessions,'main-next','main-filter-alpha');
  store.getState().setSessionProjects([{cwd:'/main-project',label:'Main',activeSessions:1}]);
  const requests=[],controllers=[];
  const makeController=()=>{
   const controller=new OmpSessionController(store,'synthetic-token-'+controllers.length);
   controllers.push(controller);
   controller.fetchAuthed=(url,init)=>{
    if(!url.startsWith('/api/sessions?'))throw Error('Unexpected request '+url);
    const params=new URL(url,'http://synthetic.invalid').searchParams;
    const request={url,init,controller,params};requests.push(request);
    if(options.manual)return new Promise((resolve,reject)=>Object.assign(request,{resolve,reject}));
    const q=params.get('q')??'';
    const matches=sessions.filter(row=>!q||[row.title,row.cwd,row.id].some(value=>value?.toLowerCase().includes(q)))
      .sort((a,b)=>b.activeAt-a.activeAt);
    const page=matches.slice(0,Number(params.get('limit')));
    for(const path of params.getAll('pinned')){
     const pinned=matches.find(row=>row.path===path);
     if(pinned&&!page.some(row=>row.path===path))page.push(pinned);
    }
    return Promise.resolve(new Response(JSON.stringify({sessions:page,nextCursor:matches.length>Number(params.get('limit'))?'older':null})));
   };
   return controller;
  };
  let controller=makeController(),active=options.active??true;
  const r=createRoot(document.getElementById('root'));
  const render=()=>r.render(h('div',null,h(SessionSwitcher,{controller,active,currentPath,
   onSwitch:p=>calls.switch.push(p)}),h(Probe)));
  render();return {store,requests,controllers,render,unmount:()=>r.unmount(),
   setActive:value=>{active=value;render()},
   replaceController:()=>{controller.dispose();controller=makeController();render()}};
 }};
`,[]);
const session=(i,extra={})=>({path:`/synthetic/s${i}.jsonl`,id:`session-${i}`,title:`Conversation ${i}`,cwd:`/synthetic/projects/project-${i%2}`,activeAt:1700000000000-i*60000,...extra});
const listingSnapshot=store=>JSON.stringify(Object.fromEntries(['sessions','sessionsNextCursor','sessionsScope','sessionsLoadingMore','sessionsUpdatedAt','sessionProjects'].map(key=>[key,store.getState()[key]])));
const authority={daemonInstanceId:'synthetic-daemon',revision:1,bindingEpoch:1,owner:{kind:'none'},turn:'idle',confidence:'confirmed',connection:'connected',observedAt:1,activity:null,capabilities:{read:true}};
async function fixture(t,sessions,currentPath=null,options={}){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;
 // Retry asks the link (runtime/link-state.ts); answer it so the probe is not a blocked network call.
 Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder,SyntaxError,fetch:async()=>new Response('{}',{status:200,headers:{'content-type':'application/json'}})});
 await act(async()=>{mounted=w.fixture.mount(sessions,currentPath,options)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());for(const controller of mounted.controllers)controller.dispose();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const rows=()=>Array.from(w.document.querySelectorAll('[data-testid="session-row"]'));
 const press=async(row,ms=650)=>{
  await act(async()=>{row.dispatchEvent(new w.MouseEvent('pointerdown',{bubbles:true,button:0}))});
  await act(async()=>{await new Promise(done=>w.setTimeout(done,ms))});
  await act(async()=>{row.dispatchEvent(new w.MouseEvent('pointerup',{bubbles:true,button:0}));row.click()});
 };
 const sections=()=>Array.from(w.document.querySelectorAll('[data-testid="switcher-sessions"] section')).map(s=>[s.getAttribute('aria-label'),Array.from(s.querySelectorAll('[data-testid="session-row"]')).map(r=>r.dataset.sessionPath)]);
 const reply=(index,body,options={})=>act(async()=>mounted.requests[index].resolve(new Response(options.status===304?null:options.raw??JSON.stringify(body),{status:options.status??200,headers:options.etag?{ETag:options.etag}:{}})));
 const visibility=value=>act(async()=>{Object.defineProperty(w.document,'visibilityState',{configurable:true,value});w.document.dispatchEvent(new w.Event('visibilitychange'))});
 return {...mounted,w,act,calls,rows,reply,visibility,press,sections,togglePin:w.fixture.togglePin,paths:()=>rows().map(r=>r.dataset.sessionPath),byId:id=>w.document.querySelector(`[data-testid="${id}"]`)};
}
test('recents use independent newest-first bounded listing, not the main list filter',async t=>{
 const corpus=Array.from({length:14},(_,i)=>session(i)).reverse();
 const f=await fixture(t,corpus,null,{main:[session(99,{title:'Alpha only'})]});
 assert.equal(f.rows().length,12);assert.equal(f.paths()[0],'/synthetic/s0.jsonl');assert.equal(f.paths()[11],'/synthetic/s11.jsonl');
 assert.equal(f.requests[0].params.get('limit'),'12');assert.equal(f.requests[0].params.get('live'),'false');
 assert.equal(f.requests[0].params.has('q'),false);assert.equal(f.requests[0].params.has('project'),false);
});
test('the open conversation is listed newest-first even outside the recent page and is marked current',async t=>{
 const f=await fixture(t,Array.from({length:18},(_,i)=>session(i)),'/synthetic/s17.jsonl');
 // One recent list, newest first: the open chat keeps its own place (last here) and is the only filled row.
 assert.equal(f.rows().length,13);assert.equal(f.paths()[0],'/synthetic/s0.jsonl');assert.equal(f.paths()[12],'/synthetic/s17.jsonl');
 const current=f.rows().filter(r=>r.getAttribute('aria-current')==='true');
 assert.deepEqual(current.map(r=>r.dataset.sessionPath),['/synthetic/s17.jsonl']);
 assert.equal(f.rows().filter(r=>r.getAttribute('aria-current')===null).length,12);
 assert.deepEqual(Array.from(f.requests[0].params.getAll('pinned')),['/synthetic/s17.jsonl']);
});
test('the new-chat home has no open conversation to fill',async t=>{
 const f=await fixture(t,[session(0),session(1)],null);
 assert.equal(f.rows().filter(r=>r.getAttribute('aria-current')==='true').length,0);
});
test('an empty drawer keeps only the bottom new-chat action',async t=>{
 const f=await fixture(t,[],null,{manual:true});
 assert.equal(f.byId('switcher-empty')===null,true);
 await f.reply(0,{sessions:[]});
 assert.equal(f.byId('switcher-empty')!==null,true);
 assert.equal(f.byId('switcher-empty').querySelector('button')===null,true);
 assert.equal(f.byId('switcher-new-chat')!==null,true);
});
test('identically named sessions carry their identity hint',async t=>{
 const f=await fixture(t,[session(0,{title:'Same title'}),session(1,{title:'Same title'}),session(2)]);
 assert.equal(f.w.document.querySelectorAll('[data-testid="session-identity"]').length,2);
});
test('a chat that never got a message is hidden unless it is the open one',async t=>{
 const unsent=i=>session(i,{title:'Untitled session',snippet:null});
 const f=await fixture(t,[session(0),unsent(1),session(2,{title:'Untitled session',snippet:{role:'assistant',text:'replied'}}),unsent(3)],'/synthetic/s3.jsonl');
 assert.deepEqual(f.paths(),['/synthetic/s0.jsonl','/synthetic/s2.jsonl','/synthetic/s3.jsonl']);
 assert.equal(f.rows()[2].textContent.includes('New chat'),true);
});
test('a tap switches to the exact path',async t=>{
 const f=await fixture(t,[session(3)]);await f.act(async()=>f.rows()[0].click());
 assert.deepEqual(Array.from(f.calls.switch),['/synthetic/s3.jsonl']);
});
test('chats are split into Needs you, Pinned and Recent, each chat once',async t=>{
 const f=await fixture(t,[session(0),session(1,{status:'waiting'}),session(2),session(3)]);
 assert.deepEqual(f.sections(),[['Needs you',['/synthetic/s1.jsonl']],['Recent',['/synthetic/s0.jsonl','/synthetic/s2.jsonl','/synthetic/s3.jsonl']]]);
 await f.act(async()=>{f.togglePin('/synthetic/s2.jsonl')});
 assert.deepEqual(f.sections(),[['Needs you',['/synthetic/s1.jsonl']],['Pinned',['/synthetic/s2.jsonl']],['Recent',['/synthetic/s0.jsonl','/synthetic/s3.jsonl']]]);
});
test('the computer row names this computer and its connection',async t=>{
 const f=await fixture(t,[session(0)]);const row=f.byId('switcher-computer');
 assert.equal(row.dataset.state,'ok');assert.ok(row.textContent.includes('synthetic')&&row.textContent.includes('Connected'));
});
test('switcher-search-toggle opens inline search inside the drawer without mutating main store scope',async t=>{
 const f=await fixture(t,[session(0)]),before=listingSnapshot(f.store);
 await f.act(async()=>f.byId('switcher-search-toggle').click());
 assert.ok(f.byId('session-search'));assert.equal(listingSnapshot(f.store),before);
});
test('a project row scopes the drawer to that folder, and All projects opens the list',async t=>{
 const f=await fixture(t,[session(0),session(1)]);
 const row=f.w.document.querySelectorAll('[data-testid="switcher-project"]')[0];
 assert.deepEqual([...f.w.document.querySelectorAll('[data-testid="switcher-project"]')].map(r=>r.dataset.cwd),
  ['/synthetic/projects/project-0','/synthetic/projects/project-1']);
 const before=listingSnapshot(f.store);
 await f.act(async()=>row.click());
 assert.equal(f.calls.switcherProject,'/synthetic/projects/project-0');
 assert.equal(f.calls.projects,false);assert.equal(listingSnapshot(f.store),before);
 await f.act(async()=>f.byId('switcher-clear-project').click());
 assert.equal(f.calls.switcherProject,null);
 await f.act(async()=>f.byId('switcher-projects').click());
 assert.equal(f.calls.projects,true);
});
test('holding a row opens its action menu instead of switching',async t=>{
 const f=await fixture(t,[session(0),session(1)]);
 await f.press(f.rows()[1]);
 assert.deepEqual(Array.from(f.calls.switch),[]);
 assert.ok(f.byId('drawer-actions'));
 assert.deepEqual(Array.from(f.w.document.querySelectorAll('[data-testid="drawer-actions"] [role="menuitem"]')).map(i=>i.dataset.testid),
  ['drawer-action-rename','drawer-action-pin','drawer-action-duplicate','drawer-action-delete','drawer-action-more']);
 await f.act(async()=>f.byId('drawer-action-pin').click());
 assert.equal(f.byId('drawer-actions'),null);
 assert.deepEqual(f.sections(),[['Pinned',['/synthetic/s1.jsonl']],['Recent',['/synthetic/s0.jsonl']]]);
});
test('Delete hides the row at once with no confirmation; the daemon is not asked until the Undo window ends',async t=>{
 const f=await fixture(t,[session(0),session(1)]);
 await f.press(f.rows()[1]);
 await f.act(async()=>f.byId('drawer-action-delete').click());
 assert.equal(f.w.document.querySelector('[role="alertdialog"],[data-testid="delete-session-confirm"]'),null);
 assert.deepEqual(f.paths(),['/synthetic/s0.jsonl']);
});
test('Delete is withheld from a chat open on the computer and disabled while it works',async t=>{
 const f=await fixture(t,[
  session(0,{sessionState:{...authority,owner:{kind:'bridge'}}}),
  session(1,{sessionState:{...authority,turn:'running'}}),
 ]);
 await f.press(f.rows()[0]);assert.equal(f.byId('drawer-action-delete'),null);
 await f.act(async()=>f.byId('drawer-actions-scrim').click());assert.equal(f.byId('drawer-actions'),null);
 await f.press(f.rows()[1]);assert.equal(f.byId('drawer-action-delete').disabled,true);
});
test('closed panels do not fetch and pre-close responses cannot replace a reopened panel',async t=>{
 const f=await fixture(t,[],null,{manual:true,active:false}),before=listingSnapshot(f.store);
 assert.equal(f.requests.length,0);
 await f.act(async()=>f.setActive(true));assert.equal(f.requests.length,1);
 await f.act(async()=>f.setActive(false));assert.equal(f.requests[0].init.signal.aborted,true);
 await f.act(async()=>f.setActive(true));assert.equal(f.requests.length,2);
 await f.reply(1,{sessions:[session(2)]});
 await f.reply(0,{sessions:[session(1,{sessionState:authority})]});
 assert.deepEqual(f.paths(),['/synthetic/s2.jsonl']);assert.equal(listingSnapshot(f.store),before);
 assert.equal(f.store.getState().sessionAuthorities['/synthetic/s1.jsonl'],undefined);
});
test('hidden document fences in-flight reads and resume requests a fresh page',async t=>{
 const f=await fixture(t,[],null,{manual:true}),before=listingSnapshot(f.store);
 await f.visibility('hidden');assert.equal(f.requests[0].init.signal.aborted,true);
 await f.reply(0,{sessions:[session(1,{sessionState:authority})]});
 assert.equal(f.rows().length,0);assert.equal(listingSnapshot(f.store),before);
 assert.equal(f.store.getState().sessionAuthorities['/synthetic/s1.jsonl'],undefined);
 await f.visibility('visible');
 // The controller also refreshes its main list on visibility. Complete the
 // independently scoped switcher read, not whichever request happened first.
 const resumed=f.requests.findIndex(request=>request.params.get('limit')==='12'&&!request.init.signal.aborted);
 await f.reply(resumed,{sessions:[session(2)]});assert.deepEqual(f.paths(),['/synthetic/s2.jsonl']);
});
test('credential/controller replacement fences the previous controller and its results',async t=>{
 const f=await fixture(t,[],null,{manual:true});
 await f.act(async()=>f.replaceController());assert.equal(f.requests.length,2);
 const before=listingSnapshot(f.store);
 await f.reply(1,{sessions:[session(2)]});
 await f.reply(0,{sessions:[session(1,{sessionState:authority})]});
 assert.deepEqual(f.paths(),['/synthetic/s2.jsonl']);assert.equal(listingSnapshot(f.store),before);
 assert.equal(f.store.getState().sessionAuthorities['/synthetic/s1.jsonl'],undefined);
 assert.equal(f.controllers[0].switcherPageCache.size,0);
});
for(const failure of ['network','invalid','server'])test(`${failure} failure reports Retry instead of a false empty result`,async t=>{
 const f=await fixture(t,[],null,{manual:true}),before=listingSnapshot(f.store);
 if(failure==='network')await f.act(async()=>f.requests[0].reject(new Error('Synthetic offline')));
 else if(failure==='invalid')await f.reply(0,null,{raw:'{"sessions":null}'});
 else await f.reply(0,{ok:false,error:'Synthetic unavailable'},{status:503});
 assert.ok(f.byId('switcher-error'));assert.equal(f.byId('switcher-empty'),null);
 await f.act(async()=>f.byId('switcher-error').querySelector('button').click());
 // Retry asks the link too, and the first answer after an outage makes the
 // controller re-read the main list; only the drawer's own read (limit 12) is its answer.
 assert.ok(f.requests.length>=2);assert.ok(f.w.document.querySelector('[aria-label="Loading sessions"]'));
 const own=f.requests.findLastIndex(request=>request.params.get('limit')==='12'&&!request.init.signal.aborted);
 await f.reply(own,{sessions:[session(2)]});
 // The recovery re-read legitimately refreshes the main list too, so only the drawer's rows are asserted.
 assert.deepEqual(f.paths(),['/synthetic/s2.jsonl']);
});
test('reopening reuses the drawer ETag without touching the main list scope',async t=>{
 const f=await fixture(t,[],null,{manual:true});
 await f.reply(0,{sessions:[session(0)]},{etag:'"recent"'});
 let mainRead;
 await f.act(async()=>{mainRead=f.controllers[0].loadSessions({query:'Alpha'})});
 await f.reply(1,{sessions:[session(99,{title:'Alpha'})],nextCursor:'main-next'},{etag:'"main"'});
 await mainRead;
 const before=listingSnapshot(f.store);
 await f.act(async()=>f.setActive(false));await f.act(async()=>f.setActive(true));
 assert.equal(f.requests[2].init.headers.get('If-None-Match'),'"recent"');
 await f.reply(2,null,{status:304});assert.deepEqual(f.paths(),['/synthetic/s0.jsonl']);
 assert.equal(f.controllers[0].sessionsPageCache.size,1);
 assert.equal(Array.from(f.controllers[0].sessionsPageCache.values())[0].etag,'"main"');
 assert.equal(listingSnapshot(f.store),before);
});
