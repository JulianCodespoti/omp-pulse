import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Exercise the production controller and store without starting Vite, a daemon,
// sockets or a provider. Only transport and unrelated model/tool side effects
// are replaced; history normalization, ledger, eviction and fencing are real.
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-latest-unit-"));
after(() => rm(directory, { recursive: true, force: true }));
const bundle = await rolldown({
  input: "history-fixture",
  plugins: [{
    name: "history-fixture",
    resolveId: (id) => id === "history-fixture" ? "\0history-fixture" : null,
    load: (id) => id === "\0history-fixture" ? `
      export { OmpSessionController } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-session-controller.ts"))};
      export { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
    ` : null,
  }],
  platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }) } },
});
await bundle.write({ file: resolve(directory, "controller.mjs"), format: "esm" });
await bundle.close();
const { OmpSessionController, createOmpStore } = await import(pathToFileURL(resolve(directory, "controller.mjs")).href);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const path = "/tmp/synthetic.jsonl";
const user = (id) => ({ type: "message", id, message: { id, role: "user", content: [{ type: "text", text: id }] } });
const metadata = { type: "title", title: "History metadata" };
const page = (ids, nextBefore) => ({ entries: ids.map(user), nextBefore });
const ids = (store) => store.getState().messages.map((message) => message.sourceEntryId);

function fixture({ cap = 4, atBottom = true, initial = ["u8", "u9"], cursor = 100 } = {}) {
  const earlier = deferred();
  const tail = deferred();
  const reads = [];
  const store = createOmpStore();
  store.getState().beginSession(path);
  const controller = Object.create(OmpSessionController.prototype);
  Object.assign(controller, {
    activeSession: path, generation: 1, disposed: false, earlierEpoch: 0, earlierInFlight: false, earlierLimit: 50,
    windowMessages: cap, atBottom, store,
    fetchHistory: (_path, options) => {
      reads.push(options);
      return options.before === undefined ? tail.promise : earlier.promise;
    },
    recordSuccess: () => {}, adoptSessionModelEntries: () => {}, adoptPlanEntries: () => {}, handleToolExecutionStarts: () => {},
  });
  controller.applyTailPage(page(initial, cursor));
  return { controller, store, reads, earlier, tail };
}

function replies(f, pages) {
  f.controller.fetchHistory = async (requestedPath, options) => {
    assert.equal(requestedPath, f.controller.activeSession);
    f.reads.push(options);
    assert.ok(pages.has(options.before), `unexpected history cursor ${options.before}`);
    const response = pages.get(options.before);
    if (response instanceof Error) throw response;
    return response;
  };
}

for (const method of ["loadEarlier", "reloadEvictedTop"]) {
  test(`${method}: an old earlier page cannot apply after a tail replacement`, async () => {
    const f = fixture();
    f.store.setState({ evictedBottom: 20, evictedTop: { before: 100, count: 50 } });
    const old = f.controller[method]();
    const latest = f.controller.jumpToLatest();
    f.tail.resolve(page(["latest"], 700));
    assert.equal(await latest, true);
    const authoritative = f.store.getState();
    f.earlier.resolve(page(["stale"], 80));
    await old;
    assert.deepEqual(ids(f.store), ["latest"]);
    assert.equal(f.store.getState().historyCursor, 700);
    assert.deepEqual(f.store.getState().historyPages, authoritative.historyPages);
    assert.equal(f.store.getState().evictedTop, null);
    assert.equal(f.controller.earlierInFlight, false);
    assert.equal(f.store.getState().loadingEarlier, false);
  });
}

test("a cancelled latest visit cannot replace the visible history", async () => {
  const f = fixture();
  f.store.setState({ evictedBottom: 20 });
  const original = f.store.getState();
  let current = true;
  const latest = f.controller.jumpToLatest(() => current);
  current = false;
  f.tail.resolve(page(["cancelled"], 700));
  assert.equal(await latest, false);
  assert.equal(f.store.getState(), original);
});

test("a changed session rejects the old tail", async () => {
  const f = fixture();
  f.store.setState({ evictedBottom: 20 });
  const latest = f.controller.jumpToLatest();
  f.controller.activeSession = "/tmp/new.jsonl";
  f.controller.generation++;
  f.store.getState().beginSession(f.controller.activeSession);
  const fresh = f.store.getState();
  f.tail.resolve(page(["stale"], 700));
  assert.equal(await latest, false);
  assert.equal(f.store.getState(), fresh);
});

test("ordinary earlier pagination still applies without a latest request", async () => {
  const f = fixture();
  const earlier = f.controller.loadEarlier();
  f.earlier.resolve(page(["u6", "u7"], 80));
  assert.equal(await earlier, true);
  assert.deepEqual(ids(f.store), ["u6", "u7", "u8", "u9"]);
  assert.equal(f.store.getState().historyCursor, 80);
  assert.equal(f.controller.earlierInFlight, false);
  assert.equal(f.store.getState().loadingEarlier, false);
});

test("gap restoration crosses metadata pages and preserves exact re-eviction cursors", async () => {
  const f = fixture({ atBottom: false, initial: ["u3"], cursor: 60 });
  f.store.setState({ evictedTop: { before: 100, count: 2 } });
  replies(f, new Map([
    [100, { entries: [user("u2"), metadata], nextBefore: 80 }],
    [80, { entries: [metadata], nextBefore: 70 }],
    [70, page(["u1"], 60)],
  ]));
  assert.equal(await f.controller.reloadEvictedTop(), true);
  assert.deepEqual(f.reads.map((read) => read.before), [100, 80, 70]);
  assert.deepEqual(ids(f.store), ["u1", "u2", "u3"]);
  assert.equal(f.store.getState().evictedTop, null);
  assert.deepEqual(f.store.getState().historyPages, [
    { before: 70, nextBefore: 60, firstId: "u1", lastId: "u1", count: 1 },
    { before: 100, nextBefore: 80, firstId: "u2", lastId: "u2", count: 1 },
    { before: null, nextBefore: 60, firstId: "u3", lastId: "u3", count: 1 },
  ]);
  f.store.getState().trimWindow(2, true);
  assert.deepEqual(ids(f.store), ["u2", "u3"]);
  assert.deepEqual(f.store.getState().evictedTop, { before: 70, count: 1 });
  assert.equal(await f.controller.reloadEvictedTop(), true);
  assert.deepEqual(ids(f.store), ["u1", "u2", "u3"]);
  assert.equal(f.store.getState().evictedTop, null);
});

test("partial restoration resumes after a bounded metadata/duplicate batch instead of replaying its original cursor", async () => {
  const f = fixture({ atBottom: false, initial: ["u3"], cursor: 20 });
  f.store.setState({ evictedTop: { before: 100, count: 2 } });
  replies(f, new Map([
    [100, { entries: [user("u2"), metadata], nextBefore: 80 }],
    [80, { entries: [metadata], nextBefore: 70 }],
    [70, page(["u2"], 60)],
    [60, { entries: [metadata], nextBefore: 50 }],
    [50, { entries: [metadata], nextBefore: 40 }],
    [40, page(["u1"], 20)],
  ]));
  assert.equal(await f.controller.reloadEvictedTop(), true);
  assert.equal(f.reads.length, 5);
  assert.deepEqual(f.store.getState().evictedTop, { before: 40, count: 1 });
  assert.deepEqual(ids(f.store), ["u2", "u3"]);
  assert.equal(await f.controller.reloadEvictedTop(), true);
  assert.deepEqual(f.reads.map((read) => read.before), [100, 80, 70, 60, 50, 40]);
  assert.deepEqual(ids(f.store), ["u1", "u2", "u3"]);
  assert.equal(f.store.getState().evictedTop, null);
  assert.equal(f.store.getState().historyPages.reduce((count, held) => count + held.count, 0), 3);
});

test("a metadata-only batch is bounded and persists its cursor without decrementing missing rows", async () => {
  const f = fixture({ atBottom: false });
  f.store.setState({ evictedTop: { before: 100, count: 2 } });
  f.controller.fetchHistory = async (_path, options) => {
    f.reads.push(options);
    return { entries: [metadata], nextBefore: options.before - 10 };
  };
  assert.equal(await f.controller.reloadEvictedTop(), false);
  assert.equal(f.reads.length, 5);
  assert.deepEqual(f.store.getState().evictedTop, { before: 50, count: 2 });
  assert.deepEqual(ids(f.store), ["u8", "u9"]);
  assert.equal(await f.controller.reloadEvictedTop(), false);
  assert.equal(f.reads[5].before, 50);
  assert.deepEqual(f.store.getState().evictedTop, { before: 0, count: 2 });
});

for (const response of [
  { entries: [], nextBefore: 80 },
  { entries: [metadata], nextBefore: 100 },
  { entries: [metadata], nextBefore: 110 },
  { entries: [metadata], nextBefore: null },
]) {
  test(`empty/stalled gap reads keep the unresolved gap (${JSON.stringify(response)})`, async () => {
    const f = fixture({ atBottom: false });
    f.store.setState({ evictedTop: { before: 100, count: 2 } });
    replies(f, new Map([[100, response]]));
    assert.equal(await f.controller.reloadEvictedTop(), false);
    assert.equal(f.reads.length, 1);
    assert.deepEqual(f.store.getState().evictedTop, { before: 100, count: 2 });
    assert.deepEqual(ids(f.store), ["u8", "u9"]);
  });
}

test("a failure after partial gap restoration preserves resumable progress", async () => {
  const f = fixture({ atBottom: false, initial: ["u3"], cursor: 60 });
  f.store.setState({ evictedTop: { before: 100, count: 2 } });
  replies(f, new Map([[100, page(["u2"], 80)], [80, new Error("offline")]]));
  assert.equal(await f.controller.reloadEvictedTop(), false);
  assert.deepEqual(f.store.getState().evictedTop, { before: 80, count: 1 });
  assert.deepEqual(ids(f.store), ["u2", "u3"]);
  assert.equal(f.store.getState().error, "offline");
  assert.equal(f.store.getState().loadingEarlier, false);
  replies(f, new Map([[80, page(["u1"], 60)]]));
  assert.equal(await f.controller.reloadEvictedTop(), true);
  assert.equal(f.store.getState().evictedTop, null);
  assert.deepEqual(ids(f.store), ["u1", "u2", "u3"]);
});

test("a session switch during partial restoration cannot apply the next page or clear new loading state", async () => {
  const f = fixture({ atBottom: false, initial: ["u3"], cursor: 20 });
  const requested = deferred();
  const second = deferred();
  f.store.setState({ evictedTop: { before: 100, count: 2 } });
  f.controller.fetchHistory = async (_path, options) => {
    f.reads.push(options);
    if (options.before === 100) return page(["u2"], 80);
    assert.equal(options.before, 80);
    requested.resolve();
    return second.promise;
  };
  const pending = f.controller.reloadEvictedTop();
  await requested.promise;
  assert.deepEqual(f.store.getState().evictedTop, { before: 80, count: 1 });
  f.controller.activeSession = "/tmp/new.jsonl";
  f.controller.generation++;
  f.controller.earlierInFlight = true;
  f.store.getState().beginSession(f.controller.activeSession);
  f.controller.applyTailPage(page(["fresh"], 900));
  f.store.getState().setLoadingEarlier(true);
  const fresh = f.store.getState();
  second.resolve(page(["u1"], 20));
  assert.equal(await pending, false);
  assert.equal(f.store.getState(), fresh);
  assert.equal(f.controller.earlierInFlight, true);
  assert.deepEqual(ids(f.store), ["fresh"]);
});

test("a reveal beyond the cap retains its target through paint, live growth and viewport reports", async () => {
  const f = fixture();
  replies(f, new Map([
    [100, page(["u6", "u7"], 80)],
    [80, page(["u4", "u5"], 60)],
    [60, page(["u2", "u3"], 40)],
    [40, page(["u0", "u1"], null)],
  ]));
  const current = () => true;
  assert.equal(await f.controller.revealEntry("u4", current), "revealed");
  assert.deepEqual(f.reads.map((read) => read.before), [100, 80]);
  assert.deepEqual(ids(f.store), ["u4", "u5", "u6", "u7"]);
  assert.equal(f.controller.atBottom, true, "reveal does not change the reported viewport edge");
  assert.equal(f.store.getState().evictedBottom, 2);
  assert.deepEqual(f.store.getState().historyPages, [
    { before: 80, nextBefore: 60, firstId: "u4", lastId: "u5", count: 2 },
    { before: 100, nextBefore: 80, firstId: "u6", lastId: "u7", count: 2 },
  ]);
  assert.equal(await f.controller.loadEarlier(), true);
  assert.equal(f.reads.length, 2, "auto-prefetch must not push the target out before landing");
  f.controller.setAtBottom(false);
  f.controller.setAtBottom(true);
  for (let i = 10; i < 30; i++) {
    f.controller.mergeHistory([user(`u${i}`)]);
    assert.equal(f.store.getState().messages.length, 4);
    assert.ok(ids(f.store).includes("u4"));
  }
  assert.equal(f.reads.length, 2, "pre-landing edge reports must not trigger a tail replacement");
  f.controller.setAtBottom(false);
  f.controller.releaseRevealedEntry("u4", current);
  assert.equal(f.controller.revealWindow, null);
  assert.equal(f.controller.atBottom, false);
  f.controller.mergeHistory([user("u30")]);
  assert.deepEqual(ids(f.store), ["u4", "u5", "u6", "u7"]);
});

test("reveal caps backward request size and releases its temporary live-edge policy", async () => {
  const f = fixture();
  replies(f, new Map([[100, page(["u4", "u5", "u6", "u7"], 80)]]));
  const current = () => true;
  assert.equal(await f.controller.revealEntry("u7", current), "revealed");
  assert.equal(f.reads[0].limit, 4);
  assert.deepEqual(ids(f.store), ["u4", "u5", "u6", "u7"]);
  f.controller.releaseRevealedEntry("u7", current);
  assert.equal(f.controller.atBottom, true);
  f.controller.mergeHistory([user("u10"), user("u11")]);
  assert.equal(f.store.getState().messages.length, 4);
  // u8 and u9 are not held: u10 and u11 cannot join the window past that hole.
  // They are counted for the jump pill and read back by cursor in order.
  assert.deepEqual(ids(f.store), ["u4", "u5", "u6", "u7"]);
  assert.equal(f.store.getState().evictedBottom, 4);
});

test("reveal checks restored gaps after each page before a later batch could evict its target", async () => {
  const f = fixture({ initial: ["u8", "u9"], cursor: 20 });
  f.store.setState({ evictedTop: { before: 100, count: 8 } });
  replies(f, new Map([
    [100, { entries: [metadata], nextBefore: 90 }],
    [90, page(["u6", "u7"], 80)],
    [80, page(["u4", "u5"], 60)],
  ]));
  const current = () => true;
  assert.equal(await f.controller.revealEntry("u6", current), "revealed");
  assert.deepEqual(f.reads.map((read) => read.before), [100, 90]);
  assert.deepEqual(f.store.getState().evictedTop, { before: 80, count: 6 });
  assert.deepEqual(ids(f.store), ["u6", "u7", "u8", "u9"]);
  assert.equal(await f.controller.reloadEvictedTop(), false);
  assert.equal(f.reads.length, 2, "a gap prefetch cannot replace the newly revealed span");
  f.controller.releaseRevealedEntry("u6", current);
});

test("overlapping reveals share in-flight history and only the latest may retain ownership", async () => {
  const f = fixture();
  const oldCurrent = () => true;
  const newCurrent = () => true;
  const first = f.controller.revealEntry("u4", oldCurrent);
  const second = f.controller.revealEntry("u4", newCurrent);
  const subsequent = new Map([[80, page(["u4", "u5"], 60)]]);
  replies(f, subsequent);
  f.earlier.resolve(page(["u6", "u7"], 80));
  assert.equal(await first, "unreachable");
  assert.equal(await second, "revealed");
  assert.deepEqual(f.reads.map((read) => read.before), [100, 80]);
  f.controller.releaseRevealedEntry("u4", oldCurrent);
  f.controller.mergeHistory([user("live")]);
  assert.ok(ids(f.store).includes("u4"), "a stale same-entry release cannot release the newer landing");
  assert.equal(f.store.getState().messages.length, 4);
  f.controller.releaseRevealedEntry("u4", newCurrent);
  assert.equal(f.controller.revealWindow, null);
});

test("a tail replacement cancels the whole reveal instead of continuing from its new cursor", async () => {
  const f = fixture();
  const reveal = f.controller.revealEntry("u4");
  f.store.setState({ evictedBottom: 2 });
  const latest = f.controller.jumpToLatest();
  f.tail.resolve(page(["new-tail"], 700));
  assert.equal(await latest, true);
  f.earlier.resolve(page(["u4", "u5"], 60));
  assert.equal(await reveal, "unreachable");
  assert.deepEqual(ids(f.store), ["new-tail"]);
  assert.equal(f.store.getState().historyCursor, 700);
  assert.equal(f.reads.length, 2);
  assert.equal(f.controller.revealWindow, null);
});

for (const method of ["loadEarlier", "reloadEvictedTop", "revealEntry"]) {
  test(`${method}: a switched-away-and-back generation cannot alter the new session`, async () => {
    const f = fixture();
    if (method === "reloadEvictedTop") f.store.setState({ evictedTop: { before: 100, count: 2 } });
    const pending = method === "revealEntry" ? f.controller.revealEntry("u4") : f.controller[method]();
    f.controller.generation += 2;
    f.controller.earlierInFlight = false;
    f.store.getState().beginSession(path);
    f.controller.applyTailPage(page(["fresh"], 900));
    f.store.getState().setLoadingEarlier(true);
    const fresh = f.store.getState();
    f.earlier.resolve(page(["u4", "u5"], 60));
    const result = await pending;
    if (method === "revealEntry") assert.equal(result, "unreachable");
    assert.equal(f.store.getState(), fresh, "including loading/error/gap state, not just message rows");
    assert.equal(f.controller.earlierInFlight, false);
  });
}

test("cancelled reveals restore viewport policy and cannot continue paging", async () => {
  const f = fixture();
  let current = true;
  const predicate = () => current;
  const pending = f.controller.revealEntry("u4", predicate);
  current = false;
  f.earlier.resolve(page(["u6", "u7"], 80));
  assert.equal(await pending, "unreachable");
  assert.equal(f.reads.length, 1);
  assert.equal(f.controller.revealWindow, null);
  assert.equal(f.controller.atBottom, true);
});

test("an unreachable reveal has a request bound and leaves no viewport override", async () => {
  const f = fixture();
  f.controller.fetchHistory = async (_path, options) => {
    f.reads.push(options);
    return { entries: [metadata], nextBefore: options.before - 1 };
  };
  assert.equal(await f.controller.revealEntry("missing"), "unreachable");
  assert.equal(f.reads.length, 20);
  assert.equal(f.controller.revealWindow, null);
  assert.equal(f.controller.atBottom, true);
  assert.equal(f.store.getState().messages.length, 2);
});

test("scrolling back down reads the dropped bottom span by cursor and slides the window", async () => {
  const f = fixture({ atBottom: false, initial: ["u6", "u7", "u8", "u9"], cursor: 60 });
  replies(f, new Map([[60, page(["u2", "u3", "u4", "u5"], 40)]]));
  assert.equal(await f.controller.loadEarlier(), true);
  assert.deepEqual(ids(f.store), ["u2", "u3", "u4", "u5"]);
  assert.equal(f.store.getState().evictedBottom, 4);
  assert.equal(f.store.getState().evictedBottomAfter, 60, "reading forward resumes where the dropped page began");

  // A live row cannot join a window that stops short of the live edge.
  f.controller.mergeHistory([user("u10")]);
  assert.deepEqual(ids(f.store), ["u2", "u3", "u4", "u5"]);
  assert.equal(f.store.getState().evictedBottom, 5);

  f.store.setState({ endOffset: 200 });
  const forward = new Map([
    [60, { entries: ["u6", "u7", "u8", "u9"].map(user), endOffset: 160 }],
    [160, { entries: ["u10", "u11"].map(user), endOffset: 200 }],
  ]);
  f.controller.fetchHistory = async (_path, options) => {
    f.reads.push(options);
    assert.ok(forward.has(options.after), `unexpected forward cursor ${options.after}`);
    return forward.get(options.after);
  };
  f.reads.length = 0;
  f.controller.setAtBottom(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.reads.map((read) => read.after), [60], "reaching the held end reads on; it does not reseed from the tail");
  assert.deepEqual(ids(f.store), ["u6", "u7", "u8", "u9"], "the far (oldest) end is shed");
  assert.deepEqual(f.store.getState().evictedTop, { before: 60, count: 4 });
  assert.equal(f.store.getState().evictedBottomAfter, 160);
  assert.ok(f.store.getState().evictedBottom > 0, "the pill stays until the live edge is reached");

  assert.equal(await f.controller.loadLater(), true);
  assert.deepEqual(ids(f.store), ["u10", "u11"]);
  assert.equal(f.store.getState().evictedBottom, 0);
  assert.equal(f.store.getState().evictedBottomAfter, null);
});

test("a window with an unknown forward cursor still reseeds from the tail", async () => {
  const f = fixture({ atBottom: false, initial: ["u6", "u7", "u8", "u9"], cursor: null });
  f.store.setState({ historyCursor: 60 });
  f.controller.fetchHistory = async (_path, options) => {
    f.reads.push(options);
    return options.before === 60 ? page(["u2", "u3", "u4", "u5"], 40) : page(["u9"], 70);
  };
  assert.equal(await f.controller.loadEarlier(), true);
  assert.equal(f.store.getState().evictedBottomAfter, null);
  assert.ok(f.store.getState().evictedBottom > 0);
  f.reads.length = 0;
  f.controller.setAtBottom(true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].after, undefined);
  assert.equal(f.reads[0].before, undefined, "the tail page");
});
