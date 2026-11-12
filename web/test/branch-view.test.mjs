import test from "node:test";
import assert from "node:assert/strict";
import { branchMoved, filterAbandoned, GOTO_CUSTOM_TYPE, UNLINKED } from "../src/runtime/branch-view.ts";

const entry = (id, parentId) => ({ type: "message", id, parentId });
const goto = (id, parentId) => ({ type: "custom", customType: GOTO_CUSTOM_TYPE, id, parentId, data: { targetId: "t" } });
const usage = (id, parentId, activeLeafId) => ({ type: "model_usage", id, parentId, ...(activeLeafId === undefined ? {} : { activeLeafId }) });
const ids = (result) => result.kept.map((e) => e.id);

// a ─ b ─ c ─ d, then "Go here" back to b: e and f continue from b.
const moved = [entry("a", null), entry("b", "a"), entry("c", "b"), entry("d", "c"), goto("g1", "b"), entry("e", "g1"), entry("f", "e")];
// The same move made with TUI `/tree`: omp writes nothing, e just hangs off b.
const tuiMoved = [entry("a", null), entry("b", "a"), entry("c", "b"), entry("d", "c"), entry("e", "b"), entry("f", "e")];

test("a linear file is left untouched", () => {
  const linear = [entry("a", null), entry("b", "a"), entry("c", "b")];
  const result = filterAbandoned(linear, null);
  assert.deepEqual(ids(result), ["a", "b", "c"]);
  assert.equal(result.leaf, "c");
  assert.deepEqual([...result.frontier], [], "the chain reached the root");
  assert.deepEqual(result.dropped, []);
});

test("a move drops the turns it abandoned, keeps their ancestors and everything after it", () => {
  const result = filterAbandoned(moved, null);
  assert.deepEqual(ids(result), ["a", "b", "e", "f"]);
  assert.deepEqual(result.dropped, ["d", "c"]);
});

test("a TUI tree move without any marker drops the abandoned turns too", () => {
  const result = filterAbandoned(tuiMoved, null);
  assert.deepEqual(ids(result), ["a", "b", "e", "f"]);
  assert.deepEqual(result.dropped, ["d", "c"]);
});

test("a move to before the first message drops everything before it", () => {
  const result = filterAbandoned([entry("a", null), entry("b", "a"), goto("g1", null), entry("c", "g1")], null);
  assert.deepEqual(ids(result), ["c"]);
  assert.deepEqual([...result.frontier], []);
});

test("the chain carries into an older page", () => {
  const tail = filterAbandoned(tuiMoved.slice(4), null);
  assert.deepEqual(ids(tail), ["e", "f"]);
  assert.deepEqual([...tail.frontier], ["b"], "the chain left the window at b");
  const older = filterAbandoned(tuiMoved.slice(0, 4), tail.frontier);
  assert.deepEqual(ids(older), ["a", "b"]);
  assert.equal(older.leaf, null, "an older page continues the tail's leaf");
  assert.deepEqual([...tail.frontier], ["b"], "the caller's frontier is not mutated");
});

test("an older page resolves the leaf when the tail held no tree entry", () => {
  const tail = filterAbandoned([{ type: "title", title: "t" }], null);
  assert.equal(tail.frontier, null);
  const older = filterAbandoned(tuiMoved, tail.frontier);
  assert.equal(older.leaf, "f");
  assert.deepEqual(ids(older), ["a", "b", "e", "f"]);
});

test("several moves: only the chain through the newest one survives", () => {
  const twice = [...moved, goto("g2", "a"), entry("h", "g2")];
  assert.deepEqual(ids(filterAbandoned(twice, null)), ["a", "h"]);
  // Moving onto an abandoned turn revives its chain, and the older marker
  // off that chain does not restart it elsewhere.
  const back = [...moved, goto("g2", "d"), entry("i", "g2")];
  assert.deepEqual(ids(filterAbandoned(back, null)), ["a", "b", "c", "d", "i"]);
});

test("the header, titles and id-less lines belong to no branch and stay", () => {
  const result = filterAbandoned([{ type: "session", id: "s" }, entry("a", null), entry("x", "a"), entry("b", "a"), { type: "note" }], null);
  assert.deepEqual(result.kept.map((e) => e.id ?? e.type), ["s", "a", "b", "note"]);
});

test("off-leaf usage is never the leaf; a captured activeLeafId in the page is", () => {
  // Late usage recorded on its initiating branch (parent a) after b was appended.
  const late = [entry("a", null), entry("b", "a"), usage("u", "a")];
  assert.deepEqual(ids(filterAbandoned(late, null)), ["a", "b", "u"]);
  assert.equal(filterAbandoned(late, null).leaf, "b");
  // Newer omp records the leaf it kept: a TUI move to a with no turn after it.
  const captured = [entry("a", null), entry("b", "a"), usage("u", "b", "a")];
  const result = filterAbandoned(captured, null);
  assert.equal(result.leaf, "a");
  assert.deepEqual(result.dropped, ["b"]);
  // A captured id outside the page proves nothing: fall back to the newest turn.
  assert.equal(filterAbandoned([entry("b", "a"), usage("u", "b", "zz")], null).leaf, "b");
});

test("a repeated id of a chain entry is the same node, not an abandoned one", () => {
  const result = filterAbandoned([entry("a", null), entry("b", "a"), entry("b", "a")], null);
  assert.deepEqual(ids(result), ["a", "b", "b"]);
  assert.deepEqual(result.dropped, []);
});

test("an entry without a parentId field ends what can be proven", () => {
  const result = filterAbandoned([entry("a", null), entry("x", "a"), { type: "message", id: "b" }, { type: "message", id: "c" }], null);
  assert.deepEqual(ids(result), ["a", "x", "b", "c"]);
  assert.equal(result.frontier, UNLINKED);
  assert.deepEqual(ids(filterAbandoned([entry("o", null)], result.frontier)), ["o"]);
});

test("branchMoved: continuing appends merge, a tree move re-seeds", () => {
  const none = new Set();
  // The next turn hangs off the transcript's leaf.
  assert.equal(branchMoved(filterAbandoned([entry("g", "f")], null), "f", none), false);
  // A re-sent tail that still runs through the leaf.
  assert.equal(branchMoved(filterAbandoned(tuiMoved, null), "e", none), false);
  // TUI /tree back to b, then a new turn: it does not hang off the leaf d.
  assert.equal(branchMoved(filterAbandoned([entry("e", "b")], null), "d", none), true);
  // A re-sent tail proving the on-screen turn c abandoned, even without a known leaf.
  assert.equal(branchMoved(filterAbandoned(tuiMoved, null), null, new Set(["c"])), true);
  // No leaf known and nothing on screen dropped: nothing to prove.
  assert.equal(branchMoved(filterAbandoned([entry("e", "b")], null), null, none), false);
  // A batch with no tree entry, or one whose links are unknown, proves nothing.
  assert.equal(branchMoved(filterAbandoned([usage("u", "a")], null), "f", none), false);
  assert.equal(branchMoved(filterAbandoned([{ type: "message", id: "n" }], null), "f", none), false);
});

test("omp 18.8.6 usage hung off the leaf is the leaf, across batches too", () => {
  // Usage at the leaf, then a child of it, in one page.
  const page = filterAbandoned([entry("a", null), usage("u", "a"), entry("t", "u")], null);
  assert.deepEqual(ids(page), ["a", "u", "t"]);
  assert.deepEqual(page.dropped, []);
  assert.equal(filterAbandoned([entry("a", null), usage("u", "a")], null).leaf, "u");
  // Idle cache-warm usage alone in a batch, then the next user entry on it.
  const none = new Set();
  const first = filterAbandoned([usage("u", "a")], null, "a");
  assert.equal(first.leaf, "u");
  assert.equal(branchMoved(first, "a", none), false);
  const second = filterAbandoned([entry("t", "u")], null, "u");
  assert.equal(branchMoved(second, first.leaf, none), false);
  assert.equal(second.leaf, "t");
});

test("usage with activeLeafId follows the captured leaf, not its parent", () => {
  const result = filterAbandoned([entry("a", null), entry("b", "a"), usage("u", "b", "b"), entry("t", "b")], null);
  assert.equal(result.leaf, "t");
  assert.deepEqual(result.dropped, ["u"]);
  // Self-selected usage is the leaf.
  assert.equal(filterAbandoned([entry("a", null), usage("u", "a", "u")], null).leaf, "u");
  // Alone in a batch with an unloaded captured leaf: no move, leaf unresolved.
  const alone = filterAbandoned([usage("u", "x", "a")], null, "a");
  assert.equal(alone.leaf, null);
  assert.equal(branchMoved(alone, "a", new Set()), false);
});

test("usage hung off a non-leaf leaves the leaf unchanged", () => {
  const result = filterAbandoned([entry("a", null), entry("b", "a"), usage("u", "a")], null);
  assert.equal(result.leaf, "b");
  assert.deepEqual(result.dropped, []);
  // A second usage still hangs off the real leaf b past the off-leaf one.
  assert.equal(filterAbandoned([entry("a", null), entry("b", "a"), usage("u", "a"), usage("v", "b")], null).leaf, "v");
  // Alone in a batch: its parent is not the current leaf, so nothing moves.
  const alone = filterAbandoned([usage("u", "a")], null, "b");
  assert.equal(alone.leaf, null);
  assert.equal(branchMoved(alone, "b", new Set()), false);
  assert.equal(branchMoved(filterAbandoned([entry("c", "b")], null, "b"), "b", new Set()), false);
});

test("re-answer displays the new native result without destroying the original comparison branch", () => {
  const original = { ...entry("answer-original", "question-call"), message: { role: "toolResult", toolName: "ask", content: [{ type: "text", text: "PostgreSQL" }] } };
  const alternate = { ...entry("answer-alternate", "question-call"), message: { role: "toolResult", toolName: "ask", content: [{ type: "text", text: "SQLite" }] } };
  const journal = [entry("request", null), entry("question-call", "request"), original, entry("old-reply", original.id), alternate, goto("moved", alternate.id), entry("new-reply", "moved")];
  const active = filterAbandoned(journal, null);
  assert.equal(active.kept.find(row => row.id === alternate.id).message.content[0].text, "SQLite");
  assert.equal(active.kept.some(row => row.id === original.id), false);
  const comparison = filterAbandoned([...journal, goto("compare", "old-reply")], null);
  assert.equal(comparison.kept.find(row => row.id === original.id).message.content[0].text, "PostgreSQL");
  assert.equal(comparison.kept.some(row => row.id === alternate.id), false);
  assert.equal(journal.find(row => row.id === original.id).message.content[0].text, "PostgreSQL");
});
