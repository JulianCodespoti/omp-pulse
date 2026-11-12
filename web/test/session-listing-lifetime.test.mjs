import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {setImmediate as settle} from 'node:timers/promises';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const test=(name,fn)=>nodeTest(name,{timeout:5000},fn);

const code = await bundleDomFixture(`
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
window.fixture = () => {
 const requests = [], controllers = [], store = createOmpStore();
 function controller(token, base='http://synthetic.invalid') {
  const c = new OmpSessionController(store, token, base);
  c.fetchAuthed = (url,init) => {
   if (!url.startsWith('/api/sessions?')) throw Error('Unexpected request '+url);
   return new Promise((resolve,reject)=>requests.push({controller:c,url,init,resolve,reject}));
  };
  c.connectSessionsSocket=()=>{};
  controllers.push(c);return c;
 }
 return {requests,controllers,store,controller};
};
`, [{
 name:'session-listing-lifetime-cache-boundary',
 transform(code,id){
  if(id.endsWith('/omp-session-controller.ts'))return code.replaceAll('import.meta',JSON.stringify({env:{VITE_PROTOCOL_VERSION:1,VITE_RELEASE_ID:'unit'}}));
 },
 resolveId(id,importer){
  if(importer?.endsWith('/omp-session-controller.ts')&&id==='./offline-cache')return '\0listing-cache';
 },
 load(id){
  if(id==='\0listing-cache')return `
   export * from ${JSON.stringify(resolve(root,'web/src/runtime/offline-cache.ts'))};
   export const loadSessionList=namespace=>window.cacheReads===null?Promise.resolve(null):
    new Promise(resolve=>window.cacheReads.push({namespace,resolve}));
   export const saveSessionList=(...args)=>{window.cacheWrites.push(args);return Promise.resolve();};
  `;
 },
}]);

async function fixture(t) {
 const dom=createDomFixture(code),w=dom.window;
 Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder});
 w.cacheReads=null;w.cacheWrites=[];
 let id=0;const timers=new Map();
 w.setTimeout=w.setInterval=(fn,delay)=>{timers.set(++id,{fn,delay});return id;};
 w.clearTimeout=w.clearInterval=id=>timers.delete(id);
 const f=w.fixture();
 t.after(()=>{for(const c of f.controllers)c.dispose();assert.deepEqual(dom.blocked,[]);dom.close();});
 const reply=async(i,body,status=200)=>{
  assert.ok(f.requests[i],'request '+i);
  f.requests[i].resolve(new Response(body===null?null:JSON.stringify(body),{status,headers:{ETag:'"page-'+i+'"'}}));
  await settle();
 };
 return {...f,w,reply};
}

function row(path,daemon,revision=1) {
 return {path,title:path,sessionState:{daemonInstanceId:daemon,revision,bindingEpoch:1,
  owner:{kind:'none'},turn:'idle',confidence:'confirmed',connection:'connected',
  observedAt:1,activity:null,capabilities:{read:true}}};
}
function snapshot(store) {
 const s=store.getState();return JSON.parse(JSON.stringify({sessions:s.sessions,cursor:s.sessionsNextCursor,
  projects:s.sessionProjects,authorities:s.sessionAuthorities,error:s.error,
  updatedAt:s.sessionsUpdatedAt,scope:s.sessionsScope,loadingMore:s.sessionsLoadingMore}));
}

test('disposed first-page request cannot replace a newer controller listing',async t=>{
 const f=await fixture(t),old=f.controller('synthetic-old','http://old.synthetic.invalid');
 const pending=old.loadSessions();await settle();assert.equal(f.requests.length,1);
 old.dispose();
 const current=f.controller('synthetic-current','http://new.synthetic.invalid');
 const fresh=current.loadSessions();await settle();
 await f.reply(1,{sessions:[row('/synthetic/current','current-daemon')],nextCursor:'current-cursor',projects:[{cwd:'/current',label:'Current'}]});
 await fresh;f.store.getState().setError('Current owner notice');
 const before=snapshot(f.store);
 await f.reply(0,{sessions:[row('/synthetic/old','old-daemon')],nextCursor:'obsolete-cursor',projects:[{cwd:'/old',label:'Old'}]});
 await pending;
 const after=snapshot(f.store);
 assert.deepEqual(after,before,'old controller completion must leave current store untouched');
 assert.equal(old.sessionsPageCache.size,0,'retired response cannot warm page cache');
 assert.equal(f.w.cacheWrites.length,1,'only current response persists its credential-scoped snapshot');
});

test('disposed older-page request cannot append into a newer controller listing',async t=>{
 const f=await fixture(t),old=f.controller('synthetic-old');
 const initial=old.loadSessions();await settle();
 await f.reply(0,{sessions:[row('/synthetic/old-first','old-daemon')],nextCursor:'shared-cursor'});await initial;
 const pending=old.loadMoreSessions();await settle();
 old.dispose();const current=f.controller('synthetic-current');
 const fresh=current.loadSessions();await settle();
 await f.reply(2,{sessions:[row('/synthetic/current','current-daemon')],nextCursor:'shared-cursor'});await fresh;
 f.store.getState().setError('Current owner notice');const before=snapshot(f.store);
 await f.reply(1,{sessions:[row('/synthetic/old-older','old-daemon')],nextCursor:'obsolete-next'});await pending;
 const after=snapshot(f.store);
 assert.deepEqual(after,before,'cursor equality does not transfer old-controller ownership');
});

test('delayed response body is fenced after controller replacement',async t=>{
 const f=await fixture(t),old=f.controller('synthetic-old');
 const pending=old.loadSessions();await settle();let finishBody;
 f.requests[0].resolve({status:200,ok:true,headers:new Headers({ETag:'"obsolete"'}),
  json:()=>new Promise(resolve=>{finishBody=resolve;})});
 await settle();assert.ok(finishBody);old.dispose();
 const current=f.controller('synthetic-current'),fresh=current.loadSessions();await settle();
 await f.reply(1,{sessions:[row('/synthetic/current','current-daemon')],nextCursor:null});await fresh;
 f.store.getState().setError('Current notice');const before=snapshot(f.store);
 finishBody({sessions:[row('/synthetic/obsolete','old-daemon')],nextCursor:'old'});await pending;
 assert.deepEqual(snapshot(f.store),before);assert.equal(old.sessionsPageCache.size,0);
});

test('same controller resume starts fresh and old 304 cannot replace the new cache',async t=>{
 const f=await fixture(t),c=f.controller('synthetic-token');
 const initial=c.loadSessions();await settle();
 await f.reply(0,{sessions:[{path:'/synthetic/original'}],nextCursor:null});await initial;
 const retired=c.loadSessions();await settle();
 assert.equal(f.requests[1].init.headers.get('If-None-Match'),'"page-0"');
 c.dispose();c.startSessionsPolling();const current=c.loadSessions();await settle();
 assert.equal(f.requests.length,3,'resumption must not share the retired pending request');
 await f.reply(2,{sessions:[{path:'/synthetic/current'}],nextCursor:'current'});await current;
 f.store.getState().setError('Current notice');const before=snapshot(f.store);
 await f.reply(1,null,304);await retired;
 assert.deepEqual(snapshot(f.store),before);
 assert.deepEqual([...c.sessionsPageCache.values()].map(p=>p.etag),['"page-2"']);
 const unchanged=c.loadSessions();await settle();
 assert.equal(f.requests[3].init.headers.get('If-None-Match'),'"page-2"');
 await f.reply(3,null,304);await unchanged;
 assert.equal(f.store.getState().sessions[0].path,'/synthetic/current');
 assert.equal(f.store.getState().error === null, true, 'current 304 preserves its ordinary success behavior');
});

test('disposed controller entry points neither fetch nor mutate the shared store',async t=>{
 const f=await fixture(t),c=f.controller('synthetic-token');c.dispose();
 f.store.getState().setSessionPage([{path:'/synthetic/current'}],'older','current-scope');
 f.store.getState().setError('Current notice');const before=snapshot(f.store);
 const pending=[c.loadSessions({query:'obsolete'}),c.loadMoreSessions(),c.refreshSessions()];await settle();
 assert.equal(f.requests.length,0);assert.deepEqual(snapshot(f.store),before);await Promise.all(pending);
});

test('delayed offline hydration from a disposed controller cannot paint or request',async t=>{
 const f=await fixture(t);f.w.cacheReads=[];
 const old=f.controller('synthetic-old'),retired=old.loadSessions();await settle();
 assert.equal(f.w.cacheReads.length,1);old.dispose();
 const current=f.controller('synthetic-current'),fresh=current.loadSessions();await settle();
 assert.equal(f.w.cacheReads.length,2);
 assert.notEqual(f.w.cacheReads[0].namespace,f.w.cacheReads[1].namespace,'credential namespaces are preserved');
 f.w.cacheReads[1].resolve(null);await settle();
 await f.reply(0,{sessions:[{path:'/synthetic/current'}],nextCursor:null});await fresh;
 f.store.getState().setError('Current notice');const before=snapshot(f.store);
 // Force a still-empty cache paint target to prove the lifetime fence itself,
 // rather than relying on sessionsUpdatedAt having already suppressed it.
 f.store.setState({sessionsUpdatedAt:null});before.updatedAt=null;
 f.w.cacheReads[0].resolve({sessions:[{path:'/synthetic/old-cache'}],savedAt:123,projects:[{cwd:'/old'}]});
 await settle();assert.deepEqual(snapshot(f.store),before);assert.equal(f.requests.length,1);await retired;
});

test('resumed controller can hydrate again while retired cache read stays inert',async t=>{
 const f=await fixture(t);f.w.cacheReads=[];
 const c=f.controller('synthetic-token'),retired=c.loadSessions();await settle();
 c.dispose();c.startSessionsPolling();const current=c.loadSessions();await settle();
 assert.equal(f.w.cacheReads.length,2,'disposal resets only the hydration attempt latch');
 f.w.cacheReads[1].resolve({sessions:[{path:'/synthetic/current-cache'}],savedAt:456});await settle();
 assert.equal(f.store.getState().sessions[0].path,'/synthetic/current-cache');
 f.w.cacheReads[0].resolve({sessions:[{path:'/synthetic/obsolete-cache'}],savedAt:123});await retired;
 assert.equal(f.requests.length,1);assert.equal(f.store.getState().sessions[0].path,'/synthetic/current-cache');
 await f.reply(0,{sessions:[{path:'/synthetic/current-network'}],nextCursor:null});await current;
});

for(const outcome of ['success','failure'])test(`retired older-page ${outcome} cannot release replacement pagination`,async t=>{
 const f=await fixture(t),old=f.controller('synthetic-old');
 const initial=old.loadSessions();await settle();
 await f.reply(0,{sessions:[{path:'/synthetic/old'}],nextCursor:'shared'});await initial;
 const retired=old.loadMoreSessions().then(()=>null,error=>error);await settle();old.dispose();
 const c=f.controller('synthetic-current'),fresh=c.loadSessions();await settle();
 await f.reply(2,{sessions:[{path:'/synthetic/current'}],nextCursor:'shared'});await fresh;
 const paging=c.loadMoreSessions();await settle();
 assert.equal(f.store.getState().sessionsLoadingMore,true);const before=snapshot(f.store);
 if(outcome==='failure')f.requests[1].reject(new Error('Retired page failed'));
 else await f.reply(1,{sessions:[{path:'/synthetic/old-older'}],nextCursor:null});
 const result=await retired;if(outcome==='failure')assert.equal(result.message,'Retired page failed');
 assert.deepEqual(snapshot(f.store),before);
 await f.reply(3,{sessions:[{path:'/synthetic/current-older'}],nextCursor:null});await paging;
 assert.equal(f.store.getState().sessionsLoadingMore,false);
 assert.deepEqual(Array.from(f.store.getState().sessions,s=>s.path),['/synthetic/current','/synthetic/current-older']);
});

test('current first-page and pagination deduplication and errors are unchanged',async t=>{
 const f=await fixture(t),c=f.controller('synthetic-token');
 const first=c.loadSessions(),shared=c.loadSessions();await settle();assert.equal(f.requests.length,1);
 await f.reply(0,{sessions:[{path:'/synthetic/first'}],nextCursor:'older'});await Promise.all([first,shared]);
 const page=c.loadMoreSessions().then(()=>null,error=>error),observer=c.loadSessions().then(()=>null,error=>error);
 await c.loadMoreSessions();await settle();assert.equal(f.requests.length,2);
 f.requests[1].reject(new Error('Current page failed'));const [pageError,observerError]=await Promise.all([page,observer]);
 assert.equal(pageError,observerError);assert.equal(pageError.message,'Current page failed');
 assert.equal(f.store.getState().sessionsLoadingMore,false);assert.equal(f.store.getState().sessionsNextCursor,'older');
 const retry=c.loadMoreSessions();await settle();await f.reply(2,{sessions:[{path:'/synthetic/older'}],nextCursor:null});await retry;
 assert.equal(f.requests.length,3);assert.equal(f.store.getState().sessions.length,2);
});

for(const transition of ['poll-stop','poll-restart','session-close'])test(`active-controller success remains useful after ${transition}`,async t=>{
 const f=await fixture(t),c=f.controller('synthetic-token'),pending=c.loadSessions();await settle();
 if(transition==='poll-stop')c.stopSessionsPolling();
 if(transition==='poll-restart')c.startSessionsPolling();
 if(transition==='session-close')c.closeSession();
 await f.reply(0,{sessions:[{path:'/synthetic/current'}],nextCursor:null});await pending;
 assert.equal(f.store.getState().sessions[0].path,'/synthetic/current');assert.equal(f.requests.length,1);
});
