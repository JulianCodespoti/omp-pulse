import test from "node:test";
import assert from "node:assert/strict";
import { createEditStash, editPlacementProblem, planRedo, redoKind } from "../src/domain/turn-redo.ts";

const user = (id, text, extra = {}) => ({ id, role: "user", text, parts: [], sourceEntryId: `e-${id}`, ...extra });
const reply = (id, text = "answer") => ({ id, role: "assistant", text, parts: [] });
const idle = { running: false, sendAllowed: true, offline: false, canWriteInPlace: true };

test("targets the newest user message and the reply under it", () => {
  const plan = planRedo([user("u1", "first"), reply("a1"), user("u2", "second"), reply("a2a"), reply("a2b", "")], idle);
  assert.equal(plan.prompt.id, "u2");
  assert.equal(plan.entryId, "e-u2");
  assert.equal(plan.replyId, "a2a");
  assert.equal(plan.disabled, false);
});

test("rewinds in place when the session is writable from here, branches otherwise", () => {
  const messages = [user("u1", "go"), reply("a1")];
  assert.equal(planRedo(messages, idle).kind, "in-place");
  assert.equal(planRedo(messages, { ...idle, canWriteInPlace: false }).kind, "branch");
  assert.equal(redoKind(true), "in-place");
  assert.equal(redoKind(false), "branch");
});

test("a turn running, a read-only session or a lost daemon disables it", () => {
  const messages = [user("u1", "go"), reply("a1")];
  for (const blocked of [{ running: true }, { sendAllowed: false }, { offline: true }]) {
    assert.equal(planRedo(messages, { ...idle, ...blocked }).disabled, true);
  }
});

test("no target without a confirmed entry, or when the newest message is not the user's to edit", () => {
  assert.equal(planRedo([user("u1", "go", { sourceEntryId: undefined })], idle), null);
  assert.equal(planRedo([user("u1", "   ")], idle), null);
  assert.equal(planRedo([reply("a1")], idle), null);
  // A confirmed turn followed by an unconfirmed local echo: the newest is the echo.
  assert.equal(planRedo([user("u1", "go"), reply("a1"), user("local:x", "again", { sourceEntryId: undefined })], idle), null);
  // An image-only prompt is still a prompt.
  const photo = user("u1", "", { parts: [{ kind: "image" }] });
  assert.equal(planRedo([photo, reply("a1")], idle).entryId, "e-u1");
});

test("a placed prompt is not reported as a problem; only a missing composer or a refusal is", () => {
  const placed = [];
  const composer = { placeForEdit: (path, text) => { placed.push([path, text]); return null; } };
  assert.equal(editPlacementProblem(composer, "/s", "Question 5"), null);
  assert.deepEqual(placed, [["/s", "Question 5"]]);
  assert.match(editPlacementProblem(null, "/s", "x"), /composer/);
  assert.equal(editPlacementProblem({ placeForEdit: () => "The conversation changed." }, "/s", "x"), "The conversation changed.");
});

test("cancelling an edit gets back the displaced draft once, only in its own conversation", () => {
  const stash = createEditStash();
  const draft = { text: "half-typed", projection: { prefix: "p" } };
  stash.hold("/a", draft);
  assert.equal(stash.take("/b"), null);
  assert.equal(stash.take("/a"), null, "a mismatched take consumes the stash");
  stash.hold("/a", draft);
  assert.equal(stash.take("/a"), draft);
  assert.equal(stash.take("/a"), null);
  stash.hold("/a", { text: "", projection: null });
  assert.equal(stash.take("/a").text, "", "an empty draft is still restored");
});
