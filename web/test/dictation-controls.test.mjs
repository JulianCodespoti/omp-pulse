import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

// The dictation takeover: a tap on the mic starts recording, and the bar that
// replaces the toolbar ends it three ways (Cancel, Insert, Insert and send).
// Real Composer and controls in a synthetic DOM; the dictation hook is a stub
// whose transcript callback the test drives, so no microphone or daemon.
const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { Composer } from ${JSON.stringify(resolve(root, "web/src/app/composer/Composer.tsx"))};
  import { seedDraft } from ${JSON.stringify(resolve(root, "web/src/app/composer/use-draft.ts"))};
  const calls = { start: 0, stop: 0, cancel: 0 };
  window.voice = { status: 'idle', options: null };
  let seq = 0, r = null;
  window.fixture = { act, calls, sends: [],
    mount({ text = '', status = 'idle', ...props } = {}) {
      window.voice.status = status;
      const path = '/synthetic/dictation-' + (++seq);
      if (text) seedDraft(path, text);
      r ??= createRoot(document.getElementById('root'));
      const render = () => r.render(h(Composer, { sessionPath: path, busy: false, onStop() {},
        onSend: (sent, _images, target, _saved, delivery) => { window.fixture.sends.push({ text: sent, target, delivery }); }, ...props }));
      render();
      return { path, setStatus(next) { window.voice.status = next; render(); } };
    },
    unmount() { r?.unmount(); r = null; },
  };
`, [{ name: "controlled-dictation", resolveId: (id, importer) =>
  importer?.endsWith("/Composer.tsx") && id === "./use-dictation" ? "\0dictation" : null,
  load: (id) => id === "\0dictation" ? `export const useDictation = (options) => {
    window.voice.options = options;
    const calls = window.fixture.calls;
    return { status: window.voice.status, reason: null, error: null, lastError: null, elapsedMs: 72000, remainingMs: 48000,
      canRecord: true, level: 0.5, silent: false, canRetry: false,
      start: async () => { calls.start++; }, stop: () => { calls.stop++; }, cancel: () => { calls.cancel++; }, toggle() {},
      retry: async () => {}, discardRetry() {} };
  };` : null,
}]);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  t.after(async () => { try { await f.act(async () => f.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const get = (s) => w.document.querySelector(s);
  const run = (fn) => f.act(async () => { await fn(); });
  const click = (s) => run(() => { const node = get(s); assert.ok(node, s); node.click(); });
  const transcribe = (words) => run(() => w.voice.options.onTranscribed(words));
  return { w, f, get, run, click, transcribe };
}

test("a tap on the mic starts dictation; there is no hold gesture", async (t) => {
  const ui = await fixture(t);
  await ui.run(() => ui.f.mount());
  await ui.click('[data-testid="voice-button"]');
  assert.equal(ui.f.calls.start, 1);
  assert.equal(ui.get('[data-testid="ptt-pill"]'), null);
});

test("recording replaces the toolbar with meter, time and the three ways out", async (t) => {
  const ui = await fixture(t);
  await ui.run(() => ui.f.mount({ status: "recording" }));
  assert.ok(ui.get('[data-testid="dictation-bar"]'));
  assert.equal(ui.get('[data-testid="composer-plus-btn"]'), null, "the toolbar steps aside");
  assert.equal(ui.get('[data-testid="voice-button"]'), null);
  assert.match(ui.get('[data-testid="dictation-status"]').textContent, /1:12/);
  assert.ok(ui.get('[data-testid="dictation-status"] [aria-hidden]').children.length > 4, "a scrolling waveform, not a four-bar meter");
  assert.ok(ui.get('[data-testid="dictation-insert"]'));
  assert.ok(ui.get('[data-testid="dictation-send"]'));
  await ui.click('[data-testid="dictation-cancel"]');
  assert.equal(ui.f.calls.cancel, 1);
});

test("transcribing keeps Cancel but offers no second Insert", async (t) => {
  const ui = await fixture(t);
  await ui.run(() => ui.f.mount({ status: "transcribing" }));
  assert.match(ui.get('[data-testid="dictation-status"]').textContent, /Transcribing/);
  assert.equal(ui.get('[data-testid="dictation-insert"]'), null);
  assert.ok(ui.get('[data-testid="dictation-cancel"]'));
});

test("Insert adds the words to the draft and sends nothing", async (t) => {
  const ui = await fixture(t);
  await ui.run(() => ui.f.mount({ status: "recording", text: "hello" }));
  await ui.click('[data-testid="dictation-insert"]');
  assert.equal(ui.f.calls.stop, 1);
  await ui.transcribe("world");
  assert.equal(ui.get('[data-testid="composer-input"]').value, "hello world");
  assert.equal(ui.f.sends.length, 0);
});

test("Insert and send sends the whole draft once, steering a running turn", async (t) => {
  const ui = await fixture(t);
  await ui.run(() => ui.f.mount({ status: "recording", text: "hello", busy: true }));
  await ui.click('[data-testid="dictation-send"]');
  await ui.transcribe("world");
  assert.deepEqual(JSON.parse(JSON.stringify(ui.f.sends)), [{ text: "hello world", target: ui.f.sends[0].target, delivery: "steer" }]);
});

test("words for a chat you left go back to that chat's draft, never sent elsewhere", async (t) => {
  const ui = await fixture(t);
  let first;
  await ui.run(() => { first = ui.f.mount({ status: "recording" }); });
  await ui.click('[data-testid="dictation-send"]');
  await ui.run(() => ui.f.mount({ status: "transcribing" }));
  await ui.transcribe("late words");
  assert.equal(ui.f.sends.length, 0);
  assert.equal(ui.get('[data-testid="composer-input"]').value, "");
  assert.equal(ui.w.localStorage.getItem(Object.keys(ui.w.localStorage).find((key) => key.endsWith(first.path))), "late words");
});
