import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const code = await bundleDomFixture(`
import {createOmpStore, selectSessionAuthority, selectSessionTurn} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {RunningAgentCountTracker} from ${JSON.stringify(resolve(root, 'web/src/runtime/running-agent-count.ts'))};
window.fixture = () => {
 const store = createOmpStore(), controller = new OmpSessionController(store, 'synthetic-token');
 let payload = null, status = 200, calls = [];
 controller.fetchAuthed = async (url, init) => {
  calls.push({url,init});
  return {status, ok:status===200, headers:new Headers({ETag:'"fixture"'}), json:async()=>payload};
 };
 controller.hydrateSessionListFromCache = async () => {};
 return {store,controller,calls,RunningAgentCountTracker,selectSessionAuthority,selectSessionTurn,
  payload(value, nextStatus=200) { payload=JSON.parse(JSON.stringify(value));status=nextStatus; }};
};
`);
const authority = (revision=1, turn='idle', daemonInstanceId='one', extra={}) => ({
 daemonInstanceId, revision, bindingEpoch:1, owner:{kind:'none'}, turn,
 confidence:'confirmed', connection:'connected', observedAt:1, activity:null,
 capabilities:{read:true}, ...extra,
});
const row = (path, revision=1, turn='idle', daemon='one', extra={}) => ({path,sessionState:authority(revision,turn,daemon),...extra});
const serial = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
 const dom=createDomFixture(code), w=dom.window;
 Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder,SyntaxError,AbortController});
 w.Date.now=()=>10_000;
 const f=w.fixture();
 t.after(()=>{f.controller.dispose();assert.deepEqual(dom.blocked,[]);dom.close();});
 return {...f,w,dom};
}
function recordCopyCounter(store) {
 let keys=0;const proxies=new WeakSet();
 const instrument=state=>{for(const key of ['sessionAuthorities','legacySessionTurns']) {
  const value=state[key]; if(proxies.has(value))continue;
  const proxy=new Proxy(value,{ownKeys(target){const own=Reflect.ownKeys(target);keys+=own.length;return own;}});
  proxies.add(proxy);state[key]=proxy;
 }};
 instrument(store.getState());const unsubscribe=store.subscribe(instrument);
 return {read:()=>keys,reset:()=>{keys=0;},close:unsubscribe};
}

test('actual controller bounds retained record copying for 50-row pages and a large refresh',async t=>{
 const f=fixture(t),count=recordCopyCounter(f.store);t.after(count.close);
 for(let offset=0;offset<300;offset+=50){
  f.payload({sessions:Array.from({length:50},(_,i)=>row('/'+(offset+i))),nextCursor:offset<250?'c'+offset:null});
  if(offset===0)await f.controller.loadSessions({query:'synthetic'});else await f.controller.loadMoreSessions();
 }
 assert.equal(f.store.getState().sessions.length,300);
 assert.ok(count.read()<20_000,`archive copied ${count.read()} record keys; baseline copies 89,700`);
 count.reset();
 f.payload({sessions:Array.from({length:300},(_,i)=>row('/'+i,2)),nextCursor:null});
 await f.controller.loadSessions({query:'synthetic'});
 assert.ok(count.read()<2_400,`refresh copied ${count.read()} record keys; baseline copies 180,000`);
});

test('batch follows ordered authority and legacy acceptance without mutating earlier snapshots',t=>{
 const f=fixture(t),s=f.store;
 s.getState().setSessionPage([{path:'/a'},{path:'/legacy'},{path:'/untouched'}],null,'scope');
 assert.equal(s.getState().reconcileSessionState('/a',row('/a',5,'running'),10),true);
 const before=s.getState(), original=serial({sessions:before.sessions,authorities:before.sessionAuthorities,legacy:before.legacySessionTurns});
 Object.freeze(before.sessions);Object.freeze(before.sessionAuthorities);Object.freeze(before.legacySessionTurns);
 const entries=[
  {path:'/a',evidence:row('/a',4)},
  {path:'/a',evidence:{sessionState:authority(6,'idle','one',{bindingEpoch:0})}},
  {path:'/a',evidence:row('/a',6)},
  {path:'/a',evidence:row('/a',6,'running')},
  {path:'/legacy',evidence:{running:true}},
  {path:'/legacy',evidence:{running:false}},
  {path:'/a',evidence:{sessionState:{revision:'invalid'},running:true}},
  {path:'/unknown',evidence:{}},
  {path:'/bad-now',evidence:{running:true,now:{state:'invalid'}}},
 ];
 const accepted=s.getState().reconcileSessionStates(entries,20);
 assert.deepEqual(serial(accepted),[false,false,true,false,true,false,false,false,false]);
 assert.equal(s.getState().sessionAuthorities['/a'].turn,'idle');
 assert.equal(s.getState().legacySessionTurns['/legacy'].turn,'running');
 assert.equal(s.getState().sessions[2],before.sessions[2],'unchanged row retains identity');
 assert.notEqual(s.getState().sessions[0],before.sessions[0]);
 assert.deepEqual(serial({sessions:before.sessions,authorities:before.sessionAuthorities,legacy:before.legacySessionTurns}),original,'prior snapshot remains unchanged');
 let notifications=0;const unsubscribe=s.subscribe(()=>notifications++);
 const stable=s.getState();
 assert.deepEqual(serial(stable.reconcileSessionStates(entries,20)),entries.map(()=>false));
 assert.equal(s.getState(),stable);assert.equal(notifications,0);unsubscribe();
});

test('batch preserves first duplicate-row projection and own reserved-key records',t=>{
 const f=fixture(t),s=f.store;
 s.getState().setSessionPage([{path:'/dup',title:'first'},{path:'/dup',title:'second'},{path:'__proto__'},{path:'constructor'},{path:'toString'}],null,'scope');
 const before=s.getState();
 const paths=['/dup','__proto__','constructor','toString'];
 assert.deepEqual(serial(s.getState().reconcileSessionStates(paths.map(path=>({path,evidence:row(path,1,'running')})),1)),paths.map(()=>true));
 const after=s.getState();
 assert.equal(after.sessions[0].running,true);
 assert.equal(after.sessions[1],before.sessions[1],'only first matching retained row is projected');
 for(const path of paths){
  assert.equal(Object.prototype.hasOwnProperty.call(after.sessionAuthorities,path),true);
  assert.equal(after.sessionAuthorities[path].turn,'running');
  assert.equal(Object.prototype.hasOwnProperty.call(after.legacySessionTurns,path),true);
 }
 assert.equal(Object.prototype.hasOwnProperty.call(before.sessionAuthorities,'__proto__'),false);
 assert.equal(Object.getPrototypeOf(after.sessionAuthorities),f.w.Object.prototype);
});

test('batch keeps daemon retirement, ingress fences and active state resets sequential',t=>{
 const f=fixture(t),s=f.store;
 s.getState().beginSession('/active');
 s.getState().setSessionPage([{path:'/active'},{path:'/passive'}],null,'scope');
 s.getState().reconcileSessionState('/active',row('/active',5,'running','one'),10);
 const results=s.getState().reconcileSessionStates([
  {path:'/passive',evidence:row('/passive',1,'running','two')},
  {path:'/active',evidence:row('/active',99,'running','one')},
  {path:'/active',evidence:row('/active',1,'idle','two')},
  {path:'/passive',evidence:row('/passive',2,'idle','two')},
 ],11);
 assert.deepEqual(serial(results),[true,false,true,true]);
 assert.equal(s.getState().sessionAuthorities['/active'].daemonInstanceId,'two');
 assert.equal(s.getState().agentWorking,false);assert.equal(s.getState().activity === null, true);
 assert.equal(s.getState().reconcileSessionState('/active',row('/active',1,'running','three'),10),false,'old request cannot start new daemon namespace');
 assert.equal(s.getState().reconcileSessionState('/active',row('/active',3,'running','two'),1),true,'same namespace still uses revision ordering');
 assert.equal(s.getState().reconcileSessionState('/active',row('/active',1,'idle','three'),12),true);
 assert.equal(s.getState().reconcileSessionState('/active',row('/active',999,'running','two'),13),false);
 assert.equal(s.getState().reconcileSessionState('/active',row('/active',999,'running','one'),14),false);
 assert.equal(s.getState().sessionAuthorities['/active'].daemonInstanceId,'three');
});

for(const storePath of ['/active','/store-active'])test(`controller batching preserves active transitions and stream commits (${storePath})`,t=>{
 function run(batch){
  const f=fixture(t),s=f.store,c=f.controller;
  s.getState().beginSession(storePath);c.activeSession='/active';
  s.getState().setSessionPage([{path:'/active'},{path:'/store-active'},{path:'/untouched'}],null,'scope');
  c.reconcileSessionState('/active',row('/active',1,'running'),1);
  if(storePath!=='/active')c.reconcileSessionState(storePath,row(storePath,1,'running'),1);
  c.setStreamingMessage({role:'assistant',id:'live-reply',content:[{type:'text',text:'Hello'}]});
  c.pendingDeltas=[{keep:null,text:' world'}];
  const commits=[],transitions=[];
  const original=c.commitStreamingMessage.bind(c);
  c.commitStreamingMessage=(...args)=>{commits.push(serial({authorities:s.getState().sessionAuthorities,rows:s.getState().sessions}));original(...args);};
  let last;
  const unsubscribe=s.subscribe(state=>{
   const next=JSON.stringify([state.sessionAuthorities[storePath],state.activity,state.agentWorking]);
   if(next!==last){last=next;transitions.push(next);}
  });
  const rows=[row('/p1',1),row('/p2',1),row('/active',2),row('/p3',1),row('/p4',1),
   row('/active',3,'running'),row('/store-active',2,'running'),row('/p5',1,'idle','two'),
   row('/p6',1,'running','two'),row('/p7',1,'idle','two'),row('/active',1,'idle','two'),
   row('/store-active',1,'running','two'),row('/p8',99,'running','one'),row('/active',99,'running','one'),
   row('/active',2,'running','two'),row('/active',3,'idle','two')];
  if(batch)c.ingestSessionSummaries(rows,2);else for(const r of rows)c.reconcileSessionState(r.path,r,2);
  unsubscribe();
  const state=s.getState();
  assert.equal(state.messages.at(-1).text,'Hello world','active idle drains queued text before committing');
  assert.equal(state.streamingMessage === null, true);
  assert.equal(state.sessionAuthorities['/active'].turn,'idle');
  assert.equal(commits.length,3,'all three accepted active idle rows commit');
  return serial({commits,transitions,state});
 }
 assert.deepEqual(run(true),run(false));
});

test('controller batching preserves real tracker requests and synchronous cancellation on daemon/owner changes',t=>{
 function run(batch){
  const f=fixture(t),s=f.store,c=f.controller;
  const controlled=(path,rev,daemon='one',owner='bridge')=>({path,sessionState:authority(rev,'running',daemon,{owner:{kind:owner,bindingId:daemon+rev}})});
  s.getState().beginSession('/active');c.activeSession='/active';s.getState().setConnection('open');
  c.reconcileSessionState('/active',controlled('/active',1),1);
  const trace=[];
  const tracker=new f.RunningAgentCountTracker(s,(path,signal)=>{
   trace.push(['read',path,s.getState().sessionAuthorities[path].daemonInstanceId,s.getState().sessionAuthorities[path].owner]);
   signal.addEventListener('abort',()=>trace.push(['abort',path]));
   return new Promise(()=>{});
  });
  tracker.start();
  const rows=[row('/p1'),row('/p2'),row('/p3'),row('/p4',1,'idle','two'),row('/p5',1,'idle','two'),
   controlled('/active',1,'two'),row('/p6',1,'idle','two'),controlled('/active',2,'two','collab'),
   row('/p7',99,'idle','one'),controlled('/active',99,'one'),row('/p8',1,'idle','two')];
  if(batch)c.ingestSessionSummaries(rows,2);else for(const r of rows)c.reconcileSessionState(r.path,r,2);
  tracker.stop();
  assert.equal(trace.filter(x=>x[0]==='read').length,3);
  assert.equal(trace.filter(x=>x[0]==='abort').length,3);
  return serial(trace);
 }
 assert.deepEqual(run(true),run(false));
});

test('controller keeps evidence and authority clock conversion interleaved in each passive run',t=>{
 function run(batch){
  const f=fixture(t),c=f.controller;let now=10_000;
  f.w.Date.now=()=>++now;
  const activity={source:'synthetic',kind:'thinking',observedAt:100,stale:false,since:100,turnStartedAt:50,tools:0};
  const rows=Array.from({length:6},(_,i)=>({path:'/'+i,sessionState:authority(1,'running','one',{activity}),
   ...(i===2?{at:500}:{}),...(i===3?{now:{state:'writing',since:200,turnStartedAt:50,tools:0}}:{})}));
  rows.push({path:'/legacy',now:{state:'thinking',since:100,turnStartedAt:50,tools:0}});
  if(batch)c.ingestSessionSummaries(rows,1);else for(const row of rows)c.reconcileSessionState(row.path,row,1);
  return serial({turns:f.store.getState().legacySessionTurns,clockShift:c.clockShift,now});
 }
 assert.deepEqual(run(true),run(false));
});
