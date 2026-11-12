import test from 'node:test';
import assert from 'node:assert/strict';
import install from '../omp-pulse-child.ts';

const questions = [{ id: 'db', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }];
const originalAnswer = { content: [{ type: 'text', text: 'User selected: SQLite' }], details: { selectedOptions: ['SQLite'] } };

function fixture() {
  const commands = new Map();
  const entries = new Map([
    ['user', { id: 'user', type: 'message', parentId: null, message: { role: 'user', content: 'Choose storage' } }],
    ['call', { id: 'call', type: 'message', parentId: 'user', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'q', name: 'ask', arguments: { questions } }] } }],
    ['original', { id: 'original', type: 'message', parentId: 'call', message: { role: 'toolResult', toolName: 'ask', toolCallId: 'q', ...originalAnswer } }],
  ]);
  let leaf = 'original';
  let persistedLeaf = leaf;
  let resumes = 0;
  let summary;
  let idle = true;
  let nextAnswer = { content: [{ type: 'text', text: 'User selected: Postgres' }, { type: 'image', data: 'preserved', mimeType: 'image/png' }], details: { selectedOptions: ['Postgres'], note: 'Keep this native metadata' } };
  let answerDialog = async () => nextAnswer;
  let cancelTree;
  const ui = {
    setStatus() {},
    select: async () => answerDialog(),
    confirm(_title, _message, { signal }) {
      return new Promise((resolve) => {
        cancelTree = () => resolve(false);
        signal.addEventListener('abort', () => resolve(false), { once: true });
      });
    },
  };
  const manager = {
    getEntry: (id) => entries.get(id),
    getCwd: () => '/project',
    getSessionFile: () => '/session.jsonl',
    appendCustomEntry(type, data) {
      const id = `marker-${entries.size}`;
      entries.set(id, { id, type: 'custom', customType: type, parentId: leaf, data });
      leaf = id;
      return id;
    },
    async flush() { persistedLeaf = leaf; },
  };
  const session = {
    settings: {},
    abortBranchSummary() {},
    getPlanModeState: () => undefined,
    buildAskReanswerContext: (toolUI) => ({ ui: toolUI }),
    resumeAfterAskReanswer() {
      assert.equal(persistedLeaf, leaf, 'resume must not race persistence');
      resumes++;
    },
    async navigateTree(id, options) {
      const target = entries.get(id);
      if (target.message?.toolName === 'ask' && options.allowAskReopen && !options.reanswerAskResult) {
        return { cancelled: false, reopenAsk: { toolCallId: 'q', questions } };
      }
      if (options.summarize) {
        if (summary?.cancelled) return summary;
        summary = options.customInstructions ?? 'Native summary';
      }
      if (options.reanswerAskResult) {
        assert.equal(options.reanswerAskResult, nextAnswer, 'the exact native result, including images/details, must survive');
        entries.set('replacement', { id: 'replacement', type: 'message', parentId: target.parentId, message: { role: 'toolResult', toolName: 'ask', toolCallId: 'q', ...options.reanswerAskResult } });
        leaf = 'replacement';
        return { cancelled: false, askReanswerCommitted: true };
      }
      leaf = target.message?.role === 'user' ? target.parentId : id;
      return { cancelled: false, editorText: target.message?.role === 'user' ? target.message.content : undefined };
    },
  };
  class AskTool {
    async execute(_id, _args, signal, _update, context) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
        signal?.addEventListener('abort', cancel, { once: true });
        Promise.resolve(context.ui.select()).then(resolve, reject)
          .finally(() => signal?.removeEventListener('abort', cancel));
      });
    }
  }
  install({
    pi: {
      AgentRegistry: { global: () => ({ get: () => ({ session }) }) },
      AskTool,
      recoverAskQuestions: (args) => args.questions,
    },
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
  });
  return {
    entries, session,
    get leaf() { return leaf; },
    get persistedLeaf() { return persistedLeaf; },
    get resumes() { return resumes; },
    get summary() { return summary; },
    setSummary(value) { summary = value; },
    setAnswer(value) { nextAnswer = value; },
    setDialog(value) { answerDialog = value; },
    setIdle(value) { idle = value; },
    stopTree() { cancelTree(); },
    async request(args, name = 'pulse-goto') {
      let reply;
      const ctx = { agent: { id: 'Main' }, sessionManager: manager, isIdle: () => idle,
        ui: { ...ui, setStatus(_key, value) { reply = JSON.parse(value); } },
        navigateTree() { throw new Error('The lossy public wrapper must never navigate'); },
      };
      await commands.get(name).handler(`request ${JSON.stringify(args)}`, ctx);
      return reply;
    },
  };
}

test('a summarized move preserves native findings and persists its selected leaf before replying', async () => {
  const f = fixture();
  const result = await f.request({ entryId: 'user', summarize: true, customInstructions: 'Keep the benchmark findings' });
  assert.equal(result.cancelled, false);
  assert.equal(result.editorText, 'Choose storage');
  assert.equal(f.summary, 'Keep the benchmark findings');
  assert.equal(f.persistedLeaf, f.leaf);
  assert.equal(f.entries.get(f.leaf).parentId, null);
  assert.equal(f.entries.get(f.leaf).customType, 'omp-pulse-goto');
  assert.equal(f.entries.get('original').message.content[0].text, 'User selected: SQLite');
});

test('native cancellation and aborted summarization leave the original branch and journal untouched', async () => {
  for (const cancelled of [{ cancelled: true }, { cancelled: true, aborted: true }]) {
    const f = fixture();
    f.setSummary(cancelled);
    const result = await f.request({ entryId: 'user', summarize: true });
    assert.equal(result.cancelled, true);
    assert.equal(result.aborted, cancelled.aborted);
    assert.equal(f.leaf, 'original');
    assert.equal(f.entries.size, 3);
  }
});

test('re-answering keeps the original choice on its branch and resumes only after a durable sibling result', async () => {
  const f = fixture();
  const result = await f.request({ entryId: 'original', summarize: false });
  assert.equal(result.askReanswerCommitted, true);
  assert.equal(result.cancelled, false);
  assert.equal(f.entries.get('original').message.content[0].text, 'User selected: SQLite');
  assert.equal(f.entries.get('replacement').parentId, 'call');
  assert.equal(f.entries.get('replacement').message.content[1].type, 'image');
  assert.equal(f.entries.get(f.persistedLeaf).parentId, 'replacement');
  assert.equal(f.resumes, 1);
});

test('cancel, chat redirect, missing questions and missing native capability never mutate the branch', async () => {
  for (const setup of [
    (f) => f.setDialog(async () => { const error = new Error('cancelled'); error.name = 'ToolAbortError'; throw error; }),
    (f) => f.setAnswer({ content: [], details: { chatRedirect: true } }),
    (f) => f.entries.delete('call'),
    (f) => { delete f.session.buildAskReanswerContext; },
  ]) {
    const f = fixture();
    setup(f);
    const before = f.entries.size;
    const result = await f.request({ entryId: 'original', summarize: false });
    assert.ok(result.cancelled || result.ok === false);
    assert.equal(f.leaf, 'original');
    assert.equal(f.persistedLeaf, 'original');
    assert.equal(f.entries.size, before);
    assert.equal(f.resumes, 0);
  }
});

test('a second tree move is refused while the historical question waits, without blocking its answer', async () => {
  const f = fixture();
  let finish;
  let presented;
  const ready = new Promise((resolve) => { presented = resolve; });
  f.setDialog(() => new Promise((resolve) => { finish = resolve; presented(); }));
  const pending = f.request({ entryId: 'original', summarize: false });
  await ready;
  const duplicate = await f.request({ entryId: 'user', summarize: false });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /current tree move/);
  f.setIdle(false);
  finish({ content: [{ type: 'text', text: 'User selected: Postgres' }], details: {} });
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(f.leaf, 'original');
  assert.equal(f.resumes, 0);
});

test('Stop cancels a waiting historical answer without committing or resuming', async () => {
  const f = fixture();
  let presented;
  const ready = new Promise((resolve) => { presented = resolve; });
  f.setDialog(() => { presented(); return new Promise(() => {}); });
  const waiting = f.request({ entryId: 'original', summarize: false });
  await ready;
  f.stopTree();
  assert.equal((await waiting).cancelled, true);
  assert.equal(f.leaf, 'original');
  assert.equal(f.persistedLeaf, 'original');
  assert.equal(f.entries.size, 3);
  assert.equal(f.resumes, 0);
});

test('Stop uses native branch-summary abort rather than waiting for the summary to finish', async () => {
  const f = fixture();
  let cancelSummary;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  f.session.navigateTree = () => new Promise((resolve) => {
    cancelSummary = () => resolve({ cancelled: true, aborted: true });
    started();
  });
  f.session.abortBranchSummary = () => cancelSummary();
  const waiting = f.request({ entryId: 'user', summarize: true });
  await ready;
  f.stopTree();
  const result = await waiting;
  assert.equal(result.aborted, true);
  assert.equal(result.cancelled, true);
  assert.equal(f.entries.size, 3);
  assert.equal(f.leaf, 'original');
});
