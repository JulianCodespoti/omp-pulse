import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const reply = '[Plan](local://PLAN.md) and [Output](artifact://0:raw:2-3).\n\nBare artifact://1.\n\n[Website](https://example.com/page). Inline `artifact://9` and `local://literal`.\n\n```text\nartifact://8\n```';
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {MessageParts} from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import {Notices} from ${JSON.stringify(resolve(root, 'web/src/app/Notices.tsx'))};
import {writePairingToken} from ${JSON.stringify(resolve(root, 'web/src/platform/browser-storage.ts'))};
writePairingToken('synthetic-resource-token');
const text=${JSON.stringify(reply)};
window.fixture={act,mount(){const r=createRoot(document.getElementById('root'));const render=(sessionPath='/sessions/a.jsonl')=>r.render(h('main',{},h('p',{'data-active':true},sessionPath??'No source'),h(MessageParts,{message:{id:'same-entry',role:'assistant',text,parts:[{kind:'text',text}]},sessionPath,finalReply:true}),h(Notices)));render();return{render,unmount:()=>r.unmount()}}};
`);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  const requests = [];
  w.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url: String(url), options, resolve, reject }));
  let app;
  await act(async () => { app = w.fixture.mount(); });
  t.after(async () => { try { await act(async () => app.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const settle = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(predicate(), 'interaction did not settle');
  };
  const button = label => [...w.document.querySelectorAll('button')].find(node => node.textContent === label);
  await settle(() => button('Plan'));
  return {
    w, requests, act, settle, button,
    render: path => act(async () => app.render(path)),
    click: async label => { await act(async () => { const node = button(label); assert.ok(node, label); node.click(); }); },
    complete: (index, content, error) => act(async () => requests[index].resolve({ok:true,status:200,json:async()=>error ? {ok:false,error} : {ok:true,content,binary:false,truncated:false,size:content.length}})),
    content: () => w.document.querySelector('[data-testid="file-content"]')?.textContent,
  };
}

test('a reply link opens originating-session bytes in the actual read-only FileViewer', async t => {
  const f = await fixture(t);
  await f.click('Plan');
  await f.settle(() => f.requests.length === 1);
  const request = new URL(f.requests[0].url, 'http://localhost');
  assert.equal(request.pathname, '/api/file');
  assert.equal(request.searchParams.get('session'), '/sessions/a.jsonl');
  assert.equal(request.searchParams.get('path'), 'local://PLAN.md');
  assert.equal(f.requests[0].options.headers.get('Authorization'), 'Bearer synthetic-resource-token');
  await f.complete(0, 'A’s private plan\n');
  assert.equal(f.content(), 'A’s private plan\n');
  assert.equal(f.w.document.querySelector('[data-testid="file-edit"]'), null);
  assert.match(f.w.document.body.textContent, /Read-only session file/);
  assert.equal(f.w.document.querySelector('a[href^="local:"],a[href^="artifact:"]'), null);
});

test('navigation cannot retarget an open link, and late old-session results cannot replace a newer selection', async t => {
  const f = await fixture(t);
  await f.click('Output');
  await f.settle(() => f.requests.length === 1);
  await f.render('/sessions/b.jsonl');
  assert.equal(new URL(f.requests[0].url, 'http://localhost').searchParams.get('session'), '/sessions/a.jsonl');
  assert.equal(new URL(f.requests[0].url, 'http://localhost').searchParams.get('path'), 'artifact://0:raw:2-3');
  await f.complete(0, 'A output remains scoped after navigation');
  assert.equal(f.content(), 'A output remains scoped after navigation');
  // Dismiss via the real sheet before tapping the newly rendered conversation.
  const close = f.w.document.querySelector('button[aria-label="Close"]');
  assert.ok(close);
  await f.act(async () => close.click());
  await f.click('Output');
  await f.settle(() => f.requests.length === 2);
  assert.equal(new URL(f.requests[1].url, 'http://localhost').searchParams.get('session'), '/sessions/b.jsonl');
  await f.complete(1, 'B output, same URI');
  assert.equal(f.content(), 'B output, same URI');
});

test('a late result from a replaced resource is ignored', async t => {
  const f = await fixture(t);
  await f.click('Plan');
  await f.settle(() => f.requests.length === 1);
  await f.act(async () => f.w.document.querySelector('button[aria-label="Close"]').click());
  await f.render('/sessions/b.jsonl');
  await f.click('Output');
  await f.settle(() => f.requests.length === 2);
  await f.complete(1, 'B saved result');
  await f.complete(0, 'obsolete A private plan');
  assert.equal(f.content(), 'B saved result');
  assert.doesNotMatch(f.w.document.body.textContent, /obsolete A private plan/);
});

test('unavailable outputs show an error without external navigation or parent-session fallback', async t => {
  const f = await fixture(t);
  await f.click('artifact://1');
  await f.settle(() => f.requests.length === 1);
  await f.complete(0, '', 'saved output is unavailable in this conversation');
  assert.equal(f.content(), undefined);
  assert.match(f.w.document.body.textContent, /saved output is unavailable/i);
  await f.act(async () => f.w.document.querySelector('button[aria-label="Close"]').click());
  await f.render(null);
  await f.click('Plan');
  assert.equal(f.requests.length, 1);
  assert.match(f.w.document.body.textContent, /conversation’s saved files are unavailable/);
});

test('ordinary links and code literals do not become session resource actions', async t => {
  const f = await fixture(t);
  assert.equal(f.w.document.querySelector('a[href="https://example.com/page"]')?.textContent, 'Website');
  assert.equal(f.button('artifact://9'), undefined);
  assert.equal(f.button('local://literal'), undefined);
  assert.equal(f.button('artifact://8'), undefined);
  assert.equal(f.requests.length, 0);
});
