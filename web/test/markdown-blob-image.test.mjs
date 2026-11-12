import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { Markdown } from ${JSON.stringify(resolve(root, 'web/src/components/markdown.tsx'))};
window.fixture = { act, mount(text) { const r = createRoot(document.getElementById('root')); r.render(h(Markdown, null, text)); return r; } };
`);

const HASH = '6a9af0e6790d91a45d23f57e13f63a83cd5f2de8caa838b1ebcdcfd9f44ee185';

test('a blob:sha256 image in a reply is fetched from the daemon, not blocked', async t => {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  const fetched = [];
  w.fetch = async (url) => { fetched.push(String(url)); return { ok: true, status: 200, blob: async () => new w.Blob(['x'], { type: 'image/png' }) }; };
  w.URL.createObjectURL = () => 'blob:http://localhost/one';
  w.URL.revokeObjectURL = () => {};
  // The fixture's observer never reports; without one ImagePart reads at once.
  w.IntersectionObserver = undefined;
  let r;
  await act(async () => { r = w.fixture.mount(`Look:\n\n![Mock screen](blob:sha256:${HASH})\n`); });
  for (let i = 0; i < 50 && !w.document.querySelector('img'); i++) await act(async () => { await new Promise(res => setTimeout(res, 20)); });
  t.after(async () => { try { await act(async () => r.unmount()); } finally { dom.close(); } });
  assert.doesNotMatch(w.document.body.textContent, /Image blocked/);
  assert.deepEqual(fetched, [`/api/blob/${HASH}`]);
  assert.equal(w.document.querySelector('img')?.getAttribute('alt'), 'Mock screen');
});
