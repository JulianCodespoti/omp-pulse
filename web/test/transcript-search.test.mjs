import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { SessionSwitcher } from ${JSON.stringify(resolve(root, "web/src/app/nav/SessionSwitcher.tsx"))};
  import { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  import { DaemonApi } from ${JSON.stringify(resolve(root, "web/src/runtime/rpc-client.ts"))};
  const pending = [], opened = [];
  DaemonApi.prototype.awaiting = async () => [];
  DaemonApi.prototype.searchMessages = (q) => new Promise((resolve, reject) => pending.push({ q, resolve, reject }));
  const store = createOmpStore();
  let allSessions = [];
  const controller = {
    getStore: () => store,
    loadSessions: async () => {},
    querySwitcherSessionsPage: async ({ query }) => {
      const q = (query ?? "").trim().toLowerCase();
      return {
        sessions: allSessions.filter((s) => !q || s.title.toLowerCase().includes(q)),
        nextCursor: null,
      };
    },
  };
  window.fixture = {
    act, pending, opened,
    mount: (sessions) => {
      allSessions = sessions;
      store.setState({ sessions, sessionsUpdatedAt: Date.now() });
      const r = createRoot(document.getElementById("root"));
      r.render(createElement(SessionSwitcher, {
        controller,
        active: true,
        currentPath: null,
        onSwitch: (path, entryId) => opened.push([path, entryId]),
      }));
      return r;
    },
  };
`, [{
  name: "closed-lazy-sheets",
  resolveId(id, importer) {
    if (importer?.endsWith("/SessionSwitcher.tsx") && id === "../sessions/AnswerSheet") return "\0AnswerSheet";
    return null;
  },
  load(id) {
    if (id === "\0AnswerSheet") return "export const AnswerSheet = () => null";
    return null;
  },
}]);

const hit = (path, line, title = "Synthetic", entryId) => ({ path, line, title, entryId });
const filler = { path: "/synthetic/filler.jsonl", title: "Filler", cwd: "/synthetic/p", activeAt: 1, running: false };

async function fixture(t, sessions = []) {
  const dom = createDomFixture(code), w = dom.window;
  w.localStorage.setItem("omp-remote-token", "synthetic-fixture");
  const { act, pending, opened } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount(sessions.length ? sessions : [filler]); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const el = (id) => w.document.querySelector(`[data-testid="${id}"]`);
  const all = (id) => Array.from(w.document.querySelectorAll(`[data-testid="${id}"]`));
  const click = (id) => act(async () => { assert.ok(el(id), id); el(id).click(); });
  const settle = () => act(async () => { await new Promise((r) => w.setTimeout(r, 300)); });
  await click("switcher-search-toggle");
  const type = async (text) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(el("session-search"), text);
      el("session-search").dispatchEvent(new w.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const finish = (index, hits = [], fail = false, truncated = false) => act(async () => {
    if (fail) pending[index].reject(new Error("Synthetic failure"));
    else pending[index].resolve({ hits, truncated, scannedFiles: truncated ? 200 : 3 });
  });
  const openedArgs = () => Array.from(opened, (args) => Array.from(args));
  await type("alpha");
  return { w, act, pending, openedArgs, el, all, click, type, finish };
}

test("one query in the drawer searches messages too, with no extra button", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Array.from(f.pending, (x) => x.q), ["alpha"]);
  assert.ok(f.el("message-search-loading"));
  await f.finish(0, [hit("/synthetic/a.jsonl", "alpha line", "Found it")]);
  const row = f.el("message-hit");
  assert.equal(row.dataset.sessionPath, "/synthetic/a.jsonl");
  assert.match(row.textContent, /Found it/);
  assert.match(row.textContent, /alpha line/);
  await f.click("message-hit");
  assert.deepEqual(f.openedArgs(), [["/synthetic/a.jsonl", undefined]]);
});

test("several hits in one session are one row", async (t) => {
  const f = await fixture(t);
  await f.finish(0, [hit("/synthetic/a.jsonl", "first"), hit("/synthetic/a.jsonl", "second")]);
  assert.equal(f.all("message-hit").length, 1);
  assert.match(f.el("message-hit").textContent, /2 matches · first/);
});

test("title matches and message matches show together", async (t) => {
  const f = await fixture(t, [{ path: "/synthetic/t.jsonl", title: "alpha plan", cwd: "/synthetic/p", activeAt: Date.now(), running: false }]);
  await f.finish(0, [hit("/synthetic/m.jsonl", "alpha in a message")]);
  assert.match(f.el("session-row").textContent, /alpha plan/);
  assert.ok(f.el("message-hit"));
  assert.equal(f.el("empty-no-search"), null);
});

test("typing a new query discards the previous message search response", async (t) => {
  const f = await fixture(t);
  await f.type("beta");
  assert.deepEqual(Array.from(f.pending, (x) => x.q), ["alpha", "beta"]);
  await f.finish(0, [hit("/synthetic/a.jsonl", "alpha line")]);
  assert.equal(f.el("message-hit"), null);
  await f.finish(1, [hit("/synthetic/b.jsonl", "beta line")]);
  assert.match(f.el("message-hit").textContent, /beta line/);
});

test("a previous query failure cannot show an error against a newer query", async (t) => {
  const f = await fixture(t);
  await f.type("beta");
  await f.finish(0, [], true);
  assert.equal(f.el("message-search-error"), null);
});

test("clearing the search invalidates pending message results", async (t) => {
  const f = await fixture(t, [{ path: "/synthetic/z.jsonl", title: "Zeta", cwd: "/synthetic/p", activeAt: Date.now(), running: false }]);
  await f.click("clear-search");
  await f.finish(0, [hit("/synthetic/a.jsonl", "alpha line")]);
  assert.equal(f.el("session-search").value, "");
  assert.equal(f.el("message-results"), null);
});

test("one letter searches titles only", async (t) => {
  const f = await fixture(t);
  await f.type("a");
  assert.equal(f.pending.length, 1);
  assert.equal(f.el("message-results"), null);
});

test("nothing anywhere: one No sessions match", async (t) => {
  const f = await fixture(t);
  assert.equal(f.el("empty-no-search"), null);
  await f.finish(0, []);
  assert.equal(f.all("empty-no-search").length, 1);
  assert.match(f.el("empty-no-search").textContent, /No sessions match/);
  assert.equal(f.el("message-results"), null);
});

test("current query failures are shown in the Messages group and can be retried", async (t) => {
  const f = await fixture(t);
  await f.finish(0, [], true);
  assert.match(f.el("message-search-error").textContent, /Couldn’t search messages/);
  assert.equal(f.el("empty-no-search"), null);
  await f.act(async () => f.el("message-search-error").querySelector("button").click());
  assert.equal(f.pending.length, 2);
  await f.finish(1, [hit("/synthetic/a.jsonl", "alpha line")]);
  assert.ok(f.el("message-hit"));
  assert.equal(f.el("message-search-error"), null);
});

test("opening a message hit lands on its session's newest matching entry", async (t) => {
  const f = await fixture(t);
  await f.finish(0, [hit("/synthetic/a.jsonl", "alpha newest", "A", "e2"), hit("/synthetic/a.jsonl", "alpha older", "A", "e1")]);
  await f.click("message-hit");
  assert.deepEqual(f.openedArgs(), [["/synthetic/a.jsonl", "e2"]]);
});

test("the Messages group says when the daemon's scan caps left older messages unsearched", async (t) => {
  const f = await fixture(t);
  await f.finish(0, [hit("/synthetic/a.jsonl", "alpha line")]);
  assert.equal(f.el("message-search-truncated"), null);
  await f.type("alphabet");
  await f.finish(1, [hit("/synthetic/a.jsonl", "alphabet line")], false, true);
  assert.ok(f.el("message-results").contains(f.el("message-search-truncated")));
});
