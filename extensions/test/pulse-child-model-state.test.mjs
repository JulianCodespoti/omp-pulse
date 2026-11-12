import assert from 'node:assert/strict';
import test from 'node:test';
import install from '../omp-pulse-child.ts';

function fixture() {
  const handlers = new Map();
  const receipts = [];
  const entries = [];
  let branch = entries;
  let configured = 'auto';
  const session = { configuredThinkingLevel: () => configured };
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
