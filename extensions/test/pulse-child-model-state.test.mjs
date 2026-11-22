import assert from 'node:assert/strict';
import test from 'node:test';
import install from '../omp-pulse-child.ts';

function fixture(sessionMethods = {}) {
  const handlers = new Map();
  const receipts = [];
  const entries = [];
  let branch = entries;
  let configured = 'auto';
  const session = { configuredThinkingLevel: () => configured, ...sessionMethods };
  install({
    pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } },
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    appendEntry(customType, data) { entries.push({ type: 'custom', id: `entry-${entries.length}`, timestamp: '2026-10-25T10:00:01Z', customType, data: structuredClone(data) }); },
  });
  const ctx = {
    agent: { id: 'Main', kind: 'main' },
    ui: {
      setStatus(key, text) { receipts.push({ key, data: JSON.parse(text) }); },
      notify(message) { throw new Error(message); },
    },
    sessionManager: { buildSessionContext: () => ({ mode: 'default' }), getBranch: () => branch },
  };
  return {
    receipts, entries,
    setConfigured(value) { configured = value; },
    setBranch(value) { branch = value; },
    event(name, event = {}) { return handlers.get(name)(event, ctx); },
  };
}

test('cold start and navigation publish the actual configured selector, not effective effort', async () => {
  const f = fixture();
  await f.event('session_start');
  assert.deepEqual(f.receipts, [{ key: 'omp-pulse-thinking', data: { configuredThinkingLevel: 'auto', modelFallback: null } }]);
  f.setConfigured('high');
  await f.event('session_switch');
  assert.deepEqual(f.receipts.at(-1), { key: 'omp-pulse-thinking', data: { configuredThinkingLevel: 'high', modelFallback: null } });
  f.setConfigured(undefined);
  await f.event('session_tree');
  assert.deepEqual(f.receipts.at(-1), { key: 'omp-pulse-thinking', data: { configuredThinkingLevel: '', modelFallback: null } });
});

test('resume publishes the restored selector, not the one active while omp awaits the hook', async () => {
  const switched = Promise.withResolvers();
  const f = fixture({ waitForSessionTransition: () => switched.promise });
  f.setConfigured('medium');
  await f.event('session_switch');
  assert.deepEqual(f.receipts, []);
  f.setConfigured('high');
  switched.resolve();
  await switched.promise;
  assert.equal(f.receipts.at(-1)?.data.configuredThinkingLevel, 'high');
});

test('a superseded resume cannot publish after the next session takes over', async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const transitions = [first, second];
  const f = fixture({ waitForSessionTransition: () => transitions.shift().promise });
  await f.event('session_switch');
  await f.event('session_switch');
  second.resolve();
  await second.promise;
  f.setConfigured('medium');
  first.resolve();
  await first.promise;
  assert.deepEqual(f.receipts.map(r => r.data.configuredThinkingLevel), ['auto']);
});

test('child owner journals the native fallback reason without inventing restoration', async () => {
  const f = fixture();
  const event = { type: 'retry_fallback_applied', from: 'openai/primary', to: 'anthropic/fallback', role: 'default', reason: 'provider capacity exhausted' };
  await f.event('retry_fallback_applied', event);
  assert.deepEqual(f.entries, [{ type: 'custom', id: 'entry-0', timestamp: '2026-10-25T10:00:01Z', customType: 'omp-pulse-model-fallback', data: event }]);
  const durable = { ...event, entryId: 'entry-0', at: 1_792_922_401_000 };
  assert.deepEqual(f.receipts.at(-1).data.modelFallback, durable);
  f.setBranch([]);
  await f.event('session_switch');
  assert.equal(f.receipts.at(-1).data.modelFallback, null);
  f.setBranch(f.entries);
  await f.event('session_tree');
  assert.deepEqual(f.receipts.at(-1).data.modelFallback, durable, 'returning to the fallback branch restores its exact receipt');
});
