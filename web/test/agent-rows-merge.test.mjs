import test from "node:test";
import assert from "node:assert/strict";
import { mergeAgentRows } from "../src/domain/agents-from-transcript.ts";

const row = (id, state = "ok") => ({ id, name: id, state });

test("a subagent spawned after the scan still shows, newest first", () => {
  // The scan (oldest first) ran when the sheet opened; call c started since.
  const scanned = [row("a:0"), row("a:1"), row("b")];
  const fromWindow = [row("c", "running"), row("b", "running")];
  assert.deepEqual(mergeAgentRows(scanned, fromWindow).map((r) => [r.id, r.state]), [
    ["c", "running"],
    ["b", "running"],
    ["a:1", "ok"],
    ["a:0", "ok"],
  ]);
});

test("a multi-task call matches across both id suffix schemes", () => {
  const scanned = [row("x:0"), row("x:1")];
  const fromWindow = [row("x:Scout", "running"), row("x:Review", "running")];
  assert.deepEqual(mergeAgentRows(scanned, fromWindow).map((r) => r.id), ["x:Scout", "x:Review"]);
});

test("no scan yet, or an empty one, leaves the window rows", () => {
  assert.deepEqual(mergeAgentRows(null, [row("c")]).map((r) => r.id), ["c"]);
  assert.deepEqual(mergeAgentRows([], [row("c")]).map((r) => r.id), ["c"]);
  assert.deepEqual(mergeAgentRows([row("a")], []).map((r) => r.id), ["a"]);
});
