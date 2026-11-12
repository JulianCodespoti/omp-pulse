import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const code = await bundleDomFixture(`
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { HiddenUnderPanels } from ${JSON.stringify(resolve(root, 'web/src/app/chat/HiddenUnderPanels.tsx'))};
import { ScreenActivityContext } from ${JSON.stringify(resolve(root, 'web/src/app/nav/screen-activity.ts'))};
import { openSwitcher, openWorkspace, closePanels } from ${JSON.stringify(resolve(root, 'web/src/app/nav/panels.ts'))};
function Notice() {
  return createPortal(h(HiddenUnderPanels, null, h('button', {id:'chat-notice'}, 'Retry')), document.body);
}
window.fixture = { act, openSwitcher, openWorkspace, closePanels, mount() {
  const root = createRoot(document.getElementById('root'));
  return { render: active => root.render(h(ScreenActivityContext.Provider, {value:active}, h(Notice))), unmount: () => root.unmount() };
} };
`);

async function fixture(t) {
  const dom = createDomFixture(code), f = dom.window.fixture;
  let mounted;
  await f.act(async () => { mounted = f.mount(); mounted.render(true); });
  t.after(async () => { await f.act(async () => mounted.unmount()); dom.close(); });
  return {
    f, shown: () => dom.window.document.querySelector('#chat-notice') !== null,
    active: value => f.act(async () => mounted.render(value)),
  };
}

test('a chat notice portal stands down while a pushed screen owns the foreground', async t => {
  const f = await fixture(t);
  assert.equal(f.shown(), true);
  await f.active(false);
  assert.equal(f.shown(), false);
  await f.active(true);
  assert.equal(f.shown(), true);
});

for (const drawer of ['switcher', 'workspace']) test(`a chat notice remains hidden under the ${drawer}`, async t => {
  const f = await fixture(t);
  await f.f.act(async () => drawer === 'switcher' ? f.f.openSwitcher() : f.f.openWorkspace('files'));
  assert.equal(f.shown(), false);
  await f.f.act(async () => f.f.closePanels());
  assert.equal(f.shown(), true);
});
