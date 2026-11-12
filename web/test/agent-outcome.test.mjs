import test from "node:test";
import assert from "node:assert/strict";
import { agentOutcome } from "../src/domain/agent-outcome.ts";

const user = { id: "u", role: "user", text: "go", parts: [] };
const assistant = (extra = {}) => ({ id: "a", role: "assistant", text: "", parts: [], ...extra });

test("agent outcome comes from the newest assistant message", () => {
  assert.equal(agentOutcome([]), null);
  assert.equal(agentOutcome([user]), null);
  assert.equal(agentOutcome([user, assistant({ stopReason: "aborted", text: "partial" })]), "stopped");
  assert.equal(agentOutcome([user, assistant({ errorMessage: "boom" })]), "failed");
  assert.equal(agentOutcome([user, assistant({ stopReason: "error" })]), "failed");
  assert.equal(agentOutcome([user, assistant({ text: "All set.", stopReason: "stop" })]), "done");
  const yielded = assistant({ stopReason: "toolUse", parts: [{ kind: "tool", callId: "c", name: "yield", args: {}, state: "ok" }] });
  assert.equal(agentOutcome([user, yielded]), "done");
  assert.equal(agentOutcome([user, assistant({ text: "looking", stopReason: "toolUse" })]), null);
});
