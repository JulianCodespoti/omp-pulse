import test from "node:test";
import assert from "node:assert/strict";
import { reachLatest, waitForLatestRender } from "../src/app/chat/latest-navigation.ts";

function fixture(overrides = {}) {
  const calls = [];
  return { calls, options: {
    isCurrent: () => true,
    needsTailReload: () => false,
    waitForRender: async () => true,
    isAtBottom: () => true,
    reloadTail: async () => { calls.push("reload"); return true; },
    scrollToBottom: async () => { calls.push("scroll"); return true; },
    ...overrides,
  } };
}

test("a retained tail goes directly to the bottom without paging through turns", async () => {
  const { calls, options } = fixture();
  assert.equal(await reachLatest(options), "arrived");
  assert.deepEqual(calls, ["scroll"]);
});

test("an evicted tail is restored before scrolling", async () => {
  const { calls, options } = fixture({ needsTailReload: () => true });
  assert.equal(await reachLatest(options), "arrived");
  assert.deepEqual(calls, ["reload", "scroll"]);
});

test("a failed tail reload cannot be reported as arrival", async () => {
  const { calls, options } = fixture({ needsTailReload: () => true, reloadTail: async () => false });
  assert.equal(await reachLatest(options), "failed");
  assert.deepEqual(calls, []);
});

test("a concurrently restored tail can still be reached", async () => {
  let missing = true;
  const { calls, options } = fixture({ needsTailReload: () => missing, reloadTail: async () => { missing = false; return false; } });
  assert.equal(await reachLatest(options), "arrived");
  assert.deepEqual(calls, ["scroll"]);
});

test("a stale visit never starts navigation", async () => {
  const { calls, options } = fixture({ isCurrent: () => false });
  assert.equal(await reachLatest(options), "cancelled");
  assert.deepEqual(calls, []);
});

test("switching sessions during reload cannot scroll the newer view", async () => {
  let current = true;
  const { calls, options } = fixture({ isCurrent: () => current, needsTailReload: () => true, reloadTail: async () => { current = false; return true; } });
  assert.equal(await reachLatest(options), "cancelled");
  assert.deepEqual(calls, []);
});

test("a completed scroll from an old visit is not arrival in the new visit", async () => {
  let current = true;
  const { options } = fixture({ isCurrent: () => current, scrollToBottom: async () => { current = false; return true; } });
  assert.equal(await reachLatest(options), "cancelled");
});

test("user interruption keeps the result cancelled", async () => {
  const { options } = fixture({ scrollToBottom: async () => false });
  assert.equal(await reachLatest(options), "cancelled");
});

test("synchronous scroll results use the same arrival contract", async () => {
  assert.equal(await reachLatest(fixture({ scrollToBottom: () => true }).options), "arrived");
  assert.equal(await reachLatest(fixture({ scrollToBottom: () => false }).options), "cancelled");
});

test("reload or scroll exceptions produce a retryable failure", async () => {
  const failed = async () => { throw new Error("test failure"); };
  for (const options of [fixture({ needsTailReload: () => true, reloadTail: failed }).options, fixture({ scrollToBottom: failed }).options]) {
    assert.equal(await reachLatest(options), "failed");
  }
});

test("an error belonging to an old visit cannot become a new-view failure", async () => {
  let current = true;
  const { options } = fixture({ isCurrent: () => current, scrollToBottom: async () => { current = false; throw new Error("old visit"); } });
  assert.equal(await reachLatest(options), "cancelled");
});


test("optimistic library success without bottom geometry is a failure", async () => {
  assert.equal(await reachLatest(fixture({ isAtBottom: () => false }).options), "failed");
});

test("scroll cannot start until the tail snapshot has rendered", async () => {
  const calls = [];
  let commit;
  const rendered = new Promise((resolve) => { commit = resolve; });
  const run = reachLatest(fixture({
    needsTailReload: () => true,
    reloadTail: async () => { calls.push("reload"); return true; },
    waitForRender: () => rendered,
    scrollToBottom: () => { calls.push("scroll"); return true; },
  }).options);
  await Promise.resolve();
  assert.deepEqual(calls, ["reload"]);
  commit(true);
  assert.equal(await run, "arrived");
  assert.deepEqual(calls, ["reload", "scroll"]);
});

test("a render timeout fails without scrolling", async () => {
  const { calls, options } = fixture({ waitForRender: async () => false });
  assert.equal(await reachLatest(options), "failed");
  assert.deepEqual(calls, []);
});

test("cancellation while waiting for React prevents a late scroll", async () => {
  let current = true;
  const { calls, options } = fixture({ isCurrent: () => current, waitForRender: async () => { current = false; return true; } });
  assert.equal(await reachLatest(options), "cancelled");
  assert.deepEqual(calls, []);
});

test("render barrier observes a committed snapshot rather than a fixed delay", async () => {
  let frame = 0;
  assert.equal(await waitForLatestRender({ isCurrent: () => true, isRendered: () => frame === 3,
    nextFrame: async () => { frame++; }, now: () => frame * 16 }), true);
  assert.equal(frame, 3);
});

test("render barrier is bounded and cancellation stops it", async () => {
  for (const cancel of [false, true]) {
    let frame = 0;
    assert.equal(await waitForLatestRender({ isCurrent: () => !cancel || frame < 2, isRendered: () => false,
      nextFrame: async () => { frame++; }, now: () => frame * 16, timeoutMs: 32 }), false);
    assert.equal(frame, 2);
  }
});
