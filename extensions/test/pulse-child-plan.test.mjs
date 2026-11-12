import test from 'node:test';
import assert from 'node:assert/strict';
import install from '../omp-pulse-child.ts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const base = { provider: 'local', id: 'execution', name: 'Execution' };
const planner = { provider: 'local', id: 'planning', name: 'Planning' };
const fast = { provider: 'local', id: 'fast', name: 'Fast' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

function fixture({ plan = { model: planner, thinkingLevel: 'high', explicitThinkingLevel: true } } = {}) {
  const commands = new Map();
  const events = new Map();
  const answers = [];
  const dialogs = [];
  const notices = [];
  const messages = [];
  const implementations = [];
  const modelHistory = [];
  let state;
  let proposal;
  let tools = ['read', 'mcp__lookup'];
  let mounted = ['task'];
  let thinking = 'medium';
  let context = { mode: 'none', models: {} };
  let compactImpl = async () => {};
  let compactCalls = 0;
  let roleOrder;
  const session = {
    model: base,
    isStreaming: false,
    settings: { rawValue: ({ segments }) => segments.join('.') === 'cycleOrder' ? roleOrder : undefined },
    configuredThinkingLevel: () => thinking,
    resolveRoleModelWithThinking: (role) => { assert.equal(role, 'plan'); return plan; },
    setThinkingLevel: (level) => { thinking = level; },
    async setModelTemporary(model, level) {
      session.model = model;
      // Native temporary switches without a level keep current reasoning unless
      // the target model declares its own default; they do not clear to unset.
      thinking = level ?? model.thinking?.defaultLevel ?? thinking;
      modelHistory.push({ id: model.id, thinking });
    },
    getRoleModelCycle(roles) {
      const all = [
        { role: 'smol', model: fast, thinkingLevel: 'low', explicitThinkingLevel: true },
        { role: 'default', model: base, thinkingLevel: undefined, explicitThinkingLevel: false },
        { role: 'slow', model: base, thinkingLevel: 'high', explicitThinkingLevel: true },
      ];
      return { models: roles.flatMap((role) => all.filter((choice) => choice.role === role)), currentIndex: 0 };
    },
    async applyRoleModel(choice) {
      session.model = choice.model;
      thinking = choice.explicitThinkingLevel && choice.thinkingLevel !== undefined
        ? choice.thinkingLevel : choice.model.thinking?.defaultLevel ?? thinking;
      modelHistory.push({ id: choice.model.id, thinking, role: choice.role });
    },
    getPlanModeState: () => state,
    setPlanModeState: (value) => { state = value; },
    setPlanProposalHandler: (handler) => { proposal = handler; },
    preparePlanForReview: async (title) => ({ details: { title, planFilePath: 'local://PLAN.md' } }),
    getPlanReferencePath: () => undefined,
    setPlanReferencePath() {},
    getEnabledToolNames: () => tools,
    getMountedXdevToolNames: () => mounted,
    hasBuiltInTool: (name) => name === 'write',
    async setActiveToolsByName(names) { tools = names; },
    async setActiveToolPresentation(enabled, mounts) { tools = enabled; mounted = mounts; },
    async restoreNonMCPToolPresentation(enabled, mounts) { tools = [...enabled, 'mcp__lookup']; mounted = mounts; },
    async sendPlanModeContext() {},
    async runModeExitTeardown(fn) { await fn(); },
    async abort() { session.isStreaming = false; },
    markPlanInternalAbortPending() {},
    clearPlanInternalAbortPending() {},
    async prompt(text, options) {
      implementations.push({ model: session.model.id, thinking, options });
      messages.push(text);
    },
  };
  const ui = {
    async select(title, choices) {
      dialogs.push({ title, choices });
      const answer = answers.shift();
      return typeof answer === 'function' ? answer(choices) : answer;
    },
    notify(message) { notices.push(message); },
    setStatus(_key, value) { reply = JSON.parse(value); },
  };
  const ctx = {
    agent: { id: 'Main', kind: 'main' }, cwd: '/tmp', ui,
    sessionManager: {
      appendModeChange(mode) { context = { ...context, mode }; },
      buildSessionContext: () => context,
      async flush() {},
    },
    async compact() { compactCalls++; await compactImpl(); },
  };
  let reply;
  install({
    pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } },
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    sendUserMessage(message) { messages.push(message); },
  });
  return {
    session, ctx, answers, dialogs, notices, messages, modelHistory, implementations,
    get state() { return state; }, get tools() { return tools; }, get thinking() { return thinking; },
    get compactCalls() { return compactCalls; }, get hasProposal() { return typeof proposal === 'function'; },
    setContext(value) { context = value; }, setRoleOrder(value) { roleOrder = value; },
    setCompact(fn) { compactImpl = fn; },
    async toggle(enabled) { await commands.get('pulse-plan').handler(`r1 ${JSON.stringify({ enabled })}`, ctx); return reply; },
    async propose(...choices) { answers.push(...choices); return proposal('Ship it'); },
    async event(name, event = {}) { await events.get(name)(event, ctx); await settle(); },
  };
}

test('enter applies configured planning model/reasoning once and exit restores original tools/model/reasoning', async () => {
  const f = fixture();
  assert.equal((await f.toggle(true)).enabled, true);
  assert.equal(f.session.model.id, 'planning');
  assert.equal(f.thinking, 'high');
  assert.ok(f.tools.includes('write'));
  await f.toggle(true);
  await f.toggle(false);
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'medium');
  assert.deepEqual(f.tools, ['read', 'mcp__lookup']);
  assert.equal(f.hasProposal, false);
});

test('same-model planning changes only explicitly configured reasoning', async () => {
  for (const explicit of [false, true]) {
    const f = fixture({ plan: { model: base, thinkingLevel: 'high', explicitThinkingLevel: explicit } });
    await f.toggle(true);
    assert.equal(f.thinking, explicit ? 'high' : 'medium');
    assert.equal(f.modelHistory.length, 0);
    await f.toggle(false);
    assert.equal(f.thinking, 'medium');
  }
});

test('inherited same-model reasoning is restored on exit and discard, including streaming', async () => {
  for (const streaming of [false, true]) {
    for (const exit of ['toggle', 'Discard']) {
      const f = fixture({ plan: { model: base, thinkingLevel: 'high', explicitThinkingLevel: true } });
      f.session.setThinkingLevel(undefined);
      f.session.isStreaming = streaming;
      await f.toggle(true);
      assert.equal(f.thinking, 'high');
      await f.toggle(true);
      if (exit === 'toggle') await f.toggle(false);
      else await f.propose(exit);
      assert.equal(f.state, undefined);
      assert.equal(f.session.model.id, 'execution');
      assert.equal(f.thinking, undefined);
      assert.deepEqual(f.tools, ['read', 'mcp__lookup']);
      f.session.isStreaming = false;
      await f.event('agent_end');
      assert.equal(f.thinking, undefined);
      assert.equal(f.modelHistory.length, 0);
    }
  }
});

test('missing planner reasoning does not override configured or inherited same-model reasoning', async () => {
  for (const original of [undefined, 'medium', 'auto']) {
    const f = fixture({ plan: { model: base, explicitThinkingLevel: true } });
    f.session.setThinkingLevel(original);
    await f.toggle(true);
    assert.equal(f.thinking, original);
    await f.toggle(false);
    assert.equal(f.thinking, original);
  }
});

test('same-model run and compact approval restore inherited reasoning before execution', async () => {
  for (const approval of ['Approve and run', 'Approve and compact context']) {
    const f = fixture({ plan: { model: base, thinkingLevel: 'high', explicitThinkingLevel: true } });
    f.session.setThinkingLevel(undefined);
    await f.toggle(true);
    f.setCompact(async () => assert.equal(f.thinking, 'high'));
    f.session.isStreaming = true;
    await f.propose(approval, 'default: Execution');
    assert.equal(f.thinking, 'high');
    await f.event('agent_end', { willContinue: true });
    assert.equal(f.thinking, 'high');
    assert.equal(f.messages.length, 0);
    await f.event('agent_end', { willContinue: false });
    assert.equal(f.state, undefined);
    assert.equal(f.session.model.id, 'execution');
    assert.equal(f.thinking, undefined);
    assert.equal(f.messages.length, 1);
    if (approval === 'Approve and run') {
      assert.deepEqual(f.implementations, [{ model: 'execution', thinking: undefined, options: { synthetic: true } }]);
    } else {
      assert.equal(f.compactCalls, 1);
    }
    await f.event('agent_end');
    assert.equal(f.thinking, undefined);
    assert.equal(f.messages.length, 1);
  }
});

test('an explicit same-model executor override supersedes inherited pre-plan reasoning', async () => {
  for (const approval of ['Approve and run', 'Approve and compact context']) {
    const f = fixture({ plan: { model: base, thinkingLevel: 'low', explicitThinkingLevel: true } });
    f.session.setThinkingLevel(undefined);
    await f.toggle(true);
    assert.equal(f.thinking, 'low');
    await f.propose(approval, 'slow: Execution (high)');
    await f.event('agent_end');
    assert.equal(f.session.model.id, 'execution');
    assert.equal(f.thinking, 'high');
    assert.equal(f.messages.length, 1);
  }
});

test('cancelled same-model compaction restores inherited reasoning without starting execution', async () => {
  const f = fixture({ plan: { model: base, thinkingLevel: 'high', explicitThinkingLevel: true } });
  f.session.setThinkingLevel(undefined);
  await f.toggle(true);
  f.setCompact(async () => { throw new Error('compaction cancelled'); });
  await f.propose('Approve and compact context', 'default: Execution');
  await f.event('agent_end');
  assert.equal(f.state, undefined);
  assert.equal(f.thinking, undefined);
  assert.equal(f.messages.length, 0);
});

test('deferred model restoration retains an explicitly unset reasoning snapshot', async () => {
  const f = fixture();
  f.session.setThinkingLevel(undefined);
  await f.toggle(true);
  assert.equal(f.session.model.id, 'planning');
  assert.equal(f.thinking, 'high');
  f.session.isStreaming = true;
  await f.propose('Discard');
  assert.equal(f.state, undefined);
  assert.equal(f.session.model.id, 'planning');
  assert.equal(f.thinking, 'high');
  f.session.isStreaming = false;
  await f.event('agent_end', { willContinue: true });
  assert.equal(f.session.model.id, 'planning');
  await f.event('agent_end', { willContinue: false });
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, undefined);
  assert.deepEqual(f.modelHistory, [
    { id: 'planning', thinking: 'high' },
    { id: 'execution', thinking: 'high' },
  ]);
  await f.event('agent_end');
  assert.equal(f.thinking, undefined);
  assert.equal(f.modelHistory.length, 2);
});

test('inherited reasoning survives cancellation of a deferred planner switch', async () => {
  const f = fixture();
  f.session.setThinkingLevel(undefined);
  f.session.isStreaming = true;
  await f.toggle(true);
  await f.toggle(false);
  await f.event('agent_end');
  assert.equal(f.state, undefined);
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, undefined);
  assert.equal(f.modelHistory.length, 0);
});

test('streaming enter waits for terminal agent_end, not a continuing boundary', async () => {
  const f = fixture();
  f.session.isStreaming = true;
  await f.toggle(true);
  assert.equal(f.session.model.id, 'execution');
  f.session.isStreaming = false;
  await f.event('agent_end', { willContinue: true });
  assert.equal(f.session.model.id, 'execution');
  await f.event('agent_end', { willContinue: false });
  assert.equal(f.session.model.id, 'planning');
  await f.toggle(false);
  assert.equal(f.thinking, 'medium');
});

test('exit before deferred plan switch removes the stale pending switch', async () => {
  const f = fixture();
  f.session.isStreaming = true;
  await f.toggle(true);
  await f.toggle(false);
  await f.event('agent_end');
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'medium');
});

test('approval offers configured execution cycle with default role first and preserves implicit original thinking', async () => {
  const f = fixture();
  f.setRoleOrder(['slow', 'default', 'smol']);
  await f.toggle(true);
  await f.propose('Approve and run', (choices) => {
    assert.deepEqual(choices, ['default: Execution', 'smol: Fast (low)', 'slow: Execution (high)']);
    return choices[0];
  });
  assert.equal(f.messages.length, 0);
  await f.event('agent_end');
  assert.equal(f.state, undefined);
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'medium');
});

test('explicit same-model execution reasoning is honored rather than restored over', async () => {
  const f = fixture();
  await f.toggle(true);
  await f.propose('Approve and run', 'slow: Execution (high)');
  await f.event('agent_end');
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'high');
});

test('execution-model dialog cancellation and keep/discard choices retain native model semantics', async () => {
  const f = fixture();
  await f.toggle(true);
  await f.propose('Approve and run', undefined);
  assert.equal(f.state.enabled, true);
  assert.equal(f.session.model.id, 'planning');
  await f.propose('Keep planning');
  assert.equal(f.state.enabled, true);
  await f.propose('Discard');
  assert.equal(f.state, undefined);
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'medium');
});

test('streaming approval switches selected execution role only at terminal boundary', async () => {
  const f = fixture();
  await f.toggle(true);
  f.session.isStreaming = true;
  await f.propose('Approve and run', 'smol: Fast (low)');
  assert.equal(f.session.model.id, 'planning');
  f.session.isStreaming = false;
  await f.event('agent_end', { willContinue: true });
  assert.equal(f.session.model.id, 'planning');
  await f.event('agent_end', { willContinue: false });
  assert.equal(f.session.model.id, 'fast');
  assert.equal(f.thinking, 'low');
  assert.deepEqual(f.implementations, [{ model: 'fast', thinking: 'low', options: { synthetic: true } }]);
  await f.event('agent_end');
  assert.equal(f.implementations.length, 1);
});

test('failed selected execution switch retains original executor after streaming approval', async () => {
  const f = fixture();
  await f.toggle(true);
  f.session.isStreaming = true;
  f.session.applyRoleModel = async () => { throw new Error('provider unavailable'); };
  await f.propose('Approve and run', 'smol: Fast (low)');
  f.session.isStreaming = false;
  await f.event('agent_end');
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'medium');
  assert.ok(f.notices.some((notice) => /provider unavailable/.test(notice)));
  assert.equal(f.implementations.length, 0);
});

test('failed plan model switch warns and leaves a functional planning session that exits cleanly', async () => {
  const f = fixture();
  const setModel = f.session.setModelTemporary;
  f.session.setModelTemporary = async () => { throw new Error('no auth'); };
  assert.equal((await f.toggle(true)).enabled, true);
  assert.equal(f.session.model.id, 'execution');
  assert.ok(f.notices.some((notice) => /no auth/.test(notice)));
  f.session.setModelTemporary = setModel;
  await f.toggle(false);
  assert.equal(f.state, undefined);
  assert.equal(f.thinking, 'medium');
});

test('failed exit rolls plan state/tools/model back and permits a later successful exit', async () => {
  const f = fixture();
  await f.toggle(true);
  const setModel = f.session.setModelTemporary;
  f.session.setModelTemporary = async () => { throw new Error('restore failed'); };
  assert.equal((await f.toggle(false)).ok, false);
  assert.equal(f.state.enabled, true);
  assert.equal(f.session.model.id, 'planning');
  assert.ok(f.tools.includes('write'));
  assert.equal(f.hasProposal, true);
  f.session.setModelTemporary = setModel;
  await f.toggle(false);
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'medium');
});

test('compact approval retains planning model for compaction, restores execution, and then dispatches', async () => {
  const f = fixture();
  await f.toggle(true);
  f.setCompact(async () => {
    assert.equal(f.session.model.id, 'planning');
    assert.equal(f.thinking, 'high');
  });
  await f.propose('Approve and compact context', 'smol: Fast (low)');
  await f.event('agent_end', { willContinue: true });
  assert.equal(f.compactCalls, 0);
  await f.event('agent_end', { willContinue: false });
  assert.equal(f.compactCalls, 1);
  assert.equal(f.session.model.id, 'fast');
  assert.equal(f.messages.length, 1);
});

test('cancelled compact restores original thinking but does not dispatch execution', async () => {
  const f = fixture();
  await f.toggle(true);
  f.setCompact(async () => { throw new Error('compaction cancelled'); });
  await f.propose('Approve and compact context', 'default: Execution');
  await f.event('agent_end');
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'medium');
  assert.equal(f.messages.length, 0);
});

test('failed compact retains planning model and still dispatches, matching native restoration', async () => {
  const f = fixture();
  await f.toggle(true);
  f.setCompact(async () => { throw new Error('summarizer provider failed'); });
  await f.propose('Approve and compact context', 'default: Execution');
  await f.event('agent_end');
  assert.equal(f.session.model.id, 'planning');
  assert.equal(f.messages.length, 1);
});

test('tree lifecycle preserves destination journal model and invalidates stale deferred work', async () => {
  const f = fixture();
  await f.toggle(true);
  await f.propose('Approve and compact context', 'default: Execution');
  f.session.model = fast;
  f.session.setThinkingLevel('low');
  f.setContext({ mode: 'none', models: { default: 'local/fast' } });
  await f.event('session_tree');
  await f.event('agent_end');
  assert.equal(f.session.model.id, 'fast');
  assert.equal(f.compactCalls, 0);
  assert.equal(f.messages.length, 0);
});

test('resumed plan uses restored journal model without a second role-model assignment', async () => {
  const f = fixture();
  await f.toggle(true);
  f.session.model = fast;
  f.session.setThinkingLevel('low');
  f.setContext({ mode: 'plan', modeData: { planFilePath: 'local://other-plan.md' }, models: { temporary: 'local/fast' } });
  await f.event('session_switch');
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.planFilePath, 'local://other-plan.md');
  assert.equal(f.session.model.id, 'fast');
  await f.toggle(false);
  assert.equal(f.session.model.id, 'fast');
  assert.equal(f.thinking, 'low');
});

test('unsupported native model APIs refuse before changing tools or mode', async () => {
  const f = fixture();
  delete f.session.resolveRoleModelWithThinking;
  assert.equal((await f.toggle(true)).ok, false);
  assert.equal(f.state, undefined);
  assert.deepEqual(f.tools, ['read', 'mcp__lookup']);
  assert.equal(f.session.model.id, 'execution');
});

test('same-model explicit planning reasoning applies during streaming and still restores once', async () => {
  const f = fixture({ plan: { model: base, thinkingLevel: 'high', explicitThinkingLevel: true } });
  f.session.isStreaming = true;
  await f.toggle(true);
  assert.equal(f.thinking, 'high');
  await f.toggle(true);
  await f.toggle(false);
  assert.equal(f.thinking, 'medium');
  assert.equal(f.modelHistory.length, 0);
});

test('execution cycle without default prefers the native current index', async () => {
  const f = fixture();
  f.setRoleOrder(['smol', 'slow']);
  const cycle = f.session.getRoleModelCycle;
  f.session.getRoleModelCycle = (roles) => ({ ...cycle(roles), currentIndex: 1 });
  await f.toggle(true);
  await f.propose('Approve and run', (choices) => {
    assert.equal(choices[0], 'slow: Execution (high)');
    return choices[0];
  });
  await f.event('agent_end');
  assert.equal(f.session.model.id, 'execution');
  assert.equal(f.thinking, 'high');
});

test('tool restoration failure preserves planning model, approval handler, and plan tools', async () => {
  const f = fixture();
  await f.toggle(true);
  const restore = f.session.restoreNonMCPToolPresentation;
  f.session.restoreNonMCPToolPresentation = async () => { throw new Error('tool restore failed'); };
  assert.equal((await f.toggle(false)).ok, false);
  assert.equal(f.state.enabled, true);
  assert.equal(f.session.model.id, 'planning');
  assert.equal(f.thinking, 'high');
  assert.equal(f.hasProposal, true);
  assert.ok(f.tools.includes('write'));
  f.session.restoreNonMCPToolPresentation = restore;
  await f.toggle(false);
  assert.equal(f.session.model.id, 'execution');
});

test('failed streaming plan-context delivery rolls back tools and mode before returning an error', async () => {
  const f = fixture();
  f.session.isStreaming = true;
  f.session.sendPlanModeContext = async () => { throw new Error('steer failed'); };
  assert.equal((await f.toggle(true)).ok, false);
  assert.equal(f.state, undefined);
  assert.equal(f.hasProposal, false);
  assert.equal(f.session.model.id, 'execution');
  assert.deepEqual(f.tools, ['read', 'mcp__lookup']);
});

async function freshFixture(t, options) {
  const f = fixture(options);
  f.session.queuedMessageCount = 0;
  const root = await mkdtemp(join(tmpdir(), 'pulse-fresh-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'planning.jsonl');
  const destination = join(root, 'implementation.jsonl');
  const original = 'Planning discussion with an intentionally rejected alternative.\n';
  const plan = '# Approved plan\nImplement the chosen design.\n';
  await writeFile(source, original);
  await mkdir(join(source + '.artifacts', 'local'), { recursive: true });
  await writeFile(join(source + '.artifacts', 'local', 'PLAN.md'), plan);
  await writeFile(join(source + '.artifacts', 'local', 'research.txt'), 'durable research');
  let current = source;
  const transitions = [];
  const dispatched = [];
  let newCalls = 0;
  let newImpl = async () => true;
  let support = true;
  let done;
  const finished = new Promise(resolve => { done = resolve; });
  Object.assign(f.ctx.sessionManager, {
    getSessionFile: () => current,
    getArtifactsDir: () => current + '.artifacts',
    getCwd: () => root,
    appendCustomEntry() {},
  });
  f.ctx.ui.confirm = async (title, message) => {
    assert.equal(title, 'omp-pulse-plan-transition');
    const request = JSON.parse(message.slice('omp-pulse:'.length));
    transitions.push(request);
    if (request.phase === 'finish') done();
    return support;
  };
  f.session.newSession = async options => {
    newCalls++;
    if (!await newImpl()) return false;
    current = join(options?.sessionDir ?? join(root, 'native-default'), 'implementation.jsonl');
    await mkdir(dirname(current), { recursive: true });
    await writeFile(current, '{"type":"session"}\n');
    await mkdir(current + '.artifacts', { recursive: true });
    await f.event('session_switch', { reason: 'new', previousSessionFile: source });
    return true;
  };
  f.session.switchSession = async path => {
    current = path;
    await f.event('session_switch', { reason: 'resume' });
    return true;
  };
  f.session.markPlanInternalAbortPending = () => {};
  f.session.clearPlanInternalAbortPending = () => {};
  f.session.markPlanReferenceSent = () => {};
  f.session.prompt = async (text, options) => {
    dispatched.push({ text, options, path: current, model: f.session.model.id, thinking: f.thinking });
  };
  f.session.abort = async () => {
    f.session.isStreaming = false;
    await f.event('agent_end');
  };
  return {
    ...f, source, destination, original, plan, transitions, dispatched, finished,
    current: () => current, newCalls: () => newCalls,
    support(value) { support = value; },
    setNew(fn) { newImpl = fn; },
  };
}

test('fresh approval carries durable plan/artifacts into a distinct context exactly once with selected executor', async t => {
  const f = await freshFixture(t);
  await f.toggle(true);
  f.session.isStreaming = true;
  await f.propose('Approve with fresh context', 'smol: Fast (low)');
  await f.finished;
  await settle();
  assert.equal(f.current(), f.destination);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
  assert.equal(await readFile(join(f.source + '.artifacts', 'local', 'PLAN.md'), 'utf8'), f.plan);
  assert.equal(await readFile(join(f.destination + '.artifacts', 'local', 'PLAN.md'), 'utf8'), f.plan);
  assert.equal(await readFile(join(f.destination + '.artifacts', 'local', 'research.txt'), 'utf8'), 'durable research');
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].path, f.destination);
  assert.equal(f.dispatched[0].model, 'fast');
  assert.equal(f.dispatched[0].thinking, 'low');
  assert.ok(f.dispatched[0].text.includes(f.plan));
  assert.ok(!f.dispatched[0].text.includes('rejected alternative'));
  await f.event('agent_end');
  assert.equal(f.dispatched.length, 1);
});

test('fresh same-model approval restores inherited reasoning unless a new executor override is selected', async t => {
  for (const execution of ['default: Execution', 'slow: Execution (high)']) {
    const f = await freshFixture(t, {
      plan: { model: base, thinkingLevel: 'low', explicitThinkingLevel: true },
    });
    f.session.setThinkingLevel(undefined);
    await f.toggle(true);
    assert.equal(f.session.configuredThinkingLevel(), 'low');
    f.session.isStreaming = true;
    await f.propose('Approve with fresh context', execution);
    await f.finished;
    await settle();
    assert.equal(f.current(), f.destination);
    assert.equal(f.dispatched.length, 1);
    assert.equal(f.dispatched[0].model, 'execution');
    assert.equal(f.dispatched[0].thinking, execution === 'default: Execution' ? undefined : 'high');
    assert.equal(f.session.configuredThinkingLevel(), f.dispatched[0].thinking);
    assert.equal(await readFile(f.source, 'utf8'), f.original);
  }
});

test('fresh selection cancellation and unavailable native/daemon capabilities do not create a session', async t => {
  const f = await freshFixture(t);
  await f.toggle(true);
  await f.propose('Approve with fresh context', undefined);
  assert.equal(f.newCalls(), 0);
  assert.equal(f.session.getPlanModeState().enabled, true);
  f.support(false);
  await assert.rejects(f.propose('Approve with fresh context', 'smol: Fast (low)'), /daemon cannot safely follow/);
  f.support(true);
  f.session.newSession = undefined;
  await assert.rejects(f.propose('Approve with fresh context', 'smol: Fast (low)'), /omp version/);
  assert.equal(f.newCalls(), 0);
  assert.equal(f.dispatched.length, 0);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
});

test('native new-session cancellation retains planning and never dispatches work', async t => {
  const f = await freshFixture(t);
  f.setNew(async () => false);
  await f.toggle(true);
  f.session.isStreaming = true;
  await f.propose('Approve with fresh context', 'smol: Fast (low)');
  await f.finished;
  await settle();
  assert.equal(f.current(), f.source);
  assert.equal(f.session.getPlanModeState().enabled, true);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.transitions.at(-1).to, f.source);
});

test('failed fresh executor switch returns to retained planning without dispatch', async t => {
  const f = await freshFixture(t);
  await f.toggle(true);
  f.session.applyRoleModel = async () => { throw new Error('executor unavailable'); };
  f.session.isStreaming = true;
  await f.propose('Approve with fresh context', 'smol: Fast (low)');
  await f.finished;
  await settle();
  assert.equal(f.current(), f.source);
  assert.equal(f.session.getPlanModeState().enabled, true);
  assert.equal(f.session.model.id, 'planning');
  assert.equal(f.dispatched.length, 0);
  assert.equal(await readFile(f.source, 'utf8'), f.original);
  assert.ok(f.notices.some(notice => /executor unavailable/.test(notice)));
});

test('fresh approval refuses queued user messages instead of dropping them during newSession', async t => {
  const f = await freshFixture(t);
  await f.toggle(true);
  f.session.queuedMessageCount = 1;
  await assert.rejects(f.propose('Approve with fresh context', 'smol: Fast (low)'), /queued messages/);
  assert.equal(f.current(), f.source);
  assert.equal(f.newCalls(), 0);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.session.queuedMessageCount, 1);
});

test('keep-context implementation waits for native abort cleanup before selected model and reasoning dispatch', async () => {
  const f = fixture();
  await f.toggle(true);
  let release;
  const cleanup = new Promise(resolve => { release = resolve; });
  let stopping = false;
  f.session.abort = async () => {
    stopping = true;
    f.session.isStreaming = false;
    await cleanup;
    f.session.setThinkingLevel('medium');
  };
  f.session.isStreaming = true;
  await f.propose('Approve and run', 'smol: Fast (low)');
  assert.equal(stopping, true, 'the planner loop is interrupted before the proposal returns');
  await f.event('agent_end');
  assert.equal(f.implementations.length, 0, 'idle alone is not completion of native abort cleanup');
  release();
  await settle();
  assert.deepEqual(f.implementations, [{ model: 'fast', thinking: 'low', options: { synthetic: true } }]);
  assert.equal(f.thinking, 'low');
});

for (const choice of ['Approve and run', 'Approve and compact context', 'Discard'])
for (const change of ['lifecycle', 'session file']) test(`${choice} rejects a changed ${change} before touching the destination plan`, async () => {
  const f = fixture();
  let source = '/planning.jsonl';
  f.ctx.sessionManager.getSessionFile = () => source;
  await f.toggle(true);
  const changeSession = async () => {
    if (change === 'lifecycle') {
      f.setContext({ mode: 'none', models: {} });
      await f.event('session_tree');
      await f.toggle(true);
    } else {
      source = '/destination.jsonl';
    }
    return choice === 'Discard' ? choice : 'smol: Fast (low)';
  };
  const answers = choice === 'Discard' ? [changeSession] : [choice, changeSession];
  await assert.rejects(f.propose(...answers), /planning session changed/);
  assert.equal(f.session.getPlanModeState().enabled, true);
  assert.equal(f.session.model.id, 'planning');
  assert.equal(f.hasProposal, true);
  assert.ok(f.tools.includes('write'));
  await f.event('agent_end');
  assert.equal(f.compactCalls, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(f.implementations.length, 0);
});
