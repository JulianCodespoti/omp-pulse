import test from "node:test";
import assert from "node:assert/strict";
import { newestPlanMode, parsePlanModeReply, planToggleTarget } from "../src/runtime/plan-state.ts";

const mode = (mode, timestamp, data) => ({ type: "mode_change", mode, timestamp, ...(data ? { data } : {}) });
const T = (minute) => `2026-10-15T10:${String(minute).padStart(2, "0")}:00.000Z`;

test("the newest mode_change in a page wins, whatever came before it", () => {
  const found = newestPlanMode([
    mode("plan", T(1), { planFilePath: "/p/old.md" }),
    { type: "message", timestamp: T(2) },
    mode("none", T(3)),
    mode("plan", T(4), { planFilePath: "/p/plan.md" }),
  ], 0);
  assert.deepEqual(found?.state, { enabled: true, planFilePath: "/p/plan.md" });
  assert.equal(found?.at, Date.parse(T(4)));
});

test("an older page never overrides what a newer one said", () => {
  const tail = newestPlanMode([mode("none", T(10))], 0);
  assert.deepEqual(tail?.state, { enabled: false });
  assert.equal(newestPlanMode([mode("plan", T(2), { planFilePath: "/p/x.md" })], tail.at), null);
  assert.equal(newestPlanMode([mode("plan", T(10))], tail.at), null, "an equal stamp is the same entry again");
});

test("every mode other than plan means plan mode is off", () => {
  for (const other of ["none", "plan_paused", "goal", "goal_paused", "vibe"]) {
    assert.deepEqual(newestPlanMode([mode(other, T(5))], 0)?.state, { enabled: false }, other);
  }
});

test("malformed entries say nothing", () => {
  assert.equal(newestPlanMode([
    null,
    "mode_change",
    { type: "mode_change", timestamp: T(1) },
    { type: "mode_change", mode: "", timestamp: T(1) },
    { type: "mode_change", mode: "plan" },
    { type: "mode_change", mode: "plan", timestamp: "not a date" },
    { type: "model_change", mode: "plan", timestamp: T(1) },
  ], 0), null);
  assert.deepEqual(newestPlanMode([mode("plan", T(1), { planFilePath: 7 })], 0)?.state, { enabled: true });
});

test("plan_mode replies are read strictly", () => {
  assert.deepEqual(parsePlanModeReply({ enabled: true, planFilePath: "/p/plan.md" }), { enabled: true, planFilePath: "/p/plan.md" });
  assert.deepEqual(parsePlanModeReply({ enabled: false, planFilePath: "/p/plan.md" }), { enabled: false });
  assert.deepEqual(parsePlanModeReply({ enabled: true }), { enabled: true });
  assert.equal(parsePlanModeReply({ enabled: "yes" }), null);
  assert.equal(parsePlanModeReply(null), null);
});

test("a bare toggle flips known state and asks while plan mode is unknown", () => {
  assert.equal(planToggleTarget({ enabled: true, planFilePath: "/p/plan.md" }), false);
  assert.equal(planToggleTarget({ enabled: false }), true);
  // Unknown: the mode_change(plan) may sit outside the loaded pages.
  assert.equal(planToggleTarget(null), null);
  // Explicit /plan on and /plan off never need to ask.
  assert.equal(planToggleTarget(null, true), true);
  assert.equal(planToggleTarget(null, false), false);
  assert.equal(planToggleTarget({ enabled: true }, true), true);
});
