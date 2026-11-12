import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// "Forget this pairing" clears prompt history for the forgotten credential's
// namespace only: another pairing on the same phone keeps its own history.
const code = await bundleDomFixture(`
import { clearPromptHistory, readPromptHistory, recordPromptHistory } from ${JSON.stringify(resolve(root, 'web/src/app/composer/prompt-history-store.ts'))};
window.fixture = { clearPromptHistory, readPromptHistory, recordPromptHistory };
`);

test('forgetting a pairing clears its prompt history and no other', (t) => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const f = dom.window.fixture;
  f.recordPromptHistory('export TOKEN=secret', 'forgotten');
  f.recordPromptHistory('another pairing', 'kept');
  assert.equal(f.readPromptHistory('forgotten').length, 1);
  f.clearPromptHistory('forgotten');
  assert.equal(dom.window.localStorage.getItem('omp-prompt-history:forgotten'), null);
  assert.equal(f.readPromptHistory('forgotten').length, 0);
  assert.equal(f.readPromptHistory('kept').length, 1);
});
