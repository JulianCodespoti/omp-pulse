import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
  import { createElement as h, act, Fragment, StrictMode } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { ImageViewer } from ${JSON.stringify(resolve(root, 'web/src/app/parts/ImageViewer.tsx'))};
  import { Notices } from ${JSON.stringify(resolve(root, 'web/src/app/Notices.tsx'))};
  let r, props, present = true;
  const render = (next = {}) => {
    props = { ...props, ...next };
    r.render(h(StrictMode, null, h(Fragment, null,
      present ? h(ImageViewer, { ...props, onOpenChange: open => render({ open }) }) : null,
      h(Notices))));
  };
  window.fixture = { act, render, remove: () => { present = false; render(); }, mount: () => {
    r = createRoot(document.getElementById('root'));
    render({ src: 'blob:synthetic-a', open: true, alt: 'Synthetic image', mimeType: 'image/png' });
    return r;
  }};
`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function fixture(t, { native = false, fileShare = true } = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  const requests = [], shares = [];
  w.fetch = (src, options) => { const job = deferred(); requests.push({ src, options, ...job }); return job.promise; };
  if (native) w.Capacitor = { isNativePlatform: () => true };
  w.navigator.canShare = () => fileShare;
  w.navigator.share = data => { const job = deferred(); shares.push({ data, ...job }); return job.promise; };
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const button = label => w.document.querySelector(`button[aria-label="${label}"]`);
  return {
    w, act, requests, shares, button,
    click: label => act(async () => button(label).click()),
    render: props => act(async () => w.fixture.render(props)),
    remove: () => act(async () => w.fixture.remove()),
    error: () => w.document.body.textContent.includes('Could not share the image'),
    response: (i, body = new w.Blob(['image'], { type: 'image/png' })) => act(async () => requests[i].resolve({ ok: true, blob: () => Promise.resolve(body) })),
    reject: i => act(async () => requests[i].reject(new Error('Synthetic fetch failure'))),
  };
}

test('repeated share taps start one preparation before React commits', async t => {
  const f = await fixture(t);
  await f.act(async () => { f.button('Share image').click(); f.button('Share image').click(); });
  assert.equal(f.requests.length, 1);
  assert.equal(f.button('Share image').disabled, true);
  assert.equal(f.button('Share image').getAttribute('aria-busy'), 'true');
  await f.response(0);
  assert.equal(f.shares.length, 1);
  await f.click('Share image');
  assert.equal(f.requests.length, 1);
  await f.act(async () => f.shares[0].resolve());
  assert.equal(f.button('Share image').disabled, false);
  assert.equal(f.button('Share image').getAttribute('aria-busy'), 'false');
});

test('Close before the fetch settles prevents a stale native share', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.click('Close image');
  await f.response(0);
  assert.equal(f.shares.length, 0);
});

test('source replacement during blob conversion prevents sharing the old image', async t => {
  const f = await fixture(t), body = deferred();
  await f.click('Share image');
  await f.response(0, body.promise);
  await f.render({ src: 'blob:synthetic-b' });
  await f.act(async () => body.resolve(new f.w.Blob(['old'], { type: 'image/png' })));
  assert.equal(f.shares.length, 0);
});

test('unmounted viewer cannot start a native share after its fetch completes', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.remove();
  await f.response(0);
  assert.equal(f.shares.length, 0);
});

test('a dismissed preparation failure cannot show a global toast', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.click('Close image');
  await f.reject(0);
  assert.equal(f.error(), false);
});

test('current preparation failure remains visible and retryable', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.reject(0);
  assert.equal(f.error(), true);
  await f.click('Share image');
  assert.equal(f.requests.length, 2);
});


test('Close invalidates synchronously before a parent render commits', async t => {
  const f = await fixture(t);
  await f.act(async () => { f.button('Close image').click(); f.button('Share image').click(); });
  assert.equal(f.requests.length, 0);
});

test('same-source reopen owns its new pending preparation after old completion', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.render({ open: false });
  assert.equal(f.requests[0].options.signal.aborted, true);
  await f.render({ open: true });
  assert.equal(f.button('Share image').disabled, false);
  await f.click('Share image');
  await f.response(0);
  assert.equal(f.shares.length, 0);
  assert.equal(f.button('Share image').disabled, true);
  await f.response(1);
  assert.equal(f.shares.length, 1);
});

test('obsolete response does not even begin blob conversion', async t => {
  const f = await fixture(t);
  let conversions = 0;
  await f.click('Share image');
  await f.render({ src: 'blob:synthetic-b' });
  await f.act(async () => f.requests[0].resolve({ blob: () => { conversions++; return new f.w.Blob(['old']); } }));
  assert.equal(conversions, 0);
  assert.equal(f.shares.length, 0);
});

test('stale blob rejection cannot show a toast or release a newer preparation', async t => {
  const f = await fixture(t), body = deferred();
  await f.click('Share image');
  await f.response(0, body.promise);
  await f.render({ src: 'blob:synthetic-b' });
  await f.click('Share image');
  await f.act(async () => body.reject(new Error('Old blob failed')));
  assert.equal(f.error(), false);
  assert.equal(f.button('Share image').disabled, true);
  await f.response(1);
  assert.equal(f.shares.length, 1);
});

test('Escape dismissal prevents pending preparation from sharing', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.act(async () => f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(f.requests[0].options.signal.aborted, true);
  await f.response(0);
  assert.equal(f.shares.length, 0);
});

test('MIME replacement invalidates preparation even with the same source', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.render({ mimeType: 'image/jpeg' });
  await f.response(0);
  assert.equal(f.shares.length, 0);
  await f.click('Share image');
  await f.response(1, new f.w.Blob(['new']));
  assert.equal(f.shares[0].data.files[0].name, 'image.jpeg');
  assert.equal(f.shares[0].data.files[0].type, 'image/jpeg');
});

test('alt-text refresh preserves the valid attempt, filename and actual blob type', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.render({ alt: 'Updated synthetic description' });
  await f.response(0, new f.w.Blob(['bytes'], { type: 'image/webp' }));
  assert.equal(f.shares.length, 1);
  assert.equal(f.shares[0].data.files[0].name, 'image.png');
  assert.equal(f.shares[0].data.files[0].type, 'image/webp');
  assert.equal(f.shares[0].data.files[0].size, 5);
});

for (const transition of ['close/reopen', 'source replacement']) {
  test(`already-issued share retains its lease through ${transition} and ignores stale failure`, async t => {
    const f = await fixture(t);
    await f.click('Share image');
    await f.response(0);
    assert.equal(f.shares.length, 1);
    if (transition === 'close/reopen') {
      await f.click('Close image');
      await f.render({ open: true });
    } else await f.render({ src: 'blob:synthetic-b' });
    assert.equal(f.requests[0].options.signal.aborted, false, 'native sharing has already been issued');
    assert.equal(f.button('Share image').disabled, true);
    await f.click('Share image');
    assert.equal(f.requests.length, 1);
    await f.act(async () => f.shares[0].reject(new Error('Old platform failure')));
    assert.equal(f.error(), false);
    assert.equal(f.button('Share image').disabled, false);
    await f.click('Share image');
    assert.equal(f.requests.length, 2);
    await f.response(1);
    assert.equal(f.shares.length, 2);
  });
}

test('an issued share can settle after viewer unmount without a global toast', async t => {
  const f = await fixture(t);
  await f.click('Share image');
  await f.response(0);
  await f.remove();
  await f.act(async () => f.shares[0].reject(new Error('Platform failure after navigation')));
  assert.equal(f.error(), false);
  assert.equal(f.shares.length, 1);
});

for (const phase of ['fetch', 'blob', 'share']) {
  test(`AbortError from current ${phase} stays quiet and releases the lease`, async t => {
    const f = await fixture(t), body = deferred();
    await f.click('Share image');
    if (phase === 'blob') await f.response(0, body.promise);
    if (phase === 'share') await f.response(0);
    await f.act(async () => {
      const error = new f.w.DOMException('Canceled', 'AbortError');
      if (phase === 'fetch') f.requests[0].reject(error);
      if (phase === 'blob') body.reject(error);
      if (phase === 'share') f.shares[0].reject(error);
    });
    assert.equal(f.error(), false);
    assert.equal(f.button('Share image').disabled, false);
    await f.click('Share image');
    assert.equal(f.requests.length, 2);
  });
}

for (const phase of ['blob', 'share']) {
  test(`current ${phase} failure reports the error and permits an explicit retry`, async t => {
    const f = await fixture(t), body = deferred();
    await f.click('Share image');
    await f.response(0, phase === 'blob' ? body.promise : new f.w.Blob(['image']));
    await f.act(async () => (phase === 'blob' ? body : f.shares[0]).reject(new Error('Synthetic current failure')));
    assert.equal(f.error(), true);
    assert.equal(f.button('Share image').disabled, false);
    await f.click('Share image');
    assert.equal(f.requests.length, 2);
  });
}

test('browser keeps the anchor download beside Share', async t => {
  const f = await fixture(t);
  const a = f.w.document.querySelector('a[aria-label="Download image"]');
  assert.equal(a?.hasAttribute('download'), true);
  assert.equal(a?.getAttribute('href'), 'blob:synthetic-a');
  assert.equal(!!f.button('Share image'), true);
});

test('native shell hides the dead Download and shares a File', async t => {
  const f = await fixture(t, { native: true });
  assert.equal(f.w.document.querySelector('a[aria-label="Download image"]') === null, true);
  await f.click('Share image');
  await f.response(0);
  assert.equal(f.shares.length, 1);
  assert.equal(f.shares[0].data.files[0] instanceof f.w.File, true);
  assert.equal(f.shares[0].data.files[0].type, 'image/png');
});

test('native shell without file share offers neither Share nor Download', async t => {
  const f = await fixture(t, { native: true, fileShare: false });
  assert.equal(f.w.document.querySelector('a[aria-label="Download image"]') === null, true);
  assert.equal(f.button('Share image') === null, true);
});
