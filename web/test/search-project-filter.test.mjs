import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Message search narrowed to the project chosen on the Sessions screen: the
// client only has to put the folder on /api/search; the daemon does the filtering.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
  import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
  const urls = [];
  DaemonApi.prototype.dedupedFetch = async (url) => { urls.push(url); return { hits: [], truncated: false, scannedFiles: 0 }; };
  import { matchesQuery } from ${JSON.stringify(resolve(root, 'web/src/app/session-format.ts'))};
  window.fixture = { urls, matchesQuery, search: (...args) => new DaemonApi('synthetic').searchMessages(...args) };
`);

test('searchMessages sends the project only when one is selected', async t => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const { urls, search } = dom.window.fixture;
  await search('alpha', 50);
  await search('alpha', 50, null);
  await search('alpha', 50, '/work/a b');
  assert.deepEqual(Array.from(urls), [
    '/api/search?q=alpha&limit=50',
    '/api/search?q=alpha&limit=50',
    '/api/search?q=alpha&limit=50&project=%2Fwork%2Fa+b',
  ]);
});

test('session list search also matches the session id', async t => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const { matchesQuery } = dom.window.fixture;
  const session = { id: 'ab12cd34-0000', path: '/s/a.jsonl', title: 'Fix login', cwd: '/work/app' };
  assert.equal(matchesQuery(session, 'AB12CD'), true);
  assert.equal(matchesQuery(session, 'zzzz'), false);
  assert.equal(matchesQuery({ ...session, id: undefined }, 'ab12cd'), false);
});
