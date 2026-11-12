import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {setImmediate as settle} from 'node:timers/promises';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const code = await bundleDomFixture(`
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
window.fixture = () => {
 const requests=[], controllers=[], store=createOmpStore();
 window.cacheWrites=[];
 const controller = () => {
  const c=new OmpSessionController(store,'synthetic-review');
  c.fetchAuthed=(url,init)=>{
   if(!url.startsWith('/api/sessions?'))throw Error('Unexpected '+url);
   return new Promise((resolve,reject)=>requests.push({url,init,resolve,reject}));
  };
  c.connectSessionsSocket=()=>{};
  controllers.push(c);return c;
 };
 return {store,requests,controllers,controller};
};
`, [{name:'listing-reentrancy-cache-boundary',transform(code,id){
 if(id.endsWith('/omp-session-controller.ts'))return code.replaceAll('import.meta',JSON.stringify({env:{VITE_PROTOCOL_VERSION:1,VITE_RELEASE_ID:'unit'}}));
},resolveId(id,importer){
 if(id==='./offline-cache' && importer?.endsWith('/omp-session-controller.ts'))return '\0review-cache';
},load(id){if(id==='\0review-cache')return `
 export const clearAllCachedHistory=async()=>{},clearOfflineHistory=async()=>{},loadSessionList=async()=>null,loadTail=async()=>null,saveTail=async()=>{},setOfflineCacheNamespace=()=>{};
 export const saveSessionList=async(...args)=>{window.cacheWrites.push(args)};
`;}}]);
const serial=x=>JSON.parse(JSON.stringify(x));
const authority=(daemon='old',turn='idle')=>({daemonInstanceId:daemon,revision:1,bindingEpoch:1,owner:{kind:'none'},turn,confidence:'confirmed',connection:'connected',observedAt:1,activity:null,capabilities:{read:true}});
const row=(path,daemon='old',turn='idle')=>({path,sessionState:authority(daemon,turn)});
const snapshot=store=>{const s=store.getState();return serial({sessions:s.sessions,cursor:s.sessionsNextCursor,projects:s.sessionProjects,authorities:s.sessionAuthorities,error:s.error,loading:s.sessionsLoadingMore,updatedAt:s.sessionsUpdatedAt,streaming:s.streamingMessage,messages:s.messages,partial:s.partialLine});};
function replace(f){
 const current=f.controller();
 f.store.setState({sessions:[row('/replacement','replacement')],sessionsNextCursor:'replacement-cursor',sessionProjects:[{cwd:'/replacement'}],sessionAuthorities:{'/replacement':authority('replacement')},sessionsUpdatedAt:1234,sessionsLoadingMore:true,error:'Replacement notice'});
 return current;
}
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window;
 Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder,SyntaxError,AbortController});
 const timers=new Map();let id=0;
 w.setTimeout=w.setInterval=(fn,delay)=>{timers.set(++id,{fn,delay});return id;};
 w.clearTimeout=w.clearInterval=id=>timers.delete(id);
 const f=w.fixture();
 t.after(()=>{for(const c of f.controllers)c.dispose();assert.deepEqual(dom.blocked,[]);dom.close();});
 return {...f,w};
}
for(const phase of ['first-authority','passive-flush','page','projects','error'])test('synchronous disposal during '+phase+' retires remaining listing work',async t=>{
 const f=await fixture(t),c=f.controller();
 f.store.getState().setError('Old notice');
 const pending=c.loadSessions();await settle();
 let before,cacheCount,triggered=false;
 const unsubscribe=f.store.subscribe(s=>{
  const fire=phase==='first-authority'?!!s.sessionAuthorities['/a']:
   phase==='passive-flush'?!!s.sessionAuthorities['/c']:
   phase==='page'?s.sessions[0]?.path==='/a':
   phase==='projects'?s.sessionProjects[0]?.cwd==='/old':s.error===null;
  if(!fire)return;
  unsubscribe();triggered=true;c.dispose();replace(f);before=snapshot(f.store);cacheCount=f.w.cacheWrites.length;
 });
 f.requests[0].resolve(new Response(JSON.stringify({sessions:[row('/a'),row('/b'),row('/c'),row('/d','second')],projects:[{cwd:'/old'}],nextCursor:'old-next'}),{headers:{ETag:'old-etag'}}));
 await pending;await settle();
 assert.equal(triggered,true);
 assert.deepEqual(snapshot(f.store),before,'remaining old work preserves replacement state');
 assert.equal(f.w.cacheWrites.length,cacheCount,'no persistence starts after retirement');
 if(phase==='first-authority'||phase==='passive-flush')assert.equal(c.sessionsPageCache.size,0,'no retired page cache write');
});

test('same-controller reuse during active authority notification cannot commit replacement stream',async t=>{
 const f=await fixture(t),c=f.controller();
 c.activeSession='/active';f.store.getState().beginSession('/active');
 c.setStreamingMessage({role:'assistant',id:'old-stream',content:[{type:'text',text:'Old'}]});
 const pending=c.loadSessions();await settle();let before;
 const unsubscribe=f.store.subscribe(s=>{
  if(!s.sessionAuthorities['/active'])return;
  unsubscribe();c.dispose();c.startSessionsPolling();c.activeSession='/active';f.store.getState().beginSession('/active');
  c.setStreamingMessage({role:'assistant',id:'replacement-stream',content:[{type:'text',text:'Replacement'}]});
  f.store.getState().setError('Replacement notice');before=snapshot(f.store);
 });
 f.requests[0].resolve(new Response(JSON.stringify({sessions:[row('/active')],nextCursor:null}),{headers:{ETag:'old-etag'}}));
 await pending;await settle();
 assert.ok(before);assert.deepEqual(snapshot(f.store),before,'old authority continuation cannot commit a new lifetime stream');
});

test('disposal during an active idle delta flush cannot commit or clear replacement stream',async t=>{
 const f=await fixture(t),c=f.controller();
 c.activeSession='/active';f.store.getState().beginSession('/active');
 c.setStreamingMessage({role:'assistant',id:'old-stream',content:[{type:'text',text:'Old'}]});
 c.pendingDeltas=[{keep:null,text:' delta'}];
 const pending=c.loadSessions();await settle();let before;
 const unsubscribe=f.store.subscribe(s=>{
  if(s.streamingMessage?.text!=='Old delta')return;
  unsubscribe();c.dispose();const current=replace(f);current.activeSession='/replacement';f.store.getState().beginSession('/replacement');
  current.setStreamingMessage({role:'assistant',id:'replacement-stream',content:[{type:'text',text:'Replacement'}]});
  before=snapshot(f.store);
 });
 f.requests[0].resolve(new Response(JSON.stringify({sessions:[row('/active')],nextCursor:null}),{headers:{ETag:'old-etag'}}));
 await pending;await settle();
 assert.ok(before);assert.deepEqual(snapshot(f.store),before,'old stream finalizer preserves new lifetime stream');
});

test('resumed first-page refresh cannot share a retired older-page request',async t=>{
 const f=await fixture(t),c=f.controller();
 const initial=c.loadSessions({query:'synthetic'});await settle();
 f.requests[0].resolve(new Response(JSON.stringify({sessions:[row('/first')],nextCursor:'same-cursor'}),{headers:{ETag:'first'}}));
 await initial;
 const older=c.loadMoreSessions();await settle();assert.equal(f.requests.length,2);
 c.dispose();c.startSessionsPolling();
 const fresh=c.loadSessions();await settle();
 assert.equal(f.requests.length,3,'resume issues fresh first page rather than joining retired pagination');
 f.requests[2].resolve(new Response(JSON.stringify({sessions:[row('/fresh','new')],nextCursor:null}),{headers:{ETag:'fresh'}}));
 await fresh;
 f.requests[1].resolve(new Response(JSON.stringify({sessions:[row('/old-page')],nextCursor:null}),{headers:{ETag:'old-page'}}));
 await older;
 assert.equal(f.store.getState().sessions[0].path,'/fresh');
});

for(const phase of ['stream-commit','partial-clear'])test('same-controller reuse during '+phase+' preserves replacement stream accumulators',async t=>{
 const f=await fixture(t),c=f.controller();
 c.activeSession='/active';f.store.getState().beginSession('/active');
 c.setStreamingMessage({role:'assistant',id:'old-stream',content:[{type:'text',text:'Old'}]});
 f.store.setState({partialLine:'old partial'});
 const pending=c.loadSessions();await settle();let before,source;
 const unsubscribe=f.store.subscribe(s=>{
  const fire=phase==='stream-commit'?s.messages.some(m=>m.id==='old-stream'):s.partialLine===null;
  if(!fire)return;
  unsubscribe();c.dispose();c.startSessionsPolling();c.activeSession='/active';f.store.getState().beginSession('/active');
  c.setStreamingMessage({role:'assistant',id:'replacement-stream',content:[{type:'text',text:'Replacement'}]});
  c.pendingDeltas=[{keep:null,text:' new delta'}];f.store.setState({partialLine:'replacement partial'});
  before=snapshot(f.store);source=serial({chain:c.responseChain,text:c.streamText,raw:c.streamRawText,display:c.streamDisplay,deltas:c.pendingDeltas});
 });
 f.requests[0].resolve(new Response(JSON.stringify({sessions:[row('/active')],nextCursor:null}),{headers:{ETag:'old-etag'}}));
 await pending;await settle();
 assert.ok(before);assert.deepEqual(snapshot(f.store),before);
 assert.deepEqual(serial({chain:c.responseChain,text:c.streamText,raw:c.streamRawText,display:c.streamDisplay,deltas:c.pendingDeltas}),source,'retired finalizer does not reset current stream state');
});
