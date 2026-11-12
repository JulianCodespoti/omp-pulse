import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const code = await bundleDomFixture(`
  import { foldTurnWork } from ${JSON.stringify(resolve(root, "web/src/app/chat/TranscriptRows.tsx"))};
  window.fixture = { foldTurnWork };
`);
const dom = createDomFixture(code);
test.after(() => dom.close());
const fold = (timeline) => dom.window.fixture.foldTurnWork(timeline, new Map(), false);

const call = (id, state = "ok") => ({ kind: "tool", callId: id, name: "bash", args: { command: id }, state, output: "" });
const user = { kind: "message", message: { id: "u", role: "user", text: "go", parts: [] } };
const prose = (id, text, parts = []) => ({ kind: "message", message: { id, role: "assistant", text, parts: [{ kind: "text", text }, ...parts] } });
// The fold runs in the DOM realm: copy its arrays into this one, or deepEqual sees different prototypes.
const ids = (work) => [...work.items.flatMap((item) => item.messages.flatMap((m) => m.parts.map((p) => p.callId)))];
const run = (key, ...parts) => ({ kind: "run", key, continued: true, reply: "", messages: [{ id: key, role: "assistant", text: "", parts }] });

test("each stretch of a turn's work is one group where it happened, and carries its own failure", () => {
  // The turn ends on the failed call, so its stretch reads as failed (a failure carried past would not).
  const timeline = [user, prose("m0", "Let me look.", [call("a")]), prose("m1", "Now the build:", [call("b")]), { ...run("r2", call("c", "error")), continued: false }];
  const { steps, workHidden, folded, worked } = fold(timeline);
  assert.deepEqual([...steps.keys()], [1, 2], "stretches key at the prose message whose text precedes them");
  assert.deepEqual(ids(steps.get(1)), ["a"]);
  assert.deepEqual(ids(steps.get(2)), ["b", "c"], "a message's own calls join the runs after it, up to the next prose");
  assert.equal(steps.get(2).failed, true, "a stretch carries its own failure");
  assert.equal(steps.get(1).failed, false);
  assert.ok(workHidden.has(1) && workHidden.has(2));
  assert.ok(folded.has(3), "the run moved into the group");
  assert.deepEqual([...worked], [3], "the turn, keyed at its last item, has a group");
});

test("work before the reply is one group in the run's own place, not a chip above the turn", () => {
  const { steps } = fold([user, run("r1", call("a"), call("b")), prose("m1", "Here it is.")]);
  assert.deepEqual([...steps.keys()], [1]);
  assert.deepEqual(ids(steps.get(1)), ["a", "b"]);
});

test("a marker between runs ends a group: the work after it is the next group in sequence", () => {
  const marker = { kind: "marker", key: "k", icon: "job", label: "Background job finished" };
  const { steps, folded } = fold([user, run("r1", call("a")), marker, run("r3", call("b")), prose("m4", "Done.")]);
  assert.deepEqual([...steps.keys()], [1, 3], "one group before the marker, the next after it");
  assert.deepEqual(ids(steps.get(1)), ["a"]);
  assert.deepEqual(ids(steps.get(3)), ["b"]);
  assert.ok(folded.has(1) && folded.has(3) && !folded.has(2), "the marker itself stays in the flow between them");
});

test("a stretch is timed from its first call to the next prose; the last one ends with the turn and carries its stop", () => {
  const at = (seconds) => new Date(1_000_000 + seconds * 1000);
  const timed = (id, startedAt, endedAt) => ({ ...call(id), startedAt: 1_000_000 + startedAt * 1000, endedAt: 1_000_000 + endedAt * 1000 });
  const withTime = (item, seconds) => ({ kind: "message", message: { ...item.message, createdAt: at(seconds) } });
  const timeline = [user, run("r1", timed("a", 1, 5)), withTime(prose("m1", "Now the build:", [timed("b", 20, 25)]), 10), run("r3", timed("c", 30, 40))];
  const summaries = new Map([[3, { startedAt: 1_000_000, endedAt: 1_045_000, stopped: true, error: false, reply: null }]]);
  const { steps } = dom.window.fixture.foldTurnWork(timeline, summaries, false);
  assert.deepEqual([steps.get(1).summary.startedAt, steps.get(1).summary.endedAt], [1_001_000, 1_010_000], "first call to the prose that followed");
  assert.equal(steps.get(1).summary.stopped, false);
  assert.deepEqual([steps.get(2).summary.startedAt, steps.get(2).summary.endedAt], [1_020_000, 1_045_000], "the final stretch ends with the turn");
  assert.equal(steps.get(2).summary.stopped, true, "the turn's stop belongs to the stretch it ended in");
});

test("the live turn stays unfolded while it streams", () => {
  const { steps, folded } = dom.window.fixture.foldTurnWork([user, run("r1", call("a"))], new Map(), true);
  assert.equal(steps.size, 0);
  assert.equal(folded.size, 0);
});
