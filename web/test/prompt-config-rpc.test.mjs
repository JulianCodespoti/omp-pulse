import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = `export { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
export { resolveHistoryText } from ${JSON.stringify(resolve(root, 'web/src/domain/prompt-history.ts'))};`;
const build = await rolldown({
  input: 'prompt-config-fixture', platform: 'node',
  transform: { define: { 'import.meta.env': JSON.stringify({ VITE_PROTOCOL_VERSION: 1 }) } },
  plugins: [{ name: 'prompt-config-fixture',
    resolveId: id => id === 'prompt-config-fixture' ? '\0prompt-config-fixture' : null,
    load: id => id === '\0prompt-config-fixture' ? source : null,
  }],
});
let DaemonApi, resolveHistoryText;
try {
  const generated = await build.generate({ format: 'esm', codeSplitting: false });
  ({ DaemonApi, resolveHistoryText } = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString('base64')}`));
} finally { await build.close(); }

function fixture(t, value) {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
  return new DaemonApi('synthetic-token', 'https://synthetic.invalid');
}

test('an authoritative disabled configuration stays disabled, never replaced with defaults', async t => {
  const api = fixture(t, { ok: true, data: { magicKeywords: [] } });
  assert.deepEqual(await api.getPromptConfig('/synthetic/session'), { magicKeywords: [] });
});

for (const data of [{}, null, { magicKeywords: [{ id: 'x', word: 'x', hue: [2] }] }, { magicKeywords: [{ id: 'x', word: 'x', hue: ['2', 3] }] }]) {
  test(`missing or malformed metadata refuses instead of supplying assumed keywords: ${JSON.stringify(data)}`, async t => {
    const api = fixture(t, { ok: true, data });
    await assert.rejects(api.getPromptConfig('/synthetic/session'), /configuration is unavailable/);
  });
}

test('owner refusal is preserved rather than converted to a fallback configuration', async t => {
  const api = fixture(t, { ok: false, error: 'owner bridge unavailable' });
  await assert.rejects(api.getPromptConfig('/synthetic/session'), /owner bridge unavailable/);
});

test('mention selector survives response parsing without model-setting side effects', async t => {
  const api = fixture(t, { ok: true, data: { choices: [{ selector: 'p/exact-id', name: 'Friendly', provider: 'p' }] } });
  assert.deepEqual(await api.getModelMentionChoices('/synthetic/session'), [{ selector: 'p/exact-id', name: 'Friendly', provider: 'p' }]);
});

test('history restores multipart original text without merging adjacent words or collapsing whitespace', async t => {
  const api = fixture(t, { entries: [{ id: 'saved-user', message: { role: 'user', content: [
    { type: 'text', text: 'first' }, { type: 'image', data: 'not-text' },
    { type: 'text', text: 'second\n\nthird' },
  ] } }] });
  const item = { origin: 'transcript', text: 'first second third', truncated: false,
    session: { path: '/synthetic/session', offset: 123, entryId: 'saved-user' } };
  const full = await resolveHistoryText(item, (...args) => api.readUserMessageAt(...args));
  assert.equal(full, 'first\nsecond\n\nthird');
});

test('a rewritten history offset cannot restore a different entry with identical preview text', async t => {
  const api = fixture(t, { entries: [{ id: 'replacement', message: { role: 'user', content: 'Same preview' } }] });
  await assert.rejects(resolveHistoryText({
    origin: 'transcript', text: 'Same preview', truncated: false,
    session: { path: '/synthetic/session', offset: 123, entryId: 'original' },
  }, (...args) => api.readUserMessageAt(...args)));
});
