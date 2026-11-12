import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
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

const draft = '  draft café 👋\n\tkeep me  \n';

async function fixture(t) {
  const dom = createDomFixture(code);
  const w = dom.window;
  const { act } = w.fixture;
  const requests = [], deadlines = [];
  // Control expiry without waiting on real clocks. Initial DaemonApi.readFile
  // and save's preflight both use the real request helper, not a mocked API.
  w.AbortSignal.timeout = ms => {
    const controller = new w.AbortController();
    deadlines.push({ ms, controller });
    return controller.signal;
  };
  w.fetch = (url, options) => {
    assert.ok(String(url).startsWith('/api/file?') || url === '/api/file');
    return new Promise((resolve, reject) => {
      const request = { url, options, resolve, reject, method: options?.method ?? 'GET', bodyReject: null };
      requests.push(request);
      // Fetch rejects either pending headers or a pending body on abort.
      // Late completion cannot undo that rejection. No network/file I/O occurs.
      const abort = () => {
        reject(options.signal.reason);
        request.bodyReject?.(options.signal.reason);
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  };

  let r, unmounted = false;
  await act(async () => { r = w.fixture.mount(); });
  const el = id => w.document.querySelector(`[data-testid="${id}"]`);
  const text = () => w.document.body.textContent;
  const fileBody = content => ({ ok: true, name: 'a.txt', path: 'a.txt', content,
    binary: false, truncated: false, size: Buffer.byteLength(content), mtime: 1 });
  const response = (i, body) => act(async () => requests[i].resolve({ ok: true, status: 200, json: async () => body }));
  const stallBody = async i => {
    let complete;
    await act(async () => requests[i].resolve({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {
      complete = resolve;
      requests[i].bodyReject = reject;
      if (requests[i].options.signal?.aborted) reject(requests[i].options.signal.reason);
    }) }));
    return body => act(async () => complete(body));
  };
  const type = value => act(async () => {
    const input = el('file-editor');
    assert.ok(input, 'editor is available');
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const edit = () => act(async () => {
    if (el('file-edit')) el('file-edit').click();
    else assert.ok(el('file-editor'), 'restored editor');
  });
  const save = () => act(async () => el('file-save').click());
  const escape = () => act(async () => el('file-editor').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const unmount = async () => {
    if (!unmounted) { unmounted = true; await act(async () => r.unmount()); }
  };
  t.after(async () => {
    try { await unmount(); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  await response(0, fileBody('baseline'));
  await edit();
  await type(draft);

  const expire = (index = 1) => act(async () => {
    const deadline = deadlines[index];
    assert.ok(deadline, 'save preflight owns a read deadline');
    assert.equal(deadline.ms, 20_000);
    deadline.controller.abort(new w.DOMException('The read timed out', 'TimeoutError'));
  });
  const pendingRead = async phase => {
    await save();
    assert.equal(deadlines.length, 2, 'one deadline each for initial read and preflight');
    assert.equal(requests[1].options.signal, deadlines[1].controller.signal);
    return phase === 'body' ? stallBody(1) : body => response(1, body);
  };
  return { w, act, el, text, requests, deadlines, fileBody, response, stallBody, type,
    edit, save, escape, expire, pendingRead, unmount,
    render: (...args) => act(async () => r.render(...args)),
    posts: () => requests.filter(r => r.method === 'POST'),
    cancel: () => w.document.querySelector('button[aria-label="Cancel edit"]') };
}

for (const phase of ['headers', 'body']) {
  test(`${phase}: timeout retains current draft, restores controls, and late read cannot POST`, async t => {
    const f = await fixture(t);
    const complete = await f.pendingRead(phase);
    const newer = draft + 'newer\n';
    await f.type(newer);
    await f.expire();
    assert.equal(f.posts().length, 0);
    assert.equal(f.el('file-editor').value, newer);
    assert.equal(f.el('file-save').disabled, false);
    assert.equal(f.cancel().disabled, false);
    assert.match(f.text(), /took too long to answer/i);
    assert.doesNotMatch(f.text(), /\bSaved\b/);
    await complete(f.fileBody('baseline'));
    assert.equal(f.requests.length, 2, 'no late write or automatic retry');
    assert.equal(f.el('file-editor').value, newer);

    await f.save();
    assert.equal(f.deadlines.length, 3, 'explicit retry owns a fresh read deadline');
    await f.response(2, f.fileBody('baseline'));
    assert.equal(f.posts().length, 1);
    assert.deepEqual(JSON.parse(f.posts()[0].options.body), {
      sessionPath: '/synthetic/session.jsonl', path: 'a.txt', content: newer, expectedContent: 'baseline',
    });
    assert.equal(f.requests[3].options.signal, undefined, 'POST has no added deadline');
    await f.response(3, { ok: true });
    assert.equal(f.el('file-editor') === null, true);
    assert.match(f.text(), /Saved/);
  });

  for (const transition of ['file', 'session', 'close/reopen', 'dismiss/reedit', 'unmount']) {
    test(`${phase}: obsolete read after ${transition} cannot write or report stale timeout`, async t => {
      const f = await fixture(t);
      const complete = await f.pendingRead(phase);
      if (transition === 'file') {
        await f.render(true, 'b.txt');
        await f.response(2, f.fileBody('new file'));
      } else if (transition === 'session') {
        await f.render(true, 'a.txt', '/synthetic/other-session.jsonl');
        await f.response(2, f.fileBody('new session'));
      } else if (transition === 'close/reopen') {
        await f.render(false);
        await f.render(true);
        await f.response(2, f.fileBody('reopened file'));
      } else if (transition === 'dismiss/reedit') {
        await f.escape();
        await f.edit();
        await f.type('new edit');
      } else await f.unmount();

      await f.expire();
      await complete(f.fileBody('baseline'));
      assert.equal(f.posts().length, 0);
      assert.doesNotMatch(f.text(), /took too long to answer|\bSaved\b/i);
      if (transition === 'file') assert.match(f.text(), /new file/);
      if (transition === 'session') assert.match(f.text(), /new session/);
      if (transition === 'close/reopen') assert.equal(f.el('file-editor').value, draft, 'reopen keeps the edit instead of the fetched disk text');
      if (transition === 'dismiss/reedit') {
        assert.equal(f.el('file-editor').value, 'new edit');
        assert.equal(f.el('file-save').disabled, false);
        assert.equal(f.cancel().disabled, false);
      }
    });
  }

  for (const oldRead of ['already timed out', 'dismissed edit']) {
    test(`${phase}: ${oldRead} cannot unlock or dispatch a newer save`, async t => {
      const f = await fixture(t);
      const complete = await f.pendingRead(phase);
      if (oldRead === 'already timed out') await f.expire();
      else { await f.escape(); await f.edit(); }
      await f.type('next draft');
      await f.save();
      if (oldRead === 'dismissed edit') await f.expire();
      await complete(f.fileBody('baseline'));
      assert.equal(f.posts().length, 0);
      assert.equal(f.el('file-save').disabled, true);
      assert.equal(f.cancel().disabled, true);
      assert.equal(f.el('file-editor').value, 'next draft');
      assert.doesNotMatch(f.text(), /took too long to answer|\bSaved\b/i);
      await f.response(2, f.fileBody('baseline'));
      assert.equal(f.posts().length, 1);
      assert.equal(JSON.parse(f.posts()[0].options.body).content, 'next draft');
      await f.response(3, { ok: true });
      assert.equal(f.el('file-editor') === null, true);
      assert.match(f.text(), /Saved/);
    });
  }

  test(`POST ${phase}: completed preflight deadline cannot cancel or repeat the write`, async t => {
    const f = await fixture(t);
    await f.save();
    await f.response(1, f.fileBody('baseline'));
    assert.equal(f.posts().length, 1);
    assert.equal(f.requests[2].options.signal, undefined);
    const complete = phase === 'body' ? await f.stallBody(2) : body => f.response(2, body);
    await f.expire();
    assert.equal(f.deadlines.length, 2, 'POST creates no deadline');
    assert.equal(f.requests.length, 3, 'POST is never automatically repeated');
    assert.equal(f.el('file-save').disabled, true);
    assert.equal(f.el('file-editor').value, draft);
    assert.doesNotMatch(f.text(), /took too long to answer|\bSaved\b/i);
    await complete({ ok: true });
    assert.equal(f.el('file-editor') === null, true);
    assert.match(f.text(), /Saved/);
  });
}

test('successful preflight/write preserves a newer draft and advances only the acknowledged baseline', async t => {
  const f = await fixture(t);
  await f.save();
  await f.type(draft + 'newer');
  await f.response(1, f.fileBody('baseline'));
  assert.equal(JSON.parse(f.posts()[0].options.body).content, draft);
  await f.response(2, { ok: true });
  assert.equal(f.el('file-editor').value, draft + 'newer');
  assert.equal(f.el('file-save').disabled, false);
  assert.doesNotMatch(f.text(), /\bSaved\b/);
  await f.save();
  await f.response(3, f.fileBody(draft));
  assert.equal(f.posts().length, 2);
  assert.equal(JSON.parse(f.posts()[1].options.body).content, draft + 'newer');
  await f.response(4, { ok: true });
  assert.equal(f.el('file-editor') === null, true);
  assert.match(f.text(), /Saved/);
});

for (const status of [200, 500]) {
  test(`malformed preflight JSON at HTTP ${status} retains draft and never writes`, async t => {
    const f = await fixture(t);
    await f.save();
    await f.act(async () => f.requests[1].resolve({ ok: status === 200, status,
      json: async () => { throw new f.w.SyntaxError('Malformed synthetic JSON'); } }));
    assert.equal(f.posts().length, 0);
    assert.equal(f.requests.length, 2, 'no automatic retry');
    assert.equal(f.el('file-editor').value, draft);
    assert.equal(f.el('file-save').disabled, false);
    assert.equal(f.cancel().disabled, false);
    assert.doesNotMatch(f.text(), /\bSaved\b|Malformed synthetic JSON/);
    assert.match(f.text(), status === 200 ? /Couldn’t verify the latest file contents/ : /Something went wrong\. Try again\./);
  });
}
