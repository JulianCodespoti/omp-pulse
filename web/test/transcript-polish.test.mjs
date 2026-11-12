import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { RunSummary } from ${JSON.stringify(resolve(root, "web/src/app/parts/RunSummary.tsx"))};
  import { transcriptGap, TURN_FOOTER_GAP } from ${JSON.stringify(resolve(root, "web/src/app/parts/spacing.ts"))};
  import { Message, MessageContent } from ${JSON.stringify(resolve(root, "web/src/components/ai-elements/message.tsx"))};
  window.fixture = { act, transcriptGap, TURN_FOOTER_GAP, mount: (props, bubble) => {
    const r = createRoot(document.getElementById('root'));
    r.render(bubble ? createElement(Message, { from: bubble }, createElement(MessageContent, {}, 'Synthetic message'))
      : createElement(RunSummary, { ...props, onOtherQuestion() {} })); return r;
  } };
`, [{ name: "presentation-boundaries", resolveId(id, importer) {
  if (importer?.endsWith("/RunSummary.tsx") && ["./ToolPart", "./ImagePart", "./QuickReplies"].includes(id)) return "\0" + id.slice(2);
  if (importer?.endsWith("/message.tsx") && id === "@/components/markdown") return "\0Markdown";
  return null;
}, load(id) {
  const react = `import {createElement as h} from ${JSON.stringify(require.resolve("react"))};`;
  if (id === "\0ToolPart") return react + `export const ToolPart = ({part,live,showImages}) => h('div',{'data-tool':part.callId,'data-live':String(live),'data-show-images':String(showImages)},part.name);`;
  if (id === "\0ImagePart") return react + `export const ImagePart = ({alt}) => h('span',{'data-image':true},alt);`;
  if (id === "\0QuickReplies") return react + `export const QuickReplies = ({question}) => h('div',{'data-question':true},question.question);`;
  if (id === "\0Markdown") return 'export const Markdown = () => null';
  return null;
} }]);

const tool = (name, state = 'ok', extras = {}) => ({ kind: 'tool', callId: name, name, args: {}, state, ...extras });
const message = parts => ({ id: 'm1', role: 'assistant', text: '', parts });
async function fixture(t, props = {}, bubble) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount({ messages: [message([tool('read'), tool('bash')])], toolsLive: false, ...props }, bubble); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  return { w, el: id => w.document.querySelector(`[data-testid="${id}"]`),
    toggle: () => act(async () => { w.document.querySelector('[data-testid="run-summary-toggle"]').click(); await Promise.resolve(); }) };
}

test('finished activity is one folded button that discloses its steps', async t => {
  const f = await fixture(t), button = f.el('run-summary-toggle');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.w.document.querySelector('[data-testid="run-step"]') === null, true);
});

test('a tap opens the steps in the transcript and a second tap folds them', async t => {
  const f = await fixture(t); await f.toggle();
  assert.equal(f.el('run-summary-toggle').getAttribute('aria-expanded'), 'true');
  const calls = [...f.el('run-steps-inline').querySelectorAll('[data-tool]')];
  assert.deepEqual(calls.map(call => call.textContent), ['read', 'bash']);
  assert.deepEqual(calls.map(call => call.dataset.live), ['false', 'false'], 'a finished run has nothing live');
  assert.equal(f.w.document.querySelector('[data-testid="tool-sheet"]'), null, 'no sheet: the run opens in place');
  await f.toggle();
  assert.equal(f.el('run-steps-inline'), null);
});

test('failed activity retains visible failure text and an alert instead of the kind icon', async t => {
  const f = await fixture(t, { messages: [message([tool('bash', 'error')])] });
  const toggle = f.el('run-summary-toggle');
  assert.match(toggle.textContent, /1 failed/);
  assert.match(toggle.getAttribute('aria-label'), /1 failed/);
  assert.equal(toggle.querySelector('.lucide-triangle-alert')?.classList.contains('text-danger'), true);
  assert.equal(Boolean(toggle.querySelector('.lucide-terminal')), false);
  assert.equal(Boolean(toggle.querySelector('.lucide-check')), false);
});

test('active work keeps its header row and the live tool identity', async t => {
  const f = await fixture(t, { toolsLive: true, liveMessageId: 'm1', messages: [message([tool('bash', 'running')])] });
  assert.ok(f.el('run-summary-toggle'), 'the header is there while live too');
  const row = f.el('run-summary').querySelector('[data-testid="run-step"] [data-tool]');
  assert.equal(row.dataset.live, 'true');
  // Photos are the run's, shown once below it; a row never repeats them.
  assert.equal(row.dataset.showImages, 'false');
});

test('photos remain outside the run rows and are not duplicated when the run opens', async t => {
  const f = await fixture(t, { messages: [message([tool('read', 'ok', { images: [{ src: '/synthetic/image', mimeType: 'image/png' }] })])] });
  assert.equal(f.w.document.querySelectorAll('[data-image]').length, 1);
  assert.equal(f.w.document.querySelectorAll('[data-testid="run-photo"]').length, 1);
  await f.toggle();
  assert.equal(f.w.document.querySelectorAll('[data-image]').length, 1);
  assert.equal(f.w.document.querySelectorAll('[data-testid="run-photo"]').length, 1);
  assert.equal(f.el('run-steps-inline').querySelector('[data-tool]').dataset.showImages, 'false', 'opened rows never repeat the photos');
});

test('an authoritative quick question stays reachable and replaces its own row in the live run', async t => {
  const pending = { id: 'ask1', total: 1, index: 0, question: 'Choose?', options: ['A', 'B'] };
  const ask = tool('ask', 'running', { callId: 'ask1', args: { questions: [{ question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }] } });
  const f = await fixture(t, { messages: [message([ask])], toolsLive: true, liveMessageId: 'm1', sessionPath: '/synthetic/session', pendingAsk: pending });
  assert.equal(f.w.document.querySelectorAll('[data-question]').length, 1);
  assert.equal(f.w.document.querySelector('[data-question]').textContent, 'Choose?');
  assert.equal(f.w.document.querySelectorAll('[data-tool]').length, 0);
});

test('the user bubble spends no accent colour', async t => {
  const f = await fixture(t, {}, 'user'), classes = f.w.document.querySelector('[data-message-box]').className.split(/\s+/);
  assert.equal(classes.some(cls => cls.includes('bg-primary') || cls.includes('text-primary-foreground')), false);
  assert.ok(f.w.document.querySelector('.is-user'), 'user messages are marked for the bubble styling');
});

test('transcript rhythm comes from one spacing matrix: tight within a turn, air before a new one', async t => {
  const f = await fixture(t), { transcriptGap, TURN_FOOTER_GAP } = f.w.fixture;
  const user = { kind: 'message', message: { role: 'user' } };
  const reply = { kind: 'message', message: { role: 'assistant' } };
  const run = { kind: 'run', key: 'r', messages: [] }, edits = { kind: 'edits', key: 'e', messages: [] };
  const day = { kind: 'day', key: 'd', label: 'Today' };
  assert.equal(transcriptGap(null, user), 0);
  assert.equal(transcriptGap(reply, user), 24, 'a new turn opens with air');
  assert.equal(transcriptGap(user, user), 4);
  assert.equal(transcriptGap(user, run), 16, 'the reply starts under its prompt');
  assert.equal(transcriptGap(run, edits), 0, 'activity of one turn sits flush');
  assert.equal(transcriptGap(run, reply), 8, 'prose and activity sit a little apart');
  assert.equal(transcriptGap(reply, reply), 12);
  assert.equal(transcriptGap(reply, day), 16);
  assert.equal(TURN_FOOTER_GAP, 4);
  const source = await readFile(resolve(root, 'web/src/app/ChatScreen.tsx'), 'utf8');
  assert.ok(source.includes('transcriptGap('), 'the chat lays its timeline out with the matrix');
  assert.equal(source.includes('group-[.is-user]:rounded-[22px]'), false);
});
