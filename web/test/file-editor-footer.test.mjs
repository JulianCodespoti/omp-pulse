import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Real FileViewer, sheet, textarea and copy control. This proves composition and
// interaction only; actual browser screenshots must establish visible geometry.
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { FileViewer } from ${JSON.stringify(resolve(root, 'web/src/app/tools/FileViewer.tsx'))};
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
const reads = [], closes = [];
DaemonApi.prototype.readFile = (...args) => new Promise((resolve, reject) => reads.push({ args, resolve, reject }));
window.fixture = { act, reads, closes, mount() {
  const r = createRoot(document.getElementById('root'));
  const render = (open = true, path = 'src/long-file.txt', sessionPath = '/synthetic') =>
    r.render(h(FileViewer, { open, path, sessionPath, onOpenChange: value => closes.push(value) }));
  render();
  return { render, unmount: () => r.unmount() };
} };
`);
const longText = Array.from({ length: 150 }, (_, i) => `${i}:  café 👋 ${'x'.repeat(140)}\n`).join('');

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, { act, reads, closes } = w.fixture;
  const requests = [];
  w.fetch = (url, options) => {
    assert.ok(String(url).startsWith('/api/file?') || url === '/api/file');
    return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  };
  let view;
  await act(async () => { view = w.fixture.mount(); });
  t.after(async () => {
    try { await act(async () => view.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const el = id => w.document.querySelector(`[data-testid="${id}"]`);
  const cancel = () => w.document.querySelector('button[aria-label="Cancel edit"]');
  const body = () => w.document.querySelector('[data-slot="scroll-area-viewport"]');
  const assertFooter = () => {
    const save = el('file-save'), cancelButton = cancel();
    assert.ok(save && cancelButton, 'both edit controls are mounted');
    assert.equal(w.document.querySelectorAll('[data-testid="file-save"]').length, 1);
    assert.equal(w.document.querySelectorAll('button[aria-label="Cancel edit"]').length, 1);
    assert.equal(body().contains(save), false, 'Save is outside the scrolling body');
    assert.equal(body().contains(cancelButton), false, 'Cancel is outside the scrolling body');
    assert.ok(body().contains(el('file-editor')), 'text remains in the scroll body');
  };
  const noFooter = () => { assert.equal(el('file-save') === null, true); assert.equal(cancel() === null, true); };
  const read = (i = 0, overrides = {}) => act(async () => reads[i].resolve({
    content: longText, size: longText.length, binary: false, truncated: false, ...overrides,
  }));
  const type = text => act(async () => {
    const input = el('file-editor');
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const response = (i, content = { ok: true, content: longText }) => act(async () => requests[i].resolve({
    ok: true, status: 200, json: async () => content,
  }));
  const edit = () => act(async () => el('file-edit').click());
  return { w, act, reads, closes, requests, el, body, assertFooter, noFooter, read, type, response, edit,
    render: (...args) => act(async () => view.render(...args)),
    save: () => act(async () => el('file-save').click()),
    cancel: () => act(async () => cancel().click()), cancelButton: cancel };
}

for (const content of [longText, 'short text']) test(`${content === longText ? 'long' : 'short'} file uses the existing non-scrolling footer`, async t => {
  const f = await fixture(t);
  f.noFooter();
  await f.read(0, { content });
  f.noFooter();
  await f.edit();
  f.assertFooter();
  assert.equal(f.el('file-editor').value, content);
  await f.cancel();
  f.noFooter();
  await f.edit();
  f.assertFooter();
  assert.equal(f.el('file-editor').value, content);
});

test('pending save disables footer controls and acknowledged save removes them', async t => {
  const f = await fixture(t); await f.read(); await f.edit(); await f.type('submitted'); await f.save();
  f.assertFooter();
  assert.equal(f.el('file-save').disabled, true); assert.equal(f.cancelButton().disabled, true);
  assert.equal(f.el('file-save').getAttribute('aria-label'), 'Saving file');
  await f.cancel(); assert.equal(f.el('file-editor').value, 'submitted');
  await f.response(0); await f.response(1, { ok: true });
  f.noFooter(); assert.equal(f.el('file-editor') === null, true);
});

test('newer typing retains the footer and Cancel restores the acknowledged snapshot', async t => {
  const f = await fixture(t); await f.read(); await f.edit(); await f.type('submitted'); await f.save();
  await f.type('newer typing'); await f.response(0); await f.response(1, { ok: true });
  f.assertFooter(); assert.equal(f.el('file-editor').value, 'newer typing');
  assert.equal(f.el('file-save').disabled, false); assert.equal(f.cancelButton().disabled, false);
  await f.cancel(); f.noFooter(); await f.edit(); assert.equal(f.el('file-editor').value, 'submitted');
});

test('conflict warning and Reload remain scrollable while edit controls stay in the footer', async t => {
  const f = await fixture(t); await f.read(); await f.edit(); await f.type('draft'); await f.save();
  await f.response(0, { ok: true, content: 'changed on disk' });
  f.assertFooter(); assert.equal(f.el('file-editor').value, 'draft');
  assert.ok(f.body().querySelector('[role="alert"]')?.textContent.includes('changed on disk'));
  const reload = f.body().querySelector('button[aria-label="Discard draft and reload"]'); assert.ok(reload);
  await f.act(async () => reload.click()); f.noFooter();
});

test('unconfirmed save retains current text, uncertainty and the same footer actions', async t => {
  const f = await fixture(t); await f.read(); await f.edit(); await f.type('submitted'); await f.save();
  await f.response(0); await f.type('newer text'); await f.response(1, {});
  f.assertFooter(); assert.equal(f.el('file-editor').value, 'newer text');
  assert.ok(f.body().querySelector('[role="alert"]')?.textContent.includes('may have been saved'));
  assert.equal(f.el('file-save').disabled, false); assert.equal(f.requests.length, 2);
});

test('navigation, loading, closed and failed reads cannot retain the edit footer', async t => {
  const f = await fixture(t); await f.read(); await f.edit(); f.assertFooter();
  await f.render(true, 'src/next.txt'); f.noFooter();
  await f.act(async () => f.reads[1].reject(Error('synthetic read failure'))); f.noFooter();
  await f.render(true, 'src/long-file.txt', '/other-session'); f.noFooter(); await f.read(2); await f.edit(); f.assertFooter();
  await f.render(false); f.noFooter();
});

for (const flag of ['binary', 'truncated']) test(`${flag} files do not expose editing or footer actions`, async t => {
  const f = await fixture(t); await f.read(0, { [flag]: true }); f.noFooter();
  assert.equal(f.el('file-edit') === null, true); assert.equal(f.el('file-editor') === null, true);
});

for (const scrollTop of [0, 180]) test(`editor touch-scroll ownership at synthetic scrollTop ${scrollTop}`, async t => {
  const f = await fixture(t); await f.read(); await f.edit();
  const input = f.el('file-editor');
  // Event ownership only: manually assigned scroll offsets are not evidence
  // that JSDOM rendered any dimensions or that native touch acceptance passed.
  input.scrollTop = scrollTop; f.body().scrollTop = 0;
  const touch = async (target, name, y) => {
    const event = new f.w.Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: name === 'touchend' ? [] : [{ clientY: y }] });
    await f.act(async () => target.dispatchEvent(event));
    return event;
  };
  for (const [name, y] of [['touchstart', 200], ['touchmove', 245], ['touchmove', 310], ['touchend', 310]]) {
    const event = await touch(input, name, y);
    assert.equal(event.defaultPrevented, false, 'native text scrolling remains available');
  }
  assert.deepEqual(Array.from(f.closes), [], 'editor gestures cannot request sheet dismissal');
  assert.equal(input.value, longText); assert.equal(f.requests.length, 0); f.assertFooter();
  // The local boundary must not disable the existing header dismissal gesture.
  const title = f.el('sheet-title-text');
  for (const [name, y] of [['touchstart', 200], ['touchmove', 280], ['touchmove', 350], ['touchend', 350]]) {
    await touch(title, name, y);
  }
  assert.deepEqual(Array.from(f.closes), [false], 'the shared header still owns its drag gesture');
});
