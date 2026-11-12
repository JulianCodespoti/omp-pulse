import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Real FileViewer, CopyButton, clipboard ownership, request helpers and sheet.
// Only fetch/clipboard are synthetic: this is interaction, not browser/layout QA.
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { FileViewer } from ${JSON.stringify(resolve(root, 'web/src/app/tools/FileViewer.tsx'))};
import { Notices } from ${JSON.stringify(resolve(root, 'web/src/app/Notices.tsx'))};
import { writePairingToken } from ${JSON.stringify(resolve(root, 'web/src/platform/browser-storage.ts'))};
import { clearAllDrafts, getDraftNamespace } from ${JSON.stringify(resolve(root, 'web/src/app/composer/use-draft.ts'))};
import { clearFileDraftMemory, flushFileDraftWrites } from ${JSON.stringify(resolve(root, 'web/src/runtime/file-draft.ts'))};
window.fixture = { act, writePairingToken, flushFileDraftWrites,
  clearAllDrafts() { const namespace = getDraftNamespace(); clearAllDrafts(namespace); clearFileDraftMemory(namespace); },
  mount() {
  const r = createRoot(document.getElementById('root'));
  const render = (open = true, path = 'a.txt', sessionPath = '/synthetic/session.jsonl') =>
    r.render(h('div', {}, h(FileViewer, { open, path, sessionPath, onOpenChange: value => render(value, path, sessionPath) }), h(Notices)));
  render();
  return { render, unmount: () => r.unmount() };
} };
`);
const baseline = 'original baseline\n';
const draft = '  draft café 👋\n\tkeep me  \n';

async function fixture(t, { clipboard = 'success', credential = '' } = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  const requests = [], writes = [], pending = [], legacyCalls = [];
  w.fetch = (url, options) => {
    assert.ok(String(url).startsWith('/api/file?') || url === '/api/file', 'only synthetic file endpoints');
    return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject, method: options?.method ?? 'GET' }));
  };
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: text => {
    writes.push(text);
    if (clipboard === 'pending') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    if (clipboard === 'fail') return Promise.reject(Error('synthetic clipboard denial'));
    return Promise.resolve();
  } } });
  w.document.execCommand = command => { legacyCalls.push(command); return false; };
  if (credential) w.fixture.writePairingToken(credential);
  let r;
  await act(async () => { r = w.fixture.mount(); });
  t.after(async () => {
    try { await act(async () => r.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const el = id => w.document.querySelector(`[data-testid="${id}"]`);
  const button = label => w.document.querySelector(`button[aria-label="${label}"]`);
  const copy = () => w.document.querySelector('button[aria-label="Copy draft"],button[aria-label="Copy file content"],button[aria-label="Copying"],button[aria-label="Copied"]');
  const fileBody = content => ({ ok: true, path: 'a.txt', name: 'a.txt', content, binary: false, truncated: false, size: Buffer.byteLength(content), mtime: 1 });
  const response = (i, body, status = 200) => act(async () => requests[i].resolve({ ok: status < 400, status, json: async () => body }));
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
    else assert.ok(el('file-editor'), 'an existing draft already restored the editor');
  });
  const save = () => act(async () => el('file-save').click());
  const escape = () => act(async () => el('file-editor').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const cancel = () => act(async () => button('Cancel edit').click());
  const dismiss = () => act(async () => button('Close').click());
  const posts = () => requests.filter(r => r.method === 'POST');
  const state = () => ({ draft: el('file-editor')?.value, saving: el('file-save')?.disabled,
    cancelDisabled: button('Cancel edit')?.disabled, saveLabel: el('file-save')?.getAttribute('aria-label'),
    // The copy-failure notice is itself an alert; its own text is asserted where it is expected.
    errors: [...w.document.querySelectorAll('[role="alert"]')].map(e => e.textContent).filter(text => !/Couldn.t copy/.test(text)),
    saved: [...w.document.querySelectorAll('[role="status"]')].some(e => e.textContent === 'Saved') });
  const copyWithoutMutation = async expected => {
    const before = state(), requestCount = requests.length, postCount = posts().length, count = writes.length;
    assert.ok(copy(), 'copy action remains available');
    assert.equal(copy().disabled, false, 'save does not disable copy');
    await act(async () => copy().click());
    assert.equal(writes.length, count + 1);
    assert.equal(writes.at(-1), expected, 'copy uses the exact current text');
    assert.deepEqual(state(), before, 'copy cannot alter editor, save lock or errors');
    assert.equal(requests.length, requestCount, 'copy adds no API request');
    assert.equal(posts().length, postCount, 'copy adds zero API writes');
  };
  await response(0, fileBody(baseline));
  await edit();
  await type(draft);
  return { w, act, requests, writes, pending, legacyCalls, el, button, copy, fileBody, response, stallBody,
    type, edit, save, escape, cancel, dismiss, posts, state, copyWithoutMutation,
    text: () => w.document.body.textContent,
    render: (...args) => act(async () => r.render(...args)),
    remount: () => act(async () => { r.unmount(); r = w.fixture.mount(); }),
    settle: (index, failure = false) => act(async () => failure ? pending[index].reject(Error('late denial')) : pending[index].resolve()) };
}

for (const text of [draft, '']) {
  test(`before saving: copies ${text ? 'whitespace and Unicode' : 'empty draft'} without advancing baseline`, async t => {
    const f = await fixture(t);
    await f.type(text);
    assert.equal(f.copy().getAttribute('aria-label'), 'Copy draft');
    assert.equal(f.button('Download file') === null, true);
    await f.copyWithoutMutation(text);
    assert.equal(f.copy().getAttribute('aria-label'), 'Copied');
    assert.equal(f.posts().length, 0);
    // Baseline is intentionally observed through Cancel/read/re-edit, not a ref spy.
    await f.cancel();
    assert.equal(f.copy().getAttribute('aria-label'), 'Copy file content');
    assert.ok(f.button('Download file'));
    await f.copyWithoutMutation(baseline);
    await f.edit();
    assert.equal(f.el('file-editor').value, baseline);
  });
}

for (const stage of ['preflight headers', 'preflight body', 'POST headers', 'POST body']) {
  test(`${stage}: copy stays independent of saving and uses newer typing`, async t => {
    const f = await fixture(t);
    await f.save();
    let complete;
    if (stage.startsWith('POST')) {
      await f.response(1, f.fileBody(baseline));
      complete = stage.endsWith('body') ? await f.stallBody(2) : body => f.response(2, body);
    } else complete = stage.endsWith('body') ? await f.stallBody(1) : body => f.response(1, body);
    assert.equal(f.el('file-save').disabled, true);
    await f.copyWithoutMutation(draft);
    const newer = draft + 'newer typing\n';
    await f.type(newer);
    await f.copyWithoutMutation(newer);
    assert.equal(f.el('file-save').disabled, true, 'clipboard success never acknowledges the save');
    assert.equal(f.state().saved, false);
    if (stage.startsWith('preflight')) {
      await complete(f.fileBody(baseline));
      complete = body => f.response(2, body);
    }
    assert.equal(f.posts().length, 1);
    assert.equal(JSON.parse(f.posts()[0].options.body).content, draft, 'copy/typing do not replace submitted snapshot');
    assert.equal(f.posts()[0].options.signal, undefined, 'copy adds no POST cancellation/deadline');
    await complete({ ok: true });
    assert.equal(f.el('file-editor').value, newer);
    assert.equal(f.el('file-save').disabled, false);
    await f.copyWithoutMutation(newer);
    // A second preflight against submitted content proves that only server
    // acknowledgement, never copying the newer draft, advanced the baseline.
    await f.save();
    await f.response(3, f.fileBody(draft));
    assert.equal(f.posts().length, 2);
    assert.equal(JSON.parse(f.posts()[1].options.body).content, newer);
    await f.response(4, { ok: true });
    assert.equal(f.el('file-editor') === null, true);
    assert.equal(f.copy().getAttribute('aria-label'), 'Copy file content');
    assert.ok(f.button('Download file'));
    await f.copyWithoutMutation(newer);
    assert.equal(f.state().saved, true);
  });
}

for (const outcome of ['preflight conflict', 'rejected save', 'uncertain transport', 'uncertain body']) {
  test(`${outcome}: copying preserves error, draft and unacknowledged baseline`, async t => {
    const f = await fixture(t);
    await f.save();
    if (outcome === 'preflight conflict') await f.response(1, f.fileBody('external edit'));
    else {
      await f.response(1, f.fileBody(baseline));
      if (outcome === 'rejected save') await f.response(2, { ok: false, error: 'Synthetic refusal' }, 409);
      else if (outcome === 'uncertain transport') await f.act(async () => f.requests[2].reject(Error('synthetic lost response')));
      else await f.response(2, {});
    }
    assert.equal(f.el('file-save').disabled, false);
    assert.match(f.text(), outcome === 'preflight conflict' ? /changed on disk/ : outcome === 'rejected save' ? /Synthetic refusal/ : /Couldn’t confirm the save/);
    await f.copyWithoutMutation(draft);
    assert.equal(f.state().saved, false);
    await f.cancel();
    await f.copyWithoutMutation(baseline);
    await f.edit();
    assert.equal(f.el('file-editor').value, baseline);
  });
}

test('pending clipboard suppresses repeated taps without unlocking an unresolved save', async t => {
  const f = await fixture(t, { clipboard: 'pending' });
  await f.save();
  const before = f.state(), requestCount = f.requests.length;
  await f.act(async () => { f.copy().click(); f.copy().click(); });
  await f.act(async () => f.copy().click());
  assert.deepEqual(f.writes, [draft]);
  assert.equal(f.copy().disabled, true);
  assert.equal(f.copy().getAttribute('aria-busy'), 'true');
  assert.deepEqual(f.state(), before);
  assert.equal(f.requests.length, requestCount);
  await f.settle(0);
  assert.equal(f.copy().getAttribute('aria-label'), 'Copied');
  assert.deepEqual(f.state(), before);
  assert.equal(f.posts().length, 0);
});

test('clipboard failure remains truthful and cannot mutate a pending save or draft', async t => {
  const f = await fixture(t, { clipboard: 'fail' });
  await f.save();
  await f.copyWithoutMutation(draft);
  assert.equal(f.copy().getAttribute('aria-label'), 'Copy draft');
  assert.match(f.text(), /Couldn't copy\. Try again or select the text\./);
  assert.deepEqual(f.legacyCalls, ['copy']);
  assert.equal(f.el('file-save').disabled, true);
  await f.response(1, f.fileBody(baseline));
  assert.equal(f.posts().length, 1, 'copy failure did not alter preflight baseline');
  assert.equal(JSON.parse(f.posts()[0].options.body).content, draft);
});

for (const failure of [false, true]) {
  test(`new typing isolates a pending clipboard ${failure ? 'failure' : 'success'}`, async t => {
    const f = await fixture(t, { clipboard: 'pending' });
    await f.copyWithoutMutation(draft);
    await f.type(draft + 'newer');
    assert.equal(f.copy().getAttribute('aria-label'), 'Copy draft');
    await f.copyWithoutMutation(draft + 'newer');
    await f.settle(0, failure);
    assert.equal(f.copy().getAttribute('aria-label'), 'Copying', 'obsolete attempt cannot settle the current one');
    assert.equal(f.copy().disabled, true);
    assert.doesNotMatch(f.text(), /Couldn't copy/);
    assert.deepEqual(f.legacyCalls, [], 'obsolete rejection cannot fall back over newer clipboard text');
    await f.settle(1);
    assert.equal(f.copy().getAttribute('aria-label'), 'Copied');
    assert.equal(f.el('file-editor').value, draft + 'newer');
    assert.equal(f.posts().length, 0);
  });
}

for (const transition of ['file', 'session', 'close/reopen', 'unmount/remount', 'edit/read', 'edit/read/edit', 'read/edit']) {
  for (const failure of [false, true]) {
    test(`${transition} with identical text suppresses stale clipboard ${failure ? 'failure' : 'success'}`, async t => {
      const f = await fixture(t, { clipboard: 'pending' });
      await f.type(baseline); // Same text makes lifetime identity, not text change, carry the protection.
      if (transition === 'read/edit') await f.cancel();
      await f.copyWithoutMutation(baseline);
      if (['file', 'session', 'close/reopen', 'unmount/remount'].includes(transition)) {
        if (transition === 'unmount/remount') await f.remount();
        if (transition === 'file') await f.render(true, 'b.txt');
        if (transition === 'session') await f.render(true, 'a.txt', '/synthetic/other.jsonl');
        if (transition === 'close/reopen') { await f.render(false); assert.equal(f.copy() === null, true); await f.render(true); }
        assert.equal(f.copy() === null, true, 'loading does not expose old copy ownership');
        await f.response(1, f.fileBody(baseline));
        await f.edit();
      } else if (transition === 'read/edit') await f.edit();
      else {
        await f.cancel();
        if (transition === 'edit/read/edit') await f.edit();
      }
      assert.equal(f.copy().getAttribute('aria-label'), transition === 'edit/read' ? 'Copy file content' : 'Copy draft');
      await f.copyWithoutMutation(baseline);
      const before = f.state(), requestCount = f.requests.length;
      await f.settle(0, failure);
      assert.equal(f.copy().getAttribute('aria-label'), 'Copying');
      assert.equal(f.copy().disabled, true);
      assert.deepEqual(f.state(), before);
      assert.equal(f.requests.length, requestCount);
      assert.doesNotMatch(f.text(), /Couldn't copy/);
      assert.deepEqual(f.legacyCalls, []);
      await f.settle(1);
      assert.equal(f.copy().getAttribute('aria-label'), 'Copied');
      assert.equal(f.posts().length, 0);
    });
  }
}

for (const value of [draft, '']) for (const transition of ['Close', 'Escape', 'unmount']) {
  test(`restores exact ${value ? 'Unicode/whitespace' : 'empty'} draft after ${transition}`, async t => {
    const f = await fixture(t);
    await f.type(value);
    if (transition === 'unmount') await f.remount();
    else {
      if (transition === 'Close') await f.dismiss();
      else await f.escape();
      await f.render(true);
    }
    await f.response(1, f.fileBody('new disk content'));
    assert.equal(f.el('file-editor')?.value, value, 'disk reads never replace unsaved text');
    await f.save();
    await f.response(2, f.fileBody('new disk content'));
    assert.equal(f.posts().length, 0, 'reopen preserves the original conflict baseline');
    assert.match(f.text(), /changed on disk/);
  });
}

for (const scope of ['file', 'workspace', 'credential']) {
  test(`drafts are isolated by ${scope} and restored on return`, async t => {
    const f = await fixture(t);
    await f.dismiss();
    if (scope === 'credential') f.w.fixture.writePairingToken('other-computer-credential');
    await f.render(true, scope === 'file' ? 'b.txt' : 'a.txt', scope === 'workspace' ? '/other/session.jsonl' : '/synthetic/session.jsonl');
    await f.response(1, f.fileBody('other baseline'));
    assert.equal(f.el('file-editor'), null, 'other scope has no inherited edit');
    await f.edit(); await f.type('other draft'); await f.dismiss();
    if (scope === 'credential') f.w.fixture.writePairingToken('');
    await f.render(true);
    await f.response(2, f.fileBody(baseline));
    assert.equal(f.el('file-editor')?.value, draft);
    await f.cancel();
    await f.dismiss();
    if (scope === 'credential') f.w.fixture.writePairingToken('other-computer-credential');
    await f.render(true, scope === 'file' ? 'b.txt' : 'a.txt', scope === 'workspace' ? '/other/session.jsonl' : '/synthetic/session.jsonl');
    await f.response(3, f.fileBody('other baseline'));
    assert.equal(f.el('file-editor')?.value, 'other draft', 'discard clears only its own scope');
  });
}

test('stale file read cannot overwrite a restored draft in the current file', async t => {
  const f = await fixture(t);
  await f.render(true, 'b.txt');
  await f.render(true);
  await f.response(2, f.fileBody(baseline));
  assert.equal(f.el('file-editor')?.value, draft);
  await f.response(1, f.fileBody('stale B disk'));
  assert.equal(f.el('file-editor')?.value, draft);
});

for (const outcome of ['success', 'refusal', 'uncertain']) {
  test(`dismissed POST ${outcome} clears only an acknowledged snapshot`, async t => {
    const f = await fixture(t);
    await f.save(); await f.response(1, f.fileBody(baseline));
    await f.dismiss();
    await f.response(2, outcome === 'success' ? { ok: true } : outcome === 'refusal' ? { ok: false, error: 'Refused' } : {});
    await f.render(true);
    await f.response(3, f.fileBody(outcome === 'success' ? draft : baseline));
    if (outcome === 'success') assert.equal(f.el('file-editor'), null);
    else assert.equal(f.el('file-editor')?.value, draft);
  });
}

test('late successful save keeps a reopened newer edit and advances its baseline', async t => {
  const f = await fixture(t), newer = draft + 'new typing';
  await f.save(); await f.response(1, f.fileBody(baseline));
  await f.dismiss(); await f.render(true); await f.response(3, f.fileBody(baseline));
  await f.type(newer);
  await f.response(2, { ok: true });
  assert.equal(f.el('file-editor')?.value, newer);
  await f.save(); await f.response(4, f.fileBody(draft));
  assert.equal(JSON.parse(f.posts()[1].options.body).content, newer);
  await f.response(5, { ok: true });
  await f.dismiss(); await f.render(true); await f.response(6, f.fileBody(newer));
  assert.equal(f.el('file-editor'), null, 'fully saved snapshot has no recovered edit');
});

test('a read started before acknowledgement cannot resurrect the old saved baseline', async t => {
  const f = await fixture(t);
  await f.save(); await f.response(1, f.fileBody(baseline));
  await f.dismiss(); await f.render(true);
  await f.response(2, { ok: true });
  await f.response(3, f.fileBody(baseline));
  assert.equal(f.el('file-editor'), null);
  assert.equal(f.el('file-content').textContent, draft, 'confirmed write supersedes its older in-flight read');
});

test('old save cannot clear a deliberately discarded and replaced draft', async t => {
  const f = await fixture(t), replacement = 'replacement edit';
  await f.save(); await f.response(1, f.fileBody(baseline));
  await f.escape(); await f.render(true); await f.response(3, f.fileBody(baseline));
  await f.cancel(); await f.edit(); await f.type(replacement);
  await f.response(2, { ok: true });
  assert.equal(f.el('file-editor')?.value, replacement);
  await f.dismiss(); await f.render(true); await f.response(4, f.fileBody(draft));
  assert.equal(f.el('file-editor')?.value, replacement);
});

test('explicit offline-data clearing also clears saved file drafts', async t => {
  const f = await fixture(t);
  await f.dismiss();
  f.w.fixture.clearAllDrafts();
  await f.render(true); await f.response(1, f.fileBody(baseline));
  assert.equal(f.el('file-editor'), null);
  await f.edit();
  assert.equal(f.el('file-editor').value, baseline);
});

for (const denial of ['quota', 'unavailable']) {
  test(`${denial} storage keeps a visible, recoverable in-memory draft and blocks unsafe reload`, async t => {
    const f = await fixture(t, { credential: 'synthetic-paired-computer' }), newer = draft + 'after storage failure';
    const prototype = f.w.Storage.prototype, originals = {};
    for (const method of denial === 'quota' ? ['setItem'] : ['getItem', 'setItem', 'removeItem']) {
      originals[method] = prototype[method];
      prototype[method] = () => { throw new f.w.DOMException('Synthetic storage denial', 'QuotaExceededError'); };
    }
    t.after(() => { for (const [method, original] of Object.entries(originals)) prototype[method] = original; });
    await f.type(newer);
    assert.equal(f.el('file-editor')?.value, newer);
    assert.match(f.text(), /Couldn’t preserve this file draft/);
    await f.act(async () => assert.throws(() => f.w.fixture.flushFileDraftWrites(), /app was not reloaded/));
    await f.dismiss(); await f.render(true); await f.response(1, f.fileBody(baseline));
    assert.equal(f.el('file-editor')?.value, newer);
    await f.remount(); await f.response(2, f.fileBody(baseline));
    assert.equal(f.el('file-editor')?.value, newer, 'component lifetime does not own the failed write');
    for (const [method, original] of Object.entries(originals)) prototype[method] = original;
    await f.act(async () => f.w.fixture.flushFileDraftWrites());
    assert.doesNotMatch(f.text(), /Couldn’t preserve this file draft/);
    await f.remount(); await f.response(3, f.fileBody(baseline));
    assert.equal(f.el('file-editor')?.value, newer, 'recovered storage contains the exact edit');
  });
}

test('discard cleanup failure cannot resurrect an older persisted edit in this document', async t => {
  const f = await fixture(t), original = f.w.Storage.prototype.removeItem;
  f.w.Storage.prototype.removeItem = () => { throw Error('Synthetic removal denial'); };
  t.after(() => { f.w.Storage.prototype.removeItem = original; });
  await f.cancel();
  assert.match(f.text(), /Couldn’t preserve this file draft/);
  await f.dismiss(); await f.render(true); await f.response(1, f.fileBody(baseline));
  assert.equal(f.el('file-editor'), null);
  f.w.Storage.prototype.removeItem = original;
  await f.act(async () => f.w.fixture.flushFileDraftWrites());
  await f.remount(); await f.response(2, f.fileBody(baseline));
  assert.equal(f.el('file-editor'), null, 'durable cleanup completes once storage permits it');
});
