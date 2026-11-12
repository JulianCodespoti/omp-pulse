import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const path = '/synthetic/space dir/日本語 file.ts';
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { PathChip } from ${JSON.stringify(resolve(root, 'web/src/app/parts/PathChip.tsx'))};
  import { Notices } from ${JSON.stringify(resolve(root, 'web/src/app/Notices.tsx'))};
  let r; const opened = [];
  const render = (path, viewer = false) => r.render(h('main', {},
    path === null ? null : h(PathChip, { path, onOpen: viewer ? p => opened.push(p) : undefined }), h(Notices)));
  window.fixture = { act, opened, render, mount: (path, viewer) => {
    r = createRoot(document.getElementById('root')); render(path, viewer); return r;
  }};
`);

async function fixture(t, { mode = 'success', legacy = false, viewer = false } = {}) {
  const dom = createDomFixture(code), w = dom.window, { act, opened, render } = w.fixture;
  const writes = [], fallbacks = [], pending = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: mode === 'absent' ? undefined : {
    writeText: text => {
      writes.push(text);
      if (mode === 'reject') return Promise.reject(Error('synthetic denial'));
      if (mode === 'pending') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      return Promise.resolve();
    },
  }});
  w.document.execCommand = command => {
    const area = w.document.querySelector('textarea');
    fallbacks.push({ command, text: area?.value, selected: area?.selectionEnd - area?.selectionStart });
    return legacy;
  };
  let mounted;
  await act(async () => { mounted = w.fixture.mount(path, viewer); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const chip = () => w.document.querySelector('[data-testid="path-chip"]');
  // Feedback is toast-only: the chip's own look must never change on copy.
  const look = chip()?.className;
  return { w, writes, fallbacks, pending, opened, chip, look,
    notices: () => [...w.document.querySelectorAll('[data-slot="toast"]')].map(el => `${el.dataset.tone}:${el.textContent}`),
    click: () => act(async () => chip().click()),
    event: type => act(async () => chip().dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }))),
    render: value => act(async () => render(value, viewer)),
    finish: (index, fail = false) => act(async () => fail ? pending[index].reject(Error('late denial')) : pending[index].resolve()),
    wait: ms => act(async () => { await delay(ms); }),
  };
}

test('chip reads as inline code carrying the full path as one text run', async t => {
  const f = await fixture(t), chip = f.chip();
  assert.equal(chip.tagName, 'BUTTON');
  assert.equal(chip.textContent, path);
  // No dir/base split spans and no rtl truncation trick: the path is plain text.
  assert.equal(chip.children.length, 0);
  assert.equal(chip.getAttribute('dir'), null);
  assert.equal(chip.getAttribute('aria-label'), `Copy path ${path}`);
  for (const cls of ['inline', 'font-mono', 'text-code', 'bg-surface-2', 'rounded-sm']) assert.ok(chip.classList.contains(cls), cls);
  assert.equal(f.look.includes('border '), false, 'not a bordered pill');
});

for (const mode of ['absent', 'reject']) {
  test(`${mode} Clipboard API falls back with the exact path and acknowledged success`, async t => {
    const f = await fixture(t, { mode, legacy: true });
    f.chip().focus(); await f.click();
    assert.deepEqual(f.fallbacks, [{ command: 'copy', text: path, selected: path.length }]);
    assert.deepEqual(f.writes, mode === 'reject' ? [path] : []);
    assert.deepEqual(f.notices(), ['success:Copied path']);
    assert.equal(f.chip().className, f.look);
    assert.equal(f.w.document.querySelector('textarea') === null, true);
    assert.equal(f.w.document.activeElement === f.chip(), true);
  });
}

test('both clipboard methods failing report failure by toast only', async t => {
  const f = await fixture(t, { mode: 'reject' }); await f.click();
  assert.deepEqual(f.writes, [path]);
  assert.deepEqual(f.fallbacks, [{ command: 'copy', text: path, selected: path.length }]);
  assert.deepEqual(f.notices(), ["error:Couldn't copy path"]);
  assert.equal(f.chip().className, f.look);
});

test('modern success copies exactly and does not invoke legacy copying', async t => {
  const f = await fixture(t); await f.click();
  assert.deepEqual(f.writes, [path]); assert.deepEqual(f.fallbacks, []);
  assert.deepEqual(f.notices(), ['success:Copied path']);
  assert.equal(f.chip().className, f.look);
  await f.wait(1250); assert.equal(f.chip().className, f.look);
});

test('viewer tap opens while a 550 ms hold and contextmenu copy only once', async t => {
  const f = await fixture(t, { viewer: true }); await f.click();
  assert.deepEqual(Array.from(f.opened), [path]); assert.deepEqual(f.writes, []);
  await f.event('touchstart'); assert.deepEqual(f.writes, []);
  await f.wait(600); await f.event('contextmenu');
  assert.deepEqual(f.writes, [path]); assert.deepEqual(f.notices(), ['success:Copied path']);
  assert.equal(f.opened.length, 1);
});

for (const replacement of [null, '/synthetic/replacement.ts']) {
  for (const fail of [false, true]) {
    test(`pending ${fail ? 'failure' : 'success'} after ${replacement === null ? 'unmount' : 'path change'} produces no stale feedback`, async t => {
      const f = await fixture(t, { mode: 'pending' }); await f.click();
      await f.render(replacement);
      if (replacement !== null) {
        await f.click(); assert.deepEqual(f.writes, [path, replacement]);
      }
      await f.finish(0, fail);
      assert.deepEqual(f.notices(), []);
      if (replacement !== null) {
        assert.equal(f.chip().textContent, replacement);
        assert.equal(f.chip().className, f.look);
        await f.click(); assert.equal(f.writes.length, 2);
        await f.finish(1); assert.deepEqual(f.notices(), ['success:Copied path']);
      }
    });
  }
}

test('replacement resets the copy gate and immediately copies its own path', async t => {
  const f = await fixture(t); await f.click(); await f.wait(650);
  await f.render('/synthetic/next.ts');
  assert.equal(f.chip().textContent, '/synthetic/next.ts');
  assert.equal(f.chip().className, f.look);
  // Still inside the 2s dedupe window of the old path; the new path is not gated by it.
  await f.click(); assert.deepEqual(f.writes, [path, '/synthetic/next.ts']);
  assert.deepEqual(f.notices(), ['success:Copied path']);
});

test('a slow pending write stays deduplicated beyond the gesture window', async t => {
  const f = await fixture(t, { mode: 'pending' }); await f.click();
  await f.wait(2100); await f.click(); assert.deepEqual(f.writes, [path]);
  await f.finish(0); assert.deepEqual(f.notices(), ['success:Copied path']);
});
