import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const code=await bundleDomFixture(`
import {RunningAgentCountTracker,parseRunningAgentCount} from ${JSON.stringify(resolve(root,'web/src/runtime/running-agent-count.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import {getOfflineQueueNamespace} from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
import {agentCounts} from ${JSON.stringify(resolve(root,'web/src/app/tools/agent-status.tsx'))};
const store=createOmpStore(),requests=[],timers=new Map();let id=0;
window.setInterval=(fn,ms)=>{timers.set(++id,{fn,ms});return id};window.clearInterval=id=>timers.delete(id);
const tracker=new RunningAgentCountTracker(store,(path,signal)=>new Promise((resolve,reject)=>requests.push({path,signal,resolve,reject})));
const controller=Object.create(OmpSessionController.prototype);
Object.assign(controller,{store,runningAgentCount:tracker,activeSession:'/synthetic/a',generation:0,disposed:false,queueNamespace:getOfflineQueueNamespace(),noteLocalActivity:()=>{},catchUp:async()=>{},reconcileSessionState:()=>{}});
window.fixture={store,tracker,requests,timers,parseRunningAgentCount,agentCounts,
 event(type,fields={}){controller.handleFrame(type==='resync'?{type}:{type:'event',event:{type,...fields}},0,'/synthetic/a')},
 start(){tracker.start()},stop(){tracker.stop()}};
`);
const authority=(patch={})=>({daemonInstanceId:'daemon-a',revision:1,bindingEpoch:1,owner:{kind:'bridge',pid:1},confidence:'confirmed',connection:'connected',turn:'idle',observedAt:1,activity:null,capabilities:{read:true},...patch});
const snapshot=(runningCount=2,connectionId='lease-a')=>({ok:true,agents:[],runningCount,connectionId});
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
async function fixture(t,patch={}){
 const dom=createDomFixture(code),f=dom.window.fixture;
 f.store.setState({sessionPath:'/synthetic/a',connection:'open',sessionAuthorities:{'/synthetic/a':authority(),'/synthetic/b':authority()},...patch});f.start();
 t.after(()=>{f.stop();assert.equal(f.timers.size,0);assert.deepEqual(dom.blocked,[]);dom.close()});
 return {...f, count:()=>f.store.getState().runningAgentCount,
 set:async patch=>{f.store.setState(patch);await drain()},
 respond:async(i,value=snapshot())=>{f.requests[i].resolve(value);await drain()},
 reject:async i=>{f.requests[i].reject(new Error('synthetic failure'));await drain()},
 tick:async()=>{for(const {fn} of [...f.timers.values()])fn();await drain()},
 visible:async value=>{Object.defineProperty(dom.window.document,'visibilityState',{configurable:true,value});dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));await drain()}};
}
test('unknown is distinct from validated complete zero and a running count',async t=>{
 const f=await fixture(t);assert.equal(f.count() === null, true);await f.respond(0,snapshot(0));assert.equal(f.count(),0);
 f.tracker.invalidate();assert.equal(f.count() === null, true);await f.respond(1,snapshot(3));assert.equal(f.count(),3);
});
test('retained desktop workers add neither work nor attention, including a recent transcript spawn',async t=>{
 const f=await fixture(t),now=1000;
 const messages=[{id:'parent',role:'assistant',text:'',createdAt:new Date(now),parts:[{
  kind:'tool',name:'task',callId:'spawn',state:'ok',endedAt:now,
  args:{tasks:[{name:'Retained'},{name:'Working'}]},
  agents:[{id:'Retained',status:'pending'},{id:'Working',status:'pending'}],
 }]}];
 const context={live:true,turnStartedAt:now,now};
 const counts=f.agentCounts([{id:'Retained',kind:'sub',status:'parked'}],messages,context);
 assert.equal(counts.working,1,'the parked roster overrides its recent pending spawn');
 assert.equal(counts.needsYou,0,'retention is not pending input');
 for(const statuses of [['parked'],['parked','parked'],['idle','parked','aborted']]){
  const rows=statuses.map((status,i)=>({id:'agent-'+i,kind:'sub',status}));
  const neutral=f.agentCounts(rows,[],context);
  assert.equal(neutral.working,0);assert.equal(neutral.needsYou,0);
 }
 await f.respond(0,{...snapshot(0),agents:[{id:'Retained',kind:'sub',status:'parked'}]});
 assert.equal(f.count(),0,'a complete roster of retained workers has zero running workers');
});
test('older servers and malformed/unknown counts never manufacture zero',async t=>{
 const f=await fixture(t);
 for(const value of [{ok:true,agents:[],connectionId:'old'},null,snapshot(null),snapshot(-1),snapshot(1.5),snapshot(4097),snapshot(2,''),{...snapshot(),agents:null}]){
  const i=f.requests.length-1;await f.respond(i,value);assert.equal(f.count() === null, true);f.tracker.invalidate();
 }
});
test('session changes abort old reads and late completions cannot repaint',async t=>{
 const f=await fixture(t);await f.set({sessionPath:'/synthetic/b'});assert.equal(f.requests[0].signal.aborted,true);
 await f.respond(1,snapshot(1));await f.respond(0,snapshot(9));assert.equal(f.count(),1);assert.equal(f.requests[1].path,'/synthetic/b');
});
test('reconnect fences same-session old success and failure',async t=>{
 const f=await fixture(t);await f.respond(0);await f.tick();await f.set({connection:'reconnecting'});assert.equal(f.count() === null, true);
 await f.set({connection:'open'});await f.respond(2,snapshot(1,'lease-new'));await f.reject(1);assert.equal(f.count(),1);
});
for(const patch of [{bindingEpoch:2},{daemonInstanceId:'daemon-b'},{owner:{kind:'bridge',pid:2}}])test('authority replacement fences pending source '+JSON.stringify(patch),async t=>{
 const f=await fixture(t);await f.set({sessionAuthorities:{'/synthetic/a':authority(patch)}});await f.respond(0,snapshot(9));assert.equal(f.count() === null, true);await f.respond(1,snapshot(1));assert.equal(f.count(),1);
});
for(const patch of [{owner:{kind:'child'}},{owner:{kind:'none'}},{confidence:'inferred'},{connection:'reconnecting'}])test('unsupported authority remains unknown '+JSON.stringify(patch),async t=>{
 const f=await fixture(t,{sessionAuthorities:{'/synthetic/a':authority(patch)}});assert.equal(f.requests.length,0);assert.equal(f.count() === null, true);assert.equal(f.timers.size,0);
});
test('visibility clears count, aborts and pauses reads, visible starts fresh',async t=>{
 const f=await fixture(t);await f.respond(0);await f.visible('hidden');assert.equal(f.count() === null, true);await f.tick();assert.equal(f.requests.length,1);assert.equal(f.timers.size,0);
 await f.visible('visible');await f.respond(1);assert.equal(f.count(),2);
});
test('events coalesce while a request is pending, never apply untagged payloads',async t=>{
 const f=await fixture(t);for(let i=0;i<20;i++)f.event('collab_agents',{agents:[]});assert.equal(f.requests.length,1);
 await f.respond(0,snapshot(9));assert.equal(f.count() === null, true);assert.equal(f.requests.length,2);await f.respond(1,snapshot(1));assert.equal(f.count(),1);
});
for(const [type,fields] of [['collab_link_state',{state:'attached'}],['collab_link_state',{state:'lost'}],['resync',{}],['collab_agents',{agents:null}]])test('real controller ingress invalidates '+type+' '+JSON.stringify(fields),async t=>{
 const f=await fixture(t);await f.respond(0);f.event(type,fields);assert.equal(f.count() === null, true);assert.equal(f.requests.length,2);
});
test('ten-second interval expires independently of a stalled read and rejects old completion',async t=>{
 const f=await fixture(t);await f.respond(0);await f.tick();assert.equal(f.count() === null, true);assert.equal(f.requests.length,2);
 await f.tick();assert.equal(f.requests[1].signal.aborted,true);assert.equal(f.requests.length,3);await f.respond(1,snapshot(9));assert.equal(f.count() === null, true);await f.respond(2,snapshot(1));assert.equal(f.count(),1);
});
test('failed read clears count and next bounded refresh recovers',async t=>{
 const f=await fixture(t);await f.respond(0);await f.tick();await f.reject(1);assert.equal(f.count() === null, true);await f.tick();await f.respond(2,snapshot(0));assert.equal(f.count(),0);
});
test('stop clears listeners/timers, aborts reads and rejects post-stop completion',async t=>{
 const f=await fixture(t);f.stop();assert.equal(f.requests[0].signal.aborted,true);await f.respond(0);assert.equal(f.count() === null, true);await f.set({sessionPath:'/synthetic/b'});assert.equal(f.requests.length,1);
});
test('revision and unrelated store changes do not create requests or reset count',async t=>{
 const f=await fixture(t);await f.respond(0);await f.set({sessionAuthorities:{'/synthetic/a':authority({revision:2,turn:'running'})},error:'unrelated'});assert.equal(f.requests.length,1);assert.equal(f.count(),2);
});
