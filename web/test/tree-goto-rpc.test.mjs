import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const code = await bundleDomFixture(`
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
window.api = new DaemonApi('synthetic-token');
`);
function fixture(t, data) {
  const dom = createDomFixture(code);
  dom.window.fetch = async () =>
    new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } });
  t.after(() => { assert.deepEqual(dom.blocked, []); dom.close(); });
  return { api: dom.window.api };
}
for (const data of [null, {}, { editorText: 'Not evidence of a commit' }]) test(`missing tree outcome never masquerades as successful navigation: ${JSON.stringify(data)}`, async t => {
  const f = fixture(t, data);
  await assert.rejects(f.api.treeGoto('/synthetic/a', 'u1', { summarize: false }), /did not report the outcome/);
});

