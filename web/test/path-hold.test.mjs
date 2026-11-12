import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { PathChip } from ${JSON.stringify(resolve(root, "web/src/app/parts/PathChip.tsx"))};
  const notices = [], opened = [];
  window.fixture = { act, notices, opened, mount: () => {
    const r = createRoot(document.getElementById('root'));
    const render = (path) => r.render(createElement(PathChip, { path, onOpen: p => opened.push(p) }));
    render('/synthetic/alpha.ts'); return { render, unmount: () => r.unmount() };
  } };
`, [{ name: "notice-sink", resolveId: (id, importer) =>
  importer?.endsWith("/PathChip.tsx") && id === "@/app/Notices" ? "\0notices" : null,
  load: (id) => id === "\0notices" ? "export const showToast = (...args) => window.fixture.notices.push(args)" : null,
}]);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, { act, notices, opened } = w.fixture;
  const copies = [], timers = new Map(); let nextTimer = -1;
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => copies.push(text) } });
  const setTimeout = w.setTimeout.bind(w), clearTimeout = w.clearTimeout.bind(w);
  w.setTimeout = (fn, delay, ...args) => {
    if (delay !== 550) return setTimeout(fn, delay, ...args);
    const id = nextTimer--; timers.set(id, () => fn(...args)); return id;
  };
  w.clearTimeout = id => { if (!timers.delete(id)) clearTimeout(id); };
  let mounted, closed = false;
  await act(async () => { mounted = w.fixture.mount(); });
  const unmount = async () => { if (!closed) { closed = true; await act(async () => mounted.unmount()); } };
  t.after(async () => { try { await unmount(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  return { copies, notices, opened, unmount,
    touch: type => act(async () => w.document.querySelector('[data-testid="path-chip"]').dispatchEvent(new w.Event(type, { bubbles: true }))),
    elapse: () => act(async () => { for (const [id, fire] of [...timers]) { timers.delete(id); fire(); } }),
    replacePath: path => act(async () => mounted.render(path)),
  };
}

for (const event of ['touchcancel', 'touchmove', 'touchend']) {
  test(`${event} prevents a pending path hold from copying`, async t => {
    const f = await fixture(t); await f.touch('touchstart'); await f.touch(event); await f.elapse();
    assert.deepEqual(f.copies, []); assert.equal(f.notices.length, 0);
  });
}

test('a replaced path cannot complete an old hold', async t => {
  const f = await fixture(t); await f.touch('touchstart'); await f.replacePath('/synthetic/beta.ts'); await f.elapse();
  assert.deepEqual(f.copies, []);
  await f.touch('touchstart'); await f.elapse(); assert.deepEqual(f.copies, ['/synthetic/beta.ts']);
});

test('unmount clears a pending path hold', async t => {
  const f = await fixture(t); await f.touch('touchstart'); await f.unmount(); await f.elapse();
  assert.deepEqual(f.copies, []);
});

test('an uninterrupted hold copies once without opening the file', async t => {
  const f = await fixture(t); await f.touch('touchstart'); await f.elapse();
  assert.deepEqual(f.copies, ['/synthetic/alpha.ts']); assert.equal(f.notices.length, 1);
  assert.equal(f.opened.length, 0);
});
