import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
  import { createElement as h, act, useState } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { FileViewer } from ${JSON.stringify(resolve(root, 'web/src/app/tools/FileViewer.tsx'))};
  import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
  const reads = [], closed = [];
  DaemonApi.prototype.readFile = (...args) => new Promise((resolve, reject) => reads.push({ args, resolve, reject }));
  window.fixture = { act, reads, closed, mount() {
    const r = createRoot(document.getElementById('root'));
    let setView;
    function Host() {
      const [view, updateView] = useState({ open: true, path: 'src/a.txt', sessionPath: '/synthetic' });
      setView = updateView;
      return h(FileViewer, { ...view, onOpenChange: value => {
        closed.push(value);
        updateView(previous => ({ ...previous, open: value }));
      }});
    }
    const render = (open = true, path = 'src/a.txt', sessionPath = '/synthetic') => setView({ open, path, sessionPath });
    r.render(h(Host));
    return { render, unmount: () => r.unmount() };
  }};
`);

const baseline = 'original text\n';
const draft = '  未確定 café 👋\n\tsecond line  \n';
async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window;
  const { act, reads, closed } = w.fixture;
  const requests = [];
  w.fetch = (url, options) => {
    const method = options?.method ?? 'GET';
    assert.ok(method === 'GET' && url.startsWith('/api/file?') || method === 'POST' && url === '/api/file');
    return new Promise((resolve, reject) => requests.push({ url, options, method, resolve, reject }));
  };
  let r, unmounted = false;
  await act(async () => { r = w.fixture.mount(); });
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => r.unmount());
  };
  t.after(async () => {
    try { await unmount(); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const el = id => w.document.querySelector(`[data-testid="${id}"]`);
  const type = value => act(async () => {
    const input = el('file-editor');
    assert.ok(input, 'file editor is mounted');
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const key = async (key, options = {}) => {
    const e = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    await act(async () => el('file-editor').dispatchEvent(e));
    return e;
  };
  const read = (i, content = baseline) => act(async () => reads[i].resolve({
    content, size: content.length, binary: false, truncated: false,
  }));
  const response = (i, body = { ok: true, content: baseline }, status = 200) => act(async () => requests[i].resolve({
    ok: status >= 200 && status < 300, status, json: async () => body,
  }));
  await read(0);
  await act(async () => el('file-edit').click());
  await type(draft);
  return {
    w, act, reads, closed, requests, el, type, key, read, response, unmount,
    render: (...args) => act(async () => r.render(...args)),
    save: () => act(async () => el('file-save').click()),
    cancel: () => act(async () => w.document.querySelector('button[aria-label="Cancel edit"]').click()),
    posts: () => requests.filter(request => request.method === 'POST'),
  };
}

for (const [name, options] of [
  ['native composition', { isComposing: true }],
  ['legacy229 composition', { keyCode: 229 }],
]) {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    test(`${name}: ${modifier}+Enter preserves the draft and IME default`, async t => {
      const f = await fixture(t);
      const event = await f.key('Enter', { ...options, [modifier]: true });
      assert.equal(f.requests.length, 0);
      assert.equal(f.el('file-editor')?.value, draft);
      assert.equal(event.defaultPrevented, false);
      assert.deepEqual(Array.from(f.closed), []);
    });
  }
  test(`${name}: Escape preserves the editor and does not dismiss the sheet`, async t => {
    const f = await fixture(t);
    const event = await f.key('Escape', options);
    assert.equal(f.el('file-editor')?.value, draft);
    assert.equal(event.defaultPrevented, false);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(Array.from(f.closed), []);
  });
}

for (const modifier of ['ctrlKey', 'metaKey']) {
  test(`held ${modifier}+Enter cannot begin a save`, async t => {
    const f = await fixture(t);
    const event = await f.key('Enter', { [modifier]: true, repeat: true });
    assert.equal(f.requests.length, 0);
    assert.equal(f.el('file-editor')?.value, draft);
    assert.equal(event.defaultPrevented, true, 'a held save shortcut must not insert newlines');
  });
  test(`fresh ${modifier}+Enter saves the exact draft after suppressed keys`, async t => {
    const f = await fixture(t);
    await f.key('Enter', { [modifier]: true, isComposing: true });
    await f.key('Enter', { [modifier]: true, keyCode: 229 });
    await f.key('Enter', { [modifier]: true, repeat: true });
    assert.equal(f.requests.length, 0);
    const event = await f.key('Enter', { [modifier]: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.requests.length, 1);
    await f.response(0);
    assert.equal(f.posts().length, 1);
    const submitted = JSON.parse(f.posts()[0].options.body);
    assert.deepEqual(submitted, { sessionPath: '/synthetic', path: 'src/a.txt', content: draft, expectedContent: baseline });
    assert.deepEqual(Buffer.from(submitted.content), Buffer.from(draft));
    await f.response(1, { ok: true });
    assert.equal(f.el('file-editor') === null, true);
    assert.ok(f.w.document.body.textContent.includes('Saved'));
  });
}

test('held Escape cannot discard a draft or dismiss its sheet', async t => {
  const f = await fixture(t);
  await f.key('Escape', { repeat: true });
  assert.equal(f.el('file-editor')?.value, draft);
  assert.deepEqual(Array.from(f.closed), []);
});

test('fresh Escape dismisses after ignored IME/repeats and reopening restores the draft', async t => {
  const f = await fixture(t);
  await f.key('Escape', { isComposing: true });
  await f.key('Escape', { keyCode: 229 });
  await f.key('Escape', { repeat: true });
  assert.equal(f.el('file-editor')?.value, draft);
  const event = await f.key('Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.el('file-editor') === null, true);
  assert.equal(f.requests.length, 0);
  assert.ok(f.closed.includes(false), 'fresh Escape preserves the existing sheet dismissal');
  await f.render(true);
  await f.read(1);
  assert.equal(f.el('file-editor').value, draft);
});

test('ordinary and Shift+Enter, including repeats, keep multiline input defaults', async t => {
  const f = await fixture(t);
  for (const options of [{}, { shiftKey: true }, { repeat: true }, { shiftKey: true, repeat: true }]) {
    const event = await f.key('Enter', options);
    assert.equal(event.defaultPrevented, false);
  }
  await f.type(`${draft}\nnext line`);
  assert.equal(f.el('file-editor').value, `${draft}\nnext line`);
  assert.equal(f.requests.length, 0);
});

test('explicit Save and Cancel still work after ignored shortcut keys', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true, isComposing: true });
  await f.save();
  assert.equal(f.requests.length, 1);
  await f.response(0);
  assert.equal(JSON.parse(f.posts()[0].options.body).content, draft);
  await f.response(1, { ok: true });
  await f.act(async () => f.el('file-edit').click());
  await f.type('discard this');
  await f.key('Escape', { isComposing: true });
  await f.cancel();
  assert.equal(f.el('file-editor') === null, true);
  await f.act(async () => f.el('file-edit').click());
  assert.equal(f.el('file-editor').value, draft);
});

test('held save does not retry a failed request; a fresh shortcut can retry', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true });
  await f.response(0, {}, 401);
  assert.equal(f.el('file-editor').value, draft);
  assert.ok(f.w.document.body.textContent.includes('This phone is no longer paired. Pair it again.'));
  await f.key('Enter', { ctrlKey: true, repeat: true });
  assert.equal(f.requests.length, 1);
  await f.key('Enter', { ctrlKey: true });
  assert.equal(f.requests.length, 2);
  await f.response(1);
  await f.response(2, { ok: true });
  assert.equal(f.el('file-editor') === null, true);
});

test('held save does not save newer typing after an earlier snapshot succeeds', async t => {
  const f = await fixture(t);
  await f.key('Enter', { metaKey: true });
  await f.type(`${draft}newer text`);
  await f.response(0);
  assert.equal(JSON.parse(f.posts()[0].options.body).content, draft);
  await f.response(1, { ok: true });
  assert.equal(f.el('file-editor')?.value, `${draft}newer text`);
  await f.key('Enter', { metaKey: true, repeat: true });
  assert.equal(f.requests.length, 2);
  await f.key('Enter', { metaKey: true });
  await f.response(2, { ok: true, content: draft });
  assert.equal(JSON.parse(f.posts()[1].options.body).content, `${draft}newer text`);
  await f.response(3, { ok: true });
  assert.equal(f.el('file-editor') === null, true);
});

test('ignored Escape during preflight keeps the current save alive', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true });
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    await f.key('Escape', options);
    assert.equal(f.el('file-editor')?.value, draft);
    assert.deepEqual(Array.from(f.closed), []);
  }
  await f.response(0);
  assert.equal(f.posts().length, 1);
  await f.response(1, { ok: true });
  assert.equal(f.el('file-editor') === null, true);
});

test('fresh Escape during shortcut preflight still invalidates the pending write', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true });
  await f.key('Escape');
  await f.response(0);
  assert.equal(f.posts().length, 0);
});

test('shortcut saves preserve the on-disk conflict guard', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true });
  await f.response(0, { ok: true, content: 'changed elsewhere\n' });
  assert.equal(f.posts().length, 0);
  assert.equal(f.el('file-editor').value, draft);
  assert.ok(f.w.document.body.textContent.includes('changed on disk'));
});

test('repeated fresh shortcuts while pending still issue just one preflight and POST', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true });
  await f.key('Enter', { metaKey: true });
  assert.equal(f.requests.length, 1);
  await f.response(0);
  await f.key('Enter', { ctrlKey: true });
  assert.equal(f.posts().length, 1);
  await f.response(1, { ok: true });
});

test('switching file during shortcut preflight still prevents a stale write', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true });
  await f.render(true, 'src/b.txt');
  await f.read(1, 'B text');
  await f.response(0);
  assert.equal(f.posts().length, 0);
  assert.ok(f.w.document.body.textContent.includes('B text'));
});

test('unmount during shortcut preflight still prevents a stale write', async t => {
  const f = await fixture(t);
  await f.key('Enter', { ctrlKey: true });
  await f.unmount();
  await f.response(0);
  assert.equal(f.posts().length, 0);
});
