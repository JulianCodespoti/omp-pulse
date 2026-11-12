import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Real Composer + real useDictation + real DaemonApi. The microphone,
// MediaRecorder and the daemon's /api/transcribe are synthetic; no audio,
// device or network is involved.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { Composer } from ${JSON.stringify(resolve(root, 'web/src/app/composer/Composer.tsx'))};
  window.fixture = { act, mount() {
    const root = createRoot(document.getElementById('root'));
    const render = (sessionPath, keyed) => root.render(h(Composer, {
      key: keyed ? sessionPath : 'composer', sessionPath, busy: false,
      onSend() { throw new Error('No send in dictation test'); },
      onStop() { throw new Error('No stop in dictation test'); },
    }));
    return { root, render };
  }};
`);

const A = '/synthetic/chat-a';
const B = '/synthetic/chat-b';

function setup() {
  const dom = createDomFixture(code);
  const w = dom.window;
  const posts = [];
  Object.defineProperty(w, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(w.navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
  } });
  w.MediaRecorder = class {
    state = 'inactive'; mimeType = 'audio/webm';
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new w.Blob(['synthetic audio'], { type: 'audio/webm' }) });
        this.onstop?.(new w.Event('stop'));
      });
    }
  };
  w.Headers = globalThis.Headers;
  const reply = (body) => ({ status: 200, ok: true, json: async () => body });
  w.fetch = (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/transcribe/warm') return Promise.resolve(reply({ ok: true, ready: true }));
    if (path !== '/api/transcribe') throw new Error(`Unexpected request ${path}`);
    let settle, fail;
    const promise = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
    init.signal?.addEventListener('abort', () => fail(init.signal.reason));
    const post = { body: String(init.body), signal: init.signal,
      answer: (text) => settle(reply({ ok: true, text })),
      refuse: () => fail(new w.TypeError('Failed to fetch')) };
    posts.push(post);
    return promise;
  };
  const { act } = w.fixture;
  const flush = () => act(async () => { await new Promise((r) => w.setTimeout(r, 0)); });
  const until = async (condition, what) => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await flush(); }
    assert.fail(`timed out waiting for ${what}`);
  };
  const q = (selector) => w.document.querySelector(selector);
  const click = (target) => act(async () => {
    (typeof target === 'string' ? q(target) : target).dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 0 }));
  });
  // The notice's action is a text button.
  const retryButton = () => [...w.document.querySelectorAll('[data-testid="dictation-error"] button')]
    .find((b) => b.textContent === 'Retry') ?? null;
  const storedDraft = (path) => {
    for (let i = 0; i < w.localStorage.length; i++) {
      const key = w.localStorage.key(i);
      if (key.startsWith('omp-draft:') && key.endsWith(`:${path}`)) return w.localStorage.getItem(key);
    }
    return '';
  };
  const editorText = () => q('textarea[name="message"]')?.value ?? '';
  // Tap the mic, tap Insert on the recording bar, wait for the POST.
  const dictate = async () => {
    const before = posts.length;
    await click('[data-testid="voice-button"]');
    await until(() => q('[data-testid="dictation-insert"]') !== null, 'recording');
    await click('[data-testid="dictation-insert"]');
    await until(() => posts.length > before, 'the transcribe POST');
  };
  return { dom, w, act, posts, flush, until, q, click, retryButton, storedDraft, editorText, dictate };
}

test('the X stays while transcribing; cancelling aborts, ignores the late text, and Retry re-posts the recording', async () => {
  const t = setup();
  let mounted;
  try {
    await t.act(async () => { mounted = t.w.fixture.mount(); mounted.render(A, true); });
    await t.dictate();
    assert.equal(t.q('[data-testid="dictation-status"]')?.textContent.includes('Transcribing'), true);
    assert.equal(t.q('[data-testid="dictation-cancel"]')?.getAttribute('aria-label'), 'Cancel transcription');
    await t.click('[data-testid="dictation-cancel"]');
    assert.equal(t.posts[0].signal.aborted, true);
    assert.equal(t.q('[data-testid="dictation-status"]') === null, true);
    t.posts[0].answer('late words'); await t.flush();
    assert.equal(t.editorText(), '');
    assert.equal(t.q('[data-testid="dictation-error"]')?.textContent.includes('Transcription cancelled.'), true);
    await t.click(t.retryButton());
    await t.until(() => t.posts.length === 2, 'the retried POST');
    assert.equal(t.posts[1].body, t.posts[0].body);
    t.posts[1].answer('kept words');
    await t.until(() => t.editorText() === 'kept words', 'the retried transcript');
    assert.equal(t.q('[data-testid="dictation-error"]') === null, true);
    assert.deepEqual(t.dom.blocked, []);
  } finally {
    if (mounted) await t.act(async () => mounted.root.unmount());
    t.dom.close();
  }
});

test('a failed transcription offers Retry with the same recording; dismissing forgets it', async () => {
  const t = setup();
  let mounted;
  try {
    await t.act(async () => { mounted = t.w.fixture.mount(); mounted.render(A, true); });
    await t.dictate();
    t.posts[0].refuse();
    await t.until(() => t.q('[data-testid="dictation-error"]') !== null, 'the failure notice');
    await t.click(t.retryButton());
    await t.until(() => t.posts.length === 2, 'the retried POST');
    assert.equal(t.posts[1].body, t.posts[0].body);
    t.posts[1].refuse();
    await t.until(() => t.retryButton() !== null, 'Retry again');
    await t.click('[data-testid="dictation-error"] button[aria-label="Dismiss"]');
    assert.equal(t.q('[data-testid="dictation-error"]') === null, true);
    assert.equal(t.posts.length, 2);
  } finally {
    if (mounted) await t.act(async () => mounted.root.unmount());
    t.dom.close();
  }
});

test('leaving the chat drops its kept recording and failure notice', async () => {
  const t = setup();
  let mounted;
  try {
    await t.act(async () => { mounted = t.w.fixture.mount(); mounted.render(A, false); });
    await t.dictate();
    t.posts[0].refuse();
    await t.until(() => t.q('[data-testid="dictation-error"]') !== null, 'the failure notice');
    await t.act(async () => mounted.render(B, false));
    assert.equal(t.q('[data-testid="dictation-error"]') === null, true);
  } finally {
    if (mounted) await t.act(async () => mounted.root.unmount());
    t.dom.close();
  }
});

for (const keyed of [true, false]) {
  test(`a transcript started in chat A lands in A's draft, never B's (${keyed ? 'remount' : 'same composer'})`, async () => {
    const t = setup();
    let mounted;
    try {
      await t.act(async () => { mounted = t.w.fixture.mount(); mounted.render(A, keyed); });
      await t.dictate();
      await t.act(async () => mounted.render(B, keyed));
      t.posts[0].answer('words from a');
      await t.until(() => t.storedDraft(A) === 'words from a', "A's saved draft");
      assert.equal(t.editorText(), '');
      assert.equal(t.storedDraft(B), '');
    } finally {
      if (mounted) await t.act(async () => mounted.root.unmount());
      t.dom.close();
    }
  });
}

test('returning to chat A before the transcript arrives puts it in A\'s editor', async () => {
  const t = setup();
  let mounted;
  try {
    await t.act(async () => { mounted = t.w.fixture.mount(); mounted.render(A, true); });
    await t.dictate();
    await t.act(async () => mounted.render(B, true));
    await t.act(async () => mounted.render(A, true));
    t.posts[0].answer('words from a');
    await t.until(() => t.editorText() === 'words from a', "A's editor");
    await t.act(async () => mounted.render(B, true));
    assert.equal(t.editorText(), '');
  } finally {
    if (mounted) await t.act(async () => mounted.root.unmount());
    t.dom.close();
  }
});
