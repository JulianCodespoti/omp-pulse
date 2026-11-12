import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';
import { root } from './support/react-dom.mjs';

// The real store and reducer; only the omp frames are synthetic (omp 18.8.6
// wire/events.ts and wire/frames.ts shapes). No DOM: nothing here renders.
const build = await rolldown({
  input: 'state-events-fixture', platform: 'browser',
  resolve: { alias: { '@': resolve(root, 'web/src') } },
  plugins: [{ name: 'fixture-entry',
    resolveId: (id) => id === 'state-events-fixture' ? '\0state-events-fixture' : null,
    load: (id) => id === '\0state-events-fixture' ? `
      export { createOmpStore } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
      export { reduceStateEvent } from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-state-events.ts'))};
    ` : null,
  }],
});
const { output } = await build.generate({ format: 'esm', codeSplitting: false });
await build.close();
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { createOmpStore, reduceStateEvent } = await import(`data:text/javascript,${encodeURIComponent(output[0].code)}`);

const PATH = '/s.jsonl';
function open() {
  const store = createOmpStore();
  store.getState().beginSession(PATH);
  return store;
}

test('config_update from a slash command replaces the header model and level', () => {
  const store = open();
  store.getState().setSessionModel({ model: 'claude-opus-5-5', provider: 'anthropic', thinkingLevel: 'low', contextWindow: 200000, ctxPercent: 40 });
  const follow = reduceStateEvent(store.getState(), PATH, {
    type: 'config_update',
    model: { id: 'gpt-6', name: 'GPT 6', provider: 'openai', contextWindow: 400000 },
    thinkingLevel: 'high',
  });
  assert.equal(follow.notice, undefined);
  const model = store.getState().sessionModel;
  assert.equal(model.model, 'gpt-6');
  assert.equal(model.provider, 'openai');
  assert.equal(model.thinkingLevel, 'high');
  assert.equal(model.contextWindow, 400000);
  // The old model's fill no longer describes this conversation.
  assert.equal(model.ctxPercent, undefined);
});

test('thinking updates keep Auto separate from the current effort', () => {
  const store = open();
  store.getState().setSessionModel({ model: 'claude-opus-5-5', thinkingLevel: 'low' });
  reduceStateEvent(store.getState(), PATH, { type: 'thinking_level_changed', thinkingLevel: 'medium', configured: 'auto' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'auto');
  assert.equal(store.getState().sessionModel.effectiveThinkingLevel, 'medium');
  assert.equal(store.getState().sessionModel.model, 'claude-opus-5-5');
  assert.equal(reduceStateEvent(store.getState(), PATH, { type: 'model_changed' }).refreshModel, true);
  reduceStateEvent(store.getState(), PATH, { type: 'config_update', model: { id: 'gpt-6', provider: 'openai' }, thinkingLevel: 'low' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'auto');
  assert.equal(store.getState().sessionModel.effectiveThinkingLevel, 'low');
  reduceStateEvent(store.getState(), PATH, { type: 'thinking_level_changed', thinkingLevel: 'low' });
  assert.equal(store.getState().sessionModel.thinkingLevel, 'low', 'pinning the same concrete effort leaves Auto');
});

test('session_info_update renames the open row and only that row', () => {
  const store = open();
  store.getState().setSessions([{ path: PATH, title: 'old' }, { path: '/other.jsonl', title: 'keep' }]);
  reduceStateEvent(store.getState(), PATH, { type: 'session_info_update', title: ' Fix the lock ', sessionId: 'x' });
  assert.equal(store.getState().sessions.find((row) => row.path === PATH).title, 'Fix the lock');
  assert.equal(store.getState().sessions.find((row) => row.path === '/other.jsonl').title, 'keep');
  const before = store.getState().sessions;
  reduceStateEvent(store.getState(), PATH, { type: 'session_info_update', sessionId: 'x' });
  assert.equal(store.getState().sessions === before, true);
});

test('auto-compaction shows while it runs and says how it ended', () => {
  const store = open();
  reduceStateEvent(store.getState(), PATH, { type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' });
  assert.equal(store.getState().compacting?.reason, 'threshold');
  const done = reduceStateEvent(store.getState(), PATH, { type: 'auto_compaction_end', action: 'context-full', aborted: false, willRetry: false, result: {} });
  assert.equal(store.getState().compacting, null);
  assert.equal(done.notice.tone, 'info');
  assert.equal(done.notice.message, 'Conversation compacted');
  reduceStateEvent(store.getState(), PATH, { type: 'auto_compaction_start', reason: 'overflow', action: 'context-full' });
  const failed = reduceStateEvent(store.getState(), PATH, { type: 'auto_compaction_end', action: 'context-full', aborted: false, willRetry: false, errorMessage: 'provider refused' });
  assert.equal(failed.notice.tone, 'error');
  assert.equal(failed.notice.message.includes('provider refused'), true);
  for (const quiet of [{ skipped: true }, { aborted: true }, { willRetry: true, errorMessage: 'x' }]) {
    const follow = reduceStateEvent(store.getState(), PATH, { type: 'auto_compaction_end', action: 'context-full', aborted: false, willRetry: false, ...quiet });
    assert.equal(follow.notice, undefined);
  }
  const bare = reduceStateEvent(store.getState(), PATH, { type: 'auto_compaction_end', aborted: false, willRetry: false });
  assert.equal(bare.notice, undefined, 'an end with no result is not a success');
});

test('notice keeps omp severity and the pushed catalogue is stored', () => {
  const store = open();
  const tone = (level) => reduceStateEvent(store.getState(), PATH, { type: 'notice', level, message: 'history could not be saved' }).notice.tone;
  assert.equal(tone('error'), 'error');
  assert.equal(tone('warning'), 'warn');
  assert.equal(tone('info'), 'info');
  assert.equal(reduceStateEvent(store.getState(), PATH, { type: 'notice', level: 'info', message: '  ' }).notice, undefined);
  reduceStateEvent(store.getState(), PATH, { type: 'available_commands_update', commands: [{ name: 'model', source: 'builtin' }] });
  assert.equal(store.getState().availableCommands.length, 1);
  assert.equal(reduceStateEvent(store.getState(), PATH, { type: 'goal_updated' }), null);
});

test("omp's own bookkeeping notices never reach a toast; user-facing ones do", () => {
  const store = open();
  const notice = (event) => reduceStateEvent(store.getState(), PATH, { type: 'notice', ...event }).notice;
  assert.equal(notice({ level: 'info', message: 'xd://: mounted mcp__phone_act, mcp__phone_apps', source: 'xdev' }), undefined);
  assert.equal(notice({ level: 'info', message: 'xd://: unmounted mcp__mre_class' }), undefined);
  assert.equal(notice({ level: 'info', message: 'Prewalk: disarmed', source: 'prewalk' }), undefined);
  assert.equal(notice({ level: 'info', message: 'Ana joined the collab session', source: 'collab' }).message, 'Ana joined the collab session');
  assert.equal(notice({ level: 'warning', message: 'snapcompact would not reduce context.', source: 'compaction' }).tone, 'warn');
});
