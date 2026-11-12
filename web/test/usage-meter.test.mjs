import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// The real framework-free meter helpers plus the store selector over them.
// Synthetic rows and messages only; no daemon, browser or session file.
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = `
  export * from ${JSON.stringify(resolve(root, "web/src/domain/usage-meter.ts"))};
  export { contextTier } from ${JSON.stringify(resolve(root, "web/src/app/session-format.ts"))};
  export { createOmpStore, selectSessionCost } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
`;
const build = await rolldown({
  input: "usage-meter-fixture",
  platform: "node",
  transform: { define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }) } },
  plugins: [{
    name: "usage-meter-fixture",
    resolveId: (id) => id === "usage-meter-fixture" ? "\0usage-meter-fixture" : null,
    load: (id) => id === "\0usage-meter-fixture" ? source : null,
  }],
});
let m;
try {
  const generated = await build.generate({ format: "esm", codeSplitting: false });
  m = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString("base64")}`);
} finally {
  await build.close();
}

test("cost labels: sub-cent, cents, whole dollars from $100, hidden when nothing to say", () => {
  for (const [usd, label] of [
    [0.001, "<$0.01"], [0.0099, "<$0.01"], [0.01, "$0.01"], [0.42, "$0.42"], [1.236, "$1.24"],
    [99.99, "$99.99"], [99.996, "$100"], [100, "$100"], [128.4, "$128"], [1234.5, "$1,235"],
  ]) assert.equal(m.formatCost(usd), label, String(usd));
  for (const usd of [0, -1, NaN, Infinity, undefined, null]) assert.equal(m.formatCost(usd), null, String(usd));
});

test("context percent needs both a usable prompt size and a window", () => {
  assert.equal(m.contextPercent(42000, 100000), 42);
  assert.equal(m.contextPercent(95, 1000), 9.5);
  assert.equal(m.contextPercent(0, 1000), 0);
  assert.equal(m.contextPercent(300000, 200000), 100, "clamped");
  for (const [tokens, window] of [[1000, undefined], [1000, 0], [undefined, 1000], [-1, 1000], [NaN, 1000], [1000, Infinity]]) {
    assert.equal(m.contextPercent(tokens, window), undefined, `${tokens}/${window}`);
  }
});

test("tier boundaries: amber from 70 through 90, red above 90", () => {
  for (const [percent, tier] of [[69.9, null], [70, "amber"], [90, "amber"], [90.1, "red"], [100, "red"], [undefined, null], [NaN, null]]) {
    assert.equal(m.contextTier(percent), tier, String(percent));
  }
});

test("session cost adds only held turns newer than the daemon's anchor", () => {
  const turn = (id, total) => ({ id, role: "assistant", parts: [], ...(total === undefined ? {} : { usage: { cost: { total } } }) });
  const user = (id) => ({ id, role: "user", parts: [] });
  const held = [turn("a1", 0.5), user("u2"), turn("a2", 0.25), turn("a3")];
  assert.equal(m.sessionCost(2, "a1", held), 2.25);
  assert.equal(m.sessionCost(2, "a3", held), 2);
  assert.equal(m.sessionCost(2, "gone", held), 2, "anchor not held: no guess");
  assert.equal(m.sessionCost(0, undefined, held), 0.75, "no assistant in the file yet");
  assert.equal(m.sessionCost(undefined, "a1", held), undefined, "unfolded file: unknown");
  assert.equal(m.sessionCost(1, "a1", [turn("a1", 1), turn("bad", NaN), turn("neg", -2)]), 1);
});

test("the store selector reads the open session's row", () => {
  const store = m.createOmpStore();
  store.setState({
    sessionPath: "/s/open.jsonl",
    sessions: [{ path: "/s/other.jsonl", costTotal: 9 }, { path: "/s/open.jsonl", costTotal: 1.5, usageThrough: "a1" }],
    messages: [{ id: "a1", role: "assistant", parts: [] }, { id: "a2", role: "assistant", parts: [], usage: { cost: { total: 0.5 } } }],
  });
  assert.equal(m.selectSessionCost(store.getState()), 2);
  store.setState({ sessionPath: "/s/unlisted.jsonl" });
  assert.equal(m.selectSessionCost(store.getState()), undefined);
});
