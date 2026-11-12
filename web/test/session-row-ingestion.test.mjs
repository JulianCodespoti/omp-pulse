import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {setImmediate as settle} from 'node:timers/promises';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const code = await bundleDomFixture(`
import {createOmpStore, selectSessionAuthority, selectSessionTurn} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {parseSessionAuthority, parseOmpActivity} from ${JSON.stringify(resolve(root, 'web/src/domain/protocol.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
window.fixture = () => {
 const requests = [], store = createOmpStore();
 const controller = new OmpSessionController(store, 'synthetic-token');
 controller.fetchAuthed = (url, init) => {
  if (!url.startsWith('/api/sessions?')) throw Error('Unexpected request ' + url);
  return new Promise(resolve => requests.push({url, init, resolve}));
 };
 return {requests, store, controller, parseSessionAuthority, parseOmpActivity, selectSessionAuthority, selectSessionTurn};
};
`);

const authority = (daemonInstanceId, revision, turn) => ({
 daemonInstanceId, revision, bindingEpoch:1, owner:{kind:'none'}, turn,
 confidence:'confirmed', connection:'connected', observedAt:1,
 activity:null, capabilities:{read:true},
});
const rows = [{path:'/synthetic/retained', title:'Retained session',
 sessionState:authority('retained-daemon', 1, 'running')}];
const projects = [{cwd:'/synthetic',label:'Retained project',activeSessions:1}];
const newerRow = {path:'/synthetic/replacement',
 sessionState:authority('replacement-daemon', 1, 'idle')};
const malformedRows = [
 ['null row', null],
 ['scalar row', 42],
 ['array row', []],
 ['missing path', {}],
 ['null path', {path:null}],
 ['numeric path', {path:42}],
];
const snapshot = state => JSON.stringify({
 sessions:state.sessions, authorities:state.sessionAuthorities,
 legacyTurns:state.legacySessionTurns, cursor:state.sessionsNextCursor,
 projects:state.sessionProjects, updatedAt:state.sessionsUpdatedAt,
 agentWorking:state.agentWorking, activity:state.activity,
});

async function fixture(t) {
 const dom = createDomFixture(code), w = dom.window;
 Object.assign(w, {Headers, Response, Request, TextEncoder, TextDecoder, SyntaxError});
 const f = w.fixture();
 t.after(() => { f.controller.dispose(); assert.deepEqual(dom.blocked, []); dom.close(); });
 async function request(operation, body, {status=200, etag='"retained"'}={}) {
  const before = f.requests.length;
  const pending = operation().then(value => ({value}), error => ({error}));
  await settle();
  assert.equal(f.requests.length, before + 1, 'one deliberate read');
  const entry = f.requests.at(-1);
  entry.resolve(new Response(status === 304 ? null : JSON.stringify(body), {status, headers:{ETag:etag}}));
  const outcome = await pending;
  await settle();
  assert.equal(f.requests.length, before + 1, 'no automatic retry');
  return {...outcome, entry};
 }
 const initial = await request(() => f.controller.loadSessions(), {sessions:rows, nextCursor:'older', projects});
 assert.equal(initial.error, undefined);
 assert.equal(f.store.getState().sessionAuthorities[rows[0].path].daemonInstanceId, 'retained-daemon');
 return {...f, request};
}

for (const page of ['first', 'next']) for (const [name, malformed] of malformedRows) {
 test(`${page} page with ${name} cannot partially ingest an earlier authority row`, async t => {
  const f = await fixture(t), before = snapshot(f.store.getState());
  f.store.getState().setError('Existing notice');
  const operation = () => page === 'first' ? f.controller.loadSessions() : f.controller.loadMoreSessions();
  const invalid = await f.request(operation, {sessions:[newerRow, malformed], nextCursor:null, projects:[]}, {etag:'"invalid"'});
  // The assertion before the rejection check proves the baseline corrupts state,
  // even when a null row already causes an incidental TypeError and rejection.
  assert.equal(snapshot(f.store.getState()), before, 'all row identities must be checked before the first authority mutation');
  assert.ok(invalid.error, 'malformed row must reject the whole page');
  assert.equal(invalid.error.message, 'Invalid session listing response');
  assert.equal(f.store.getState().error, 'Existing notice', 'direct caller retains error ownership');
  assert.equal(f.store.getState().sessionsLoadingMore, false, 'older-page lock is released');
  const recovered = await f.request(operation, {sessions:[{path:'/synthetic/recovered'}], nextCursor:null});
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.entry.init.headers.get('If-None-Match'), page === 'first' ? '"retained"' : null,
   'malformed page cannot install its ETag');
  assert.equal(f.store.getState().sessionAuthorities[rows[0].path].daemonInstanceId, 'retained-daemon');
  assert.equal(f.store.getState().sessions.at(-1).path, '/synthetic/recovered');
  assert.equal(f.store.getState().error === null, true);
 });
}

test('304 after invalid row reuses the retained first-page body and authority', async t => {
 const f = await fixture(t), before = snapshot(f.store.getState());
 const invalid = await f.request(() => f.controller.loadSessions(), {sessions:[newerRow, null], nextCursor:null}, {etag:'"invalid"'});
 assert.equal(snapshot(f.store.getState()), before);
 assert.ok(invalid.error);
 const unchanged = await f.request(() => f.controller.loadSessions(), null, {status:304});
 assert.equal(unchanged.error, undefined);
 assert.equal(unchanged.entry.init.headers.get('If-None-Match'), '"retained"');
 assert.equal(JSON.stringify(f.store.getState().sessions), JSON.stringify(rows.map(row => ({...row, running:true, streaming:true, now:null, capabilities:{read:true}}))));
 assert.equal(f.store.getState().sessionsNextCursor, 'older');
});

test('string row paths retain legacy optional-field and project tolerance', async t => {
 const f = await fixture(t);
 const legacy = {path:'', title:null, sessionState:null, now:{unknown:true}, unknownFutureField:true};
 const result = await f.request(() => f.controller.loadSessions(), {sessions:[legacy], projects:'legacy-unknown-shape'});
 assert.equal(result.error, undefined);
 assert.equal(f.store.getState().sessions.length, 1);
 assert.equal(f.store.getState().sessions[0].path, '');
 assert.equal(f.store.getState().sessions[0].title === null, true);
 assert.equal(f.store.getState().sessions[0].unknownFutureField, true);
 assert.equal(f.store.getState().sessionsNextCursor === null, true, 'omitted legacy cursor remains valid');
 assert.equal(JSON.stringify(f.store.getState().sessionProjects), JSON.stringify(projects));
});

const invalidEnums = [
 ['owner kind', value => ({sessionState:{...authority('retained-daemon', 2, 'idle'), owner:{kind:value}}})],
 ['turn', value => ({sessionState:{...authority('retained-daemon', 2, 'idle'), turn:value}})],
 ['confidence', value => ({sessionState:{...authority('retained-daemon', 2, 'idle'), confidence:value}})],
 ['connection', value => ({sessionState:{...authority('retained-daemon', 2, 'idle'), connection:value}})],
 ['legacy activity state', value => ({now:{state:value, since:1, turnStartedAt:1, tools:0}})],
];
for (const page of ['first', 'next']) for (const [name, optionalFields] of invalidEnums) {
 test(`${page} page ignores non-coercible optional ${name} without a partial-ingestion failure`, async t => {
  const f = await fixture(t), before = snapshot(f.store.getState());
  const newer = {...rows[0], sessionState:authority('retained-daemon', 2, 'idle')};
  const malformed = {path:'/synthetic/invalid-optional', ...optionalFields({toString:null})};
  const operation = () => page === 'first' ? f.controller.loadSessions() : f.controller.loadMoreSessions();
  const result = await f.request(operation, {sessions:[newer, malformed], nextCursor:null});
  assert.ok(!result.error || snapshot(f.store.getState()) === before,
   'an optional enum must not throw after the preceding authority row was reconciled');
  assert.equal(result.error, undefined, 'malformed optional evidence is ignored by existing parsers');
  assert.equal(f.store.getState().sessionAuthorities[rows[0].path].revision, 2);
  assert.equal(f.store.getState().sessionAuthorities[malformed.path], undefined);
  assert.equal(f.store.getState().legacySessionTurns[malformed.path], undefined);
  assert.equal(f.store.getState().sessions.length, 2);
  assert.equal(f.store.getState().sessions.at(-1).path, malformed.path);
  assert.equal(f.store.getState().sessionsNextCursor === null, true);
  assert.equal(f.store.getState().sessionsLoadingMore, false);
 });
}

for (const page of ['first', 'next']) for (const path of ['constructor', '__proto__', 'toString']) {
 test(`${page} page treats ${path} as a string identity, never inherited authority`, async t => {
  const f = await fixture(t), before = snapshot(f.store.getState());
  const newer = {...rows[0], sessionState:authority('retained-daemon', 2, 'idle')};
  const operation = () => page === 'first' ? f.controller.loadSessions() : f.controller.loadMoreSessions();
  const result = await f.request(operation, {sessions:[newer, {path}], nextCursor:'more'});
  assert.ok(!result.error || snapshot(f.store.getState()) === before,
   'inherited map entries must not throw after an earlier authority update');
  assert.equal(result.error, undefined, 'string paths do not acquire a content restriction');
  assert.equal(f.store.getState().sessions.at(-1).path, path);
  assert.equal(f.store.getState().sessions.at(-1).sessionState, undefined);
  assert.equal(Object.hasOwn(f.store.getState().sessionAuthorities, path), false);
  assert.equal(f.selectSessionAuthority(f.store.getState(), path) === null, true);
  assert.equal(f.selectSessionTurn(f.store.getState(), path), 'unknown');
  const legacy = await f.request(() => f.controller.loadSessions(), {sessions:[{path, running:false}], nextCursor:null});
  assert.equal(legacy.error, undefined);
  assert.equal(Object.hasOwn(f.store.getState().legacySessionTurns, path), true);
  assert.equal(f.store.getState().legacySessionTurns[path].turn, 'idle');
  const canonical = await f.request(() => f.controller.loadSessions(), {
   sessions:[{path, sessionState:authority('retained-daemon', 3, 'running')}], nextCursor:null,
  });
  assert.equal(canonical.error, undefined);
  assert.equal(Object.hasOwn(f.store.getState().sessionAuthorities, path), true);
  assert.equal(f.store.getState().sessionAuthorities[path].revision, 3);
  assert.equal(f.store.getState().sessions.find(row => row.path === path).running, true);
 });
}

test('authority and activity parsers preserve valid strings and ignore non-string enums', async t => {
 const f = await fixture(t);
 for (const [field, values] of Object.entries({
  kind:['none','child','bridge','collab','foreign','ambiguous'],
  turn:['running','idle','unknown'], confidence:['confirmed','inferred'],
  connection:['connected','reconnecting','unavailable'],
 })) for (const value of values) {
  const state = authority('valid-daemon', 1, 'idle');
  if (field === 'kind') state.owner.kind = value; else state[field] = value;
  assert.ok(f.parseSessionAuthority(state), `${field}=${value} remains valid`);
 }
 for (const value of ['thinking','writing','tool']) {
  assert.equal(f.parseOmpActivity({state:value, since:1, turnStartedAt:1, tools:0}).state, value);
 }
 for (const [name, optionalFields] of invalidEnums) {
  for (const value of [null, 42, true, ['idle'], ['none'], ['confirmed'], ['connected'], ['thinking'], {}, {toString:null}]) {
   const fields = optionalFields(value);
   const parsed = fields.sessionState ? f.parseSessionAuthority(fields.sessionState) : f.parseOmpActivity(fields.now);
   assert.equal(parsed === null, true, `${name}: a non-string is not enum evidence`);
  }
 }
});
