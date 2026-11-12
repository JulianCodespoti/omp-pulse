import {test as nodeTest} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const test = (name, fn) => nodeTest(name, {timeout: 10000}, fn);
// The chat's tab-row badges fed from what omp actually writes: the real
// controller ingests `entries` frames into the real store and the real
// SessionPager renders the tab row. omp's `task` returns at spawn time
// (agents `pending`); each agent's end comes later as an `async-result`
// notice or a `wait` job snapshot. Synthetic DOM, network blocked; no paint
// or geometry claim.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {SessionPager} from ${JSON.stringify(resolve(root, 'web/src/app/nav/SessionPager.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {RunningAgentCountTracker} from ${JSON.stringify(resolve(root, 'web/src/runtime/running-agent-count.ts'))};
DaemonApi.prototype.getChangesSummary = async () => ({notRepo: true, files: [], totals: {files: 0, additions: 0, deletions: 0}});
const store = createOmpStore();
store.getState().beginSession('/synthetic');
const controller = Object.create(OmpSessionController.prototype);
Object.assign(controller, {
 store, activeSession: '/synthetic', generation: 1, disposed: false,
 runningAgentCount: new RunningAgentCountTracker(store, async () => { throw Error('Unexpected count read'); }),
 stateIngressSequence: 0, clockShift: 0, flushHandle: null, flushKind: null,
 pendingDeltas: [], responseChain: null, streamText: '', atBottom: true,
 modelEntryAt: 0, thinkingEntryAt: 0, openingHistory: null,
 historyAbort: new AbortController(), reconnectTimer: null, socket: null,
 watchdogTimer: null, livenessProbe: null, catchUpTimer: null,
 recordSuccess() {}, reconcileReceipts: async () => {}, reloadHistory: async () => {},
 syncOffline() {}, syncQueuedCount() {}, startOfflineTicker() {},
 startLivenessProbe() {}, platformOffline: () => false,
});
window.fixture = {act, store, controller,
 mount() { const r = createRoot(document.getElementById('root')); r.render(h('main', {}, h(SessionPager, {sessionPath: '/synthetic', controller, header: () => null}, h('p', {}, 'chat')))); return r },
};
`, [{name: 'test-import-meta', options(options) {
 return {...options, transform: {...options.transform, define: {...options.transform?.define, 'import.meta': '{}'}}};
}}]);

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
const iso = at => new Date(at).toISOString();
const spawn = (callId, at, names) => ({type: 'message', id: `call-${callId}`, timestamp: iso(at), message: {
 role: 'assistant', timestamp: at,
 content: [{type: 'toolCall', id: callId, name: 'task', arguments: {tasks: names.map(name => ({name, agent: 'task', task: `Do ${name}`}))}}],
}});
const result = (callId, at, toolName, details) => ({type: 'message', id: `result-${callId}`, timestamp: iso(at), message: {
 role: 'toolResult', toolCallId: callId, toolName, isError: false, content: [{type: 'text', text: 'synthetic'}], ...(details ? {details} : {}),
}});
const spawned = (callId, at, names) => result(callId, at, 'task', {results: [], progress: names.map((id, index) => ({index, id, agent: 'task', status: 'pending'}))});
const asyncResult = (id, at, status = 'completed') => ({type: 'custom_message', customType: 'async-result', id: `notice-${id}`, timestamp: iso(at), display: true,
 content: `<system-notice>\nBackground job ${id} has completed.\n<task-result id="${id}" agent="task" status="${status}" duration="1m">\n<output>done</output>\n</task-result>\n</system-notice>`,
 details: {jobs: [{jobId: id, type: 'task', label: id, durationMs: 60_000}]},
});
const waited = (callId, at, jobs) => [
 {type: 'message', id: `call-${callId}`, timestamp: iso(at), message: {role: 'assistant', timestamp: at, content: [{type: 'toolCall', id: callId, name: 'wait', arguments: {}}]}},
 result(callId, at, 'wait', {op: 'wait', jobs: jobs.map(([id, status]) => ({id, type: 'task', status, label: id}))}),
];

async function fixture(t) {
 const dom = createDomFixture(code), w = dom.window;
 const {act, store, controller} = w.fixture;
 w.HTMLElement.prototype.scrollTo = () => {};
 let mounted;
 await act(async () => { mounted = w.fixture.mount() });
 t.after(async () => {
  try {
   await act(async () => { controller.closeSession(); mounted.unmount() });
   assert.deepEqual(dom.blocked, [], 'no fixture attempted network access');
  } finally { dom.close() }
 });
 const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) });
 const change = async fn => { await act(async () => fn()); await settle() };
 const badge = () => w.document.querySelector('[data-testid="tab-badge-agents"]');
 const tab = name => w.document.querySelector(`[data-testid="workspace-tabs"] [data-value="${name}"]`);
 return {
  w, store, change,
  history: entries => change(() => controller.handleFrame({type: 'entries', entries}, controller.generation, controller.activeSession)),
  // `activity` drives the turn selector; null is a known idle turn.
  turn: (running, turnStartedAt = Date.now() - MINUTE) => change(() => store.setState({activity: running ? {state: 'tool', since: Date.now(), turnStartedAt, tools: 1} : null})),
  roster: agents => change(() => store.setState({collabAgents: agents})),
  text: () => badge()?.textContent ?? null,
  tone: () => badge()?.getAttribute('data-tone') ?? null,
  label: () => tab('agents').getAttribute('aria-label'),
  tab,
 };
}

test('a live turn with an in-flight 3-task call badges 3 agents; the result clears it', async t => {
 const f = await fixture(t), now = Date.now();
 await f.turn(true);
 await f.history([spawn('sync', now, ['Alpha', 'Beta', 'Gamma'])]);
 assert.equal(f.text(), '3');
 assert.equal(f.tone(), 'running');
 assert.equal(f.label(), 'Agents, 3 working');
 // A synchronous task returns once its agents are done; no progress means no agent left running.
 await f.history([result('sync', now + 1000, 'task')]);
 assert.equal(f.text(), null);
 assert.equal(f.label(), 'Agents');
});

test('background spawns count until async-result and wait reports settle each one', async t => {
 const f = await fixture(t), now = Date.now();
 await f.turn(true);
 await f.history([spawn('bg', now, ['Alpha', 'Beta', 'Gamma']), spawned('bg', now + 5, ['Alpha', 'Beta', 'Gamma'])]);
 assert.equal(f.text(), '3', 'the spawn result (all pending) keeps every agent counted');
 // The parent often ends its turn while its agents keep working.
 await f.turn(false);
 assert.equal(f.text(), '3');
 await f.history([asyncResult('Alpha', now + MINUTE)]);
 assert.equal(f.text(), '2');
 assert.equal(f.store.getState().settledAgents.Alpha, 'completed');
 await f.history(waited('w1', now + 2 * MINUTE, [['Beta', 'completed']]));
 assert.equal(f.text(), '1');
 assert.equal(f.label(), 'Agents, 1 working');
 await f.history([asyncResult('Gamma', now + 3 * MINUTE, 'failed')]);
 assert.equal(f.text(), null);
 assert.equal(f.store.getState().settledAgents.Gamma, 'failed');
});

test('a months-old unsettled spawn never counts, idle or during a new turn', async t => {
 const f = await fixture(t), old = Date.now() - 90 * DAY;
 await f.history([
  spawn('old-bg', old, ['Alpha', 'Beta']), spawned('old-bg', old + 5, ['Alpha', 'Beta']),
  spawn('old-sync', old + MINUTE, ['Gamma']),
 ]);
 await f.turn(false);
 assert.equal(f.text(), null);
 await f.turn(true, Date.now());
 assert.equal(f.text(), null, 'a new turn does not revive spawns from an earlier one');
});

test('a roster agent the transcript also spawned is counted once, by the roster', async t => {
 const f = await fixture(t), now = Date.now();
 await f.turn(true);
 await f.history([spawn('mix', now, ['Alpha', 'Beta']), spawned('mix', now + 5, ['Alpha', 'Beta'])]);
 assert.equal(f.text(), '2');
 await f.roster([
  {id: 'Alpha', kind: 'sub', displayName: 'Alpha', status: 'running'},
  {id: 'Helper', kind: 'sub', displayName: 'Helper', status: 'parked'},
 ]);
 assert.equal(f.text(), '2', 'retained workers do not add to the running count');
 assert.equal(f.tone(), 'running', 'parked lifecycle state does not turn the badge amber');
 assert.equal(f.label(), 'Agents, 2 working');
 // The roster's word wins for an agent both sources know.
 await f.roster([{id: 'Alpha', kind: 'sub', displayName: 'Alpha', status: 'parked'}]);
 assert.equal(f.text(), '1', 'a parked roster worker overrides its transcript spawn');
 assert.equal(f.tone(), 'running');
 assert.equal(f.label(), 'Agents, 1 working');
 await f.roster([{id: 'Alpha', kind: 'sub', displayName: 'Alpha', status: 'idle'}]);
 assert.equal(f.text(), '1');
});

test('the badge follows roster updates', async t => {
 const f = await fixture(t);
 const rows = statuses => statuses.map((status, i) => ({id: 'agent-' + i, kind: 'sub', displayName: 'Agent ' + i, status, createdAt: 1}));
 for (const [statuses, text, tone, words] of [
  [['running', 'running', 'running'], '3', 'running', '3 working'],
  [['parked'], null, null, null],
  [['parked', 'parked'], null, null, null],
  [['running', 'parked'], '1', 'running', '1 working'],
  [['idle', 'aborted'], null, null, null],
  [[], null, null, null],
 ]) {
  await f.roster(rows(statuses));
  assert.equal(f.text(), text, statuses.join());
  assert.equal(f.tone(), tone, statuses.join());
  assert.equal(f.label(), words ? `Agents, ${words}` : 'Agents', statuses.join());
 }
});

test('the Tasks tab counts what is left of the open plan and says how far it got', async t => {
 const f = await fixture(t), now = Date.now();
 const plan = (id, at, statuses) => [
  {type: 'message', id: `call-${id}`, timestamp: iso(at), message: {role: 'assistant', timestamp: at, content: [{type: 'toolCall', id, name: 'todo', arguments: {}}]}},
  result(id, at + 5, 'todo', {phases: [{name: 'Fix', tasks: statuses.map((status, i) => ({content: `Task ${i}`, status}))}]}),
 ];
 const tasks = () => f.w.document.querySelector('[data-testid="tab-badge-tasks"]')?.textContent ?? null;
 await f.history(plan('todo-1', now, ['completed', 'in_progress', 'pending']));
 assert.equal(tasks(), '2');
 assert.equal(f.tab('tasks').getAttribute('aria-label'), 'Tasks, 1 of 3 done');
 await f.history(plan('todo-2', now + MINUTE, ['completed', 'completed', 'completed']));
 assert.equal(tasks(), null, 'a finished plan has nothing left to count');
 assert.equal(f.tab('tasks').getAttribute('aria-label'), 'Tasks');
});
