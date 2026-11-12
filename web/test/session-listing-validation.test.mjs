import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {setImmediate as settle} from 'node:timers/promises';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const code = await bundleDomFixture(`
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
window.fixture = () => {
 const requests = [], store = createOmpStore();
 const controller = new OmpSessionController(store, 'synthetic-token');
 controller.fetchAuthed = (url, init) => {
  if (!url.startsWith('/api/sessions?')) throw Error('Unexpected request ' + url);
  return new Promise((resolve, reject) => requests.push({url, init, resolve, reject}));
 };
 controller.connectSessionsSocket = () => {};
 return {requests, store, controller};
};
`);

const rows = [{path:'/synthetic/current',title:'Retained session'}];
const projects = [{cwd:'/synthetic',label:'Retained project',activeSessions:1}];
const malformed = [
 ['invalid JSON', '{'],
 ['null body', 'null'],
 ['scalar body', 'true'],
 ['array body', '[]'],
 ['missing sessions', '{}'],
 ['null sessions', '{"sessions":null}'],
 ['object sessions', '{"sessions":{}}'],
 ['explicit failure', '{"ok":false,"error":"Listing unavailable","sessions":[]}'],
 ['numeric cursor', '{"sessions":[],"nextCursor":42}'],
 ['object cursor', '{"sessions":[],"nextCursor":{}}'],
];
const snapshot = state => JSON.stringify({
 sessions:state.sessions, cursor:state.sessionsNextCursor, projects:state.sessionProjects,
 updatedAt:state.sessionsUpdatedAt, authorities:state.sessionAuthorities,
});

async function fixture(t) {
 const dom = createDomFixture(code), w = dom.window;
 // Response.json and SyntaxError must share the production realm relationship.
 Object.assign(w, {Headers, Response, Request, TextEncoder, TextDecoder, SyntaxError});
 const timeouts = new Map(), intervals = new Map(); let id=0;
 w.setTimeout=(fn,delay)=>{timeouts.set(++id,{fn,delay});return id;};
 w.clearTimeout=id=>timeouts.delete(id);
 w.setInterval=(fn,delay)=>{intervals.set(++id,{fn,delay});return id;};
 w.clearInterval=id=>intervals.delete(id);
 const f=w.fixture();
 t.after(()=>{f.controller.dispose();assert.deepEqual(dom.blocked,[]);dom.close();});
 async function request(operation, raw, {status=200,etag='"original"'}={}) {
  const before=f.requests.length;
  const result=operation().then(value=>({value}),error=>({error}));
  await settle();
  assert.equal(f.requests.length,before+1,'one deliberate read, no replay');
  const entry=f.requests.at(-1);
  entry.resolve(new Response(raw,{status,headers:{ETag:etag}}));
  const outcome=await result;await settle();
  assert.equal(f.requests.length,before+1,'response does not trigger a retry');
  return {...outcome,entry};
 }
 const initial=await request(()=>f.controller.loadSessions(),JSON.stringify({sessions:rows,nextCursor:'older',projects}));
 assert.equal(initial.error,undefined);
 return {...f,request,timeouts};
}

for(const page of ['first','next'])for(const [name,raw] of malformed){
 test(`malformed ${page} page (${name}) rejects without losing the current listing`,async t=>{
  const f=await fixture(t),before=snapshot(f.store.getState());
  f.store.getState().setError('Existing notice');
  const operation=()=>page==='first'?f.controller.loadSessions():f.controller.loadMoreSessions();
  const outcome=await f.request(operation,raw,{etag:'"invalid"'});
  assert.ok(outcome.error,'malformed HTTP 200 must reject');
  if(name==='explicit failure')assert.equal(outcome.error.message,'Listing unavailable');
  assert.equal(snapshot(f.store.getState()),before,'rows, cursor, projects and authority remain intact');
  assert.equal(f.store.getState().error,'Existing notice','direct callers retain error ownership');
  assert.equal(f.store.getState().sessionsLoadingMore,false,'pagination lock is released');
  const recovered=await f.request(operation,JSON.stringify({sessions:page==='first'?rows:[{path:'/synthetic/older'}],nextCursor:null}));
  assert.equal(recovered.error,undefined);
  assert.equal(recovered.entry.init.headers.get('If-None-Match'),page==='first'?'"original"':null,'invalid response never replaces the validator');
  assert.equal(f.store.getState().error === null, true, 'valid deliberate recovery clears the error');
 });
}

test('valid empty page still clears rows and ends pagination',async t=>{
 const f=await fixture(t);
 const outcome=await f.request(()=>f.controller.loadSessions(),'{"sessions":[],"nextCursor":null}');
 assert.equal(outcome.error,undefined);
 assert.equal(f.store.getState().sessions.length,0);
 assert.equal(f.store.getState().sessionsNextCursor === null, true);
});

test('legacy omitted cursor and optional fields remain accepted',async t=>{
 const f=await fixture(t);
 const outcome=await f.request(()=>f.controller.loadSessions(),'{"sessions":[{"path":"/synthetic/legacy","unknownFutureField":true}]}');
 assert.equal(outcome.error,undefined);
 assert.equal(f.store.getState().sessions[0].path,'/synthetic/legacy');
 assert.equal(f.store.getState().sessionsNextCursor === null, true);
});

test('304 after malformed response retains the last valid cached page and validator',async t=>{
 const f=await fixture(t);
 const before=JSON.stringify(f.store.getState().sessions);
 const invalid=await f.request(()=>f.controller.loadSessions(),'null',{etag:'"invalid"'});
 assert.ok(invalid.error);
 const unchanged=await f.request(()=>f.controller.loadSessions(),null,{status:304});
 assert.equal(unchanged.error,undefined);
 assert.equal(unchanged.entry.init.headers.get('If-None-Match'),'"original"');
 assert.equal(JSON.stringify(f.store.getState().sessions),before);
 assert.equal(f.store.getState().sessionsNextCursor,'older');
});

test('concurrent observers share one malformed read and both reject',async t=>{
 const f=await fixture(t);let second;
 const first=await f.request(()=>{
  const first=f.controller.loadSessions();
  second=f.controller.loadSessions().then(()=>null,error=>error);
  return first;
 },'{}');
 assert.ok(first.error);assert.equal(await second,first.error);
});

test('background malformed response reports failure and preserves rows until a later valid poll',async t=>{
 const f=await fixture(t),before=snapshot(f.store.getState());
 const result=await f.request(()=>f.controller.refreshSessions(),'null');
 assert.equal(result.error,undefined,'background owner consumes rejection');
 assert.equal(snapshot(f.store.getState()),before);
 assert.match(f.store.getState().error,/Invalid session listing response/);
 const recovered=await f.request(()=>f.controller.refreshSessions(),JSON.stringify({sessions:rows,nextCursor:'older',projects}));
 assert.equal(recovered.error,undefined);assert.equal(f.store.getState().error === null, true);
});


test('invalid cursor cannot ingest otherwise valid session authority',async t=>{
 const f=await fixture(t),before=snapshot(f.store.getState());
 const sessionState={daemonInstanceId:'synthetic-daemon',revision:1,bindingEpoch:1,
  owner:{kind:'none'},turn:'idle',confidence:'confirmed',connection:'connected',
  observedAt:1,activity:null,capabilities:{read:true}};
 const outcome=await f.request(()=>f.controller.loadSessions(),JSON.stringify({
  sessions:[{path:'/synthetic/new-authority',sessionState}],nextCursor:42,
 }));
 assert.ok(outcome.error);
 assert.equal(snapshot(f.store.getState()),before);
 assert.equal(f.store.getState().sessionAuthorities['/synthetic/new-authority'],undefined);
});
