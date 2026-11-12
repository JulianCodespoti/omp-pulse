#!/usr/bin/env node
// The worst-phone standard, measured.
//
// "Smooth" is not a spec; a frame budget is. Two profiles:
//
//   good   (default)  headed window at the panel's rate (8.3ms here), no
//                     throttle — the 120Hz claim on a good phone.
//   worst  (--worst)  headless 60Hz, 6x CPU, software compositing — a cheap
//                     phone: Chrome's "low-end mobile" CPU factor, and raster
//                     done on the CPU because no real GPU is that slow.
//
// Per interaction it reports and gates on four numbers:
//
//   p95      frame delta at the 95th percentile. The gate is one display
//            budget (16.7ms on the worst phone, 8.3ms good).
//   over%    share of frames over 1.5x budget, i.e. frames the reader sees as
//            a stutter. Gate: at most 1%.
//   long     main-thread tasks over 50ms during the interaction. Gate: zero —
//            a React commit or a synchronous parse inside a gesture is what
//            turns a composited animation into a stutter.
//   layout   LayoutCount delta, diagnostic only: a transform-only animation
//            should show 0, and the standard's rule is exactly that, but a
//            first mount legitimately counts one or two and this window
//            includes it.
//
// A checked-in baseline (perf/motion-baseline.json, one entry per profile)
// turns the numbers into a ratchet: p95 may not grow more than 20% + 2ms and
// over% not more than 2 points against it. --update-baseline rewrites it.
//
//   node scripts/measure-motion.mjs                      # good phone
//   node scripts/measure-motion.mjs --worst --gate        # the standard
//   node scripts/measure-motion.mjs --worst --update-baseline
//
// Needs a running app: OMP_PULSE_BASE + OMP_PULSE_TOKEN, or run under
// e2e/with-test-daemon.sh (which sets the TEST variants). It opens screens,
// drags the drawer, opens one sheet and leaves: no prompt is sent.
//
// Exit code = number of failed interactions (breach or immeasurable).
import { readFileSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPuppeteer, chromium, startWebApp } from "../e2e/lib/env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(HERE, "../bench/motion-baseline.json");

const BASE = process.env.OMP_PULSE_BASE ?? process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TOKEN ?? process.env.OMP_PULSE_TEST_TOKEN;
if (!BASE || !TOKEN) {
  console.error("set OMP_PULSE_BASE and OMP_PULSE_TOKEN (or run under e2e/with-test-daemon.sh)");
  console.error("  OMP_PULSE_BASE=https://host OMP_PULSE_TOKEN=... node scripts/measure-motion.mjs --worst --gate");
  process.exit(2);
}

const WORST = process.argv.includes("--worst");
const GATE = process.argv.includes("--gate");
const SAVE = process.argv.includes("--update-baseline");
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const PROFILE_JS = process.argv.includes("--profile");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? null;
const RUNS = (() => {
  const arg = process.argv.find((a) => a.startsWith("--runs="));
  // Mount interactions vary by 20-40% between 3-run batches on this machine
  // (sheet open: 116.6 then 133.4 with no related change), so the gate takes
  // five. Passing interactions are stable well inside the budget either way.
  const n = arg ? Number(arg.slice(7)) : GATE ? 5 : 1;
  return Number.isFinite(n) ? Math.max(1, Math.min(7, Math.round(n))) : 1;
})();
const HEADED = !WORST;
const PROFILE = WORST ? "worst" : "good";
// One budget: the worst phone is a 60Hz panel, and the good profile must also
// run at 120Hz. A frame is late when it doubles.
const BUDGET = WORST ? 1000 / 60 : 1000 / 120;
// rAF deltas quantise to the refresh: a perfect 60Hz run reports 16.7-16.8ms.
// A 6% allowance keeps "one frame" from failing on timer noise, and anything
// slower is a missed frame, not a rounding error.
const P95_LIMIT = BUDGET * 1.06;
// Two standards, because they are two different things. Continuous motion (a
// drag, a settle, a pop) must hold every frame: one budget, 1% over. A mount
// (a sheet's body, a page, a transcript) is a discrete action that builds its
// nodes; on a 6x CPU bound it is allowed two frames and 5% over, and is judged
// mainly by its longest task and by not being an outline of a screen. Chat open
// is the one interaction over even that, which is the next work item.
const LIMITS = {
  motion: { p95: P95_LIMIT, over: 1 },
  mount: { p95: BUDGET * 2, over: 5 },
};
const SLOW_FRAME = BUDGET * 1.5;
// Chrome's 50ms "long task" threshold is a native-speed heuristic. Under the
// worst profile's 6x CPU handicap a perfectly ordinary 10ms commit becomes
// 60ms, so the threshold scales with the throttle: a task fails when it would
// have been a long task on the reference device.
const CPU_FACTOR = WORST ? 6 : 1;
const LONG_TASK_MS = 50 * CPU_FACTOR;

// One conversation with real weight: 120 turns, mixed long tool output and
// code. The same file every run, so the drawer drag and the sheet open are
// measured against the same DOM.
const FIXTURE_TITLE = "Motion fixture";
if (SESSIONS) {
  const dir = `${SESSIONS}/-tmp-motion-fixture`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000e1.jsonl`;
  const entries = [
    { type: "title", title: FIXTURE_TITLE },
    { type: "session", id: "019ff400-0000-7000-0000-0000000000e1", cwd: "/tmp/motion-fixture", title: FIXTURE_TITLE },
  ];
  for (let i = 1; i <= 120; i++) {
    const t = String(i).padStart(2, "0");
    entries.push({
      id: `e-u-${t}`, type: "message", timestamp: new Date(Date.now() - (200 - i) * 1000).toISOString(),
      message: { id: `m-u-${t}`, role: "user", content: [{ type: "text", text: `MOTION TURN ${t}` }] },
    });
    const body = i % 6 === 0
      ? `\`\`\`ts\n${Array.from({ length: 24 }, (_, k) => `const value${k} = compute(${k});`).join("\n")}\n\`\`\``
      : "Filler text that wraps at 390px and gives this assistant turn real height on a phone. ".repeat(i % 4 === 0 ? 8 : 2);
    entries.push({
      id: `e-a-${t}`, type: "message", timestamp: new Date(Date.now() - (200 - i) * 1000 + 500).toISOString(),
      message: { id: `m-a-${t}`, role: "assistant", content: [{ type: "text", text: body }] },
    });
  }
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const when = new Date(Date.now() - 60_000);
  utimesSync(file, when, when);
}

// A gate on the live daemon measures whichever conversation the launch rule
// opened: two identical runs gave p95 66.6 and 99.9ms on the same build. The
// standard therefore only gates a controlled fixture.
if (GATE && !SESSIONS) {
  console.error("--gate needs a controlled corpus: run it under e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node scripts/measure-motion.mjs --worst --gate");
  process.exit(2);
}

// --dev serves the app through vite instead of the embedded bundle: the same
// code, unminified, so --profile names real functions instead of `fl` and `ac`.
const devApp = process.argv.includes("--dev") ? await startWebApp({ base: BASE, port: 5401 }) : null;
const APP_URL = devApp ? devApp.url : `${BASE}/app/`;

const puppeteer = await loadPuppeteer();
const browser = await puppeteer.launch({
  headless: !HEADED,
  executablePath: chromium(),
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // Parked off-screen: it must neither steal focus nor flash at the owner.
    "--window-position=6000,6000",
    "--window-size=390,844",
    // No real phone rasterises this slowly: it is the bound, not a model.
    ...(WORST ? ["--disable-gpu", "--disable-gpu-compositing"] : []),
  ],
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
if (WORST) await page.emulateCPUThrottling(6);
// Diagnostic: the same interactions with motion switched off. It attributes a
// miss to the animation or to the work the screen must do anyway.
if (process.argv.includes("--reduced")) {
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
}
const cdp = await page.createCDPSession();
await cdp.send("Performance.enable");
if (PROFILE_JS) await cdp.send("Profiler.enable");
/** Top functions by self time while one interaction ran. */
async function profile(run) {
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await run();
  const { profile } = await cdp.send("Profiler.stop");
  const byFunction = new Map();
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const total = profile.samples.length || 1;
  for (const id of profile.samples) {
    const node = nodes.get(id);
    if (!node) continue;
    const frame = node.callFrame;
    const name = frame.functionName || "(anonymous)";
    const url = (frame.url || "").replace(/^https?:\/\/[^/]+/, "").split("/").pop() || "";
    const key = `${name} @ ${url}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + 1);
  }
  return [...byFunction.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, samples]) => `${key} ${Math.round((samples / total) * 100)}%`);
}

const debugMetrics = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const at = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    layout: at("LayoutCount"),
    style: at("RecalcStyleCount"),
    task: at("TaskDuration"),
    script: at("ScriptDuration"),
    layoutTime: at("LayoutDuration"),
    styleTime: at("RecalcStyleDuration"),
  };
};

const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

await page.evaluateOnNewDocument((token) => localStorage.setItem("omp-remote-token", token), TOKEN);
await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(
  () => !!document.querySelector("[data-testid='new-session-menu'], [data-testid='session-back']"),
  { timeout: 60000 },
);

// Open the seeded conversation: the drawer's list and the chat are then the
// same content on every run. On a live daemon (no SESSIONS) the launch rule's
// chat is used as-is and the numbers are a spot check, not a gate.
async function openFixture() {
  if (!SESSIONS) return;
  await page.evaluate(() => (document.querySelector("[data-testid='new-session-menu']") ?? document.querySelector("[data-testid='session-back']"))?.click());
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 20000 });
  await page.evaluate((title) => {
    const row = [...document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']")].find((r) => (r.textContent || "").includes(title));
    if (row) row.click();
  }, FIXTURE_TITLE);
  await page.waitForFunction(
    (title) => (document.querySelector("[data-testid='chat-heading']")?.textContent ?? "").includes(title),
    { timeout: 20000 },
    FIXTURE_TITLE,
  );
  await new Promise((r) => setTimeout(r, 800));
}
await openFixture();

const rows = [];
const failures = [];

/** Samples rAF deltas and long tasks around one interaction. */
async function measure(name, run, kind = "motion") {
  if (ONLY && !name.includes(ONLY)) return;
  const before = await debugMetrics();
  await page.evaluate(() => {
    window.__frames = [];
    window.__long = [];
    window.__sampling = true;
    const tick = (t) => {
      if (!window.__sampling) return;
      window.__frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__long.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  });
  const error = [];
  let hot = null;
  try {
    if (PROFILE_JS) hot = await profile(run);
    else await run();
  } catch (e) {
    error.push(String(e).slice(0, 120));
  }
  // The settle after a release is part of the interaction.
  await new Promise((r) => setTimeout(r, 700));
  const sample = await page.evaluate(() => {
    window.__sampling = false;
    const deltas = window.__frames.slice(1).map((t, i) => t - window.__frames[i]);
    return { deltas, long: window.__long.slice() };
  });
  const after = await debugMetrics();
  const deltas = sample.deltas.filter((d) => d > 0).sort((a, b) => a - b);
  const p = (q) => (deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))] : 0);
  const slow = deltas.filter((d) => d > SLOW_FRAME).length;
  const row = {
    interaction: name,
    kind,
    frames: deltas.length,
    p50: +p(0.5).toFixed(1),
    p95: +p(0.95).toFixed(1),
    over: deltas.length ? Math.round((slow / deltas.length) * 100) : 0,
    long: sample.long.filter((d) => d >= LONG_TASK_MS).length,
    longest: sample.long.length ? Math.round(Math.max(...sample.long)) : 0,
    layout: after.layout - before.layout,
    style: after.style - before.style,
    taskMs: Math.round((after.task - before.task) * 1000),
    scriptMs: Math.round((after.script - before.script) * 1000),
    layoutMs: Math.round((after.layoutTime - before.layoutTime) * 1000),
    styleMs: Math.round((after.styleTime - before.styleTime) * 1000),
    error: error[0] ?? null,
    hot,
  };
  rows.push(row);
  if (hot) for (const line of hot) console.log(`   ${name}: ${line}`);
  if (error.length) failures.push(`${name}: ${error[0]}`);
}

const drawerOpen = () => page.$("[data-testid='session-switcher'] [data-open]");
const closeDrawer = async () => {
  if (await drawerOpen()) {
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
  }
};
const touch = (type, x, y) =>
  cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }],
  });

async function sequence() {
  await closeDrawer();
  // 1. The drawer: a drag from the middle of the screen, released past half.
  await measure("drawer swipe open + settle", async () => {
    const start = { x: 360, y: 520 };
    await touch("touchStart", start.x, start.y);
    for (let step = 1; step <= 10; step++) {
      await touch("touchMove", start.x - (180 * step) / 10, start.y);
      await new Promise((r) => setTimeout(r, 16));
    }
    await touch("touchEnd", 0, 0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  });

  // 2. A bottom sheet: Session settings from the chat header's ⋮ menu.
  await measure("sheet open (session settings)", async () => {
    await closeDrawer();
    if (!(await page.$("[data-testid='session-actions']"))) throw new Error("no chat open");
    await page.evaluate(() => document.querySelector("[data-testid='session-actions']").click());
    await page.waitForSelector("[data-testid='session-actions-sheet']", { timeout: 5000 });
    await page.evaluate(() => document.querySelector("[data-testid='session-settings']").click());
    await page.waitForSelector("[data-testid='session-settings-sheet']", { timeout: 5000 });
  }, "mount");

  // 3. Its exit is part of the same feel.
  await measure("sheet close", async () => {
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
  }, "mount");

  // 4. Opening a chat is the most common mount in the app: back to the list,
  //    then into the same 120-turn fixture.
  await measure("chat open (120 turns)", async () => {
    await closeDrawer();
    await page.evaluate(() => document.querySelector("[data-testid='session-actions']")?.click());
    await page.waitForSelector("[data-testid='session-actions-sheet']", { timeout: 5000 });
    await page.evaluate(() => document.querySelector("[data-testid='session-back-row']")?.click());
    await page.waitForSelector("[data-testid='session-row']", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate((title) => {
      const row = [...document.querySelectorAll("[data-testid='session-row']")].find((r) => (r.textContent || "").includes(title));
      if (row) row.click();
    }, FIXTURE_TITLE);
    await page.waitForSelector("[data-testid='chat-message']", { timeout: 15000 });
  }, "mount");

  // 5. The composer expands by a spring; the field is the only layout there.
  await measure("composer expand", async () => {
    await page.evaluate(() => document.querySelector("[data-testid='composer-expand']")?.click());
    await new Promise((r) => setTimeout(r, 200));
  }, "mount");

  // 6. A pushed page (a view transition), and back.
  await measure("settings push", async () => {
    if (!(await drawerOpen())) {
      await page.evaluate(() => document.querySelector("[data-testid='session-back'], [data-testid='new-session-menu']")?.click());
      await new Promise((r) => setTimeout(r, 500));
    }
    await page.evaluate(() => document.querySelector("[data-testid='switcher-settings']")?.click());
    await page.waitForSelector("[data-testid='settings-layer']", { timeout: 5000 });
  }, "mount");
  await measure("settings pop", async () => {
    await page.evaluate(() => document.querySelector("[data-testid='settings-layer'] [aria-label='Back']")?.click());
    await new Promise((r) => setTimeout(r, 300));
  });

}

const runs = [];
for (let run = 0; run < RUNS; run++) {
  const before = rows.length;
  await sequence();
  runs.push(rows.slice(before));
}

// The median of the runs is the measurement; a single run on a shared
// machine is noise (two identical live runs gave p95 66.6 and 99.9ms).
const middle = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = runs[0].map((first, index) => ({
  interaction: first.interaction,
  kind: first.kind,
  frames: Math.round(middle(runs.map((r) => r[index].frames))),
  p50: middle(runs.map((r) => r[index].p50)),
  p95: middle(runs.map((r) => r[index].p95)),
  over: middle(runs.map((r) => r[index].over)),
  long: middle(runs.map((r) => r[index].long)),
  longest: Math.max(...runs.map((r) => r[index].longest)),
  layout: middle(runs.map((r) => r[index].layout)),
  style: middle(runs.map((r) => r[index].style)),
  taskMs: middle(runs.map((r) => r[index].taskMs)),
  scriptMs: middle(runs.map((r) => r[index].scriptMs)),
  layoutMs: middle(runs.map((r) => r[index].layoutMs)),
  styleMs: middle(runs.map((r) => r[index].styleMs)),
  error: first.error,
}));

// --- gate -------------------------------------------------------------------
let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"))[PROFILE] ?? null;
} catch {
  baseline = null;
}
for (const row of results) {
  if (row.error) continue; // already a failure
  const limit = LIMITS[row.kind] ?? LIMITS.motion;
  if (row.p95 > limit.p95) failures.push(`${row.interaction}: p95 ${row.p95}ms over the ${limit.p95.toFixed(1)}ms ${row.kind} budget`);
  if (row.over > limit.over) failures.push(`${row.interaction}: ${row.over}% of frames over budget (max ${limit.over}% for ${row.kind})`);
  if (row.long > 0) failures.push(`${row.interaction}: ${row.long} long task(s), longest ${row.longest}ms`);
  const was = baseline?.find((b) => b.interaction === row.interaction);
  if (was) {
    if (row.p95 > was.p95 * 1.2 + 2) failures.push(`${row.interaction}: p95 regressed ${was.p95} -> ${row.p95}ms`);
    if (row.over > was.over + 2) failures.push(`${row.interaction}: over% regressed ${was.over} -> ${row.over}`);
  }
}

const width = { interaction: 30, kind: 7, frames: 5, p50: 5, p95: 6, "over%": 5, long: 4, longest: 7, layout: 5, task: 8, script: 7, stylems: 7 };
console.log(
  `\n${PROFILE} profile${WORST ? " (60Hz, 6x CPU, software raster)" : " (120Hz headed)"}  ${BASE}\n`,
);
console.log(Object.keys(width).map((k) => k.padEnd(width[k])).join(" "));
for (const row of results) {
  const cells = {
    interaction: row.interaction,
    kind: row.kind,
    frames: row.frames,
    p50: row.p50,
    p95: row.p95,
    "over%": row.over,
    long: row.long,
    longest: `${row.longest}ms`,
    layout: row.layout,
    task: `${row.taskMs}ms`,
    script: `${row.scriptMs}ms`,
    stylems: `${row.styleMs}ms`,
  };
  console.log(Object.entries(width).map(([k, w]) => String(cells[k]).padEnd(w)).join(" ") + (row.error ? `  ${row.error}` : ""));
}
console.log(
  `\nbudget ${BUDGET.toFixed(1)}ms/frame; over% counts frames > ${SLOW_FRAME.toFixed(1)}ms; ` +
    `long = tasks >= ${LONG_TASK_MS}ms (${50}ms x ${CPU_FACTOR} CPU)`,
);

if (SAVE) {
  const all = (() => {
    try {
      return JSON.parse(readFileSync(BASELINE, "utf8"));
    } catch {
      return {};
    }
  })();
  all[PROFILE] = results.map(({ interaction, kind, p95, over, long }) => ({ interaction, kind, p95, over, long }));
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`baseline written for "${PROFILE}": ${BASELINE}`);
}
if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
if (failures.length) {
  console.log(`\nFAIL ${failures.length}:`);
  for (const failure of failures) console.log(`  ${failure}`);
} else if (GATE) {
  console.log("\nPASS");
}
await browser.close();
devApp?.stop();
process.exit(failures.length);
