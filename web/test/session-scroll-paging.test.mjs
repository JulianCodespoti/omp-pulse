import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

// Older sessions load inside the drawer when the end-of-list sentinel nears the
// viewport, or from the button; a failed page is not retried automatically.
const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { SessionSwitcher } from ${JSON.stringify(resolve(root, "web/src/app/nav/SessionSwitcher.tsx"))};
  import { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  import { DaemonApi } from ${JSON.stringify(resolve(root, "web/src/runtime/rpc-client.ts"))};
  DaemonApi.prototype.awaiting = async () => [];
  const observers = new Set();
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() { observers.add(this); } disconnect() { observers.delete(this); } };
  const store = createOmpStore(), calls = { more: 0 };
  let fail = false;
  const controller = {
    getStore: () => store,
    loadSessions: async () => {},
    querySwitcherSessionsPage: async ({ cursor }) => {
      if (!cursor) {
        return { sessions: [{ path: "/synthetic/new.jsonl", title: "new", cwd: "/synthetic/p", activeAt: Date.now() }], nextCursor: "c1" };
      }
      calls.more++;
      if (fail) throw new Error("down");
      return { sessions: [{ path: "/synthetic/old.jsonl", title: "old", cwd: "/synthetic/p", activeAt: 1 }], nextCursor: null };
    },
  };
  window.fixture = {
    act, calls, store, observers,
    fail: () => { fail = true; },
    mount: () => {
      const r = createRoot(document.getElementById("root"));
      r.render(createElement(SessionSwitcher, { controller, active: true, currentPath: null, onSwitch() {} }));
      return r;
    },
  };
`, [{
  name: "closed-sheet-boundaries",
  resolveId(id, importer) {
    if (importer?.endsWith("/SessionSwitcher.tsx") && id === "../sessions/AnswerSheet") return "\0AnswerSheet";
    return null;
  },
  load(id) {
    if (id === "\0AnswerSheet") return "export const AnswerSheet = () => null;";
    return null;
  },
}]);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  w.localStorage.setItem("omp-remote-token", "synthetic-fixture");
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => { try { await act(async () => mounted.unmount()); } finally { dom.close(); } });
  const see = () => act(async () => { for (const o of [...w.fixture.observers]) o.cb([{ isIntersecting: true }]); });
  return { w, act, see, fx: w.fixture };
}

test("the drawer sentinel pulls the next page and ends when the daemon has no more", async (t) => {
  const f = await fixture(t);
  await f.see();
  assert.equal(f.fx.calls.more, 1);
  assert.equal(f.w.document.querySelectorAll('[data-testid="session-row"]').length, 2);
  assert.equal(f.w.document.querySelector('[data-testid="session-load-more"]'), null);
});

test("a failed drawer page is not retried by the sentinel, only by the button", async (t) => {
  const f = await fixture(t);
  f.fx.fail();
  await f.see();
  await f.see();
  assert.equal(f.fx.calls.more, 1);
  await f.act(async () => f.w.document.querySelector('[data-testid="session-load-more"]').click());
  assert.equal(f.fx.calls.more, 2);
});
