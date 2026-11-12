import test from "node:test";
import assert from "node:assert/strict";
import { hasReplyActions } from "../src/domain/reply-actions.ts";

test("older and newer assistant prose replies each get actions", () => {
  for (const text of ["Earlier reply", "Latest reply", "```js\nconst answer = 42;\n```", "你好 👋"]) {
    assert.equal(hasReplyActions({ role: "assistant", text }), true);
  }
});

test("user messages do not get assistant reply actions", () => {
  assert.equal(hasReplyActions({ role: "user", text: "My message" }), false);
});

test("empty, whitespace, thinking-only and tool-only messages do not get actions", () => {
  for (const text of ["", " ", "\n\t"]) {
    assert.equal(hasReplyActions({ role: "assistant", text }), false);
  }
});

test("the visibility check does not trim or modify the copied payload", () => {
  const message = Object.freeze({ role: "assistant", text: "  exact reply\n" });
  assert.equal(hasReplyActions(message), true);
  assert.equal(message.text, "  exact reply\n");
});
