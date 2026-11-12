import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Exercise the real viewer and request path. Only the file API is synthetic;
// rendered labels here are behavioral evidence, not browser/layout acceptance.
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { FileViewer } from ${JSON.stringify(resolve(root, 'web/src/app/tools/FileViewer.tsx'))};
window.fixture = { act, mount() {
  const r = createRoot(document.getElementById('root'));
  const render = (open = true, path = 'a.txt', sessionPath = '/synthetic/session.jsonl') =>
    r.render(h(FileViewer, { open, path, sessionPath, onOpenChange() {} }));
  render();
  return { render, unmount: () => r.unmount() };
} };
`);
const baseline = 'baseline';

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture, requests = [];
  w.fetch = (url, options) => {
    assert.ok(String(url).startsWith('/api/file?') || url === '/api/file', 'only synthetic file endpoints');
    return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject, method: options?.method ?? 'GET' }));
  };
  let r;
  await act(async () => { r = w.fixture.mount(); });
  t.after(async () => {
    try { await act(async () => r.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const el = id => w.document.querySelector(`[data-testid="${id}"]`);
  // Size heads the sheet description ('8 B · Text'); edit mode adds no meta.
  const description = () => w.document.querySelector('[data-testid="sheet-description"]')?.textContent ?? '';
  const saved = () => [...w.document.querySelectorAll('[role="status"]')].some(e => e.textContent === 'Saved');
  const fileBody = content => ({ ok: true, path: 'a.txt', name: 'a.txt', content, binary: false, truncated: false, size: Buffer.byteLength(content), mtime: 1 });
  const response = (i, body, status = 200) => act(async () => requests[i].resolve({ ok: status >= 200 && status < 300, status, json: async () => body }));
  const stallBody = async i => {
    let complete;
    await act(async () => requests[i].resolve({ ok: true, status: 200, json: () => new Promise(resolve => { complete = resolve; }) }));
    return body => act(async () => complete(body));
  };
  const type = value => act(async () => {
    const input = el('file-editor');
    assert.ok(input);
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const edit = () => act(async () => {
    if (el('file-edit')) el('file-edit').click();
    else assert.ok(el('file-editor'), 'restored editor');
  });
  const save = () => act(async () => el('file-save').click());
  const escape = () => act(async () => el('file-editor').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const cancel = () => act(async () => w.document.querySelector('button[aria-label="Cancel edit"]').click());
  const posts = () => requests.filter(r => r.method === 'POST');
  const expectSize = expected => assert.equal(description().split(' · ')[0], expected);
  await response(0, fileBody(baseline));
  return { w, act, requests, el, saved, fileBody, response, stallBody, type, edit, save, escape, cancel, posts, expectSize,
    render: (...args) => act(async () => r.render(...args)) };
}

for (const [name, submitted, expected] of [
  ['ASCII', 'plain text\n', '11 B'],
  ['accented and CJK text', 'café 漢字', '12 B'],
  ['emoji', '🧭👋', '8 B'],
  ['combining marks', 'e\u0301', '3 B'],
  ['empty text', '', '0 B'],
  ['UTF-8 KB boundary', 'é'.repeat(512), '1.0 KB'],
  ['observed 22,867-byte save', 'a'.repeat(19867) + 'é'.repeat(1500), '22.3 KB'],
]) {
  test(`${name}: acknowledged byte metadata agrees with reopening`, async t => {
    const f = await fixture(t);
    await f.edit(); await f.type(submitted); await f.save();
    f.expectSize('8 B');
    await f.response(1, f.fileBody(baseline));
    assert.equal(JSON.parse(f.posts()[0].options.body).content, submitted);
    f.expectSize('8 B');
    await f.response(2, { ok: true });
    assert.equal(f.el('file-editor') === null, true);
    assert.ok(f.saved());
    f.expectSize(expected);
    assert.equal(f.requests.length, 3, 'byte metadata adds no request');
    await f.render(false); await f.render(true);
    await f.response(3, f.fileBody(submitted));
    f.expectSize(expected);
    await f.edit();
    assert.equal(f.el('file-editor').value, submitted);
  });
}

for (const stage of ['preflight headers', 'preflight body', 'POST headers', 'POST body']) {
  test(`${stage}: metadata uses the captured submission while newer draft chars stay local`, async t => {
    const f = await fixture(t), submitted = 'café 🧭', newer = submitted + ' 漢字 newer';
    await f.edit(); await f.type(submitted); await f.save();
    let complete;
    if (stage.startsWith('POST')) {
      await f.response(1, f.fileBody(baseline));
      complete = stage.endsWith('body') ? await f.stallBody(2) : body => f.response(2, body);
    } else complete = stage.endsWith('body') ? await f.stallBody(1) : body => f.response(1, body);
    await f.type(newer);
    f.expectSize('8 B');
    assert.equal(f.el('file-editor').value, newer);
    if (stage.startsWith('preflight')) {
      await complete(f.fileBody(baseline));
      complete = body => f.response(2, body);
    }
    assert.equal(f.posts().length, 1);
    assert.equal(JSON.parse(f.posts()[0].options.body).content, submitted);
    f.expectSize('8 B');
    await complete({ ok: true });
    f.expectSize('10 B');
    assert.equal(f.el('file-editor').value, newer);
    assert.equal(f.saved(), false);
    assert.equal(f.el('file-save').disabled, false);
    // Accepting the first snapshot also advances the baseline, but not the draft.
    await f.save(); await f.response(3, f.fileBody(submitted));
    assert.equal(JSON.parse(f.posts()[1].options.body).content, newer);
    await f.response(4, { ok: true });
    f.expectSize(`${Buffer.byteLength(newer)} B`);
  });
}

for (const outcome of ['preflight conflict', 'preflight failure', 'refusal', 'missing acknowledgement', 'transport failure', 'body failure']) {
  test(`${outcome}: no saved byte metadata or content is promoted`, async t => {
    const f = await fixture(t), submitted = 'different café 🧭';
    await f.edit(); await f.type(submitted); await f.save();
    if (outcome === 'preflight conflict') await f.response(1, f.fileBody('external edit'));
    else if (outcome === 'preflight failure') await f.response(1, {}, 503);
    else {
      await f.response(1, f.fileBody(baseline));
      if (outcome === 'refusal') await f.response(2, { ok: false, error: 'Synthetic refusal' }, 409);
      if (outcome === 'missing acknowledgement') await f.response(2, {});
      if (outcome === 'transport failure') await f.act(async () => f.requests[2].reject(Error('lost response')));
      if (outcome === 'body failure') await f.act(async () => f.requests[2].resolve({ ok: true, status: 200, json: async () => { throw Error('lost body'); } }));
    }
    f.expectSize('8 B');
    assert.ok(f.w.document.querySelector('[role="alert"]'));
    assert.equal(f.el('file-editor').value, submitted);
    assert.equal(f.saved(), false);
    assert.equal(f.requests.length, outcome.startsWith('preflight') ? 2 : 3, 'no automatic retry');
    await f.cancel(); f.expectSize('8 B'); await f.edit();
    assert.equal(f.el('file-editor').value, baseline, 'unacknowledged content never becomes saved baseline');
  });
}

for (const stage of ['headers', 'body']) for (const transition of ['file', 'session', 'close/reopen', 'cancel/reedit']) {
  test(`acknowledgement ${stage} after ${transition} only promotes its retained edit lifetime`, async t => {
    const f = await fixture(t);
    await f.edit(); await f.type('old 🧭'); await f.save(); await f.response(1, f.fileBody(baseline));
    const complete = stage === 'body' ? await f.stallBody(2) : body => f.response(2, body);
    if (transition === 'cancel/reedit') { await f.escape(); await f.edit(); await f.cancel(); await f.edit(); }
    else {
      if (transition === 'close/reopen') await f.render(false);
      await f.render(true, transition === 'file' ? 'b.txt' : 'a.txt', transition === 'session' ? '/synthetic/other.jsonl' : '/synthetic/session.jsonl');
      await f.response(3, f.fileBody('新しい'));
      await f.edit();
    }
    const current = transition === 'cancel/reedit' ? baseline : transition === 'close/reopen' ? 'old 🧭' : '新しい';
    await f.type('newer local draft'); await complete({ ok: true });
    f.expectSize(`${Buffer.byteLength(current)} B`);
    assert.equal(f.el('file-editor').value, 'newer local draft');
    assert.equal(f.saved(), false);
    await f.cancel(); await f.edit();
    assert.equal(f.el('file-editor').value, current);
  });
}
