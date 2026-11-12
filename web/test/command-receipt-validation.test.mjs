import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Real API/controller/outbox code; only transport is synthetic. No browser evidence.
const code = await bundleDomFixture(`
import { DaemonApi, sendPromptDurably } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import { OmpSessionController } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import * as queue from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
const calls = [], namespace = queue.offlineQueueNamespaceForCredential('synthetic-token');
queue.setOfflineQueueNamespace(namespace);
let receipt, protocol = 1, status = 200, receiptResponse = null;
const envelope = (path, init) => ({ok:true, receipt, receipts:[receipt], receiptBinding:{version:1,
 requestedSessionPath: path === '/api/prompt' ? JSON.parse(init.body).sessionPath : new URL(path, 'http://synthetic.invalid').searchParams.get('session'), canonicalSessionPath:receipt?.sessionPath}});
DaemonApi.prototype.fetchJson = async function(path, init) {
 calls.push({ path, init });
 if (path === '/api/version') return { protocolVersion: protocol, minClientProtocolVersion: 1, capabilities:['receipt-session-binding-v1'] };
 return envelope(path,init);
};
DaemonApi.prototype.dedupedFetch = DaemonApi.prototype.fetchJson;
const controller = Object.create(OmpSessionController.prototype);
Object.assign(controller, { queueNamespace: namespace, activeSession: null, reconcilingReceipts: false,
 store: { getState: () => ({ setQueuedCount() {}, setError() {} }) },
 ensureReceiptProtocol: async () => {},
 request: async (path, init) => { calls.push({path,init}); return envelope(path,init); },
 fetchAuthed: async path => { calls.push({path}); if(receiptResponse)return receiptResponse; return { status, ok: status === 200, json: async () => envelope(path) }; }
});
window.fixture = { Error, queue, namespace, calls, controller, api: new DaemonApi('synthetic-token'),
 configure(value, version = 1, httpStatus = 200, response = null) { receipt = value; protocol = version; status = httpStatus; receiptResponse = response; },
 seed: (commandId, sessionPath = '/synthetic/intended') => queue.enqueue({commandId, sessionPath, text:'Retained '+commandId, namespace}),
 get: id => queue.getQueued(id, namespace),
 flush: send => queue.flush(send, {namespace, isTransient: () => false}),
 status: id => sendPromptDurably('/synthetic/intended','Retained '+id,[],{token:'synthetic-token',commandId:id}),
};
`);
const receipt = (extra = {}) => ({ commandId: 'intended-command', sessionPath: '/synthetic/intended', state: 'completed', createdAt: 1, updatedAt: 2, ...extra });
const invalid = [
 ['other command', receipt({commandId:'other-command'})],
 ['unknown state', receipt({state:'surprise'})],
 ['local saved state', receipt({state:'saved'})],
 ['missing identity', {state:'completed'}],
 ['missing receipt', null],
 ['missing session path', receipt({sessionPath:undefined})],
 ['empty session path', receipt({sessionPath:''})],
 ['missing timestamp', receipt({updatedAt:undefined})],
 ['invalid timestamp', receipt({createdAt:NaN})],
 ['invalid error', receipt({error:{message:'bad'}})],
 ['invalid code', receipt({code:7})],
];
function fixture(t) { const dom = createDomFixture(code); t.after(() => { assert.deepEqual(dom.blocked, []); dom.close(); }); const f=dom.window.fixture,configure=f.configure; f.configure=(value,version=1,status=200)=>configure(value,version,status,status===404?new Response('{\"ok\":false,\"error\":\"receipt not found\"}',{status}):null); return f; }
for (const [name, value] of invalid) {
 test(`queue rejects ${name} without confirming either command or replaying`, async t => {
  const f=fixture(t); await f.seed('intended-command'); await f.seed('other-command','/synthetic/other'); let sends=0;
  await f.flush(async()=>{sends++;return value});
  const intended=await f.get('intended-command'), other=await f.get('other-command');
  assert.equal(intended.state,'uncertain'); assert.equal(intended.commandId,'intended-command'); assert.equal(intended.text,'Retained intended-command');
  assert.equal(other.state,'saved'); assert.equal(sends,1);
  await f.flush(async entry=>{sends++;return receipt({commandId:entry.commandId,sessionPath:entry.sessionPath})});
  assert.equal(sends,2); assert.equal((await f.get('intended-command')).state,'uncertain');
 });
 test(`controller submit rejects ${name} as uncertain`, async t => {
  const f=fixture(t); await f.seed('intended-command'); f.configure(value); await f.controller.flushQueue();
  assert.equal((await f.get('intended-command')).state,'uncertain');
  await f.controller.flushQueue(); assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,1);
 });
 test(`controller status preserves uncertainty for ${name}`, async t => {
  const f=fixture(t); await f.seed('intended-command'); await f.queue.update('intended-command',{state:'uncertain'},f.namespace);
  f.configure(value); await f.controller.reconcileReceipts(); assert.equal((await f.get('intended-command')).state,'uncertain');
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].path,'/api/receipts/intended-command?session=%2Fsynthetic%2Fintended');
 });
 test(`durable Check status cannot confirm ${name}`, async t => {
  const f=fixture(t); await f.seed('intended-command'); await f.queue.update('intended-command',{state:'uncertain'},f.namespace); f.configure(value);
  try { await f.status('intended-command'); } catch {}
  assert.equal((await f.get('intended-command')).state,'uncertain'); assert.equal(f.calls.length,1); assert.equal(f.calls[0].path,'/api/receipts/intended-command?session=%2Fsynthetic%2Fintended');
 });
 test(`DaemonApi submit rejects ${name}`, async t => {
  const f=fixture(t); f.configure(value); await assert.rejects(f.api.prompt('/synthetic/intended','text',[],'intended-command'), /receipt/i);
 });
}
for (const state of ['accepted','dispatching','forwarded','received','running','completed','failed','uncertain']) {
 test(`valid ${state} receipt survives submit and status unchanged`,async t=>{
  const f=fixture(t), value=receipt({state,code:'synthetic',error:'metadata'}); f.configure(value);
  assert.equal((await f.api.prompt('/synthetic/intended','text',[],'intended-command')).receipt,value);
  assert.equal((await f.api.getReceipt({commandId:'intended-command',sessionPath:'/synthetic/intended'})).receipt,value);
 });
}
test('incompatible protocol retains saved command without POST',async t=>{
 const f=fixture(t); await f.seed('intended-command'); f.configure(receipt(),0);
 await f.flush(e=>f.api.prompt(e.sessionPath,e.text,[],e.commandId));
 assert.equal((await f.get('intended-command')).state,'saved'); assert.deepEqual(Array.from(f.calls,c=>c.path),['/api/version']);
});
test('controller 404 retains same-ID uncertainty without POST',async t=>{
 const f=fixture(t); await f.seed('intended-command'); await f.queue.update('intended-command',{state:'accepted'},f.namespace); f.configure(null,1,404);
 await f.controller.reconcileReceipts(); assert.equal((await f.get('intended-command')).state,'accepted'); assert.equal(f.calls.length,1);
});

test('ordinary alias input accepts a canonical receipt without changing queue identity',async t=>{
 const f=fixture(t), alias='/synthetic/alias/session.jsonl', canonical='/synthetic/real/session.jsonl';
 const value=receipt({sessionPath:canonical}); f.configure(value);
 assert.equal((await f.api.prompt(alias,'text',[],'intended-command')).receipt,value);
 await f.seed('intended-command',alias); await f.controller.flushQueue();
 const saved=await f.get('intended-command'); assert.equal(saved.state,'completed'); assert.equal(saved.sessionPath,alias); assert.equal(saved.receipt.sessionPath,canonical);
 await f.queue.update('intended-command',{state:'uncertain'},f.namespace);
 await f.controller.reconcileReceipts(); assert.equal((await f.get('intended-command')).state,'completed');
 await f.queue.update('intended-command',{state:'uncertain'},f.namespace);
 assert.equal((await f.status('intended-command')).sessionPath,canonical);
 assert.equal((await f.get('intended-command')).sessionPath,alias);
});
test('generated and recovered IDs are compared exactly without browser normalization',async t=>{
 const f=fixture(t); const id=f.queue.makeCommandId(); assert.equal(id,id.trim());
 f.configure(receipt({commandId:id})); assert.equal((await f.api.prompt('/synthetic/intended','text',[],id)).receipt.commandId,id);
 f.configure(receipt({commandId:'padded-id'}));
 await assert.rejects(f.api.prompt('/synthetic/intended','text',[],' padded-id '),/receipt/i);
});

test('receipt listing validates structures without comparing canonical paths to raw aliases',async t=>{
 const f=fixture(t), value=receipt({sessionPath:'/synthetic/real/session.jsonl'}); f.configure(value);
 assert.equal((await f.api.getReceipts('/synthetic/alias/session.jsonl'))[0],value);
 f.configure(receipt({state:'future'})); await assert.rejects(f.api.getReceipts('/synthetic/alias/session.jsonl'),/receipt/i);
});
test('DaemonApi 404 remains absence rather than a replay instruction',async t=>{
 const f=fixture(t); f.api.dedupedFetch=async()=>{const error=new f.Error('not found');error.status=404;throw error};
 assert.equal(await f.api.getReceipt({commandId:'intended-command',sessionPath:'/synthetic/intended'}) === null, true);
});
test('ingress-trimmed caller ID cannot confirm another record or authorize resend',async t=>{
 const f=fixture(t); await f.seed(' padded-id '); await f.seed('padded-id');
 f.configure(receipt({commandId:'padded-id'})); await f.controller.flushQueue();
 assert.equal((await f.get(' padded-id ')).state,'uncertain'); assert.equal((await f.get('padded-id')).state,'saved');
 assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,1);
 try { await f.status(' padded-id '); } catch {}
 assert.equal((await f.get(' padded-id ')).state,'uncertain'); assert.equal((await f.get('padded-id')).state,'saved');
 assert.equal(f.calls.filter(c=>c.path==='/api/prompt').length,1);
 assert.equal(f.calls.at(-1).path,'/api/receipts/%20padded-id%20?session=%2Fsynthetic%2Fintended');
});
