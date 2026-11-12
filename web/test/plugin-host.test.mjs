import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// The real plugin host with every outside dependency faked: no browser, no
// daemon, no sandbox frame, no real timers. Time only moves when a test says so.
const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = `
  export * from ${JSON.stringify(resolve(root, "web/src/runtime/plugin-host.ts"))};
  export { createPluginSandbox } from ${JSON.stringify(resolve(root, "web/src/runtime/plugin-sandbox.ts"))};
  export { validatePluginView } from ${JSON.stringify(resolve(root, "web/src/domain/plugins.ts"))};
`;
const build = await rolldown({
  input: "plugin-host-fixture",
  platform: "node",
  transform: { define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1 }) } },
  plugins: [{
    name: "plugin-host-fixture",
    resolveId: (id) => (id === "plugin-host-fixture" ? "\0plugin-host-fixture" : null),
    load: (id) => (id === "\0plugin-host-fixture" ? entry : null),
  }],
});
let actual;
try {
  const generated = await build.generate({ format: "esm", codeSplitting: false });
  actual = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString("base64")}`);
} finally {
  await build.close();
}
const { createPluginHost, createPluginSandbox, validatePluginView } = actual;

const plugin = (id, extra = {}) => ({
  id,
  name: `Plugin ${id}`,
  version: "1.0.0",
  description: "",
  status: "enabled",
  hash: "hash-1",
  slots: ["drawer"],
  sources: [],
  linked: false,
  permissions: [],
  tools: [],
  messages: [],
  options: [],
  optionValues: {},
  actions: [],
  ...extra,
});
const loadSource = { id: "load", command: ["cat", "/proc/loadavg"], intervalS: 10, timeoutS: 5 };
const reading = (fetchedAtMs, text = "0.10 0.20") => ({ ok: true, text, exitCode: 0, fetchedAtMs, truncated: false });
const goodView = (text = "hi") => ({ k: "text", p: { text }, c: [] });
const badView = { k: "no-such-node", p: {}, c: [] };

/** Let queued promise callbacks run; the fake clock is untouched. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
};

function harness({ catalog = [], guardSet = false, paired = true } = {}) {
  let clock = 0;
  let timerSeq = 0;
  let timers = [];
  const calls = [];
  const sandboxes = [];
  const visibility = { visible: true, listeners: new Set() };
  const pageHide = new Set();
  const guard = { set: guardSet, writes: [] };
  const world = {
    catalog: catalog.map((p) => ({ ...p })),
    readings: [],
    listFails: null,
    stateFails: null,
    scriptFails: false,
    /** When set, source requests wait for this promise: a slow daemon. */
    sourceGate: null,
  };
  const api = {
    async listPlugins() {
      calls.push("list");
      if (world.listFails) throw new Error(world.listFails);
      return structuredClone(world.catalog);
    },
    async getPluginScript(id) {
      calls.push(`script:${id}`);
      if (world.scriptFails) throw new Error("The computer is not reachable");
      return `script of ${id}`;
    },
    async setPluginState(id, enabled, hash) {
      calls.push(`state:${id}:${enabled}:${hash}`);
      if (world.stateFails) throw new Error(world.stateFails);
      return world.catalog.find((p) => p.id === id);
    },
    async getPluginSource(id, source) {
      calls.push(`source:${id}:${source}`);
      if (world.sourceGate) await world.sourceGate;
      return world.readings.length > 1 ? world.readings.shift() : world.readings[0];
    },
    async setPluginOptions(id, values) {
      calls.push(`options:${id}:${JSON.stringify(values)}`);
      if (world.optionsFails) throw new Error(world.optionsFails);
      return world.catalog.find((p) => p.id === id);
    },
    async runPluginAction(id, action, hash, arg) {
      calls.push(`action:${id}:${action}:${hash}:${arg}`);
      return { ok: true, text: "done", exitCode: 0, fetchedAtMs: 5, truncated: false };
    },
    async bash(sessionId, command, excludeFromContext) {
      calls.push(`bash:${sessionId}:${command}:${excludeFromContext}`);
      return { ok: true, output: "out", exitCode: 0 };
    },
    async rpc(sessionId, command) {
      calls.push(`rpc:${sessionId}:${command}`);
      return { ok: true, data: {} };
    },
  };
  const host = createPluginHost({
    api: () => (paired ? api : null),
    createSandbox(options) {
      const sandbox = {
        options,
        posted: [],
        disposed: false,
        post(message) { this.posted.push(message); },
        dispose() { this.disposed = true; },
        /** What the worker would say. */
        say(message) { options.onMessage(message); },
      };
      sandboxes.push(sandbox);
      return sandbox;
    },
    setTimer(callback, ms) {
      const timer = { id: ++timerSeq, at: clock + ms, callback };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timers = timers.filter((t) => t !== timer); },
    now: () => clock,
    isVisible: () => visibility.visible,
    onVisibilityChange(listener) {
      visibility.listeners.add(listener);
      return () => visibility.listeners.delete(listener);
    },
    onPageHide(listener) {
      pageHide.add(listener);
      return () => pageHide.delete(listener);
    },
    guard: {
      isSet: () => guard.set,
      set(on) { guard.set = on; guard.writes.push(on); },
    },
  });
  const effects = { composed: [], prompted: [], opened: [], toasts: [] };
  host.configure({
    openPage: (id) => effects.opened.push(id),
    toast: (text) => effects.toasts.push(text),
    compose: async (sessionId, text) => { effects.composed.push([sessionId, text]); },
    prompt: async (sessionId, text) => { effects.prompted.push([sessionId, text]); },
  });
  const advance = async (ms) => {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      clock = due.at;
      due.callback();
      await settle();
    }
    clock = target;
    await settle();
  };
  const setVisible = (visible) => {
    visibility.visible = visible;
    for (const listener of [...visibility.listeners]) listener();
  };
  const hidePage = () => { for (const listener of [...pageHide]) listener(); };
  return { host, world, calls, sandboxes, guard, advance, setVisible, hidePage, effects };
}

const lastRender = (sandbox, slot) =>
  [...sandbox.posted].reverse().find((m) => m.t === "render" && m.slot === slot);
const renderCount = (sandbox) => sandbox.posted.filter((m) => m.t === "render").length;
const answerView = (sandbox, view, slot = "drawer") =>
  sandbox.say({ t: "view", id: lastRender(sandbox, slot).id, slot, view });

/** Retain a slot, load the catalog, and bring the last started plugin's worker to "ready". */
async function runPlugin(h, slot = "drawer") {
  const release = h.host.retainSlot(slot);
  await h.host.refresh();
  await settle();
  const sandbox = h.sandboxes[h.sandboxes.length - 1];
  sandbox.say({ t: "ready" });
  return { sandbox, release };
}

test("only an enabled plugin with a retained declared slot is started", async () => {
  const h = harness({
    catalog: [
      plugin("alpha"),
      plugin("off", { status: "disabled" }),
      plugin("new", { status: "needs_review" }),
      plugin("pageonly", { slots: ["page"] }),
    ],
  });
  await h.host.refresh();
  await settle();
  assert.equal(h.sandboxes.length, 0, "nothing runs before a slot is on screen");

  h.host.retainSlot("drawer");
  await settle();
  assert.equal(h.sandboxes.length, 1);
  assert.equal(h.sandboxes[0].options.script, "script of alpha");
  assert.deepEqual(h.host.getState().runtimes, {
    alpha: { state: "starting" },
    pageonly: { state: "idle" },
  });
});

test("a retain naming a plugin starts only that plugin", async () => {
  const h = harness({ catalog: [plugin("a", { slots: ["page"] }), plugin("b", { slots: ["page"] })] });
  await h.host.refresh();
  h.host.retainSlot("page", "a");
  await settle();
  assert.equal(h.sandboxes.length, 1);
  assert.equal(h.sandboxes[0].options.script, "script of a");
  assert.deepEqual(h.host.getState().runtimes, { a: { state: "starting" }, b: { state: "idle" } });

  const everyone = h.host.retainSlot("page");
  await settle();
  assert.equal(h.sandboxes.length, 2, "an unnamed retain keeps every declaring plugin running");
  everyone();
});

test("releasing the last slot keeps the plugin and its views for 10 s, then stops it", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox, release } = await runPlugin(h);
  answerView(sandbox, goodView());
  assert.equal(h.host.getState().views.drawer.length, 1);

  const other = h.host.retainSlot("drawer");
  release();
  await h.advance(20000);
  assert.equal(sandbox.disposed, false, "a second holder keeps it running");

  other();
  await h.advance(9999);
  assert.equal(sandbox.disposed, false, "still inside the grace period");
  assert.equal(h.host.getState().views.drawer.length, 1, "views stay in place meanwhile");
  assert.equal(h.host.getState().runtimes.alpha.state, "running");

  await h.advance(1);
  assert.equal(sandbox.disposed, true);
  assert.deepEqual(h.host.getState().views.drawer, []);
  assert.deepEqual(h.host.getState().runtimes, { alpha: { state: "idle" } });
});

test("retaining again inside the grace period cancels the stop", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox, release } = await runPlugin(h);
  answerView(sandbox, goodView());
  release();
  await h.advance(8000);
  h.host.retainSlot("drawer");
  await h.advance(30000);
  assert.equal(sandbox.disposed, false);
  assert.equal(h.sandboxes.length, 1, "no restart");
  assert.equal(h.host.getState().views.drawer.length, 1);
});

test("disabling stops a plugin at once, grace period or not", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());
  h.world.catalog = [plugin("alpha", { status: "disabled" })];
  await h.host.refresh();
  assert.equal(sandbox.disposed, true);
  assert.deepEqual(h.host.getState().views.drawer, []);
});

test("a valid view appears under its slot; an invalid one and an answer to a render nobody asked for do not", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  const { id } = lastRender(sandbox, "drawer");

  sandbox.say({ t: "view", id: id + 1, slot: "drawer", view: goodView("wrong request") });
  sandbox.say({ t: "view", id: id + 1000, slot: "drawer", view: goodView("never asked for") });
  sandbox.say({ t: "view", id, slot: "drawer", view: badView });
  assert.deepEqual(h.host.getState().views.drawer, [], "nothing shown yet");
  assert.equal(h.host.getState().runtimes.alpha.state, "running", "one bad view is tolerated");

  sandbox.say({ t: "refresh" });
  await h.advance(250);
  answerView(sandbox, goodView("shown"));
  const [shown] = h.host.getState().views.drawer;
  assert.equal(shown.pluginId, "alpha");
  assert.equal(shown.pluginName, "Plugin alpha");
  assert.equal(shown.view.k, "text");
  assert.equal(shown.view.p.text, "shown");
  assert.deepEqual(h.host.getState().views["composer.status"], []);
  assert.deepEqual(h.host.getState().views.page, []);
});

test("three invalid views in a row fail the plugin with the validator's message; a valid one resets the count", async () => {
  const expected = validatePluginView("drawer", badView);
  assert.equal(expected.ok, false);
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  const answer = async (view) => {
    sandbox.say({ t: "refresh" });
    await h.advance(250);
    answerView(sandbox, view);
  };

  answerView(sandbox, badView);
  await answer(badView);
  await answer(goodView());
  await answer(badView);
  await answer(badView);
  assert.equal(h.host.getState().runtimes.alpha.state, "running", "the good view reset the streak");

  await answer(badView);
  assert.deepEqual(h.host.getState().runtimes.alpha, { state: "failed", error: expected.error });
  assert.equal(sandbox.disposed, true);
  assert.deepEqual(h.host.getState().views.drawer, []);
});

test("a render that is not answered within 2000 ms fails the plugin", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  assert.ok(lastRender(sandbox, "drawer"));

  await h.advance(1999);
  assert.equal(h.host.getState().runtimes.alpha.state, "running");
  await h.advance(1);
  assert.equal(h.host.getState().runtimes.alpha.state, "failed");
  assert.match(h.host.getState().runtimes.alpha.error, /2 seconds/);
  assert.equal(sandbox.disposed, true);
});

test("a render waiting for an uncached source is not charged for the daemon's time, only for the plugin's own", async () => {
  const slow = async (rendererMs) => {
    const h = harness({ catalog: [plugin("alpha", { sources: [loadSource] })] });
    let open;
    h.world.sourceGate = new Promise((resolve) => { open = resolve; });
    h.world.readings = [reading(1000)];
    const { sandbox } = await runPlugin(h);
    sandbox.say({ t: "source", id: 1, sourceId: "load" }); // the renderer awaits pulse.source()
    await h.advance(20000); // a command that legitimately takes a long time
    assert.equal(h.host.getState().runtimes.alpha.state, "running", "the wait is the daemon's");
    assert.equal(sandbox.posted.some((m) => m.t === "source"), false);

    open();
    await settle();
    assert.equal(sandbox.posted.find((m) => m.t === "source").reading.fetchedAtMs, 1000);
    await h.advance(rendererMs);
    return { h, sandbox };
  };

  const quick = await slow(1999);
  assert.equal(quick.h.host.getState().runtimes.alpha.state, "running", "the full budget starts after the reading is posted");
  answerView(quick.sandbox, goodView());
  assert.equal(quick.h.host.getState().views.drawer.length, 1);

  const sluggish = await slow(2000);
  assert.equal(sluggish.h.host.getState().runtimes.alpha.state, "failed", "the plugin itself still has 2000 ms");
});

test("a worker that never finishes loading fails, and a script error fails at once", async () => {
  const h = harness({ catalog: [plugin("alpha"), plugin("beta")] });
  h.host.retainSlot("drawer");
  await h.host.refresh();
  await settle();
  h.sandboxes[1].options.onFailure("ReferenceError: nope is not defined");
  assert.deepEqual(h.host.getState().runtimes.beta, { state: "failed", error: "ReferenceError: nope is not defined" });
  await h.advance(5000);
  assert.equal(h.host.getState().runtimes.alpha.state, "failed");
});

test("a script download failure is not a plugin failure: the next refresh tries again", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  h.world.scriptFails = true;
  h.host.retainSlot("drawer");
  await h.host.refresh();
  await settle();
  assert.equal(h.sandboxes.length, 0);
  assert.deepEqual(h.host.getState().runtimes, { alpha: { state: "idle" } });

  await h.advance(60000); // no start budget runs without a script
  assert.deepEqual(h.host.getState().runtimes, { alpha: { state: "idle" } });

  h.world.scriptFails = false;
  await h.host.refresh();
  await settle();
  assert.equal(h.sandboxes.length, 1);
  assert.equal(h.host.getState().runtimes.alpha.state, "starting");
});

test("a catalog refresh with a new hash restarts a plugin, including a failed one", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  const same = h.host.getState().catalog;
  await h.host.refresh();
  assert.equal(h.host.getState().catalog, same, "an unchanged catalog keeps its identity");
  assert.equal(h.sandboxes.length, 1);

  h.world.catalog = [plugin("alpha", { hash: "hash-2" })];
  await h.host.refresh();
  await settle();
  assert.equal(sandbox.disposed, true);
  assert.equal(h.sandboxes.length, 2);
  assert.equal(h.host.getState().runtimes.alpha.state, "starting");

  h.sandboxes[1].options.onFailure("boom");
  await h.host.refresh();
  await settle();
  assert.equal(h.sandboxes.length, 2, "a failed plugin stays stopped while its hash is unchanged");
  assert.equal(h.host.getState().runtimes.alpha.state, "failed");

  h.world.catalog = [plugin("alpha", { hash: "hash-3" })];
  await h.host.refresh();
  await settle();
  assert.equal(h.sandboxes.length, 3);
  assert.equal(h.host.getState().runtimes.alpha.state, "starting");
});

test("the crash marker halts start-up until resume", async () => {
  const h = harness({ catalog: [plugin("alpha")], guardSet: true });
  h.host.retainSlot("drawer");
  await h.host.refresh();
  await settle();
  assert.equal(h.sandboxes.length, 0);
  assert.equal(h.host.getState().haltedAfterCrash, true);
  assert.equal(h.host.getState().catalog.length, 1, "the catalog still loads so Settings can show it");

  h.host.resume();
  await settle();
  assert.equal(h.host.getState().haltedAfterCrash, false);
  assert.equal(h.sandboxes.length, 1);
});

test("the crash marker is written before a start and cleared 5000 ms after it finished", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  assert.equal(h.guard.set, false);
  const { sandbox } = await runPlugin(h);
  assert.equal(h.guard.set, true);
  answerView(sandbox, goodView());
  await h.advance(4999);
  assert.equal(h.guard.set, true);
  await h.advance(1);
  assert.equal(h.guard.set, false);
});

test("leaving the page clears the crash marker: a reload is not a crash", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  await runPlugin(h);
  assert.equal(h.guard.set, true);
  h.hidePage();
  assert.equal(h.guard.set, false);
});

test("setEnabled posts the decision, then reloads the catalog", async () => {
  const h = harness({ catalog: [plugin("alpha", { status: "needs_review" })] });
  await h.host.refresh();
  h.calls.length = 0;

  h.world.catalog = [plugin("alpha")];
  await h.host.setEnabled("alpha", true, "hash-1");
  assert.deepEqual(h.calls, ["state:alpha:true:hash-1", "list"]);
  assert.equal(h.host.getState().catalog[0].status, "enabled");

  h.calls.length = 0;
  h.world.stateFails = "This device is read-only";
  await assert.rejects(h.host.setEnabled("alpha", false), /read-only/);
  assert.deepEqual(h.calls, ["state:alpha:false:undefined"], "a refused change does not reload");
});

test("without a stored credential refresh leaves the catalog unloaded and reports nothing", async () => {
  const h = harness({ catalog: [plugin("alpha")], paired: false });
  await h.host.refresh();
  assert.equal(h.host.getState().catalog, null);
  assert.equal(h.host.getState().catalogError, null);
  assert.deepEqual(h.calls, []);
  await assert.rejects(h.host.setEnabled("alpha", false), /Pair this device/);
});

test("a failed catalog request keeps the old catalog and says why", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  await h.host.refresh();
  h.world.listFails = "The computer is not reachable";
  await h.host.refresh();
  assert.equal(h.host.getState().catalog.length, 1);
  assert.equal(h.host.getState().catalogError, "The computer is not reachable");
});

test("views keep their array identity when a re-render changes nothing", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView("same"));
  const before = h.host.getState().views.drawer;
  const seen = [];
  h.host.subscribe(() => seen.push(1));

  sandbox.say({ t: "refresh" });
  await h.advance(250);
  answerView(sandbox, goodView("same"));
  assert.equal(h.host.getState().views.drawer, before);
  assert.deepEqual(seen, [], "no listener is woken for an identical view");
});

test("two refresh requests inside 250 ms produce one render, after the gap", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());
  assert.equal(renderCount(sandbox), 1);

  await h.advance(100);
  sandbox.say({ t: "refresh" });
  sandbox.say({ t: "refresh", slot: "drawer" });
  assert.equal(renderCount(sandbox), 1, "deferred, not dropped and not immediate");
  await h.advance(149);
  assert.equal(renderCount(sandbox), 1);
  await h.advance(1);
  assert.equal(renderCount(sandbox), 2);
  answerView(sandbox, goodView());
  await h.advance(5000);
  assert.equal(renderCount(sandbox), 2, "one render served both requests");
});

test("nothing is rendered while the page is hidden; the deferred render goes out when it is shown", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  h.setVisible(false);
  const { sandbox } = await runPlugin(h);
  assert.equal(renderCount(sandbox), 0);
  await h.advance(10000);
  assert.equal(renderCount(sandbox), 0);

  h.setVisible(true);
  assert.equal(renderCount(sandbox), 1);
  answerView(sandbox, goodView());

  h.setVisible(false);
  sandbox.say({ t: "refresh" });
  await h.advance(1000);
  assert.equal(renderCount(sandbox), 1, "a refresh while hidden waits");
  h.setVisible(true);
  assert.equal(renderCount(sandbox), 2);
});

test("sources: fetched once on demand, polled a second after the interval, refused when undeclared, silent while hidden", async () => {
  const h = harness({ catalog: [plugin("alpha", { sources: [loadSource] })] });
  h.world.readings = [reading(1000, "first"), reading(1000, "first"), reading(2000, "second")];
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());

  sandbox.say({ t: "source", id: 7, sourceId: "secret" });
  await settle();
  const refusal = sandbox.posted.find((m) => m.t === "source" && m.id === 7);
  assert.equal(refusal.reading.ok, false);
  assert.ok(!h.calls.some((c) => c.startsWith("source:alpha:secret")));

  sandbox.say({ t: "source", id: 8, sourceId: "load" });
  await settle();
  sandbox.say({ t: "source", id: 9, sourceId: "load" });
  await settle();
  assert.equal(h.calls.filter((c) => c === "source:alpha:load").length, 1, "the second ask is served from the reading");
  assert.equal(sandbox.posted.find((m) => m.id === 9).reading.text, "first");

  const rendersBefore = renderCount(sandbox);
  await h.advance(10999);
  assert.equal(h.calls.filter((c) => c === "source:alpha:load").length, 1, "not inside the daemon's cache window");
  await h.advance(1);
  assert.equal(h.calls.filter((c) => c === "source:alpha:load").length, 2);
  assert.equal(renderCount(sandbox), rendersBefore, "an unchanged reading draws nothing");

  await h.advance(11000);
  assert.equal(h.calls.filter((c) => c === "source:alpha:load").length, 3);
  assert.equal(renderCount(sandbox), rendersBefore + 1, "a newer reading renders again");
  answerView(sandbox, goodView("second"));

  h.setVisible(false);
  const before = h.calls.length;
  await h.advance(60000);
  assert.equal(h.calls.length, before, "nothing is polled while the page is hidden");
});

test("openPage is honoured only for a plugin with a page and only within 1000 ms of a tap; toast text is cut", async () => {
  const h = harness({ catalog: [plugin("alpha"), plugin("paged", { slots: ["drawer", "page"] })] });
  const opened = [];
  const toasts = [];
  h.host.configure({ openPage: (id) => opened.push(id), toast: (text) => toasts.push(text) });
  const release = h.host.retainSlot("drawer");
  await h.host.refresh();
  await settle();
  const [alpha, paged] = h.sandboxes;
  alpha.say({ t: "ready" });
  paged.say({ t: "ready" });
  answerView(paged, goodView());

  paged.say({ t: "openPage" });
  assert.deepEqual(opened, [], "no tap, no page");

  h.host.dispatchAction("alpha", "drawer", "go");
  alpha.say({ t: "openPage" });
  assert.deepEqual(opened, [], "alpha declares no page");

  const posted = paged.posted.length;
  h.host.dispatchAction("paged", "drawer", "go=now", "row-1");
  assert.deepEqual(paged.posted[posted], { t: "action", slot: "drawer", action: "go=now", item: "row-1", session: null });
  await h.advance(250);
  assert.equal(paged.posted.slice(posted + 1).some((m) => m.t === "render"), true, "it draws the result of the tap");
  await h.advance(750);
  paged.say({ t: "openPage" });
  assert.deepEqual(opened, ["paged"], "exactly 1000 ms after the tap is still inside");
  await h.advance(1);
  paged.say({ t: "openPage" });
  assert.deepEqual(opened, ["paged"], "later it needs a new tap");

  paged.say({ t: "toast", text: "x".repeat(500) });
  paged.say({ t: "toast", text: 42 });
  assert.deepEqual(toasts, [`Plugin paged: ${"x".repeat(200)}`], "cut, and named after its plugin");
  release();
});

test("a toast names its plugin; each tap earns one, and others show at most once per 30 s", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());
  const shown = () => h.effects.toasts.length;

  sandbox.say({ t: "toast", text: "untapped 1" });
  sandbox.say({ t: "toast", text: "untapped 2" });
  assert.deepEqual(h.effects.toasts, ["Plugin alpha: untapped 1"], "the second came too soon");

  h.host.dispatchAction("alpha", "drawer", "go");
  sandbox.say({ t: "toast", text: "answer" });
  sandbox.say({ t: "toast", text: "answer again" });
  assert.equal(h.effects.toasts.at(-1), "Plugin alpha: answer", "one toast per tap");
  assert.equal(shown(), 2);

  await advanceHealthy(h, sandbox, 29999);
  sandbox.say({ t: "toast", text: "still too soon" });
  assert.equal(shown(), 2);
  await advanceHealthy(h, sandbox, 1);
  sandbox.say({ t: "toast", text: "untapped 3" });
  assert.equal(h.effects.toasts.at(-1), "Plugin alpha: untapped 3");
});

test("hostile messages are ignored and a flood fails the plugin", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  const { sandbox } = await runPlugin(h);
  for (const junk of [null, 5, "text", [], {}, { t: "nonsense" }, { t: "view" }, { t: "source", id: "x" }, { t: "toast" }]) sandbox.say(junk);
  assert.equal(h.host.getState().runtimes.alpha.state, "running");

  for (let i = 0; i < 650; i++) sandbox.say({ t: "nonsense" });
  assert.deepEqual(h.host.getState().runtimes.alpha, { state: "failed", error: "The plugin sent too many messages" });
});

// ── Slice 2: keyed slots, claims, taps, options ─────────────────────────

const sessionInfo = (id, title = "Chat") => ({ id, title, cwd: "/work", model: "m", status: "idle", activeAt: null });
const chipView = (text = "busy") => ({ k: "chip", p: { text }, c: [] });
const toolContext = (name, id = "call-1") => ({
  session: null,
  call: { id, name, args: {}, output: "", state: "done", truncated: false },
});
const rendersFor = (sandbox, slot, key) =>
  sandbox.posted.filter((m) => m.t === "render" && m.slot === slot && (key === undefined || m.key === key));
const answerKey = (sandbox, slot, key, view) => {
  const render = rendersFor(sandbox, slot, key).at(-1);
  sandbox.say({ t: "view", id: render.id, slot, key, view });
};
const callResult = (sandbox, id) => sandbox.posted.find((m) => m.t === "callResult" && m.id === id)?.result;
/** What the worker does when a plugin calls an action method. */
async function call(sandbox, id, op, fields = {}) {
  sandbox.say({ t: "call", id, op, ...fields });
  await settle();
  return callResult(sandbox, id);
}
/** Move the clock like `advance`, answering every render as a healthy plugin would (an unanswered one fails after 2 s). */
async function advanceHealthy(h, sandbox, ms) {
  const answered = (sandbox.answered ??= new Set());
  for (let left = ms; left > 0; left -= 100) {
    await h.advance(Math.min(100, left));
    for (const m of sandbox.posted.filter((posted) => posted.t === "render" && !answered.has(posted.id))) {
      answered.add(m.id);
      sandbox.say({ t: "view", id: m.id, slot: m.slot, key: m.key, view: null });
    }
  }
}
const actor = (extra = {}) =>
  plugin("acts", {
    permissions: ["session.prompt", "session.compose", "session.bash", "session.read"],
    actions: [{ id: "start", label: "Start", command: ["x", "{arg}"], argPattern: "a+", timeoutS: 30 }],
    hash: "hash-9",
    ...extra,
  });

test("a keyed render gets its context and its view lands under its key", async () => {
  const h = harness({ catalog: [plugin("rows", { slots: ["session.row"] })] });
  const context = { session: sessionInfo("/s/1", "One") };
  h.host.retainKey("session.row", "/s/1", context);
  await h.host.refresh();
  await settle();
  const sandbox = h.sandboxes[0];
  sandbox.say({ t: "ready" });

  const [render] = rendersFor(sandbox, "session.row");
  assert.equal(render.key, "/s/1");
  assert.equal(render.ctx.session.title, "One");
  answerKey(sandbox, "session.row", "/s/1", chipView());

  const { keyed, views } = h.host.getState();
  assert.equal(keyed["session.row"]["/s/1"][0].pluginId, "rows");
  assert.equal(keyed["session.row"]["/s/1"][0].view.p.text, "busy");
  assert.deepEqual(views["session.row"], [], "keyed views are not in the unkeyed record");
  assert.deepEqual(keyed["session.menu"], {});
});

test("a changed context re-renders its key, an unchanged one does not, and views keep their identity", async () => {
  const h = harness({ catalog: [plugin("rows", { slots: ["session.row"] })] });
  h.host.retainKey("session.row", "/s/1", { session: sessionInfo("/s/1", "One") });
  await h.host.refresh();
  await settle();
  const sandbox = h.sandboxes[0];
  sandbox.say({ t: "ready" });
  answerKey(sandbox, "session.row", "/s/1", chipView());
  const before = h.host.getState().keyed["session.row"]["/s/1"];

  h.host.retainKey("session.row", "/s/1", { session: sessionInfo("/s/1", "One") });
  await h.advance(1000);
  assert.equal(rendersFor(sandbox, "session.row").length, 1, "same JSON, no render");

  h.host.retainKey("session.row", "/s/1", { session: sessionInfo("/s/1", "Two") });
  await h.advance(250);
  const renders = rendersFor(sandbox, "session.row");
  assert.equal(renders.length, 2);
  assert.equal(renders[1].ctx.session.title, "Two", "the latest context wins");
  answerKey(sandbox, "session.row", "/s/1", chipView());
  assert.equal(h.host.getState().keyed["session.row"]["/s/1"], before, "an identical answer changes nothing");
});

test("a transcript card goes to the first enabled plugin whose claims match; the others are not started", async () => {
  const h = harness({
    catalog: [
      plugin("a", { slots: ["transcript.tool"], tools: ["foo_*"], permissions: ["session.read"] }),
      plugin("b", { slots: ["transcript.tool"], tools: ["foo_bar"] }),
      plugin("c", { slots: ["transcript.tool"], tools: ["zzz"] }),
      plugin("d", { slots: ["transcript.tool"], tools: ["foo_*"], status: "disabled" }),
    ],
  });
  h.host.setOpenSession(sessionInfo("/s/open", "Open"));
  h.host.retainKey("transcript.tool", "call-1", toolContext("foo_bar"));
  await h.host.refresh();
  await settle();
  assert.equal(h.sandboxes.length, 1);
  assert.equal(h.sandboxes[0].options.script, "script of a");
  assert.deepEqual(h.host.getState().runtimes, {
    a: { state: "starting" },
    b: { state: "idle" },
    c: { state: "idle" },
  });
  h.sandboxes[0].say({ t: "ready" });
  const [render] = rendersFor(h.sandboxes[0], "transcript.tool");
  assert.equal(render.ctx.call.name, "foo_bar");
  assert.equal(render.ctx.session.id, "/s/open", "the host fills in the open conversation");

  h.host.retainKey("transcript.tool", "call-2", toolContext("zzz", "call-2"));
  await settle();
  assert.equal(h.sandboxes.length, 2);
  assert.equal(h.sandboxes[1].options.script, "script of c");

  h.host.retainKey("transcript.tool", "call-3", toolContext("unclaimed", "call-3"));
  await settle();
  assert.equal(h.sandboxes.length, 2, "nobody claims it, nobody starts");
});

test("unkeyed renders carry the open conversation, and a change of it re-renders", async () => {
  const h = harness({ catalog: [plugin("alpha", { permissions: ["session.read"] })] });
  const { sandbox } = await runPlugin(h);
  assert.equal(lastRender(sandbox, "drawer").ctx.session, null);
  answerView(sandbox, goodView());

  h.host.setOpenSession(sessionInfo("/s/1", "One"));
  await h.advance(250);
  assert.equal(lastRender(sandbox, "drawer").ctx.session.id, "/s/1");
  answerView(sandbox, goodView());

  h.host.setOpenSession(sessionInfo("/s/1", "One"));
  await h.advance(1000);
  assert.equal(renderCount(sandbox), 2, "the same conversation again changes nothing");

  h.host.setOpenSession(null);
  await h.advance(250);
  assert.equal(lastRender(sandbox, "drawer").ctx.session, null);
});

test("an action call needs a tap: none is refused, one is honoured once, and it expires after 3000 ms", async () => {
  const h = harness({ catalog: [actor()] });
  h.host.setOpenSession(sessionInfo("/s/open"));
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());

  const untapped = await call(sandbox, 1, "prompt", { text: "hello" });
  assert.equal(untapped.ok, false);
  assert.match(untapped.error, /needs a tap/);
  assert.deepEqual(h.effects.prompted, []);

  h.host.dispatchAction("acts", "drawer", "go=1");
  assert.deepEqual(sandbox.posted.find((m) => m.t === "action"), { t: "action", slot: "drawer", action: "go=1", session: sessionInfo("/s/open") });
  assert.equal((await call(sandbox, 2, "prompt", { text: "hello" })).ok, true);
  assert.deepEqual(h.effects.prompted, [["/s/open", "hello"]]);

  const second = await call(sandbox, 3, "prompt", { text: "again" });
  assert.equal(second.ok, false, "one call per tap");
  assert.match(second.error, /needs a tap/);
  assert.equal(h.effects.prompted.length, 1);

  h.host.dispatchAction("acts", "drawer", "go=2");
  await advanceHealthy(h, sandbox, 3000);
  assert.equal((await call(sandbox, 4, "compose", { text: "draft" })).ok, true, "3000 ms is still inside");
  assert.deepEqual(h.effects.composed, [["/s/open", "draft"]]);

  h.host.dispatchAction("acts", "drawer", "go=3");
  await advanceHealthy(h, sandbox, 3001);
  assert.match((await call(sandbox, 5, "compose", { text: "late" })).error, /needs a tap/);
});

test("a tap on a row targets that row's conversation, not the open one", async () => {
  const h = harness({ catalog: [plugin("rows", { slots: ["session.row"], permissions: ["session.prompt", "session.bash"] })] });
  h.host.setOpenSession(sessionInfo("/s/open"));
  h.host.retainKey("session.row", "/s/row", { session: sessionInfo("/s/row", "Row") });
  await h.host.refresh();
  await settle();
  const sandbox = h.sandboxes[0];
  sandbox.say({ t: "ready" });
  answerKey(sandbox, "session.row", "/s/row", chipView());

  h.host.dispatchAction("rows", "session.row", "go", "item-1", "/s/row");
  const action = sandbox.posted.find((m) => m.t === "action");
  assert.equal(action.key, "/s/row");
  assert.equal(action.item, "item-1");
  assert.equal(action.session.title, "Row");
  assert.equal((await call(sandbox, 1, "bash", { command: "ls", excludeFromContext: true })).ok, true);
  assert.ok(h.calls.includes("bash:/s/row:ls:true"), "the command ran in the row's conversation");
});

test("a call for an undeclared permission or action, or over a limit, is refused without spending the tap", async () => {
  const h = harness({ catalog: [actor({ permissions: ["session.prompt"] })] });
  h.host.setOpenSession(sessionInfo("/s/open"));
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());
  h.host.dispatchAction("acts", "drawer", "go");

  assert.match((await call(sandbox, 1, "bash", { command: "ls" })).error, /session\.bash/);
  assert.match((await call(sandbox, 2, "hostRun", { action: "nope" })).error, /no action called "nope"/);
  assert.match((await call(sandbox, 3, "prompt", { text: "x".repeat(20001) })).error, /20000/);
  assert.match((await call(sandbox, 4, "rpc", { command: "get_state", params: {} })).error, /session\.rpc/);
  assert.deepEqual(h.effects.prompted, []);
  assert.equal((await call(sandbox, 5, "prompt", { text: "fine" })).ok, true, "the tap was still there");
});

test("hostRun runs the declared action with the hash the plugin started with", async () => {
  const h = harness({ catalog: [actor()] });
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());
  h.host.dispatchAction("acts", "drawer", "go");

  const result = await call(sandbox, 1, "hostRun", { action: "start", arg: "aaa", hash: "something-else" });
  assert.ok(h.calls.includes("action:acts:start:hash-9:aaa"));
  assert.equal(result.ok, true);
  assert.equal(result.text, "done");
});

test("a plugin turned off or changed on the computer cannot spend a tap, and is stopped", async () => {
  for (const change of [{ status: "disabled" }, { status: "needs_review", hash: "hash-edited" }]) {
    const h = harness({ catalog: [actor()] });
    h.host.setOpenSession(sessionInfo("/s/open"));
    const { sandbox } = await runPlugin(h);
    answerView(sandbox, goodView());
    // The phone still runs the approved script; the daemon has moved on.
    Object.assign(h.world.catalog[0], change);
    h.host.dispatchAction("acts", "drawer", "go");
    const result = await call(sandbox, 1, "bash", { command: "ls" });
    // The reload stops the worker, so no answer reaches it at all.
    assert.equal(result, undefined, JSON.stringify(change));
    assert.equal(h.calls.some((c) => c.startsWith("bash:")), false, "nothing ran");
    assert.equal(sandbox.disposed, true, "the reload stopped it");
  }
});

test("a call the daemon cannot confirm does not run", async () => {
  const h = harness({ catalog: [actor()] });
  h.host.setOpenSession(sessionInfo("/s/open"));
  const { sandbox } = await runPlugin(h);
  answerView(sandbox, goodView());
  h.world.listFails = "The computer is not reachable";
  h.host.dispatchAction("acts", "drawer", "go");
  const result = await call(sandbox, 1, "prompt", { text: "hello" });
  assert.equal(result.ok, false);
  assert.deepEqual(h.effects.prompted, []);
});

test("options reach the worker before the first render, and changed values re-render without a restart", async () => {
  const h = harness({ catalog: [plugin("alpha", { optionValues: { warn: "80" } })] });
  const { sandbox } = await runPlugin(h);
  const order = sandbox.posted.map((m) => m.t);
  assert.deepEqual(sandbox.posted[0], { t: "options", values: { warn: "80" } });
  assert.ok(order.indexOf("options") < order.indexOf("render"));
  answerView(sandbox, goodView());

  h.world.catalog = [plugin("alpha", { optionValues: { warn: "90" } })];
  await h.host.refresh();
  await h.advance(250);
  assert.equal(h.sandboxes.length, 1, "no restart");
  const tail = sandbox.posted.slice(2).map((m) => m.t);
  assert.deepEqual(tail, ["options", "render"], "the new values come before the render they cause");
  assert.deepEqual(sandbox.posted[2].values, { warn: "90" });
});

test("setOptions posts the values then reloads; a refusal rejects and does not reload", async () => {
  const h = harness({ catalog: [plugin("alpha")] });
  await h.host.refresh();
  h.calls.length = 0;
  await h.host.setOptions("alpha", { warn: "90" });
  assert.deepEqual(h.calls, ['options:alpha:{"warn":"90"}', "list"]);

  h.calls.length = 0;
  h.world.optionsFails = "This device is read-only";
  await assert.rejects(h.host.setOptions("alpha", { warn: "70" }), /read-only/);
  assert.deepEqual(h.calls, ['options:alpha:{"warn":"70"}']);
});

// The sandbox needs a browser. These tests give it the few DOM pieces it touches and
// drive the worker's end of the port by hand.
function withFakeBrowser(run) {
  const saved = { MessageChannel: globalThis.MessageChannel, window: globalThis.window, document: globalThis.document };
  const env = { frames: [], ports: [], timeouts: [] };
  globalThis.MessageChannel = class {
    constructor() {
      this.port1 = { posted: [], closed: false, onmessage: null, postMessage(m) { this.posted.push(m); }, close() { this.closed = true; } };
      this.port2 = {};
      env.ports.push(this.port1);
    }
  };
  globalThis.window = {
    setTimeout: (callback) => env.timeouts.push(callback),
    clearTimeout() {},
  };
  globalThis.document = {
    body: { appendChild(frame) { frame.attached = true; } },
    createElement() {
      const frame = {
        attrs: {},
        listeners: {},
        removed: false,
        setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        remove() { this.removed = true; },
        contentWindow: { postMessage(...args) { frame.handoff = args; } },
      };
      env.frames.push(frame);
      return frame;
    },
  };
  try {
    return run(env);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test("sandbox: the frame gets allow-scripts and nothing else", () => {
  withFakeBrowser((env) => {
    createPluginSandbox({ script: "", onMessage() {}, onFailure() {} });
    assert.equal(env.frames[0].attrs.sandbox, "allow-scripts");
  });
});

test("sandbox: a worker message that is not bounded JSON fails the plugin once, and nothing after it is parsed", () => {
  withFakeBrowser((env) => {
    const messages = [];
    const failures = [];
    createPluginSandbox({ script: "", onMessage: (m) => messages.push(m), onFailure: (r) => failures.push(r) });
    const port = env.ports[0];
    port.onmessage({ data: '{"t":"ready"}' });
    port.onmessage({ data: "[1,2]" });
    port.onmessage({ data: "[" + "1,".repeat(65000) + "x" });
    port.onmessage({ data: '{"t":"toast"}' });
    assert.deepEqual(messages, [{ t: "ready" }, [1, 2]], "any valid JSON is relayed; the host judges its shape");
    assert.deepEqual(failures, ["The plugin sent an invalid message"]);
  });
});

test("sandbox: a message over the size cap fails the plugin even when it is valid JSON", () => {
  withFakeBrowser((env) => {
    const messages = [];
    const failures = [];
    createPluginSandbox({ script: "", onMessage: (m) => messages.push(m), onFailure: (r) => failures.push(r) });
    env.ports[0].onmessage({ data: "0".repeat(131073) });
    assert.deepEqual(messages, []);
    assert.deepEqual(failures, ["The plugin sent an invalid message"]);
  });
});

test("sandbox: a bootstrap error report, or a frame that never answers, fails the plugin", () => {
  withFakeBrowser((env) => {
    const failures = [];
    createPluginSandbox({ script: "", onMessage() {}, onFailure: (r) => failures.push(r) });
    env.ports[0].onmessage({ data: { c: "error", message: "SyntaxError: bad" } });
    assert.deepEqual(failures, ["SyntaxError: bad"]);

    const silent = [];
    createPluginSandbox({ script: "", onMessage() {}, onFailure: (r) => silent.push(r) });
    env.timeouts[1]();
    assert.equal(silent.length, 1);
    createPluginSandbox({ script: "", onMessage() {}, onFailure: (r) => silent.push(r) });
    env.ports[2].onmessage({ data: { c: "ready" } });
    env.timeouts[2]();
    assert.equal(silent.length, 1, "an answered frame is not failed by the timer");
  });
});

test("sandbox: dispose is idempotent and silences the worker", () => {
  withFakeBrowser((env) => {
    const messages = [];
    const failures = [];
    const sandbox = createPluginSandbox({ script: "", onMessage: (m) => messages.push(m), onFailure: (r) => failures.push(r) });
    sandbox.dispose();
    sandbox.dispose();
    assert.equal(env.frames[0].removed, true);
    assert.equal(env.ports[0].closed, true);
    assert.equal(env.ports[0].posted.filter((m) => m.c === "stop").length, 1);
    env.ports[0].onmessage({ data: "not json" });
    sandbox.post({ t: "render" });
    assert.deepEqual([messages, failures], [[], []]);
  });
});

// ── Review amendments: session.read, tap scope, key eviction ────────────

const menuView = () => ({ k: "list", p: { items: [{ id: "a", label: "A" }], actions: { click: "go" } }, c: [] });

/** One plugin drawing in a drawer, a transcript card and a conversation row, with the open conversation set. */
async function visibilityHarness(permissions) {
  const h = harness({
    catalog: [plugin("p", { slots: ["drawer", "transcript.tool", "session.row"], tools: ["t_*"], permissions })],
  });
  h.host.setOpenSession(sessionInfo("/s/open", "Open"));
  h.host.retainSlot("drawer");
  h.host.retainKey("transcript.tool", "c1", toolContext("t_x", "c1"));
  h.host.retainKey("session.row", "/s/row", { session: sessionInfo("/s/row", "Row") });
  await h.host.refresh();
  await settle();
  const sandbox = h.sandboxes[0];
  sandbox.say({ t: "ready" });
  return { h, sandbox };
}

test("without session.read a plugin never learns the open conversation; a row still names its own", async () => {
  const { h, sandbox } = await visibilityHarness(["session.prompt"]);
  assert.equal(lastRender(sandbox, "drawer").ctx.session, null);
  assert.equal(rendersFor(sandbox, "transcript.tool")[0].ctx.session, null);
  assert.equal(rendersFor(sandbox, "session.row")[0].ctx.session.id, "/s/row");
  answerView(sandbox, goodView());

  h.host.dispatchAction("p", "drawer", "go");
  const [drawerTap] = sandbox.posted.filter((m) => m.t === "action");
  assert.equal(drawerTap.session, null);
  assert.equal((await call(sandbox, 1, "prompt", { text: "hi" })).ok, true);
  assert.deepEqual(h.effects.prompted, [["/s/open", "hi"]], "the tap still acts on the open conversation, unseen");

  h.host.dispatchAction("p", "session.row", "go", undefined, "/s/row");
  const rowTap = sandbox.posted.filter((m) => m.t === "action")[1];
  assert.equal(rowTap.session.id, "/s/row");

  await advanceHealthy(h, sandbox, 300); // let the tap's own re-render go first
  const before = rendersFor(sandbox, "drawer").length;
  h.host.setOpenSession(sessionInfo("/s/other", "Other"));
  await advanceHealthy(h, sandbox, 1000);
  assert.equal(rendersFor(sandbox, "drawer").length, before, "nothing new to tell it");
});

test("with session.read a plugin gets the open conversation, and a change of it re-renders drawers and transcript cards", async () => {
  const { h, sandbox } = await visibilityHarness(["session.read"]);
  assert.equal(lastRender(sandbox, "drawer").ctx.session.id, "/s/open");
  assert.equal(rendersFor(sandbox, "transcript.tool")[0].ctx.session.id, "/s/open");
  answerView(sandbox, goodView());
  answerKey(sandbox, "transcript.tool", "c1", goodView());
  answerKey(sandbox, "session.row", "/s/row", chipView());

  h.host.dispatchAction("p", "drawer", "go");
  assert.equal(sandbox.posted.find((m) => m.t === "action").session.id, "/s/open");

  h.host.setOpenSession(sessionInfo("/s/other", "Other"));
  await h.advance(250);
  assert.equal(lastRender(sandbox, "drawer").ctx.session.id, "/s/other");
  assert.equal(rendersFor(sandbox, "transcript.tool").at(-1).ctx.session.id, "/s/other");
  assert.equal(rendersFor(sandbox, "session.row").length, 1, "a row names its own conversation and is not redrawn");
});

test("a tap re-renders the tapped key and the unkeyed targets, not every row", async () => {
  const h = harness({ catalog: [plugin("p", { slots: ["session.row", "drawer"] })] });
  h.host.retainSlot("drawer");
  h.host.retainKey("session.row", "k1", { session: sessionInfo("k1") });
  h.host.retainKey("session.row", "k2", { session: sessionInfo("k2") });
  await h.host.refresh();
  await settle();
  const sandbox = h.sandboxes[0];
  sandbox.say({ t: "ready" });
  answerView(sandbox, goodView());
  answerKey(sandbox, "session.row", "k1", chipView());
  answerKey(sandbox, "session.row", "k2", chipView());
  await h.advance(300);

  h.host.dispatchAction("p", "session.row", "go", undefined, "k1");
  assert.equal(rendersFor(sandbox, "session.row", "k1").length, 2);
  assert.equal(rendersFor(sandbox, "session.row", "k2").length, 1, "the other row is left alone");
  assert.equal(rendersFor(sandbox, "drawer").length, 2, "unkeyed targets follow the tap");
});

test("a key over the cap evicts the oldest; the evicted handle's release is harmless", async () => {
  const h = harness({ catalog: [plugin("menus", { slots: ["session.menu"] })] });
  const handles = {};
  for (const key of ["k1", "k2", "k3", "k4"]) handles[key] = h.host.retainKey("session.menu", key, { session: sessionInfo(key) });
  await h.host.refresh();
  await settle();
  const sandbox = h.sandboxes[0];
  sandbox.say({ t: "ready" });
  for (const key of ["k1", "k2", "k3", "k4"]) answerKey(sandbox, "session.menu", key, menuView());
  assert.deepEqual(Object.keys(h.host.getState().keyed["session.menu"]).sort(), ["k1", "k2", "k3", "k4"]);

  h.host.retainKey("session.menu", "k5", { session: sessionInfo("k5") });
  answerKey(sandbox, "session.menu", "k5", menuView());
  assert.deepEqual(Object.keys(h.host.getState().keyed["session.menu"]).sort(), ["k2", "k3", "k4", "k5"], "the oldest made room");

  // k1 comes back (evicting k2); the stale handle must not take the new k1 away.
  h.host.retainKey("session.menu", "k1", { session: sessionInfo("k1") });
  await h.advance(250);
  answerKey(sandbox, "session.menu", "k1", menuView());
  handles.k1();
  assert.deepEqual(Object.keys(h.host.getState().keyed["session.menu"]).sort(), ["k1", "k3", "k4", "k5"]);
  handles.k2();
  assert.ok(h.host.getState().keyed["session.menu"].k3, "releasing an evicted handle changes nothing else");
});
