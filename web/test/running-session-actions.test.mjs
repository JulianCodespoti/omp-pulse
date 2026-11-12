import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
// Stop lives inside the drawer's More… -> SessionActionsSheet for a working session.
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { SessionSwitcher } from ${JSON.stringify(resolve(root, "web/src/app/nav/SessionSwitcher.tsx"))};
  import { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  import { DaemonApi } from ${JSON.stringify(resolve(root, "web/src/runtime/rpc-client.ts"))};
  DaemonApi.prototype.awaiting = async () => [];
  const store = createOmpStore(), calls = { loads: 0, opened: [], stops: [] };
  const controller = {
    getStore: () => store,
    querySwitcherSessionsPage: async () => ({ sessions: store.getState().sessions, nextCursor: null }),
    loadSessions: async () => { calls.loads++; },
    abortTurn: async (path) => { calls.stops.push(path); },
  };
  window.fixture = {
    act,
    calls,
    mount: (sessions) => {
      store.setState({ sessions, sessionsUpdatedAt: Date.now() });
      const r = createRoot(document.getElementById("root"));
      r.render(createElement(SessionSwitcher, { controller, active: true, currentPath: null, onSwitch: (path) => calls.opened.push(path) }));
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
    if (id === "\0AnswerSheet") return "export const AnswerSheet = () => null";
    return null;
  },
}]);

const row = (title, extra = {}) => ({
  path: "/synthetic/" + title + ".jsonl",
  title,
  cwd: "/synthetic/project",
  activeAt: Date.now(),
  running: false,
  ...extra,
});

async function fixture(t, sessions = []) {
  const dom = createDomFixture(code), w = dom.window, { act, calls } = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  w.localStorage.setItem("omp-remote-token", "synthetic-fixture");
  let mounted;
  await act(async () => { mounted = w.fixture.mount(sessions); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const el = (id) => w.document.querySelector(`[data-testid="${id}"]`);
  return {
    w, el, calls, act,
    unmount: () => act(async () => mounted.unmount()),
    pointer: (type, x = 0) => act(async () => el("session-row").dispatchEvent(new w.MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 0 }))),
    hold: () => act(async () => new Promise((r) => w.setTimeout(r, 530))),
    click: (id) => act(async () => { assert.ok(el(id), id); el(id).click(); }),
  };
}

test("holding a working row opens its drawer menu and consumes the following click", async (t) => {
  const f = await fixture(t, [row("Running", { running: true })]);
  await f.pointer("pointerdown"); await f.hold();
  assert.ok(f.el("drawer-actions"));
  await f.pointer("pointerup"); await f.click("session-row");
  assert.equal(f.calls.opened.length, 0); assert.equal(f.calls.stops.length, 0);
});

test("a normal tap on a working row still opens the conversation", async (t) => {
  const f = await fixture(t, [row("Running", { running: true })]);
  await f.pointer("pointerdown"); await f.pointer("pointerup"); await f.click("session-row");
  assert.deepEqual(Array.from(f.calls.opened), ["/synthetic/Running.jsonl"]);
  assert.equal(Boolean(f.el("drawer-actions")), false);
});

for (const event of ["pointercancel", "pointerleave", "pointermove"]) {
  test(`${event} cancels a pending hold`, async (t) => {
    const f = await fixture(t, [row("Running", { running: true })]);
    await f.pointer("pointerdown");
    await f.pointer(event === "pointerleave" ? "pointerout" : event, 30);
    await f.hold();
    assert.equal(Boolean(f.el("drawer-actions")), false);
  });
}

test("Stop lives in More… -> actions sheet of a working session, apart from opening it", async (t) => {
  const f = await fixture(t, [row("Running", { running: true })]);
  await f.pointer("pointerdown"); await f.hold();
  await f.click("drawer-action-more");
  await f.click("action-stop");
  assert.deepEqual(Array.from(f.calls.stops), ["/synthetic/Running.jsonl"]);
  assert.equal(f.calls.opened.length, 0);
});

test("an idle session offers no Stop", async (t) => {
  const f = await fixture(t, [row("Idle")]);
  await f.pointer("pointerdown"); await f.hold();
  await f.click("drawer-action-more");
  assert.ok(f.el("action-sheet"));
  assert.equal(f.el("action-stop"), null);
});

test("unmount clears the outstanding hold timer", async (t) => {
  const f = await fixture(t, [row("Running", { running: true })]);
  const set = f.w.setTimeout.bind(f.w), clear = f.w.clearTimeout.bind(f.w), cleared = [];
  let hold;
  f.w.setTimeout = (fn, ms, ...args) => { const id = set(fn, ms, ...args); if (ms === 500) hold = id; return id; };
  f.w.clearTimeout = (id) => { cleared.push(id); clear(id); };
  await f.pointer("pointerdown"); assert.ok(hold);
  await f.unmount();
  assert.ok(cleared.includes(hold));
});
