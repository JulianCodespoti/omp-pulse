import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { agentsTabHarness } from './support/agents-tab.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Exercise the real tab, reader, normalizer, MessageParts and expandable tools.
// Only transport and timer scheduling are controlled; this is not browser/layout QA.
const code = await bundleDomFixture(agentsTabHarness(require) + `
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { MessageParts } from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import { TranscriptActionsContext } from ${JSON.stringify(resolve(root, 'web/src/app/parts/TurnNotices.tsx'))};
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import { enqueue, update, getSnapshot } from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
import { handleNativeBack } from ${JSON.stringify(resolve(root, 'web/src/platform/native-back.ts'))};
const store = createOmpStore(), otherStore = createOmpStore();
const hosts = [agentsTab.host({ getStore: () => store }), agentsTab.host({ getStore: () => otherStore })];
const requests = [], rosterRequests = [], calls = [], intervals = new Map();
let rpc = 'owned', scan = [], timer = 0, rosterMode = 'mirror';
DaemonApi.prototype.getDesktopAgentRoster = (session, signal) => new Promise((resolve, reject) => {
  rosterRequests.push({ session, signal, resolve, reject });
  if (rosterMode === 'deferred') return;
  if (rosterMode && typeof rosterMode === 'object' && rosterMode.error) {
    const error = new Error('Synthetic passive roster unavailable'); error.code = rosterMode.error; reject(error); return;
  }
  resolve({ ok: true, agents: rosterMode === 'mirror' ? store.getState().collabAgents : rosterMode, connectionId: 'synthetic-passive-connection' });
});
DaemonApi.prototype.getDesktopAgentTranscript = (session, id, fromByte, signal, expectedCreatedAt, expectedConnectionId) =>
  new Promise((resolve, reject) => requests.push({ session, id, fromByte, signal, expectedCreatedAt, expectedConnectionId, resolve, reject }));
DaemonApi.prototype.getAgentFileTranscript = (session, id, fromByte, signal) =>
  new Promise((resolve, reject) => requests.push({ source: 'file', session, id, fromByte, signal, resolve, reject }));
const replyReads = [], replyWrites = [];
DaemonApi.prototype.getDesktopAgentFollowUp = (session, target, signal) => {
  const deferred = Promise.withResolvers();
  replyReads.push({ session, target, signal, ...deferred }); return deferred.promise;
};
DaemonApi.prototype.sendDesktopAgentFollowUp = (session, target, text) => {
  const deferred = Promise.withResolvers();
  replyWrites.push({ session, target, text, ...deferred }); return deferred.promise;
};
DaemonApi.prototype.getSubagents = async (...args) => {
  calls.push({ method: 'getSubagents', args });
  if (rpc === 'owned') throw new Error('session_owned_by_terminal');
  if (rpc === 'empty') return [];
  if (Array.isArray(rpc)) return { agents: rpc };
  return { agents: [{ id: 'rpc-id', name: 'RPC worker', status: 'running' }] };
};
for (const method of ['getSubagentMessages', 'steerSubagent', 'cancelSubagent', 'collabAttach', 'prompt', 'abort', 'cancelTool']) {
  DaemonApi.prototype[method] = async (...args) => { calls.push({ method, args }); return {}; };
}
window.setInterval = (fn, ms) => { intervals.set(++timer, { fn, ms }); return timer; };
window.clearInterval = id => intervals.delete(id);
window.fixture = { act, store, otherStore, requests, rosterRequests, calls, intervals, handleNativeBack,
  replyReads, replyWrites,
  configure(mode, tasks, roster) { rpc = mode; scan = tasks; rosterMode = roster; },
  configureRoster: mode => { rosterMode = mode; }, scan: () => scan,
  async seedQueue(text) { const entry = await enqueue({ sessionPath: '/synthetic/a', text }); await update(entry.id, { state: 'failed', error: 'Synthetic failed queue item' }); return getSnapshot(); },
  mountNormal(message, options = {}) {
    const root = createRoot(document.getElementById('root'));
    // The chat provides transcript actions; a live Bash Stop needs its turn Stop.
    const actions = { switchModel() {}, editPrompt() {}, stopTurn: async () => {} };
    const render = (nextMessage, nextOptions = {}) => root.render(h(TranscriptActionsContext.Provider, { value: actions }, h(MessageParts, { message: nextMessage, ...nextOptions })));
    render(message, options); return { render, unmount: () => root.unmount() };
  },
  mount: (strict = false) => agentsTab.mount({ hosts, strict }),
};
`);
const agent = (overrides = {}) => ({
  id: 'agent-one', displayName: 'Check session reconnects', kind: 'sub', status: 'running',
  parentId: 'main-agent', createdAt: Date.UTC(2026, 9, 7, 15, 40),
  lastActivity: Date.UTC(2026, 9, 7, 15, 52, 58), hasSessionFile: true, ...overrides,
});
const entry = (id, text, role = 'assistant') => ({ type: 'message', id, message: { role, content: [{ type: 'text', text }] } });
const taskMessage = (id, name = 'task') => ({
  id: 'parent-message', sourceEntryId: 'parent-entry', role: 'assistant', text: 'PARENT CONVERSATION MUST NOT APPEAR',
  parts: [{ kind: 'tool', name, callId: id, state: 'ok', args: { tasks: [{ name: 'Recorded task' }] } }],
});
const rpcAuthority = (overrides = {}) => ({ daemonInstanceId: 'synthetic-daemon', bindingEpoch: 1, owner: { kind: 'child' }, confidence: 'confirmed', connection: 'connected', ...overrides });
const rpcState = (overrides = {}) => ({ sessionPath: '/synthetic/a', connection: 'open', sessionAuthorities: { '/synthetic/a': rpcAuthority(), '/synthetic/b': rpcAuthority() }, ...overrides });
const authority = bindingEpoch => ({ daemonInstanceId: 'synthetic-daemon', bindingEpoch, owner: { kind: 'collab' } });
async function fixture(t, { rows = [agent()], rpc = 'owned', scan = [], messages = [], strict = false, state = {}, rosterMode = 'mirror', appearance = null } = {}) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.TextEncoder = TextEncoder;
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollTo = () => {};
  const resizeObservers = new Set();
  w.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.add(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); resizeObservers.delete(this); }
  };
  w.fetch = async url => {
    assert.match(String(url), /^\/api\/agents\?/);
    return { ok: true, json: async () => ({ agents: f.scan() }) };
  };
  f.configure(rpc, scan, rosterMode);
  // Tool rows are the Grouped mode's; these tests read a recorded call's state
  // through its row and sheet. The default Summary mode draws the same calls as
  // rail chips over the same callState and sheet (work-rail.test.mjs).
  w.localStorage.setItem('omp-appearance', JSON.stringify(appearance ?? { toolCalls: 'grouped' }));
  f.store.setState({ collabAgents: rows, messages, ...state });
  f.otherStore.setState({ collabAgents: rows, messages, ...state });
  let mounted, unmounted = false;
  await f.act(async () => { mounted = f.mount(strict); });
  const unmount = async () => { if (!unmounted) { unmounted = true; await f.act(async () => mounted.unmount()); } };
  t.after(async () => { try { await unmount(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const rowButtons = () => [...w.document.querySelectorAll('button[data-desktop-agent]')];
  const button = id => rowButtons().find(b => b.dataset.desktopAgent === id);
  const transcript = () => w.document.querySelector('[data-testid="agent-transcript"]');
  const roster = () => w.document.querySelector('[data-testid="agent-roster"]');
  const clickButton = async selector => f.act(async () => { const b = w.document.querySelector(selector); assert.ok(b, selector); b.click(); });
  const respondRaw = async (index, text, nextByte, overrides = {}) => {
    await f.act(async () => {
      const request = f.requests[index]; assert.ok(request, `desktop request ${index}`);
      request.resolve({ ok: true, agentId: request.id, connectionId: 'synthetic-passive-connection', fromByte: request.fromByte, nextByte, text, reset: false, ...overrides });
    });
    // Tool-only turns fold into a run, as in the chat; open them to reach their rows.
    await f.act(async () => { for (const b of transcript()?.querySelectorAll('[data-testid="run-summary"] > button[aria-expanded="false"]') ?? []) b.click(); });
  };
  return {
    ...f, w, unmount, rowButtons, button, transcript, roster, clickButton, respondRaw,
    workspace: () => w.agentsTab.workspace(), jumps: w.agentsTab.jumps,
    closePanel: () => f.act(async () => w.agentsTab.close()),
    // The in-tab conversation header: Back, then the agent's name over its status.
    title: () => w.document.querySelector('button[aria-label="Back to agents"]')?.nextElementSibling?.firstElementChild?.textContent,
    // A tool call is one row; a tap opens its ToolSheet (portalled to the document).
    // A settled turn's work is a collapsed group: open each (as a reader would) before reading its rows.
    toolRows: () => {
      for (const title of transcript()?.querySelectorAll('[data-testid="turn-work-title"][aria-expanded="false"]') ?? []) f.act(() => title.click());
      return [...(transcript()?.querySelectorAll('button[data-testid="tool-row"]') ?? [])];
    },
    sheet: () => [...w.document.querySelectorAll('[data-testid="tool-sheet"]')].at(-1) ?? null,
    openTool: row => f.act(async () => { assert.ok(row, 'tool row'); row.click(); }),
    closeTool: () => f.act(async () => { const b = [...w.document.querySelectorAll('[data-testid="tool-sheet"] [data-testid="sheet-close"]')].at(-1); assert.ok(b, 'open tool sheet'); b.click(); }),
    showArgs: () => f.act(async () => { const b = [...w.document.querySelectorAll('[data-testid="tool-sheet"] [data-testid="tool-args"] button')].at(-1); assert.ok(b, 'tool args'); b.click(); }),
    respondRoster: (index, agents) => f.act(async () => f.rosterRequests[index].resolve({ ok: true, agents, connectionId: 'synthetic-passive-connection' })),
    rejectRoster: (index, code = 'host_unavailable') => f.act(async () => { const error = new w.Error('Synthetic passive roster unavailable'); error.code = code; f.rosterRequests[index].reject(error); }),
    resize: target => f.act(async () => { for (const observer of resizeObservers) if (observer.targets.has(target)) observer.callback([{ target }], observer); }),
    text: () => w.document.body.textContent,
    lines: () => [...(transcript()?.querySelectorAll('[data-agent-message] [data-testid="reply-text"]') ?? [])].map(p => p.textContent),
    click: (id = 'agent-one') => f.act(async () => { const b = button(id); assert.ok(b, `Conversation row for ${id}`); assert.equal(roster().hidden, false); b.click(); }),
    back: () => clickButton('button[aria-label="Back to agents"]'),
    render: (...args) => f.act(async () => mounted.render(...args)),
    setRows: rows => f.act(async () => f.store.setState({ collabAgents: rows })),
    setState: patch => f.act(async () => f.store.setState(patch)),
    tick: () => f.act(async () => { for (const { fn, ms } of [...f.intervals.values()]) if (ms === 3000) fn(); }),
    respond: async (index, entries) => {
      const text = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
      const nextByte = f.requests[index].fromByte + Buffer.byteLength(text, 'utf8');
      await respondRaw(index, text, nextByte);
      return nextByte;
    },
    reject: (index, code = 'transcript_timeout', message = 'Synthetic read failure') => f.act(async () => {
      const error = new w.Error(message); error.code = code; f.requests[index].reject(error);
    }),
    visibility: value => f.act(async () => {
      Object.defineProperty(w.document, 'visibilityState', { configurable: true, value });
      w.document.dispatchEvent(new w.Event('visibilitychange'));
    }),
  };
}

for (const rpc of ['owned', 'empty']) test(`${rpc}: desktop roster is flat, qualified and never asks generic RPC`, async t => {
  const f = await fixture(t, { rpc, rows: [
    agent({ id: 'idle', status: 'idle' }), agent({ id: 'aborted', status: 'aborted' }),
    agent({ id: 'unknown', status: 'invented-status' }), agent({ id: 'running' }),
    agent({ id: 'parked', status: 'parked' }), agent({ id: 'host', kind: 'main' }),
  ] });
  assert.deepEqual(f.rowButtons().map(b => b.dataset.desktopAgent), ['idle', 'aborted', 'unknown', 'running', 'parked']);
  assert.doesNotMatch(f.text(), /Last received from the desktop|Status may have changed/);
  assert.equal(f.w.document.querySelector('details, summary') === null, true, 'No replacement disclosure clutter in the roster');
  assert.doesNotMatch(f.text(), /Running now|Live from|live ·|invented-status|Parent ID|Last activity|Created/);
  assert.equal(f.w.document.querySelector('dl, [data-desktop-status], [data-testid="desktop-agent-details"]') === null, true);
  for (const b of f.rowButtons()) {
    assert.equal(b.tagName, 'BUTTON'); assert.equal(b.type, 'button');
    assert.match(b.getAttribute('aria-label'), /^Open .* conversation, (?:Idle|Stopped|Unknown|Running|Parked)$/);
    assert.equal(b.hasAttribute('aria-expanded'), false);
    assert.ok(b.className.includes('focus-visible:'));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
});

test('parked workers stay neutral in the roster and conversation header, then resume working normally', async t => {
  const f = await fixture(t, { rows: [agent({ status: 'parked' })] });
  const assertParked = () => {
    const row = f.button('agent-one');
    assert.match(row.getAttribute('aria-label'), /conversation, Parked$/);
    assert.equal(row.querySelector('[data-slot="agent-tile"]').dataset.state, 'parked');
    assert.equal(row.hasAttribute('data-ring'), false);
    assert.equal(row.querySelector('.text-warning, .text-running, .text-success'), null);
    assert.doesNotMatch(row.textContent, /Needs you|Running|Done/);
  };
  assertParked();
  await f.click();
  const header = () => f.w.document.querySelector('button[aria-label="Back to agents"]').parentElement;
  assert.match(header().textContent, /Parked · Read only/);
  assert.equal(header().querySelector('.text-warning'), null);
  await f.setRows([agent()]);
  assert.match(header().textContent, /Running · Read only/);
  await f.back();
  assert.equal(f.button('agent-one').dataset.ring, 'live');
  await f.setRows([agent({ status: 'parked' })]);
  assertParked();
});

test('RPC lifecycle states are neutral; only explicit input waits need attention', async t => {
  const statuses = [
    ['parked', 'Parked', 'parked', undefined],
    [' PARKED ', 'Parked', 'parked', undefined],
    ['idle', 'Idle', 'idle', undefined],
    ['waiting', 'Unknown', 'unknown', undefined],
    ['blocked', 'Unknown', 'unknown', undefined],
    ['awaiting_input', 'Needs you', 'needsYou', 'attention'],
    ['awaiting-input', 'Needs you', 'needsYou', 'attention'],
    ['needs input', 'Needs you', 'needsYou', 'attention'],
    ['running', 'Running', 'working', 'live'],
    ['completed', 'Done', 'done', undefined],
  ];
  const f = await fixture(t, {
    rows: [], state: rpcState(), rosterMode: { error: 'host_unavailable' },
    rpc: statuses.map(([status], index) => ({ id: `rpc-${index}`, name: `Worker ${index}`, status })),
  });
  for (const [index, [, label, state, ring]] of statuses.entries()) {
    const row = f.w.document.querySelector(`button[data-rpc-agent="rpc-${index}"]`);
    assert.ok(row, `RPC row ${index}`);
    assert.equal(row.querySelector('[data-slot="agent-tile"]').dataset.state, state);
    assert.equal(row.parentElement.dataset.ring, ring);
    assert.ok(row.textContent.includes(label), label);
    assert.equal(Boolean(row.querySelector('.text-warning')), state === 'needsYou');
    if (state === 'needsYou' || state === 'parked') {
      await f.act(async () => row.click());
      const header = f.w.document.querySelector('button[aria-label="Back to agents"]').parentElement;
      assert.ok(header.textContent.includes(`${label} · Read only`), label);
      assert.equal(Boolean(header.querySelector('.text-warning')), state === 'needsYou');
      await f.back();
    }
  }
});

test('whole row opens real normalized user/assistant messages and a tool call with its arguments and output', async t => {
  const f = await fixture(t, { messages: [taskMessage('agent-one')] });
  await f.click();
  assert.equal(f.roster().hidden, true);
  assert.equal(f.title(), 'Check session reconnects');
  assert.match(f.text(), /Running · Read only/);
  for (const selector of ['button[aria-label="Back to agents"]']) {
    assert.equal(f.w.document.querySelector(selector).closest('[aria-hidden="true"]') === null, true, selector + ' must remain accessible');
  }
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.session, '/synthetic/a'); assert.equal(request.id, 'agent-one'); assert.equal(request.fromByte, 0);
  assert.equal(request.expectedCreatedAt, agent().createdAt); assert.equal(request.signal.aborted, false);
  assert.equal(request.expectedConnectionId, 'synthetic-passive-connection', 'the first transcript read is bound to its passive roster connection');
  await f.respond(0, [
    entry('user-entry', 'Please inspect the child code', 'user'),
    { type: 'message', id: 'assistant-entry', message: { role: 'assistant', content: [
      { type: 'text', text: 'I found the child-specific result' },
      { type: 'toolCall', id: 'inspect-call', name: 'inspect_widget', arguments: { target: 'child-only-widget', mode: 'full-inspection' } },
    ] } },
    { type: 'message', id: 'result-entry', message: { role: 'toolResult', toolCallId: 'inspect-call', content: [{ type: 'text', text: 'CHILD TOOL OUTPUT 42' }] } },
  ]);
  assert.deepEqual(f.lines(), ['Please inspect the child code', 'I found the child-specific result']);
  assert.deepEqual([...f.transcript().querySelectorAll('[data-agent-role]')].map(a => a.dataset.agentRole), ['user', 'assistant']);
  assert.equal(f.transcript().querySelectorAll('[data-agent-message]').length, 2, 'tool result attaches to its real call');
  const [toolRow] = f.toolRows();
  assert.ok(toolRow, 'actual ToolRow'); assert.equal(toolRow.dataset.state, 'ok');
  await f.openTool(toolRow);
  assert.ok(f.sheet(), 'tool detail sheet');
  assert.match(f.sheet().querySelector('[data-testid="tool-detail"]').textContent, /CHILD TOOL OUTPUT 42/);
  await f.showArgs();
  for (const content of ['child-only-widget', 'full-inspection']) assert.ok(f.sheet().textContent.includes(content), content);
  assert.equal(f.w.document.querySelector('[data-testid="desktop-agent-details"]') === null, true);
  assert.doesNotMatch(f.transcript().textContent, /PARENT CONVERSATION|Recorded task|Parent ID|main-agent|View task in conversation/);
  assert.equal(f.workspace(), 'agents'); assert.equal(f.calls.length, 0);
});

test('conversation stays read only with failed parent queue, Bash and ask tool records', async t => {
  const f = await fixture(t);
  let queued;
  await f.act(async () => { queued = await f.seedQueue('same text as parent queue'); });
  assert.equal(queued.length, 1); assert.equal(queued[0].state, 'failed');
  await f.click();
  await f.respond(0, [entry('queued-lookalike', 'same text as parent queue', 'user'), {
    type: 'message', id: 'calls', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'bash-running', name: 'bash', arguments: { command: 'echo child-command' } },
      { type: 'toolCall', id: 'question', name: 'ask', arguments: { question: 'Pick one', options: ['Alpha', 'Beta'] } },
    ] },
  }]);
  const sheetLabels = [];
  for (const row of f.toolRows()) {
    await f.openTool(row);
    sheetLabels.push(...[...f.sheet().querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()));
    assert.equal(f.sheet().querySelector('[data-testid="stop-command"], form, textarea, [contenteditable="true"], [role="textbox"]') === null, true);
    await f.closeTool();
  }
  assert.equal(f.toolRows().length, 2);
  assert.match(f.transcript().textContent, /child-command/);
  assert.match(f.transcript().textContent, /Pick one/);
  assert.equal(f.transcript().querySelector('form, textarea, input:not([type="checkbox"]), [contenteditable="true"], [role="textbox"]') === null, true);
  const labels = [...f.transcript().querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()).concat(sheetLabels);
  for (const label of labels) assert.doesNotMatch(label, /^(?:Stop|Stop agent|Retry|Send|Submit|Approve|Deny|Answer|Alpha|Beta|Redirect)(?:$|\s)/);
  assert.doesNotMatch(f.transcript().textContent, /Synthetic failed queue item|Delivery uncertain/);
  assert.equal(f.calls.length, 0);
});

test('explicitly unavailable transcript opens honest terminal state without any request or parent fallback', async t => {
  const f = await fixture(t, { rows: [agent({ hasSessionFile: false })], messages: [taskMessage('agent-one')] });
  await f.click(); await f.tick();
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(f.transcript().textContent, /PARENT CONVERSATION|Recorded task|View task/);
  const back = [...f.transcript().querySelectorAll('button')].find(b => b.textContent === 'Back to agents');
  assert.equal(Boolean(back), true);
  await f.act(async () => back.click());
  assert.equal(f.transcript() === null, true); assert.equal(f.roster().hidden, false);
  assert.equal(f.w.document.activeElement === f.button('agent-one'), true);
});

for (const code of ['transcript_unavailable', 'host_error', 'session_not_found', 'invalid_request', 'invalid_host_response', 'agent_changed']) {
  test(`typed ${code} is terminal and never falls back to generic RPC`, async t => {
    const f = await fixture(t); await f.click(); await f.reject(0, code); await f.tick();
    assert.ok(f.transcript().querySelector('[role="alert"]'));
    assert.equal([...f.transcript().querySelectorAll('button')].some(b => b.textContent === 'Retry'), false);
    assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0);
    await f.act(async () => [...f.transcript().querySelectorAll('button')].find(b => b.textContent === 'Back to agents').click());
    assert.equal(f.transcript() === null, true); assert.equal(f.roster().hidden, false);
  });
}
for (const code of ['transcript_timeout', 'host_unavailable']) test(`${code}: explicit retry preserves messages and resumes the current byte cursor`, async t => {
  const f = await fixture(t); await f.click(); const initialCursor = await f.respond(0, [entry('initial', 'initial')]);
  await f.tick(); assert.equal(f.requests[1].fromByte, initialCursor); await f.reject(1, code); await f.tick();
  assert.equal(f.requests.length, 2); assert.deepEqual(f.lines(), ['initial']);
  const details = f.transcript().querySelector('[role="alert"] details');
  assert.equal(Boolean(details), true); assert.equal(details.open, false);
  await f.act(async () => [...f.transcript().querySelectorAll('button')].find(b => b.textContent === 'Retry').click());
  assert.equal(f.requests[2].fromByte, initialCursor);
  const recoveredCursor = await f.respond(2, [entry('recovered', 'recovered')]);
  assert.deepEqual(f.lines(), ['initial', 'recovered']); await f.tick(); assert.equal(f.requests[3].fromByte, recoveredCursor);
});

test('initial and tail reads are each single-flight and completed ranges appear once', async t => {
  const f = await fixture(t); await f.click(); await f.tick(); await f.tick();
  assert.equal(f.requests.length, 1); await f.respond(0, [entry('initial', 'initial')]);
  await f.tick(); await f.tick(); await f.tick(); assert.equal(f.requests.length, 2);
  const tailCursor = await f.respond(1, [entry('tail', 'tail')]); assert.deepEqual(f.lines(), ['initial', 'tail']);
  await f.tick(); assert.equal(f.requests[2].fromByte, tailCursor);
});

test('Back restores the retained roster scroll and original row focus and aborts its pending read', async t => {
  const f = await fixture(t); const row = f.button('agent-one');
  const viewport = f.roster().closest('[data-slot="scroll-area-viewport"]'); assert.ok(viewport);
  viewport.scrollTop = 328; await f.act(async () => row.focus()); await f.click();
  assert.equal(viewport.scrollTop, 0);
  assert.equal(f.w.document.activeElement.getAttribute('aria-label'), 'Back to agents');
  await f.back(); assert.equal(f.transcript() === null, true); assert.equal(f.roster().hidden, false);
  assert.equal(f.button('agent-one') === row, true); assert.equal(f.w.document.activeElement === row, true); assert.equal(viewport.scrollTop, 328);
  assert.equal(row.getAttribute('aria-current'), 'true', 'Back retains the selected roster row');
  assert.equal(f.requests[0].signal.aborted, true);
  await f.respond(0, [entry('stale', 'stale')]); await f.tick(); assert.equal(f.requests.length, 1);
  assert.equal(f.workspace(), 'agents');
});

test('native Back leaves the conversation before dismissing the workspace', async t => {
  const f = await fixture(t); await f.click();
  await f.act(async () => { assert.equal(f.handleNativeBack('commit'), true); });
  assert.equal(f.transcript() === null, true); assert.equal(f.roster().hidden, false); assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.workspace(), 'agents');
});

for (const transition of ['Back', 'close intent', 'close/reopen', 'session', 'controller', 'connection source', 'binding epoch', 'daemon instance', 'createdAt', 'removal', 'session-file availability']) {
  for (const completion of ['success', 'error']) test(`${transition} invalidates a pending desktop ${completion}, including same-ID reuse`, async t => {
    const f = await fixture(t, { state: { sessionAuthorities: { '/synthetic/a': authority(1) } } });
    await f.click(); const old = f.requests[0];
    if (transition === 'Back') await f.back();
    else if (transition === 'close intent') {
      await f.closePanel();
      assert.equal(f.workspace(), null);
      await f.tick();
      assert.equal(f.transcript() === null, true); assert.equal(f.requests.length, 1); assert.equal(old.signal.aborted, true);
      await f.render(false); await f.render(true);
    } else if (transition === 'close/reopen') { await f.render(false); await f.render(true); }
    else if (transition === 'session') await f.render(true, '/synthetic/b');
    else if (transition === 'controller') await f.render(true, '/synthetic/a', true);
    else if (transition === 'connection source') await f.setState({ collabAttached: true });
    else if (transition === 'binding epoch') await f.setState({ sessionAuthorities: { '/synthetic/a': authority(2) } });
    else if (transition === 'daemon instance') await f.setState({ sessionAuthorities: { '/synthetic/a': { ...authority(1), daemonInstanceId: 'replacement-daemon' } } });
    else if (transition === 'createdAt') await f.setRows([agent({ createdAt: agent().createdAt + 1 })]);
    else if (transition === 'removal') { await f.setRows([]); await f.setRows([agent()]); }
    else { await f.setRows([agent({ hasSessionFile: false })]); await f.setRows([agent()]); }
    assert.equal(f.transcript() === null, true); assert.equal(old.signal.aborted, true);
    assert.equal(f.button('agent-one').getAttribute('aria-current'), ['Back', 'session-file availability'].includes(transition) ? 'true' : null, 'selection belongs to the same visit and agent creation');
    await f.click(); assert.equal(f.requests.length, 2);
    if (completion === 'error') {
      await f.reject(0); assert.match(f.transcript().textContent, /Loading messages/);
      assert.doesNotMatch(f.transcript().textContent, /Synthetic read failure|timed out/);
    }
    await f.respond(1, [entry('current', 'current visit')]);
    if (completion === 'success') await f.respond(0, [entry('old', 'obsolete visit')]);
    assert.deepEqual(f.lines(), ['current visit']);
    if (transition === 'session') assert.equal(f.requests[1].session, '/synthetic/b');
    if (transition === 'createdAt') assert.equal(f.requests[1].expectedCreatedAt, agent().createdAt + 1);
    await f.tick(); assert.equal(f.requests.length, 3, 'stale completion must not stop current polling');
  });
}

test('switching source from desktop to RPC discards the desktop conversation', async t => {
  const f = await fixture(t, { rpc: 'agents' }); await f.click();
  f.configureRoster({ error: 'host_unavailable' });
  await f.setState({ collabAgents: [], ...rpcState() });
  assert.equal(f.transcript() === null, true); assert.equal(f.requests[0].signal.aborted, true);
  assert.ok(f.w.document.querySelector('button[data-rpc-agent="rpc-id"]'));
  await f.respond(0, [entry('old', 'desktop stale')]); assert.equal(f.transcript() === null, true);
});

test('status and name updates retain content, cursor, an open tool sheet and conversation scroll', async t => {
  // Default Summary mode: the running→idle flip below settles the turn, and the open tool sheet must survive it (useLiveWhileSheetOpen).
  const f = await fixture(t); const row = f.button('agent-one'); await f.click();
  const initialCursor = await f.respond(0, [{ type: 'message', id: 'stable', message: { role: 'assistant', content: [
    { type: 'text', text: 'keep this conversation' },
    { type: 'toolCall', id: 'keep-tool', name: 'inspect_widget', arguments: { mode: 'keep-open' } },
  ] } }]);
  await f.openTool(f.toolRows()[0]); const sheet = f.sheet(); assert.ok(sheet, 'tool sheet');
  const panel = f.transcript(), viewport = f.roster().closest('[data-slot="scroll-area-viewport"]'); viewport.scrollTop = 194;
  await f.setRows([agent({ status: 'idle', displayName: 'Updated worker name', lastActivity: Date.now() })]);
  assert.equal(f.transcript() === panel, true); assert.equal(f.button('agent-one') === row, true); assert.equal(f.sheet() === sheet, true);
  assert.equal(viewport.scrollTop, 194); assert.deepEqual(f.lines(), ['keep this conversation']);
  assert.equal(f.requests.length, 1); assert.match(f.text(), /Idle · Read only/);
  assert.equal(f.title(), 'Updated worker name');
  await f.tick(); assert.equal(f.requests[1].fromByte, initialCursor);
});

test('hidden document suppresses polling and visibility resumes at the current cursor', async t => {
  const f = await fixture(t); await f.click(); const initialCursor = await f.respond(0, [entry('visible', 'visible')]);
  await f.visibility('hidden'); await f.tick(); await f.tick(); assert.equal(f.requests.length, 1);
  await f.visibility('visible'); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].fromByte, initialCursor);
  await f.visibility('visible'); await f.tick(); assert.equal(f.requests.length, 2, 'visibility and timer share one flight');
  await f.back(); await f.visibility('visible'); await f.tick(); assert.equal(f.requests.length, 2);
});

test('opening while hidden defers the initial transcript request until visible', async t => {
  const f = await fixture(t); await f.visibility('hidden'); await f.click(); await f.tick(); assert.equal(f.requests.length, 0);
  await f.visibility('visible'); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].fromByte, 0);
});

test('unmount aborts pending desktop read and removes refresh interval', async t => {
  const f = await fixture(t); await f.click(); await f.unmount();
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.intervals.size, 0);
  await f.respond(0, [entry('old', 'old')]); await f.tick(); assert.equal(f.requests.length, 1);
});

test('malformed and duplicate rows stay omitted without unlocking desktop RPC actions', async t => {
  const f = await fixture(t, { rpc: 'agents', rows: [null, [], 12, {}, { id: ' ' }, agent(), agent({ status: 'aborted' })] });
  assert.equal(f.rowButtons().length, 0); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(f.text(), /RPC worker|Redirect|Stop agent/);
});

test('literal long names remain accessible and IDs are passed byte-for-byte without metadata expansion', async t => {
  const name = '<script>unsafe()</script> ' + 'Long agent label '.repeat(25);
  const f = await fixture(t, { rows: [agent({ id: ' agent-one ', displayName: name })], messages: [taskMessage('agent-one')] });
  const b = f.button(' agent-one '); assert.ok(b.getAttribute('aria-label').includes(name));
  await f.click(' agent-one '); assert.equal(f.requests[0].id, ' agent-one ');
  assert.equal(f.title(), name);
  assert.equal(f.w.document.querySelector('script') === null, true); assert.doesNotMatch(f.text(), /View task in conversation/);
});

for (const status of ['RUNNING', '', null, 1, ['running']]) test(`unrecognized status ${JSON.stringify(status)} stays honest in roster and header`, async t => {
  const f = await fixture(t, { rows: [agent({ status })] });
  assert.match(f.button('agent-one').textContent, /Unknown/); await f.click();
  assert.match(f.text(), /Unknown · Read only/);
});

test('run info shows the agent model, reasoning and newest context, not the parent session', async t => {
  const f = await fixture(t, { state: { sessionModel: { model: 'parent-only-model', thinkingLevel: 'low' } } });
  await f.click();
  assert.equal(f.w.document.querySelector('[data-testid="agent-run-info"]') === null, true, 'nothing recorded yet');
  await f.respond(0, [
    { type: 'model_change', id: 'm1', model: 'anthropic/claude-opus-5-5' },
    { type: 'thinking_level_change', id: 't1', thinkingLevel: 'high' },
    { type: 'message', id: 'a1', message: { role: 'assistant', model: 'claude-opus-5-5', contextSnapshot: { promptTokens: 12000 }, content: [{ type: 'text', text: 'first' }] } },
    { type: 'message', id: 'a2', message: { role: 'assistant', model: 'claude-opus-5-5', contextSnapshot: { promptTokens: 43381 }, content: [{ type: 'text', text: 'second' }] } },
  ]);
  const fact = id => f.w.document.querySelector(`[data-testid="agent-run-info"] [data-testid="${id}"]`)?.textContent;
  assert.equal(fact('agent-run-model'), 'Opus 5.5'); assert.equal(fact('agent-run-reasoning'), 'High'); assert.match(fact('agent-run-context'), /^43K\b/);
  assert.doesNotMatch(f.w.document.querySelector('[data-testid="agent-run-info"]').textContent, /parent-only-model|Low|12K/);
});

// A desktop omp TUI owns a bridged session; it has no live roster to hand
// over, so its probe answers host_unavailable for every bridged chat.
for (const [owner, confidence] of [['none', 'inferred'], ['bridge', 'confirmed']]) for (const scan of [[], [{ callId: 'recorded', name: 'Historic task' }]]) test(`${owner === 'none' ? 'idle phone' : 'desktop-bridged'} session with ${scan.length ? 'recorded tasks' : 'no tasks'} is not a reconnect error`, async t => {
  const idle = rpcAuthority({ owner: { kind: owner }, confidence });
  const f = await fixture(t, { rows: [], scan, rosterMode: { error: 'host_unavailable' }, state: rpcState({ sessionAuthorities: { '/synthetic/a': idle } }) });
  await f.act(async () => {});
  assert.equal(f.roster().querySelector('[data-slot="notice"]'), null, 'no error notice');
  assert.doesNotMatch(f.text(), /Reconnect|Retry/);
  if (scan.length) assert.match(f.text(), /Historic task/);
  else assert.ok(f.roster().querySelector('[data-slot="empty-state"]'), 'the empty state, not an error');
  assert.equal(f.calls.length, 0, 'an idle session never boots an RPC child to list agents');
});

test('empty or malformed desktop list retains explicitly recorded tasks', async t => {
  const f = await fixture(t, { rows: [], scan: [{ callId: 'recorded', name: 'Historic task' }] });
  assert.match(f.text(), /Historic task/);
  await f.setRows([null, { id: 4 }, { id: 'main', kind: 'main' }]);
  assert.match(f.text(), /Historic task/); assert.doesNotMatch(f.text(), /Running now|No active|0 running|live ·/);
});
for (const rpc of ['owned', 'empty']) test(`${rpc}: no records does not claim a fresh desktop zero`, async t => {
  const f = await fixture(t, { rows: [], rpc }); assert.match(f.text(), /No agents yet/);
  assert.doesNotMatch(f.text(), /No active subagents|no subagents running|No subagents in this session/);
});

test('a recorded task opens its own retained transcript, live or finished, never the parent', async t => {
  const f = await fixture(t, { rows: [], messages: [taskMessage('recorded-task')] });
  const row = [...f.w.document.querySelectorAll('button')].find(node => node.textContent.includes('Recorded task'));
  assert.ok(row);
  await f.act(async () => row.click());
  assert.equal(f.workspace(), 'agents', 'the conversation opens in the tab'); assert.deepEqual(Array.from(f.jumps), []);
  assert.equal(f.requests.length, 1);
  assert.deepEqual([f.requests[0].source, f.requests[0].session, f.requests[0].id, f.requests[0].fromByte], ['file', '/synthetic/a', 'Recorded task', 0]);
  await f.respond(0, [entry('assignment', 'Do the recorded work', 'user'), entry('answer', 'Recorded agent answer')]);
  assert.deepEqual(f.lines(), ['Do the recorded work', 'Recorded agent answer']);
  assert.doesNotMatch(f.transcript().textContent, /PARENT CONVERSATION/);
  assert.equal(f.calls.filter(c => c.method !== 'getSubagents').length, 0);
});

test('a recorded task that names no agent still jumps to where the chat started it', async t => {
  const f = await fixture(t, { rows: [], messages: [{ ...taskMessage('unnamed-task'), parts: [{ kind: 'tool', name: 'task', callId: 'unnamed-task', state: 'ok', args: { tasks: [{ description: 'Unnamed work' }] } }] }] });
  const row = [...f.w.document.querySelectorAll('button')].find(node => node.textContent.includes('Unnamed work'));
  assert.ok(row);
  await f.act(async () => row.click());
  assert.equal(f.workspace(), null, 'a jump closes the workspace'); assert.deepEqual(Array.from(f.jumps), ['parent-entry']);
  assert.equal(f.requests.length, 0);
});

test('StrictMode effect replay aborts obsolete reads and only current results become conversation content', async t => {
  const f = await fixture(t, { strict: true }); await f.click();
  const currentIndex = f.requests.length - 1;
  assert.ok(currentIndex >= 0);
  for (let i = 0; i < currentIndex; i++) assert.equal(f.requests[i].signal.aborted, true);
  assert.equal(f.requests[currentIndex].signal.aborted, false);
  await f.respond(currentIndex, [entry('current-strict', 'current StrictMode visit')]);
  for (let i = 0; i < currentIndex; i++) await f.respond(i, [entry('obsolete-strict', 'obsolete StrictMode visit')]);
  assert.deepEqual(f.lines(), ['current StrictMode visit']);
  assert.equal(f.calls.length, 0);
});

test('a missing tool result is explicitly unknown without a live clock, shimmer or Stop, then resolves on a later page', async t => {
  const f = await fixture(t); await f.click();
  await f.respond(0, [{ type: 'message', id: 'unknown-result', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'unknown-bash', name: 'bash', arguments: { command: 'echo pending-result' } },
    { type: 'toolCall', id: 'unknown-generic', name: 'inspect_widget', arguments: { target: 'pending-widget' } },
  ] } }]);
  const rows = f.toolRows();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.dataset.state, 'ok', 'a passive call without a result is settled, not running');
    assert.doesNotMatch(row.textContent, /Interrupted|Running|Ran|Stop|\d+:\d+/);
    assert.equal(row.querySelector('[class*="animate-[shimmer"]') === null, true);
  }
  assert.equal(f.transcript().querySelector('[data-testid="live-tool-output"]') === null, true);
  await f.openTool(rows[1]);
  assert.match(f.sheet().textContent, /This transcript has no result for this call\./);
  await f.closeTool();
  await f.openTool(rows[0]);
  const detail = () => f.sheet().querySelector('[data-testid="tool-detail"]');
  assert.match(detail().textContent, /This transcript has no result for this call\./);
  assert.equal(f.sheet().querySelector('[data-testid="stop-command"]') === null, true);
  assert.equal([...f.intervals.values()].some(({ ms }) => ms === 1000), false, 'no live elapsed clock for passive history');
  assert.equal([...f.transcript().querySelectorAll('button')].some(b => /^Stop\b/.test(b.textContent.trim())), false);
  await f.tick();
  await f.respond(1, [
    { type: 'message', id: 'bash-result', message: { role: 'toolResult', toolCallId: 'unknown-bash', content: [{ type: 'text', text: 'bash recorded result' }] } },
    { type: 'message', id: 'generic-result', message: { role: 'toolResult', toolCallId: 'unknown-generic', content: [{ type: 'text', text: 'widget recorded result' }] } },
  ]);
  assert.equal(f.transcript().querySelectorAll('[data-agent-message], [data-agent-run]').length, 1, 'results attach to their calls');
  assert.match(detail().textContent, /bash recorded result/, 'the open sheet follows its result');
  assert.doesNotMatch(detail().textContent, /no result for this call|Stopped before/);
  await f.closeTool();
  await f.openTool(f.toolRows()[1]);
  assert.match(detail().textContent, /widget recorded result/);
  assert.doesNotMatch(f.transcript().textContent, /Interrupted/);
  assert.equal(f.calls.length, 0);
});

test('withheld incomplete EOF at a torn emoji keeps the cursor unchanged until one complete record arrives', async t => {
  const f = await fixture(t); await f.click();
  const text = 'A café 🌻 child reply';
  const completeRecord = JSON.stringify(entry('completed-utf8-record', text)) + '\n';
  const encoded = Buffer.from(completeRecord, 'utf8');
  const emojiStart = encoded.indexOf(Buffer.from('🌻', 'utf8'));
  const tornEof = encoded.subarray(0, emojiStart + 2);
  assert.ok(emojiStart >= 0); assert.equal(tornEof.includes(10), false);
  assert.ok(encoded.length > completeRecord.length, 'UTF-8 byte cursor differs from JavaScript character count');
  // The passive server withholds the entire unterminated line, including the
  // incomplete UTF-8 suffix. The UI receives neither a fragment nor a new cursor.
  await f.respondRaw(0, '', 0);
  assert.deepEqual(f.lines(), []); assert.match(f.transcript().textContent, /No messages yet/);
  await f.tick(); assert.equal(f.requests[1].fromByte, 0);
  await f.respondRaw(1, '', 0);
  assert.deepEqual(f.lines(), []); assert.doesNotMatch(f.transcript().textContent, /invalid|�/i);
  await f.tick(); assert.equal(f.requests[2].fromByte, 0);
  await f.respondRaw(2, completeRecord, encoded.length);
  assert.deepEqual(f.lines(), [text]); assert.equal(f.transcript().querySelectorAll('[data-agent-message]').length, 1);
  await f.tick(); assert.equal(f.requests[3].fromByte, encoded.length);
  await f.respondRaw(3, '', encoded.length);
  assert.deepEqual(f.lines(), [text]); assert.equal(f.transcript().querySelectorAll('[data-agent-message]').length, 1);
  assert.equal(f.calls.length, 0);
});

test('a desktop adapter violating the complete-line contract shows an error rather than a final-record preview', async t => {
  const f = await fixture(t); await f.click();
  const noNewline = JSON.stringify(entry('unsafe-preview', 'Do not publish an unterminated desktop record'));
  await f.respondRaw(0, noNewline, Buffer.byteLength(noNewline));
  assert.deepEqual(f.lines(), []);
  assert.ok(f.transcript().querySelector('[role="alert"]'));
  assert.equal([...f.transcript().querySelectorAll('button')].some(b => b.textContent === 'Retry'), false);
  await f.tick(); assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0);
});


test('a same-ID new creation cannot inherit the selected roster row after Back', async t => {
  const f = await fixture(t); await f.click(); await f.back();
  assert.equal(f.button('agent-one').getAttribute('aria-current'), 'true');
  await f.setRows([agent({ createdAt: agent().createdAt + 1 })]);
  assert.equal(f.button('agent-one').hasAttribute('aria-current'), false);
  assert.equal(f.transcript() === null, true); assert.equal(f.requests.length, 1);
});

for (const kind of ['nonempty oversized span', 'nonempty undersized span', 'empty advancing span']) test(`malformed desktop byte range: ${kind} stays terminal without rendering skipped or duplicated content`, async t => {
  const f = await fixture(t); await f.click();
  const text = kind === 'empty advancing span' ? '' : JSON.stringify(entry('bad-range', 'A café 🌻 transcript')) + '\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  const claimedEnd = kind === 'nonempty undersized span' ? bytes - 1 : bytes + 1;
  await f.respondRaw(0, text, claimedEnd);
  assert.deepEqual(f.lines(), []); assert.ok(f.transcript().querySelector('[role="alert"]'));
  assert.equal([...f.transcript().querySelectorAll('button')].some(b => b.textContent === 'Retry'), false);
  await f.tick(); assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 0);
});

test('the newest assistant text stays expanded even after later user and tool-only messages', async t => {
  const f = await fixture(t); await f.click();
  const earlier = 'earlier reply '.repeat(160) + 'EARLIER END';
  const latest = 'latest reply '.repeat(170) + 'LATEST END';
  await f.respond(0, [
    entry('earlier-long-reply', earlier), entry('latest-long-reply', latest),
    entry('later-user', 'A later user instruction', 'user'),
    { type: 'message', id: 'later-tool-only', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'later-tool', name: 'inspect_widget', arguments: { target: 'widget' } },
    ] } },
  ]);
  const earlierArticle = f.transcript().querySelector('[data-agent-message="earlier-long-reply"]');
  const latestArticle = f.transcript().querySelector('[data-agent-message="latest-long-reply"]');
  assert.ok(earlierArticle.querySelector('[data-testid="reply-expand"]'), 'older long replies keep the normal disclosure');
  assert.equal(latestArticle.querySelector('[data-testid="reply-expand"]') === null, true, 'latest assistant text never starts collapsed');
  assert.ok(latestArticle.textContent.includes(latest));
  const newest = 'newest reply '.repeat(170) + 'NEWEST END';
  await f.tick(); await f.respond(1, [entry('newest-long-reply', newest)]);
  assert.ok(latestArticle.querySelector('[data-testid="reply-expand"]'), 'a later answer makes the former final answer historical');
  const newestArticle = f.transcript().querySelector('[data-agent-message="newest-long-reply"]');
  assert.equal(newestArticle.querySelector('[data-testid="reply-expand"]') === null, true);
  assert.ok(newestArticle.textContent.includes(newest));
});

test('the shared viewport follows latest content and reflow only while the user remains at the bottom', async t => {
  const f = await fixture(t); const row = f.button('agent-one');
  const viewport = f.roster().closest('[data-slot="scroll-area-viewport"]');
  let height = 1600, top = 328;
  // Deterministic synthetic geometry proves scroll ownership and state only.
  // It does not claim browser layout, touch behavior or rendered dimensions.
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 500 },
    scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, height - 500)); } },
  });
  const scroll = value => f.act(async () => { viewport.scrollTop = value; viewport.dispatchEvent(new f.w.Event('scroll')); });
  await f.click(); height = 1200;
  await f.respond(0, [{ type: 'message', id: 'initial-scroll', message: { role: 'assistant', content: [
    { type: 'text', text: 'initial conversation content ' + 'earlier reply '.repeat(160) },
    { type: 'toolCall', id: 'scroll-inspection', name: 'inspect_widget', arguments: { target: 'scroll-anchor' } },
  ] } }]);
  assert.equal(viewport.scrollTop, 700, 'initial read opens at the latest content');
  assert.equal(f.transcript().closest('[data-slot="scroll-area-viewport"]') === viewport, true, 'the tab owns the only scroller');
  await f.tick(); height = 1800; await f.respond(1, [entry('followed-tail', 'new tail while following')]);
  assert.equal(viewport.scrollTop, 1300, 'appended content follows the bottom');
  await scroll(300);
  await f.tick(); height = 2100; await f.respond(2, [entry('unfollowed-tail', 'new tail while reading earlier content')]);
  assert.equal(viewport.scrollTop, 300, 'polling cannot yank a user reading earlier content');
  height = 2300; await f.resize(f.transcript());
  assert.equal(viewport.scrollTop, 300, 'asynchronous markdown or image reflow cannot yank the reader');
  await scroll(1800);
  await f.tick(); height = 2600; await f.respond(3, [entry('refollowed-tail', 'new tail after returning to the bottom')]);
  assert.equal(viewport.scrollTop, 2100, 'returning to the bottom resumes following');
  height = 2800; await f.resize(f.transcript());
  assert.equal(viewport.scrollTop, 2300, 'reflow follows the bottom only while opted in');
  // Opening an older reply in place is a reading-position choice too.
  const more = f.transcript().querySelector('[data-agent-message="initial-scroll"] [data-testid="reply-expand"]');
  assert.ok(more, 'the older long reply has a disclosure');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await f.act(async () => more.click());
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  height = 3100; await f.resize(f.transcript());
  assert.equal(viewport.scrollTop, 2300, 'expanding a reply at the bottom preserves the clicked block before resize');
  await f.tick(); height = 3300; await f.respond(4, [entry('inspection-tail', 'new tail while reading the expanded reply')]);
  assert.equal(viewport.scrollTop, 2300, 'polling cannot yank the expanded block either');
  await scroll(2800); height = 3500; await f.resize(f.transcript());
  assert.equal(viewport.scrollTop, 3000, 'an explicit scroll back to the bottom resumes following after expansion');
  height = 1600; await f.back();
  assert.equal(viewport.scrollTop, 328, 'Back restores the original roster scroll');
  assert.equal(f.w.document.activeElement === row, true); assert.equal(row.getAttribute('aria-current'), 'true');
});

test('cold opening discovers a passive desktop roster beside a bridge writer without waiting for a WebSocket event', async t => {
  const f = await fixture(t, {
    rows: [], rpc: 'agents', rosterMode: 'deferred',
    state: rpcState({ sessionAuthorities: { '/synthetic/a': rpcAuthority({ owner: { kind: 'bridge' } }) } }),
  });
  assert.equal(f.rosterRequests.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.rosterRequests[0].session, '/synthetic/a'); assert.equal(f.rosterRequests[0].signal.aborted, false);
  assert.equal(f.rowButtons().length, 0);
  await f.respondRoster(0, [agent({ displayName: 'Cold-open desktop worker' })]);
  assert.equal(f.button('agent-one').textContent.includes('Cold-open desktop worker'), true);
  await f.click(); await f.respond(0, [entry('cold-open-message', 'real cold-open agent conversation')]);
  assert.deepEqual(f.lines(), ['real cold-open agent conversation']);
  await f.tick(); assert.equal(f.rosterRequests.length, 1); assert.equal(f.calls.length, 0);
});

test('passive roster is probed once per tab activation and never polled with transcript or status refreshes', async t => {
  const f = await fixture(t);
  assert.equal(f.rosterRequests.length, 1);
  await f.tick(); await f.tick(); await f.render(true);
  await f.setRows([agent({ status: 'idle' })]);
  assert.equal(f.rosterRequests.length, 1);
  await f.click(); await f.respond(0, [entry('one-probe', 'one roster probe per visit')]); await f.tick();
  await f.back(); await f.tick(); assert.equal(f.rosterRequests.length, 1);
  await f.render(false); await f.render(true); assert.equal(f.rosterRequests.length, 2);
  await f.tick(); assert.equal(f.rosterRequests.length, 2);
});

for (const completion of ['success', 'error']) for (const update of ['new creation', 'empty array']) {
  test(`newer WebSocket ${update} wins over a stale passive roster ${completion}`, async t => {
    const f = await fixture(t, { rows: [agent()], rpc: 'agents', rosterMode: 'deferred', state: rpcState() });
    const newer = update === 'empty array' ? [] : [agent({ createdAt: agent().createdAt + 1, displayName: 'Newer WebSocket creation' })];
    await f.setRows(newer);
    assert.equal(f.rosterRequests.length, 1, 'a WebSocket array update is not another passive probe');
    if (completion === 'success') await f.respondRoster(0, [agent({ displayName: 'Obsolete passive snapshot' })]);
    else await f.rejectRoster(0);
    assert.equal(f.calls.length, 0, 'a newer WebSocket snapshot prevents fallback even when empty');
    assert.doesNotMatch(f.text(), /Obsolete passive snapshot|Synthetic passive roster unavailable/);
    if (update === 'empty array') assert.equal(f.rowButtons().length, 0);
    else {
      assert.equal(f.rowButtons().length, 1); assert.match(f.button('agent-one').textContent, /Newer WebSocket creation/);
      await f.click(); assert.equal(f.requests[0].expectedCreatedAt, agent().createdAt + 1);
    }
    await f.tick(); assert.equal(f.rosterRequests.length, 1);
  });
}

test('even an empty-to-empty WebSocket array replacement prevents stale passive rows from appearing', async t => {
  const initial = [], replacement = [];
  const f = await fixture(t, { rows: initial, rpc: 'agents', rosterMode: 'deferred', state: rpcState() });
  await f.setRows(replacement); assert.notEqual(initial, replacement);
  await f.respondRoster(0, [agent()]);
  assert.equal(f.rowButtons().length, 0); assert.equal(f.calls.length, 0); assert.equal(f.rosterRequests.length, 1);
});

test('successful empty passive roster remains a known desktop source even with explicit RPC ownership', async t => {
  const f = await fixture(t, { rows: [], rpc: 'agents', rosterMode: [], state: rpcState() });
  assert.equal(f.rosterRequests.length, 1); assert.equal(f.rowButtons().length, 0);
  assert.equal(f.w.document.querySelector('[data-rpc-agent]') === null, true); assert.equal(f.calls.length, 0);
  await f.tick(); await f.tick(); assert.equal(f.rosterRequests.length, 1); assert.equal(f.calls.length, 0);
});

for (const code of ['host_unavailable', 'session_not_found', 'invalid_request']) {
  test(`failed ${code} roster with unknown ownership fails closed and retains recorded tasks`, async t => {
    const f = await fixture(t, { rows: [], rpc: 'agents', rosterMode: { error: code }, messages: [taskMessage('recorded-task')] });
    assert.equal(f.rosterRequests.length, 1); assert.equal(f.calls.length, 0);
    assert.match(f.text(), /Recorded task/);
    assert.equal(f.w.document.querySelector('[data-rpc-agent]') === null, true);
    await f.tick(); assert.equal(f.calls.length, 0); assert.equal(f.rosterRequests.length, 1);
  });
  test(`failed ${code} roster requires both safe host absence and confirmed connected RPC authority`, async t => {
    const f = await fixture(t, { rows: [], rpc: 'agents', rosterMode: { error: code }, state: rpcState() });
    assert.equal(f.rosterRequests.length, 1);
    const allowed = code === 'host_unavailable';
    assert.equal(f.calls.filter(c => c.method === 'getSubagents').length, allowed ? 1 : 0);
    assert.equal(Boolean(f.w.document.querySelector('button[data-rpc-agent="rpc-id"]')), allowed);
    if (allowed) { assert.match(f.text(), /Redirect/); assert.match(f.text(), /Stop agent/); }
    else assert.doesNotMatch(f.text(), /Redirect|Stop agent/);
  });
}

for (const [label, state, rows] of [
  ['disconnected client', rpcState({ connection: 'closed' }), []],
  ['connecting client', rpcState({ connection: 'connecting' }), []],
  ['inferred child ownership', rpcState({ sessionAuthorities: { '/synthetic/a': rpcAuthority({ confidence: 'inferred' }) } }), []],
  ['reconnecting child authority', rpcState({ sessionAuthorities: { '/synthetic/a': rpcAuthority({ connection: 'reconnecting' }) } }), []],
  ['collab owner', rpcState({ sessionAuthorities: { '/synthetic/a': rpcAuthority({ owner: { kind: 'collab' } }) } }), []],
  ['bridge owner', rpcState({ sessionAuthorities: { '/synthetic/a': rpcAuthority({ owner: { kind: 'bridge' } }) } }), []],
  ['foreign owner', rpcState({ sessionAuthorities: { '/synthetic/a': rpcAuthority({ owner: { kind: 'foreign' } }) } }), []],
  ['known desktop rows', rpcState(), [agent()]],
]) test(`${label} cannot start generic RPC after a failed passive roster probe`, async t => {
  const f = await fixture(t, { rows, rpc: 'agents', rosterMode: { error: 'host_unavailable' }, state });
  assert.equal(f.rosterRequests.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.w.document.querySelector('[data-rpc-agent]') === null, true);
  await f.tick(); assert.equal(f.calls.length, 0); assert.equal(f.rosterRequests.length, 1);
});

for (const transition of ['close/reopen', 'session', 'controller', 'binding epoch']) test(`passive roster response from before ${transition} cannot replace the current visit`, async t => {
  const f = await fixture(t, { rows: [], rosterMode: 'deferred', state: { sessionAuthorities: { '/synthetic/a': authority(1) } } });
  if (transition === 'close/reopen') { await f.render(false); await f.render(true); }
  else if (transition === 'session') await f.render(true, '/synthetic/b');
  else if (transition === 'controller') await f.render(true, '/synthetic/a', true);
  else await f.setState({ sessionAuthorities: { '/synthetic/a': authority(2) } });
  assert.equal(f.rosterRequests.length, 2); assert.equal(f.rosterRequests[0].signal.aborted, true);
  await f.respondRoster(1, [agent({ displayName: 'Current passive roster' })]);
  await f.respondRoster(0, [agent({ displayName: 'Stale passive roster' })]);
  assert.match(f.button('agent-one').textContent, /Current passive roster/); assert.doesNotMatch(f.text(), /Stale passive roster/);
  assert.equal(f.calls.length, 0);
});

for (const transition of ['authority inferred', 'socket disconnected']) test(`RPC authority lost during the passive probe cannot authorize a late fallback: ${transition}`, async t => {
  const f = await fixture(t, { rows: [], rpc: 'agents', rosterMode: 'deferred', state: rpcState() });
  if (transition === 'authority inferred') await f.setState(rpcState({ sessionAuthorities: { '/synthetic/a': rpcAuthority({ confidence: 'inferred' }) } }));
  else await f.setState({ connection: 'closed' });
  assert.equal(f.rosterRequests[0].signal.aborted, true);
  await f.rejectRoster(0);
  for (let index = 1; index < f.rosterRequests.length; index++) await f.rejectRoster(index);
  assert.equal(f.calls.length, 0); assert.equal(f.w.document.querySelector('[data-rpc-agent]') === null, true);
});

test('malformed passive roster is not permission to use even an otherwise authorized RPC path', async t => {
  const f = await fixture(t, { rows: [], rpc: 'agents', rosterMode: 'deferred', state: rpcState() });
  await f.act(async () => f.rosterRequests[0].resolve({ ok: true, agents: [agent()], connectionId: '' }));
  assert.equal(f.rowButtons().length, 0); assert.equal(f.calls.length, 0);
  assert.ok(f.roster().querySelector('[role="alert"]'));
  await f.tick(); assert.equal(f.rosterRequests.length, 1);
});

test('unavailable passive roster retries only on explicit activation and keeps that retry single-flight', async t => {
  const f = await fixture(t, { rows: [], rpc: 'agents', rosterMode: { error: 'host_unavailable' } });
  await f.tick(); await f.tick(); assert.equal(f.rosterRequests.length, 1); assert.equal(f.calls.length, 0);
  f.configureRoster('deferred');
  const retry = [...f.roster().querySelectorAll('button')].find(b => b.textContent === 'Retry'); assert.ok(retry);
  await f.act(async () => { retry.click(); retry.click(); });
  assert.equal(f.rosterRequests.length, 2);
  await f.tick(); assert.equal(f.rosterRequests.length, 2);
  await f.respondRoster(1, [agent({ displayName: 'Recovered passive worker' })]);
  assert.match(f.button('agent-one').textContent, /Recovered passive worker/); assert.equal(f.calls.length, 0);
});

for (const exit of ['close intent', 'unmount']) test(`${exit} aborts an unfinished passive roster probe without publishing its late rows`, async t => {
  const f = await fixture(t, { rows: [], rosterMode: 'deferred' });
  if (exit === 'unmount') await f.unmount();
  else await f.closePanel();
  assert.equal(f.rosterRequests[0].signal.aborted, true);
  await f.respondRoster(0, [agent()]);
  assert.equal(f.rowButtons().length, 0); assert.equal(f.calls.length, 0);
  await f.tick(); assert.equal(f.rosterRequests.length, 1);
});

test('a row opened before the roster probe settles binds its first transcript connection and ignores the obsolete snapshot', async t => {
  const f = await fixture(t, { rows: [agent()], rosterMode: 'deferred' });
  await f.click(); assert.equal(f.requests[0].expectedConnectionId, undefined);
  const text = JSON.stringify(entry('bound-message', 'message from the observed connection')) + '\n';
  const nextByte = Buffer.byteLength(text, 'utf8');
  await f.respondRaw(0, text, nextByte, { connectionId: 'connection-observed-by-read' });
  await f.setRows([agent({ status: 'idle' })]);
  await f.respondRoster(0, [agent({ displayName: 'Obsolete passive roster' })]);
  assert.doesNotMatch(f.text(), /Obsolete passive roster/); assert.deepEqual(f.lines(), ['message from the observed connection']);
  assert.equal(f.requests.length, 1);
  await f.tick(); assert.equal(f.requests[1].expectedConnectionId, 'connection-observed-by-read');
  await f.respondRaw(1, '', nextByte, { connectionId: 'connection-observed-by-read' });
  await f.tick(); assert.equal(f.requests[2].expectedConnectionId, 'connection-observed-by-read');
  const alien = JSON.stringify(entry('alien-message', 'must not cross connection boundaries')) + '\n';
  await f.respondRaw(2, alien, nextByte + Buffer.byteLength(alien), { connectionId: 'replacement-connection' });
  assert.deepEqual(f.lines(), ['message from the observed connection']);
  assert.ok(f.transcript().querySelector('[role="alert"]'));
  assert.equal([...f.transcript().querySelectorAll('button')].some(b => b.textContent === 'Retry'), false);
  await f.tick(); assert.equal(f.requests.length, 3); assert.equal(f.calls.length, 0);
});

for (const connectionId of [undefined, '', 'unexpected-connection']) test(`a seeded desktop read rejects a missing, empty or mismatched connection echo: ${String(connectionId)}`, async t => {
  const f = await fixture(t); await f.click();
  assert.equal(f.requests[0].expectedConnectionId, 'synthetic-passive-connection');
  await f.respondRaw(0, '', 0, { connectionId });
  assert.deepEqual(f.lines(), []); assert.ok(f.transcript().querySelector('[role="alert"]'));
  assert.equal([...f.transcript().querySelectorAll('button')].some(b => b.textContent === 'Retry'), false);
  await f.tick(); assert.equal(f.requests.length, 1);
});

test('empty conversation quiet polling retains its empty state while an explicit retry shows loading', async t => {
  const f = await fixture(t); await f.click();
  assert.match(f.transcript().textContent, /Loading messages/);
  await f.respond(0, []); assert.match(f.transcript().textContent, /No messages yet/);
  await f.tick(); assert.equal(f.requests[1].fromByte, 0);
  assert.match(f.transcript().textContent, /No messages yet/);
  assert.doesNotMatch(f.transcript().textContent, /Loading messages/);
  await f.reject(1, 'transcript_timeout');
  const retry = [...f.transcript().querySelectorAll('button')].find(b => b.textContent === 'Retry'); assert.ok(retry);
  await f.act(async () => retry.click());
  assert.match(f.transcript().textContent, /Loading messages/);
  await f.respond(2, []); assert.match(f.transcript().textContent, /No messages yet/);
});

test('a current passive roster fences a conversation opened while its snapshot was still pending', async t => {
  const f = await fixture(t, { rows: [agent()], rosterMode: 'deferred' });
  await f.click(); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].expectedConnectionId, undefined);
  const oldRequest = f.requests[0];
  await f.respondRoster(0, [agent()]);
  assert.equal(oldRequest.signal.aborted, true, 'the unbound reader is disposed as soon as the current roster supplies its token');
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].expectedConnectionId, 'synthetic-passive-connection');
  assert.equal(f.requests[1].fromByte, 0); assert.equal(f.requests[1].signal.aborted, false);
  await f.respond(0, [entry('unfenced-old', 'obsolete unfenced transcript')]);
  assert.deepEqual(f.lines(), []); assert.match(f.transcript().textContent, /Loading messages/);
  await f.respond(1, [entry('fenced-current', 'current fenced transcript')]);
  assert.deepEqual(f.lines(), ['current fenced transcript']); assert.equal(f.rosterRequests.length, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.roster().hidden, true);
});

// A passive transcript can't tell a missing result from one still coming, so
// an unresolved call wears a tense-free label ("File", "Command", "Search"):
// no live verb, no completed verb, not the agent's optimistic intent.
for (const [name, neutralLabel, completedLabel] of [
  ['read', 'File', 'Read'], ['write', 'Write', 'Wrote'],
  ['edit', 'Edit', 'Edited'], ['apply_patch', 'Edit', 'Edited'],
]) test(`passive ${name} call stays neutral until its actual file result attaches`, async t => {
  const f = await fixture(t); await f.click();
  await f.respond(0, [{ type: 'message', id: 'file-request', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'file-call', name, arguments: { path: '/synthetic/requested-file.ts', content: 'requested content' } },
  ] } }]);
  const [row] = f.toolRows();
  assert.ok(row.textContent.startsWith(neutralLabel + ' '), row.textContent); assert.equal(row.dataset.state, 'ok');
  assert.doesNotMatch(row.textContent, /\b(?:Read|Wrote|Edited|Reading|Writing|Editing)\b/);
  await f.openTool(row);
  assert.match(f.sheet().textContent, /This transcript has no result for this call\./);
  assert.doesNotMatch(f.sheet().textContent, /\b(?:Wrote|Edited|Reading|Writing|Editing)\b/);
  await f.closeTool();
  await f.tick(); await f.respond(1, [{ type: 'message', id: 'file-result', message: {
    role: 'toolResult', toolCallId: 'file-call', content: [{ type: 'text', text: `Actual ${name} result payload` }],
  } }]);
  assert.ok(f.toolRows()[0].textContent.startsWith(completedLabel + ' '), f.toolRows()[0].textContent);
  await f.openTool(f.toolRows()[0]);
  assert.doesNotMatch(f.sheet().textContent, /no result for this call/);
  assert.equal(f.calls.length, 0);
});

test('passive file requests do not promote an optimistic intent into a completed write', async t => {
  const f = await fixture(t); await f.click();
  await f.respond(0, [{ type: 'message', id: 'intent-request', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'intent-call', name: 'write', arguments: { path: '/synthetic/file.ts' }, intent: 'Wrote and finished the requested changes' },
  ] } }]);
  const [row] = f.toolRows();
  assert.match(row.textContent, /^Write /); assert.doesNotMatch(row.textContent, /Wrote|finished/);
  await f.openTool(row);
  assert.doesNotMatch(f.sheet().textContent, /Wrote|finished/);
});

test('passive search never invents no matches before a recorded result confirms it', async t => {
  const f = await fixture(t); await f.click();
  await f.respond(0, [{ type: 'message', id: 'search-request', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'search-call', name: 'grep', arguments: { pattern: 'needle', path: 'src' } },
  ] } }]);
  const [row] = f.toolRows();
  assert.match(row.textContent, /^Search /); assert.doesNotMatch(row.textContent, /Searched|Searching/);
  await f.openTool(row);
  const detail = () => f.sheet().querySelector('[data-testid="tool-detail"]');
  assert.match(detail().textContent, /This transcript has no result for this call\./);
  assert.doesNotMatch(detail().textContent, /no matches|0 matches/i);
  assert.equal(detail().querySelector('[data-testid="search-result-summary"]') === null, true);
  await f.tick(); await f.respond(1, [{ type: 'message', id: 'search-result', message: {
    role: 'toolResult', toolCallId: 'search-call', content: [{ type: 'text', text: 'No matches found' }],
  } }]);
  assert.match(f.toolRows()[0].textContent, /^Searched /);
  assert.match(detail().textContent, /No matches for/); assert.doesNotMatch(detail().textContent, /no result for this call/);
});

for (const [name, args, neutral] of [
  ['bash', { command: 'echo neutral-command' }, /^Command echo neutral-command$/],
  ['python', { code: 'print(42)' }, /^Code/],
]) test(`passive ${name} without a result avoids completed or live summary defaults`, async t => {
  const f = await fixture(t); await f.click();
  await f.respond(0, [{ type: 'message', id: 'neutral-request', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'neutral-call', name, arguments: args },
  ] } }]);
  const [row] = f.toolRows();
  assert.match(row.textContent, neutral);
  // The row carries the bare command; the state word is screen-reader text.
  assert.doesNotMatch(row.textContent, /\bRan\b|\bRunning\b|Interrupted/);
  await f.openTool(row);
  assert.doesNotMatch(f.sheet().textContent, /\bRan\b|Running code|Running command/);
  assert.equal(f.sheet().querySelector('[data-testid="stop-command"]') === null, true);
  await f.closeTool();
  await f.tick(); await f.respond(1, [{ type: 'message', id: 'neutral-result', message: {
    role: 'toolResult', toolCallId: 'neutral-call', content: [{ type: 'text', text: 'confirmed tool output' }],
  } }]);
  if (name === 'bash') assert.match(f.toolRows()[0].textContent, /^Ran /);
  await f.openTool(f.toolRows()[0]);
  assert.match(f.sheet().textContent, /confirmed tool output/);
});

test('normal chat keeps live and completed File, Bash, Search and Generic labels without the passive flag', async t => {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.TextEncoder = TextEncoder; w.Element.prototype.getAnimations = () => []; w.HTMLElement.prototype.scrollTo = () => {};
  w.localStorage.setItem('omp-appearance', JSON.stringify({ toolCalls: 'grouped' })); // rows, as in fixture()
  const names = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'python'];
  const args = name => name === 'bash' ? { command: 'echo normal-command' }
    : name === 'grep' ? { pattern: 'needle', path: 'src' }
    : name === 'python' ? { code: 'print(42)' } : { path: '/synthetic/normal.ts' };
  const message = state => ({ id: 'normal-tools', role: 'assistant', text: '', parts: names.map((name, index) => ({
    kind: 'tool', callId: 'normal-' + index, name, args: args(name), state,
    ...(state === 'ok' ? { output: name === 'grep' ? 'No matches found' : 'confirmed normal output' } : {}),
  })) });
  let mounted;
  await f.act(async () => { mounted = f.mountNormal(message('running'), { toolsLive: true, sessionPath: '/synthetic/normal' }); });
  t.after(async () => { try { await f.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const rows = () => [...w.document.querySelectorAll('button[data-testid="tool-row"]')];
  assert.equal(rows().length, names.length);
  const liveLabels = [/^Reading /, /^Writing /, /^Editing /, /^Editing /, /^Running /, /^Searching /, /^Running code/];
  rows().forEach((row, index) => { assert.match(row.textContent, liveLabels[index]); assert.equal(row.dataset.state, 'running'); });
  await f.act(async () => rows()[4].click());
  assert.ok(w.document.querySelector('[data-testid="tool-sheet"] [data-testid="stop-command"]'), 'normal live Bash retains its Stop action');
  assert.doesNotMatch(w.document.body.textContent, /no result for this call/);
  await f.act(async () => w.document.querySelector('[data-testid="tool-sheet"] [data-testid="sheet-close"]').click());
  await f.act(async () => mounted.render(message('ok'), { sessionPath: '/synthetic/normal' }));
  assert.equal(rows().length, 0, 'settled, the work folds into its group');
  await f.act(async () => w.document.querySelector('[data-testid="turn-work-title"]').click());
  const completeLabels = [/^Read /, /^Wrote /, /^Edited /, /^Edited /, /^Ran /, /^Searched /, /^Ran code/];
  rows().forEach((row, index) => assert.match(row.textContent, completeLabels[index]));
  assert.equal(w.document.querySelector('[data-testid="stop-command"]') === null, true);
  await f.act(async () => rows()[5].click());
  assert.match([...w.document.querySelectorAll('[data-testid="tool-sheet"]')].at(-1).textContent, /No matches for “needle”/);
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.rosterRequests.length, 0);
});

for (const status of ['running', 'idle', 'parked']) test(`direct desktop follow-up preserves ${status} agent identity and fences same-turn duplicate taps`, async t => {
  const f = await fixture(t, { rows: [agent({status})], state: rpcState({sessionAuthorities:{'/synthetic/a':rpcAuthority({owner:{kind:'bridge'}})}}) });
  await f.click();
  assert.equal(f.replyReads.length,1);
  assert.equal(f.replyReads[0].target.agentId,'agent-one');
  assert.equal(f.replyReads[0].target.expectedCreatedAt,agent().createdAt);
  assert.equal(f.replyReads[0].target.expectedConnectionId,'synthetic-passive-connection');
  assert.equal(f.replyReads[0].target.bindingEpoch,1);
  await f.act(async()=>f.replyReads[0].resolve({available:true}));
  const input=f.w.document.querySelector('[data-testid="desktop-agent-reply"] textarea');
  await f.act(async()=>{
    Object.getOwnPropertyDescriptor(f.w.HTMLTextAreaElement.prototype,'value').set.call(input,'Please review the second patch');
    input.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  });
  await f.act(async()=>{
    const send=f.w.document.querySelector('[data-testid="desktop-agent-reply-send"]');
    send.click();send.click();
  });
  assert.equal(f.replyWrites.length,1);
  assert.equal(f.replyWrites[0].text,'Please review the second patch');
  assert.equal(f.calls.length,0,'no parent prompt, child steering, attach or restart');
  await f.act(async()=>f.replyWrites[0].resolve({delivery:'handoff'}));
  assert.match(f.text(),/Handed to the desktop connection/);
  assert.equal(input.value,'Please review the second patch');
});

for (const change of ['back','binding','replacement','stopped']) test(`direct follow-up ignores stale availability after ${change}`, async t=>{
  const state=rpcState({sessionAuthorities:{'/synthetic/a':rpcAuthority({owner:{kind:'collab'}})}});
  const f=await fixture(t,{state});await f.click();
  const read=f.replyReads[0];assert.ok(read);
  if(change==='back')await f.back();
  if(change==='binding')await f.setState({sessionAuthorities:{'/synthetic/a':rpcAuthority({bindingEpoch:2,owner:{kind:'collab'}})}});
  if(change==='replacement')await f.setRows([agent({createdAt:agent().createdAt+1})]);
  if(change==='stopped')await f.setRows([agent({status:'aborted'})]);
  assert.equal(read.signal.aborted,true);
  await f.act(async()=>read.resolve({available:true}));
  assert.equal(f.w.document.querySelector('[data-testid="desktop-agent-reply-send"]'),null);
  assert.equal(f.replyWrites.length,0);
});

for(const status of [409,504])test(`desktop follow-up ${status} preserves text without automatic retry`,async t=>{
  const state=rpcState({sessionAuthorities:{'/synthetic/a':rpcAuthority({owner:{kind:'collab'}})}});
  const f=await fixture(t,{state});await f.click();
  await f.act(async()=>f.replyReads[0].resolve({available:true}));
  const input=f.w.document.querySelector('[data-testid="desktop-agent-reply"] textarea');
  await f.act(async()=>{
    Object.getOwnPropertyDescriptor(f.w.HTMLTextAreaElement.prototype,'value').set.call(input,'Keep this reply');
    input.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  });
  await f.clickButton('[data-testid="desktop-agent-reply-send"]');
  await f.act(async()=>{const error=new f.w.Error('Synthetic refusal');error.status=status;f.replyWrites[0].reject(error)});
  assert.equal(input.value,'Keep this reply');assert.equal(input.disabled,true);
  if(status===504)assert.match(f.text(),/Delivery is unconfirmed/);
  await f.clickButton('[data-testid="desktop-agent-reply-send"]');
  assert.equal(f.replyWrites.length,1);
});

test('late direct follow-up completion cannot publish into a reopened conversation',async t=>{
  const state=rpcState({sessionAuthorities:{'/synthetic/a':rpcAuthority({owner:{kind:'collab'}})}});
  const f=await fixture(t,{state});await f.click();
  await f.act(async()=>f.replyReads[0].resolve({available:true}));
  await f.act(async()=>{
    const input=f.w.document.querySelector('[data-testid="desktop-agent-reply"] textarea');
    Object.getOwnPropertyDescriptor(f.w.HTMLTextAreaElement.prototype,'value').set.call(input,'Old visit reply');
    input.dispatchEvent(new f.w.Event('input',{bubbles:true}));
  });
  await f.clickButton('[data-testid="desktop-agent-reply-send"]');
  await f.back();await f.click();
  const newInput=f.w.document.querySelector('[data-testid="desktop-agent-reply"] textarea');
  assert.equal(newInput.value,'');
  await f.act(async()=>f.replyWrites[0].resolve({delivery:'handoff'}));
  assert.equal(newInput.value,'');assert.doesNotMatch(f.text(),/Handed to the desktop connection/);
  assert.equal(f.replyWrites.length,1);
});
