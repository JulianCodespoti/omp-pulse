import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptSearch } from "../src/app/sessions/transcript-search.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("reset on unmount invalidates both successful and failed completions", async () => {
  for (const failed of [false, true]) {
    const owner = new TranscriptSearch(), request = deferred();
    const result = owner.run("alpha", () => request.promise); owner.reset();
    if (failed) request.reject(new Error("synthetic")); else request.resolve([]);
    assert.equal(await result, null);
  }
});

test("a newer query owns the result even when requests finish in reverse order", async () => {
  const owner = new TranscriptSearch(), first = deferred(), second = deferred();
  const a = owner.run("alpha", () => first.promise), b = owner.run("beta", () => second.promise);
  second.resolve(["beta"]); assert.deepEqual(await b, { ok: true, query: "beta", value: ["beta"] });
  first.resolve(["alpha"]); assert.equal(await a, null);
});

test("a synchronous transport failure remains retryable", async () => {
  const owner = new TranscriptSearch(), error = new Error("synthetic");
  assert.deepEqual(await owner.run("alpha", () => { throw error; }), { ok: false, query: "alpha", error });
  assert.deepEqual(await owner.run("alpha", async () => []), { ok: true, query: "alpha", value: [] });
});
