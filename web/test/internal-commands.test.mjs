import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, isInternalCommandName, PLAN_COMMAND } from "../src/app/commands/command-registry.ts";

test("the daemon helper's own commands are never offered to the owner", () => {
  for (const name of ["pulse-plan", "pulse-goto", "pulse-label", "pulse-bash", "/pulse-anything", "//PULSE-Plan"]) {
    assert.equal(isInternalCommandName(name), true, name);
  }
});

test("ordinary commands, including ones that merely mention pulse, stay listed", () => {
  for (const name of ["plan", "/goal", "model", "pulse", "pulsecheck", "my-pulse-tool", "impulse-"]) {
    assert.equal(isInternalCommandName(name), false, name);
  }
});

test("/plan toggles on the phone instead of reaching the model as text", () => {
  assert.equal(PLAN_COMMAND.shape, "pick");
  assert.equal(PLAN_COMMAND.picker, "plan");
  const advertised = classifyCommand({ name: "plan", source: "builtin", description: "omp text" });
  assert.equal(advertised.shape, "pick");
  assert.equal(advertised.picker, "plan");
});
