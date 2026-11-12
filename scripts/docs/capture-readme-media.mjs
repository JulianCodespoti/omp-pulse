#!/usr/bin/env node
// Reproduce the README and website media in docs/media/ from synthetic data:
//
//   screenshot-chat.png         finished turn: floating chrome, work rail, inline diff, markdown reply, composer
//   screenshot-drawer.png       left session drawer: computer status, projects, Needs you, pinned & recent
//   screenshot-workspace.png    right workspace drawer: Changes tab with expanded git diff & bottom dock
//   screenshot-ask.png          desktop ask answer sheet opened over a conversation
//   screenshot-phone-mode.png   Android first-run screen ("Run on this phone" / "Connect a computer")
//   screenshot-phone-tools.png  Android Settings › Phone access: Phone tools for the agent & permissions
//   demo.gif                    open a working session from the drawer and watch the live turn stream, edit, test and finish
//   node scripts/docs/capture-readme-media.mjs                     # all seven
//   node scripts/docs/capture-readme-media.mjs --only chat,gif     # subset by shot key
//   node scripts/docs/capture-readme-media.mjs --out /tmp/media    # write somewhere else
//
// Run bare, it re-executes itself under e2e/with-test-daemon.sh: the only
// daemon it talks to is a throwaway one, and every session, project path,
// prompt and reply below is invented. Nothing reads your real sessions.
//
// Needs what the browser suites need (a release build with the web client
// embedded, `npm ci` in web/, a Chromium; see e2e/README.md), plus ffmpeg for
// the GIF and pngquant or ImageMagick (`magick`) to compress PNGs cleanly.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, loadPuppeteer } from "../../e2e/lib/env.mjs";
import { recipeApi } from "../ui/states/api.mjs";
import { makeEnv, runningState } from "../ui/states/env.mjs";
import { CLOCK } from "../ui/states/fixtures.mjs";
import { FREEZE_CSS, pageShim } from "../ui/states/page-shim.mjs";
import { scrollQuiet } from "../ui/states/stabilize.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Matches the owner's phone geometry and appearance setup (accent: violet,
// background: black, tinted user bubbles, system font scale 0.9).
const VIEWPORT = { width: 412, height: 892, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
const PHONE_APPEARANCE = JSON.stringify({ accent: "violet", background: "black", userBubble: "tinted", turnFooter: "full" });
const GIF_WIDTH = 380;
const GIF_FPS = 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Synthetic corpus ────────────────────────────────────────────────────────
// Ages are minutes before CLOCK, the instant the page clock is pinned to.

const MODEL = { provider: "anthropic", model: "claude-opus-4-1" };
const MAIN = "Add cursor pagination to GET /todos";

const at = (minutesAgo) => new Date(CLOCK - minutesAgo * 60_000).toISOString();
const user = (ago, text) => ({ type: "message", timestamp: at(ago), message: { role: "user", content: [{ type: "text", text }] } });
const reply = (ago, content, output = 400) => ({
  type: "message",
  timestamp: at(ago),
  message: {
    role: "assistant",
    content,
    ...MODEL,
    stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
    usage: { input: 14_200, output, cost: { total: output * 0.000_04 } },
  },
});
const result = (ago, callId, toolName, text, details) => ({
  type: "message",
  timestamp: at(ago),
  message: { role: "toolResult", toolCallId: callId, toolName, isError: false, content: [{ type: "text", text }], ...(details ? { details } : {}) },
});

const ROUTE_BEFORE = `import { Router } from "express";
import { db } from "../db";

export const todos = Router();

todos.get("/", async (_req, res) => {
  const rows = await db.todo.findMany();
  res.json(rows);
});
`;

const ROUTE_DIFF = `--- a/src/routes/todos.ts
+++ b/src/routes/todos.ts
@@ -6,4 +6,15 @@
-todos.get("/", async (_req, res) => {
-  const rows = await db.todo.findMany();
-  res.json(rows);
+todos.get("/", async (req, res) => {
+  if (req.query.all === "true") {
+    return res.json(await db.todo.findMany());
+  }
+  const limit = pageSize(req.query.limit);
+  const after = decode(req.query.cursor);
+  const rows = await db.todo.findMany({
+    where: { id: { gt: after } },
+    orderBy: { id: "asc" },
+    take: limit + 1,
+  });
+  res.json(page(rows, limit));
 });`;

const CURSOR_HELPER_DIFF = `@@ -0,0 +1,8 @@
+export const pageSize = (raw?: unknown) =>
+  Math.min(100, Math.max(1, Number(raw ?? 20) || 20));
+
+export const page = <T extends { id: number }>(rows: T[], limit: number) => ({
+  items: rows.slice(0, limit),
+  nextCursor: rows.length > limit ? btoa(String(rows[limit - 1].id)) : null,
+});
`;

const TEST_OUTPUT = [
  "> todo-api@1.4.0 test",
  "> vitest run todos",
  "",
  " ✓ test/todos.spec.ts (9 tests) 212ms",
  "   ✓ returns the first 20 todos",
  "   ✓ follows nextCursor to the second page",
  "   ✓ caps limit at 100",
  "   ✓ rejects a malformed cursor with 400",
  "   ✓ ?all=true returns every row",
  "",
  " Test Files  1 passed (1)",
  "      Tests  9 passed (9)",
];

const FINAL_REPLY =
  "Done. `GET /todos` now returns cursor-paginated pages:\n\n" +
  "- **`limit`** defaults to `20` and caps at `100`\n" +
  "- **`cursor`** is opaque (`id` in base64) so inserts don't shift pages\n" +
  "- **`?all=true`** preserves the unpaged admin export\n\n" +
  "All 9 Vitest cases pass. Want me to add an RFC 8288 `Link` header too?";

const CALLS = {
  read: { type: "toolCall", id: "call_read", name: "read", intent: "Reading the todos route", arguments: { path: "src/routes/todos.ts" } },
  edit: { type: "toolCall", id: "call_edit", name: "edit", intent: "Adding cursor pagination", arguments: { path: "src/routes/todos.ts" } },
  bash: { type: "toolCall", id: "call_bash", name: "bash", intent: "Running the todos tests", arguments: { command: "npm test -- todos" } },
};
const STEP_TEXT = "The handler loads the whole table. Paging by id keeps the cursor stable while rows are being inserted.";
const EDIT_DETAILS = { path: "src/routes/todos.ts", diff: ROUTE_DIFF };

// The main conversation in two halves: the GIF opens it after the first tool
// call and plays the rest live; the chat screenshot shows it finished.
const MAIN_START = [
  user(6, "GET /todos returns every row at once. Add cursor pagination (20 per page) and keep ?all=true."),
  reply(5.8, [{ type: "thinking", thinking: "Inspecting src/routes/todos.ts first so cursor decoding matches the primary key type." }, CALLS.read], 60),
  result(5.7, "call_read", "read", ROUTE_BEFORE),
];
const MAIN_REST = [
  reply(5, [{ type: "thinking", thinking: "Paging on monotonic id > cursor avoids offset drift under concurrent writes." }, CALLS.edit], 520),
  result(4.9, "call_edit", "edit", ROUTE_DIFF, EDIT_DETAILS),
  reply(4.5, [CALLS.bash], 40),
  result(4, "call_bash", "bash", TEST_OUTPUT.join("\n")),
  reply(3, [{ type: "text", text: FINAL_REPLY }], 610),
];

/** [title, project, age (min), conversation] */
const SESSIONS = [
  [MAIN, "todo-api", 3, MAIN_START],
  ["Write a post on running SQLite in production", "blog", 26, [
    user(40, "Draft a post about why we moved the blog's comments to SQLite. Keep it under 1,000 words."),
    reply(26, [{ type: "text", text: "Draft is in `posts/sqlite-in-production.md`, about 900 words." }], 2_400),
  ]],
  ["Migrate the blog to Astro 5", "blog", 58, [
    user(70, "Upgrade Astro to 5 and fix whatever breaks."),
    reply(58, [{ type: "text", text: "Content collections moved to the new loader API; three pages still use the old glob." }], 900),
  ]],
  ["Fix flaky timezone test in CI", "todo-api", 190, [
    user(200, "test/due-dates.spec.ts fails on CI about once a day. Why?"),
    reply(190, [{ type: "text", text: "It builds dates with the runner's local timezone. Pinned `TZ=UTC` in the test setup and used `Date.UTC` in the fixture." }], 700),
  ]],
  ["Why is the Docker image 1.2 GB?", "weather-cli", 1_500, [
    user(1_510, "Why is the Docker image 1.2 GB?"),
    reply(1_500, [{ type: "text", text: "The build stage's dev dependencies and the full Debian base end up in the final image. A multi-stage build on distroless gets it to 96 MB." }], 800),
  ]],
  ["Add a units flag to forecast", "weather-cli", 2_900, [
    user(2_910, "Add --units metric|imperial, defaulting to metric."),
    reply(2_900, [{ type: "text", text: "Added `--units` with clap's `ValueEnum`; the forecast table converts at render time." }], 650),
  ]],
  ["Set up zsh with starship", "dotfiles", 5_800, [
    user(5_810, "Move my prompt from oh-my-zsh to starship and keep the git status segment."),
    reply(5_800, [{ type: "text", text: "Installed starship, ported the git segment, and dropped oh-my-zsh. Shell start-up went from 410 ms to 60 ms." }], 500),
  ]],
  ["Explain the token bucket", "rate-limiter", 8_700, [
    user(8_710, "Explain how the token bucket in src/bucket.rs refills."),
    reply(8_700, [{ type: "text", text: "Lazily: each `take()` adds `elapsed × rate` tokens, capped at `burst`, before spending one." }], 450),
  ]],
];

function seed(sessionsRoot, codeRoot) {
  const files = {};
  for (const [i, [title, project, age, entries]] of SESSIONS.entries()) {
    const cwd = join(codeRoot, project);
    mkdirSync(cwd, { recursive: true });
    const slug = `-code-${project}`;
    mkdirSync(join(sessionsRoot, slug), { recursive: true });
    const id = `01a2b3c4-0000-7000-8000-${String(i + 1).padStart(12, "0")}`;
    const file = join(sessionsRoot, slug, `2026-09-20T08-00-00-000Z_${id}.jsonl`);
    writeFileSync(file, chain([{ type: "session", id, cwd, title, timestamp: at(age + 15) }, ...entries], `s${i}`));
    const when = new Date(CLOCK - age * 60_000);
    utimesSync(file, when, when);
    files[title] = file;
  }
  return files;
}

// id/parentId chain: /api/tree and the timeline read the branch from them.
function chain(entries, prefix, prev = null) {
  return entries.map((e, i) => {
    const id = `${prefix}-e${i}`;
    const line = JSON.stringify(prev ? { ...e, id, parentId: prev } : { ...e, id });
    prev = id;
    return line + "\n";
  }).join("");
}

async function listing(base, token, expect) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    const rows = r.ok ? ((await r.json()).sessions ?? []) : [];
    if (expect(rows)) return rows;
    await sleep(150);
  }
  throw new Error("the daemon never listed the seeded sessions");
}

// ── Page harness ────────────────────────────────────────────────────────────

/** Android shell bridges: OmpNative reports the 0.9 system font scale; OmpLocal drives phone-mode onboarding. */
function nativeScaleBridge() {
  window.OmpNative = { senderRequired: () => false, ...(window.OmpNative ?? {}), fontScale: () => 0.9 };
}
function phoneBridge(custom = null) {
  const state = custom?.state ?? { supported: true, mode: "unset", phase: "idle", installed: false, progress: -1, appUrl: null, laptopUrl: null, downloadBytes: 251_000_000, ompVersion: "18.10.4", phoneTools: false };
  const access = custom?.access ?? {};
  const json = (v) => () => JSON.stringify(v);
  window.OmpLocal = {
    state: json(state), access: json(access), providers: json([]), loginState: json({ running: false, exitCode: null, output: "" }),
    computerStatus: json({}),
    connectLaptop: json({ ok: true }), useComputer: json({ ok: true }), forgetComputer() {}, setMode() {}, prepare() {}, setPhoneTools() {}, grant() {}, openAppSettings() {},
    loginStart() {}, loginInput() {}, loginCancel() {},
  };
}

async function openPage(browser, env, { hash = "", stubs = [], storage = {}, unpaired = false, bridge = false, bridgeConfig = null, motion = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(VIEWPORT);
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: "dark" },
    { name: "prefers-reduced-motion", value: motion ? "no-preference" : "reduce" },
  ]);
  await page.emulateTimezone("UTC");
  const net = { inflight: new Map() };
  page.on("request", (req) => net.inflight.set(req, req.url()));
  page.on("requestfinished", (req) => net.inflight.delete(req));
  page.on("requestfailed", (req) => net.inflight.delete(req));
  const cdp = await page.createCDPSession();
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const cfg = {
    token: unpaired ? null : env.token,
    storage: { "omp-appearance": PHONE_APPEARANCE, ...storage },
    css: motion ? "" : FREEZE_CSS,
    clock: CLOCK,
    notificationPermission: "granted",
    native: null,
    stubs: [...stubs, ...env.defaultStubs],
    ws: {},
  };
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${pageShim})(${JSON.stringify(cfg)});` });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${nativeScaleBridge})();` });
  if (bridge || bridgeConfig) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${phoneBridge})(${JSON.stringify(bridgeConfig)});` });
  await page.goto(env.appUrl + hash, { waitUntil: "domcontentloaded" });
  if ((await page.evaluate(() => document.documentElement.getAttribute("data-capture-shim"))) !== "ok") {
    throw new Error("page shim did not install; refusing to drive an unstubbed app");
  }
  const ui = recipeApi(page, env, net);
  ui.close = () => context.close().catch(() => {});
  return ui;
}

async function still(ui, out) {
  await ui.quiet();
  await scrollQuiet(ui.page);
  await ui.page.evaluate(() => {
    for (const el of document.querySelectorAll("textarea, input, [contenteditable]")) el.spellcheck = false;
  });
  const raw = `${out}.raw.png`;
  await ui.page.screenshot({ path: raw, type: "png" });
  optimisePng(raw, out);
}

function optimisePng(raw, out) {
  try {
    execFileSync("pngquant", ["--quality", "75-96", "--speed", "1", "--strip", "--force", "--output", out, raw], { stdio: "inherit" });
    rmSync(raw);
    return;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    execFileSync("magick", [raw, "-strip", "-define", "png:compression-level=9", "-define", "png:compression-filter=5", out], { stdio: "inherit" });
    rmSync(raw);
    return;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  console.warn("neither pngquant nor magick found: writing an unoptimised PNG");
  renameSync(raw, out);
}

// ── Live turn frames (web/src/domain/protocol.ts) ───────────────────────────

const ev = (event) => ({ type: "event", event });
const assistant = (responseId, content) => ({ role: "assistant", responseId, content, ...MODEL });

/** Prefixes of `text` ending on word boundaries, about `chunk` characters apart. */
function prefixes(text, chunk) {
  const out = [];
  for (let i = chunk; i < text.length; i += chunk) {
    const cut = text.indexOf(" ", i);
    if (cut < 0) break;
    out.push(text.slice(0, cut));
    i = cut;
  }
  out.push(text);
  return out;
}

async function streamText(ui, responseId, before, text, { chunk = 24, every = 70 } = {}) {
  for (const part of prefixes(text, chunk)) {
    await ui.frames("chat", [ev({ type: "message_update", message: assistant(responseId, [...before, { type: "text", text: part }]) })]);
    await sleep(every);
  }
}

async function playTurn(ui, row) {
  const base = row.sessionState;
  let revision = base.revision + 100;
  const activity = (now, kind, label) => ui.frames("chat", [{
    type: "activity", path: row.path, now,
    sessionState: now ? { ...runningState(base, CLOCK, { kind, label }), revision: ++revision } : { ...base, revision: ++revision },
  }]);
  const turnStartedAt = CLOCK - 6 * 60_000;

  // Step 1: a sentence, then the edit.
  await ui.frames("chat", [ev({ type: "message_start", message: assistant("r1", []) })]);
  await activity({ state: "writing", since: CLOCK, turnStartedAt, tools: 1 }, "writing");
  await streamText(ui, "r1", [], STEP_TEXT);
  const step1 = [{ type: "text", text: STEP_TEXT }, CALLS.edit];
  await ui.frames("chat", [ev({ type: "message_end", message: assistant("r1", step1) })]);
  await ui.frames("chat", [ev({ type: "tool_execution_start", toolCallId: "call_edit", toolName: "edit", intent: CALLS.edit.intent, args: CALLS.edit.arguments })]);
  await sleep(700);
  await ui.frames("chat", [ev({ type: "tool_execution_end", toolCallId: "call_edit", toolName: "edit", isError: false, result: { content: [{ type: "text", text: ROUTE_DIFF }], details: EDIT_DETAILS } })]);
  await sleep(400);

  // Step 2: the tests, output arriving line by line.
  await ui.frames("chat", [
    ev({ type: "message_start", message: assistant("r2", []) }),
    ev({ type: "message_end", message: assistant("r2", [CALLS.bash]) }),
    ev({ type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash", intent: CALLS.bash.intent, args: CALLS.bash.arguments }),
  ]);
  await activity({ state: "tool", tool: "bash", label: "npm test -- todos", since: CLOCK, turnStartedAt, tools: 2 }, "tool", "npm test -- todos");
  for (let n = 2; n <= TEST_OUTPUT.length; n += 2) {
    await ui.frames("chat", [ev({ type: "tool_execution_update", toolCallId: "call_bash", toolName: "bash", partialResult: { content: [{ type: "text", text: TEST_OUTPUT.slice(0, n).join("\n") }] } })]);
    await sleep(220);
  }
  await ui.frames("chat", [ev({ type: "tool_execution_end", toolCallId: "call_bash", toolName: "bash", isError: false, result: { content: [{ type: "text", text: TEST_OUTPUT.join("\n") }] } })]);
  await sleep(300);

  // Step 3: the answer.
  await ui.frames("chat", [ev({ type: "message_start", message: assistant("r3", []) })]);
  await activity({ state: "writing", since: CLOCK, turnStartedAt, tools: 3 }, "writing");
  await streamText(ui, "r3", [], FINAL_REPLY, { chunk: 28, every: 60 });
  await ui.frames("chat", [
    ev({ type: "message_end", message: assistant("r3", [{ type: "text", text: FINAL_REPLY }]) }),
    ev({ type: "agent_end" }),
  ]);
  await activity(null);
}

/** A fading dot where the finger lands, so a viewer can follow the tap. */
async function tap(ui, selector) {
  const handle = await ui.el(selector);
  const box = await handle.boundingBox();
  const x = box.x + Math.min(box.width / 2, 140);
  const y = box.y + box.height / 2;
  await ui.page.evaluate((x, y) => {
    const dot = document.createElement("div");
    dot.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.35);z-index:2147483647;pointer-events:none;transition:opacity .5s ease-out .25s,transform .5s ease-out .25s`;
    document.body.appendChild(dot);
    requestAnimationFrame(() => requestAnimationFrame(() => { dot.style.opacity = "0"; dot.style.transform = "scale(1.6)"; }));
    setTimeout(() => dot.remove(), 900);
  }, x, y);
  await sleep(350);
  await ui.page.touchscreen.tap(x, y);
}

/** Record the page with a CDP screencast while `run` drives it; returns timed frames. */
async function record(page, run, holdMs) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: VIEWPORT.width * 2, maxHeight: VIEWPORT.height * 2, everyNthFrame: 1 });
  const start = Date.now() / 1000;
  try {
    await run();
    await sleep(holdMs);
  } finally {
    await cdp.send("Page.stopScreencast");
    await cdp.detach();
  }
  const end = Date.now() / 1000;
  return { frames, start, end };
}

function encodeGif({ frames, start, end }, out) {
  if (frames.length < 2) throw new Error(`screencast produced ${frames.length} frames`);
  const dir = mkdtempSync(join(tmpdir(), "omp-readme-gif-"));
  try {
    let list = "";
    frames.forEach((f, i) => {
      const name = `f${String(i).padStart(5, "0")}.png`;
      writeFileSync(join(dir, name), Buffer.from(f.data, "base64"));
      const from = i === 0 ? Math.min(start, f.t) : f.t;
      const to = frames[i + 1]?.t ?? end;
      list += `file '${name}'\nduration ${Math.max(0.001, to - from).toFixed(3)}\n`;
    });
    list += `file 'f${String(frames.length - 1).padStart(5, "0")}.png'\n`;
    writeFileSync(join(dir, "list.txt"), list);
    const filter = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-2:flags=lanczos,split[a][b];` +
      "[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vf", filter, "-loop", "0", out], { stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHANGES_PAYLOAD = {
  ok: true,
  cwd: "/code/todo-api",
  repoRoot: "/code/todo-api",
  branch: "feat/cursor-pagination",
  notRepo: false,
  truncated: false,
  totals: { files: 2, additions: 20, deletions: 3 },
  files: [
    {
      path: "src/routes/todos.ts",
      status: "modified",
      additions: 12,
      deletions: 3,
      binary: false,
      patch: ROUTE_DIFF.replace(/^---.*\n\+\+\+.*\n/, ""),
      patchTruncated: false,
    },
    {
      path: "src/lib/pagination.ts",
      status: "added",
      additions: 8,
      deletions: 0,
      binary: false,
      patch: CURSOR_HELPER_DIFF,
      patchTruncated: false,
    },
  ],
};

// ── Shots ───────────────────────────────────────────────────────────────────

const SHOTS = {
  async phone(browser, env, out) {
    const ui = await openPage(browser, env, { unpaired: true, bridge: true });
    try {
      await ui.el("[data-testid='onboarding-phone']");
      await still(ui, join(out, "screenshot-phone-mode.png"));
    } finally {
      await ui.close();
    }
  },

  async phoneTools(browser, env, out) {
    const ui = await openPage(browser, env, {
      bridgeConfig: {
        state: {
          supported: true,
          mode: "phone",
          phase: "ready",
          installed: true,
          progress: -1,
          appUrl: env.appUrl,
          laptopUrl: null,
          downloadBytes: 0,
          ompVersion: "18.10.4",
          phoneTools: true,
        },
        access: { storage: true, install: true, accessibility: true, battery: true },
      },
    });
    try {
      await ui.click("[data-testid='new-session-menu'], [data-testid='session-back']");
      await ui.el("[data-testid='switcher-settings']");
      await ui.click("[data-testid='switcher-settings']");
      await ui.el("[data-testid='settings-screen']");
      await ui.clickText("Phone access", { within: "[data-settings-page='root']", exact: true });
      await ui.el("[data-testid='phone-tools']");
      await still(ui, join(out, "screenshot-phone-tools.png"));
    } finally {
      await ui.close();
    }
  },

  async gif(browser, env, out) {
    const row = env.row(MAIN);
    const working = (r) => r.path === row.path
      ? { sessionState: env.runningState(r, CLOCK, { kind: "tool", label: "Reading the todos route" }), now: { state: "tool", tool: "read", label: "Reading the todos route", since: CLOCK - 20_000, turnStartedAt: CLOCK - 6 * 60_000, tools: 1 } }
      : null;
    const ui = await openPage(browser, env, { motion: true, stubs: [env.listingStub(working)] });
    try {
      // Start from the drawer over home/chat so the tap slides into the live working conversation.
      await ui.sessions();
      await ui.quiet();
      const clip = await record(ui.page, async () => {
        await sleep(1_200);
        await tap(ui, `[data-testid='session-switcher'] [data-testid='session-row'][data-session-path='${row.path}']`);
        await ui.el("[data-testid='chat-message']", { timeout: 15_000 });
        await ui.socket("chat");
        await sleep(500);
        await playTurn(ui, row);
      }, 2_000);
      const seconds = clip.end - clip.start;
      if (seconds < 8 || seconds > 16) console.warn(`demo.gif runs ${seconds.toFixed(1)} s (target 8-16 s)`);
      encodeGif(clip, join(out, "demo.gif"));
    } finally {
      await ui.close();
    }
  },
  async drawer(browser, env, out) {
    const blog = env.row("Write a post on running SQLite");
    const astro = env.row("Migrate the blog to Astro 5");
    const ask = { question: "Which title should the post use?", options: ["SQLite in production: a year in", "We run prod on SQLite"] };
    const now = { state: "tool", tool: "bash", label: "npm run build", since: CLOCK - 9_000, turnStartedAt: CLOCK - 70_000, tools: 7 };
    const ui = await openPage(browser, env, {
      hash: env.chatHash(MAIN),
      storage: { "omp-pins": JSON.stringify([env.row("Fix flaky timezone test in CI").path]) },
      stubs: [
        { method: "GET", path: "/api/status", body: { ok: true, hostname: "studio", httpsOrigin: "https://studio.ts.net" } },
        { method: "GET", path: "/api/awaiting", body: { ok: true, sessions: [blog.path] } },
        env.listingStub((r) =>
          r.path === blog.path ? { pendingAsk: ask }
          : r.path === astro.path ? { sessionState: env.runningState(r, CLOCK, { kind: "tool", label: "npm run build" }), now }
          : null),
      ],
    });
    try {
      await ui.chat();
      await ui.click("[data-testid='session-back']");
      await ui.el("[data-testid='session-switcher'] [data-testid='session-row']");
      await ui.text("Projects");
      await still(ui, join(out, "screenshot-drawer.png"));
    } finally {
      await ui.close();
    }
  },

  async chat(browser, env, out) {
    const ui = await openPage(browser, env, {
      hash: env.chatHash(MAIN),
      stubs: [
        { method: "GET", path: "/api/changes", body: CHANGES_PAYLOAD },
        { method: "POST", path: "/api/rpc", rpc: "get_state", body: { ok: true, data: { model: { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" }, thinkingLevel: "medium", contextUsage: { percent: 24, tokens: 48_000, contextWindow: 200_000 } } } },
      ],
    });
    try {
      await ui.chat();
      await ui.text("Link");
      // Open the settled "Worked for …" group so the WorkRail (thoughts + Read/Edited/Ran) sits above the markdown reply and footer.
      await ui.click("[data-testid='turn-work-title']");
      await ui.el("[data-testid='rail-act'][data-category='edit'] [data-testid='rail-chip']");
      await ui.quiet();
      await ui.page.evaluate(() => {
        const scroller = document.querySelector(".chat-scroll");
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await scrollQuiet(ui.page);
      await ui.page.evaluate(() => document.querySelector("[data-testid='jump-nav']")?.style.setProperty("visibility", "hidden", "important"));
      await still(ui, join(out, "screenshot-chat.png"));
    } finally {
      await ui.close();
    }
  },

  async workspace(browser, env, out) {
    const ui = await openPage(browser, env, {
      hash: env.chatHash(MAIN),
      stubs: [{ method: "GET", path: "/api/changes", body: CHANGES_PAYLOAD }],
    });
    try {
      await ui.chat();
      await ui.page.evaluate(() => document.querySelector("[data-testid='workspace-tabs'] [data-value='changes']")?.click());
      await ui.el("[data-testid='workspace-tabs'] [data-value='changes'][aria-selected='true']");
      await ui.el("[data-testid='changes-list']");
      await ui.click("[data-testid='changes-file'] button");
      await ui.text("pageSize(req.query.limit)");
      await still(ui, join(out, "screenshot-workspace.png"));
    } finally {
      await ui.close();
    }
  },

  async ask(browser, env, out) {
    const row = env.row(MAIN);
    const ui = await openPage(browser, env, {
      hash: env.chatHash(MAIN),
      stubs: [
        { method: "GET", path: "/api/awaiting", body: { ok: true, sessions: [row.path] } },
        env.listingStub((r) =>
          r.path === row.path
            ? {
                status: "waiting",
                live: true,
                bridge: true,
                pendingAsk: {
                  id: "toolu_capture_ask",
                  index: 0,
                  total: 1,
                  question: "How should GET /todos expose the next page link?",
                  options: [
                    "JSON body (nextCursor) + RFC 8288 Link header",
                    "JSON body (nextCursor) only",
                    "Skip cursor pagination on /todos/export",
                  ],
                  recommended: 0,
                },
              }
            : null,
        ),
      ],
    });
    try {
      await ui.chat();
      await ui.el("[data-testid='answer-sheet']");
      await ui.text("Recommended");
      await still(ui, join(out, "screenshot-ask.png"));
    } finally {
      await ui.close();
    }
  },
};

const OUTPUT_FILES = [
  "demo.gif",
  "screenshot-chat.png",
  "screenshot-drawer.png",
  "screenshot-workspace.png",
  "screenshot-ask.png",
  "screenshot-phone-mode.png",
  "screenshot-phone-tools.png",
];

// ── Main ────────────────────────────────────────────────────────────────────

async function main(argv) {
  const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const out = resolve(value("out") ?? join(ROOT, "docs/media"));
  const only = value("only")?.split(",").filter(Boolean) ?? Object.keys(SHOTS);
  const unknown = only.filter((name) => !(name in SHOTS));
  if (unknown.length) throw new Error(`unknown shot(s): ${unknown.join(", ")} (choose from ${Object.keys(SHOTS).join(", ")})`);

  const base = process.env.OMP_PULSE_TEST_BASE;
  const token = process.env.OMP_PULSE_TEST_TOKEN;
  const url = new URL(base);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port === "7682") {
    throw new Error(`refusing ${base}: run through e2e/with-test-daemon.sh`);
  }
  mkdirSync(out, { recursive: true });

  const files = seed(process.env.OMP_PULSE_TEST_SESSIONS, join(process.env.OMP_PULSE_TEST_TMP, "code"));
  const ready = (rows) => SESSIONS.every(([title]) => rows.some((r) => r.title === title));
  let env = makeEnv({ base, token, appUrl: `${base}/app/`, listing: await listing(base, token, ready) });

  const puppeteer = await loadPuppeteer();
  const profile = mkdtempSync(join(tmpdir(), "omp-readme-media-"));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`, "--hide-scrollbars"],
  });
  try {
    // The GIF plays the main conversation's second half live, so it runs
    // while the file holds only the first half; the stills need all of it.
    for (const name of ["phone", "phoneTools", "gif"].filter((n) => only.includes(n))) await SHOTS[name](browser, env, out);
    const before = env.row(MAIN).revision;
    appendFileSync(files[MAIN], chain(MAIN_REST, "rest", "s0-e3"));
    const when = new Date(CLOCK - 3 * 60_000);
    utimesSync(files[MAIN], when, when);
    env = makeEnv({ base, token, appUrl: `${base}/app/`, listing: await listing(base, token, (rows) => ready(rows) && rows.find((r) => r.title === MAIN)?.revision !== before) });
    for (const name of ["drawer", "chat", "workspace", "ask"].filter((n) => only.includes(n))) {
      await SHOTS[name](browser, env, out);
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
  for (const name of OUTPUT_FILES) {
    try { console.log(`${join(out, name)}  ${Math.round(statSync(join(out, name)).size / 1024)} KB`); } catch {}
  }
}

if (!process.env.OMP_PULSE_TEST_BASE) {
  try {
    execFileSync(resolve(ROOT, "e2e/with-test-daemon.sh"), [process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(0);
  } catch (e) {
    process.exit(typeof e.status === "number" ? e.status : 1);
  }
}
await main(process.argv.slice(2));
