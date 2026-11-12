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
// Let host Response body parsing and controller observers finish before assertions.
async function fixture(t) {
 const dom = createDomFixture(code), w = dom.window;
 Object.assign(w, {Headers, Response, Request, TextEncoder, TextDecoder});
 const timeouts = new Map(), intervals = new Map(); let id=0;
 w.setTimeout = (fn, delay) => {timeouts.set(++id, {fn, delay});return id;};
 w.clearTimeout = id => timeouts.delete(id);
 w.setInterval = (fn, delay) => {intervals.set(++id, {fn, delay});return id;};
 w.clearInterval = id => intervals.delete(id);
 const f = w.fixture();
 t.after(() => {f.controller.dispose();assert.deepEqual(dom.blocked, []);dom.close();});
 const reply = async (i, status=503, body={error:'Retired listing failed'}) => {
  assert.ok(f.requests[i]);f.requests[i].resolve(new Response(JSON.stringify(body), {status}));await settle();
 };
 const poll = async () => {
  const entry=[...timeouts].find(([,value])=>value.delay===3000);assert.ok(entry);
  timeouts.delete(entry[0]);entry[1].fn();await settle();
 };
 f.controller.startSessionsPolling();
 await poll();assert.equal(f.requests.length,1);
 return {...f,w,reply,poll,timeouts,intervals};
}

for (const transition of ['dispose','stop','restart','session','newer-scope']) {
 test(`retired background failure cannot overwrite current state after ${transition}`, async t => {
  const f=await fixture(t);
  if(transition==='dispose')f.controller.dispose();
  if(transition==='stop')f.controller.stopSessionsPolling();
  if(transition==='restart')f.controller.startSessionsPolling();
  if(transition==='session')f.controller.closeSession();
  if(transition==='newer-scope'){
   const newer=f.controller.loadSessions({query:'newer'});await settle();
   await f.reply(1,200,{sessions:[{path:'/synthetic/new',title:'Newer'}],nextCursor:null});await newer;
  }
  f.store.getState().setError('Current owner notice');
  await f.reply(0);
  assert.equal(f.store.getState().error,'Current owner notice');
  assert.equal(f.requests.length,transition==='newer-scope'?2:1,'no replay or recovery request');
 });
}

test('current background failure is reported and later success clears it',async t=>{
 const f=await fixture(t);await f.reply(0);
 assert.equal(f.store.getState().error,'Retired listing failed');
 await f.poll();await f.reply(1,200,{sessions:[],nextCursor:null});
 assert.equal(f.store.getState().error === null, true);
});

test('direct observer still rejects while sharing the background request',async t=>{
 const f=await fixture(t);const direct=f.controller.loadSessions();
 const rejected=assert.rejects(direct,/Retired listing failed/);
 await settle();assert.equal(f.requests.length,1);
 await f.reply(0);await rejected;
 assert.equal(f.store.getState().error,'Retired listing failed');
});

test('restarted polling reports its own request, not the retired one',async t=>{
 const f=await fixture(t);
 f.controller.startSessionsPolling();
 // A changed scope creates an independent current read; polling shares it.
 const current=f.controller.loadSessions({query:'current'});
 const rejected=assert.rejects(current,/Current failure/);
 await settle();await f.poll();assert.equal(f.requests.length,2);
 await f.reply(1,503,{error:'Current failure'});await rejected;
 assert.equal(f.store.getState().error,'Current failure');
 await f.reply(0);assert.equal(f.store.getState().error,'Current failure');
});
