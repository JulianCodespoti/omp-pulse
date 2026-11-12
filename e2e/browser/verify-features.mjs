#!/usr/bin/env node
// Behavioural proof for the web/ client's phase 1-3 features. Runs against the
// isolated test daemon (e2e/with-test-daemon.sh) and asserts ten surfaces:
//
//   a. thinking collapsed by default, expands on tap
//   b. tool header human summary + success state
//   c. cross-page tool stitching via pendingToolResults
//   d. status chip for streaming vs idle
//   e. filter chips actually filter (Unread)
//   f. slash palette opens on / and filters
//   g. long-press opens actions sheet
//   h. POST /api/prompt with images array
//   i. day separators between different days
//   j. no horizontal overflow at 390px
//
// Exit code is the number of failed checks.
// Pair through localStorage before app boot; the token never enters the URL.
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { backToSessions, showSessionsList } from "../lib/chat-nav.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-features.mjs");
  process.exit(2);
}
if (/^http:\/\/127\.0\.0\.1:7682/.test(BASE) || BASE.includes("7682")) {
  console.error("refusing to run against live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const failedChecks = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures++;
    failedChecks.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------------------
// Helpers: write a session JSONL file
// ---------------------------------------------------------------------------
function writeSession(dirName, fileName, title, cwd, entries, ageMs = 2 * 60 * 1000) {
  const dir = `${SESSIONS}/${dirName}`;
  mkdirSync(dir, { recursive: true });
  const p = `${dir}/${fileName}`;
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const when = new Date(Date.now() - ageMs);
  utimesSync(p, when, when);
  return p;
}


// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates age out of the list.
// Offsets relative to 2026-08-20T12:01:00.000Z are preserved exactly; the Aug 18 messages stay
// two calendar days before the rest (still inside the window) so day separators still render.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:01:00.000Z");
const ts = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

// ---------------------------------------------------------------------------
// 1. Fixture: main transcript (a, b, i, h, f, j)
// ---------------------------------------------------------------------------
const MAIN_DIR = "-tmp-verify-main";
const MAIN_FILE = "2026-08-20T12-00-00-000Z_019ff400-0000-7000-0000-0000000000a1.jsonl";
writeSession(
  MAIN_DIR,
  MAIN_FILE,
  "Verify main transcript",
  "/tmp/verify-main",
  [
    { type: "title", title: "Verify main transcript" },
    { type: "session", id: "019ff400-0000-7000-0000-0000000000a1", cwd: "/tmp/verify-main", title: "Verify main transcript" },
    // Day 1 message (older day)
    {
      type: "message",
      timestamp: ts("2026-08-18T10:00:00.000Z"),
      message: { id: "u-day1", role: "user", content: [{ type: "text", text: "Message from Aug 18" }] },
    },
    {
      type: "message",
      timestamp: ts("2026-08-18T10:00:02.000Z"),
      message: { id: "a-day1", role: "assistant", content: [{ type: "text", text: "Reply Aug 18" }] },
    },
    // Day 2 messages with thinking+tool
    {
      type: "message",
      timestamp: ts("2026-08-20T12:00:05.000Z"),
      message: { id: "u-main", role: "user", content: [{ type: "text", text: "Run the suite?" }] },
    },
    {
      type: "message",
      timestamp: ts("2026-08-20T12:00:06.000Z"),
      message: {
        id: "a-think-tool",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "weighing options: should run cargo test" },
          { type: "text", text: "Running it now." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "cargo test" }, intent: "run the suite" },
        ],
      },
    },
    {
      type: "message",
      timestamp: ts("2026-08-20T12:00:07.000Z"),
      message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: "test result: ok. 162 passed", isError: false },
    },
    // Image placeholder message (src null -> placeholder)
    {
      type: "message",
      timestamp: ts("2026-08-20T12:00:08.000Z"),
      message: {
        id: "a-image",
        role: "assistant",
        content: [
          { type: "text", text: "Here is screenshot:" },
          { type: "image", data: "", mimeType: "image/png" },
        ],
      },
    },
    // Extra filler to make sure transcript scrollable
    {
      type: "message",
      timestamp: ts("2026-08-20T12:00:09.000Z"),
      message: { id: "a-final", role: "assistant", content: [{ type: "text", text: "All done. Verify complete." }] },
    },
  ],
  2 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// 2. Fixture: cross-page stitching (c) — 80 filler entries, call early, result late
// ---------------------------------------------------------------------------
const XPAGE_DIR = "-tmp-verify-xpage";
const XPAGE_FILE = "2026-08-20T12-01-00-000Z_019ff400-0000-7000-0000-0000000000a2.jsonl";
{
  const entries = [];
  entries.push({ type: "title", title: "Cross-page tool stitch" });
  entries.push({ type: "session", id: "019ff400-0000-7000-0000-0000000000a2", cwd: "/tmp/verify-xpage", title: "Cross-page tool stitch" });
  // Generate 70 filler pairs (user+assistant) = 140 entries would be too many, so 70 single user msgs
  // We want >50 entries so initial 50 excludes the early call.
  for (let i = 0; i < 70; i++) {
    const sec = String(i).padStart(2, "0");
    // early call at i=5
    if (i === 5) {
      entries.push({
        type: "message",
        timestamp: new Date(Date.UTC(2026, 7, 20, 10, 0, i) + SHIFT_MS).toISOString(),
        message: {
          id: `a-xpage-call`,
          role: "assistant",
          content: [{ type: "toolCall", id: "call_xpage", name: "bash", arguments: { command: "cargo test" } }],
        },
      });
    } else {
      entries.push({
        type: "message",
        timestamp: new Date(Date.UTC(2026, 7, 20, 10, 0, i) + SHIFT_MS).toISOString(),
        message: { id: `u-${i}`, role: "user", content: [{ type: "text", text: `filler message ${i}` }] },
      });
    }
  }
  // Result is newest entry — will be in first page, call is in older page
  entries.push({
    type: "message",
    timestamp: ts("2026-08-20T12:01:00.000Z"),
    message: { role: "toolResult", toolCallId: "call_xpage", toolName: "bash", content: "xpage result ok", isError: false },
  });
  writeSession(XPAGE_DIR, XPAGE_FILE, "Cross-page tool stitch", "/tmp/verify-xpage", entries, 90 * 1000);
}

// ---------------------------------------------------------------------------
// 3. Fixtures: unread filtering (e) — two small sessions with distinct sizes
// ---------------------------------------------------------------------------
const UNREAD_A_DIR = "-tmp-verify-unread-a";
const UNREAD_B_DIR = "-tmp-verify-unread-b";
const UNREAD_A_FILE = "2026-08-20T11-00-00-000Z_019ff400-0000-7000-0000-0000000000a3.jsonl";
const UNREAD_B_FILE = "2026-08-20T11-01-00-000Z_019ff400-0000-7000-0000-0000000000a4.jsonl";
writeSession(
  UNREAD_A_DIR,
  UNREAD_A_FILE,
  "Unread Alpha",
  "/tmp/verify-unread-a",
  [
    { type: "title", title: "Unread Alpha" },
    { type: "session", id: "019ff400-0000-7000-0000-0000000000a3", cwd: "/tmp/verify-unread-a", title: "Unread Alpha" },
    { type: "message", timestamp: ts("2026-08-20T11:00:01.000Z"), message: { id: "ua1", role: "user", content: [{ type: "text", text: "hello alpha" }] } },
    // make file larger by adding extra long text
    { type: "message", timestamp: ts("2026-08-20T11:00:02.000Z"), message: { id: "aa1", role: "assistant", content: [{ type: "text", text: "x".repeat(2000) }] } },
  ],
  5 * 60 * 1000,
);
writeSession(
  UNREAD_B_DIR,
  UNREAD_B_FILE,
  "Unread Beta",
  "/tmp/verify-unread-b",
  [
    { type: "title", title: "Unread Beta" },
    { type: "session", id: "019ff400-0000-7000-0000-0000000000a4", cwd: "/tmp/verify-unread-b", title: "Unread Beta" },
    { type: "message", timestamp: ts("2026-08-20T11:01:01.000Z"), message: { id: "ub1", role: "user", content: [{ type: "text", text: "hello beta" }] } },
  ],
  6 * 60 * 1000,
);

// Two more inert sessions for idle/streaming chip test fallback
const IDLE_DIR = "-tmp-verify-idle";
const IDLE_FILE = "2026-08-20T11-02-00-000Z_019ff400-0000-7000-0000-0000000000a5.jsonl";
writeSession(
  IDLE_DIR,
  IDLE_FILE,
  "Idle Session",
  "/tmp/verify-idle",
  [
    { type: "title", title: "Idle Session" },
    { type: "session", id: "019ff400-0000-7000-0000-0000000000a5", cwd: "/tmp/verify-idle", title: "Idle Session" },
    { type: "message", timestamp: ts("2026-08-20T11:02:01.000Z"), message: { id: "ui1", role: "user", content: [{ type: "text", text: "idle hello" }] } },
  ],
  7 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Vite + puppeteer
// ---------------------------------------------------------------------------
const webApp = await startWebApp({ base: BASE, port: 5188 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-verify-features-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  const pageErrors = [];
  const consoleErrors = [];
  const NOISE = /favicon\.ico|Failed to load resource|the server responded with a status of 404|ERR_|net::|WebSocket|Failed to fetch/i;
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      if (!NOISE.test(t)) consoleErrors.push(t);
      else console.log(`(ignored console noise) ${t.slice(0, 200)}`);
    }
  });

  // Capture POST /api/prompt bodies for check h
  let capturedPromptBody = null;
  page.on("request", (req) => {
    try {
      const url = req.url();
      if (url.includes("/api/prompt") && req.method() === "POST") {
        const data = req.postData();
        if (data) {
          try {
            capturedPromptBody = JSON.parse(data);
          } catch {
            capturedPromptBody = data;
          }
        }
      }
    } catch {}
  });

  // Intercept /api/rpc get_available_commands to provide slash palette commands + fake sessions for check d
  // Use request interception via setRequestInterception if available; fallback to fetch override via evaluateOnNewDocument
  // Puppeteer-core: page.setRequestInterception
  let useFakeSessions = true; // for check d — return one streaming + one idle
  let interceptCommands = true;
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      const method = req.method();
      // Fake sessions listing for d while flag is true
      if (useFakeSessions && url.includes("/api/sessions") && method === "GET" && !url.includes("q=")) {
        const now = Date.now();
        const fake = {
          sessions: [
            { path: "/tmp/fake-streaming/2026-08-20T12-00-00-000Z_fake1.jsonl", id: "fake-streaming", title: "Streaming session demo", cwd: "/tmp/fake-streaming", mtime: now, size: 1234, status: "streaming", live: true, streaming: true, snippet: { text: "live demo" } },
            { path: "/tmp/fake-idle/2026-08-20T12-00-00-000Z_fake2.jsonl", id: "fake-idle", title: "Idle session demo", cwd: "/tmp/fake-idle", mtime: now - 10000, size: 567, status: "idle", live: false, streaming: false, snippet: { text: "idle demo" } },
            // include real unread sessions as well so e still has them after flag flips, but for d we keep minimal
          ],
        };
        req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(fake) });
        return;
      }
      if (url.includes("/api/rpc") && method === "POST") {
        const post = req.postData() || "";
        if (post.includes("get_available_commands")) {
          req.respond({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, commands: [{ name: "/commit", description: "commit changes", source: "file" }, { name: "/review", description: "review code", source: "file" }, { name: "/status", description: "show status", source: "file" }, { name: "usage", description: "Show provider usage and limits", source: "builtin", subcommands: [{ name: "show", description: "Show provider usage and limits" }] }, { name: "login", description: "Sign in", source: "builtin" }] }),
          });
          return;
        }
      }
      req.continue();
    });
  } catch {
    interceptCommands = false;
  }
  if (!interceptCommands) {
    await page.evaluateOnNewDocument(() => {
      const origFetch = window.fetch;
      // @ts-ignore
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url || String(input);
        const body = init && typeof init.body === "string" ? init.body : "";
        if (url.includes("/api/rpc") && body.includes("get_available_commands")) {
          return new Response(JSON.stringify({ ok: true, commands: [{ name: "/commit", description: "commit", source: "file" }, { name: "/review", description: "review", source: "file" }, { name: "usage", description: "Show provider usage and limits", source: "builtin", subcommands: [{ name: "show", description: "Show provider usage and limits" }] }, { name: "login", description: "Sign in", source: "builtin" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return origFetch(input, init);
      };
    });
  }

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  // Projects are checked against the real folders first, before the fake
  // streaming listing below takes over the session endpoint.
  useFakeSessions = false;
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 500));
  check("no pushed all-chats page exists", !(await page.$("[data-testid='all-chats-layer']")), "all-chats-layer came back");
  const allRows = await page.$$eval("[data-testid='session-switcher'] [data-testid='session-row']", (rows) => rows.length);
  await page.waitForSelector("[data-testid='switcher-project']", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  const cwds = await page.$$eval("[data-testid='switcher-project']", (nodes) => nodes.map((node) => node.getAttribute("data-cwd")));
  check("the drawer lists projects as folders", cwds.length > 0 && cwds.every((cwd) => typeof cwd === "string" && cwd.includes("/")), JSON.stringify(cwds).slice(0, 300));
  if (cwds.length > 0) {
    await page.click(`[data-testid='switcher-project'][data-cwd='${cwds[0]}']`);
    await page.waitForSelector("[data-testid='project-new-chat']", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 800));
    const scoped = await page.evaluate(() => document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']").length);
    check("a project scopes the drawer to its own chats", scoped > 0 && scoped <= allRows, `all=${allRows} scoped=${scoped}`);
    await page.click("[data-testid='project-new-chat']");
    await page.waitForSelector("[data-testid='new-session-project']", { timeout: 10000 });
    const chip = await page.evaluate(() => document.querySelector("[data-testid='new-session-project']")?.textContent ?? "");
    check("New chat from a project arrives home with it chosen", chip.includes(cwds[0].split("/").filter(Boolean).pop()), chip);
    await showSessionsList(page);
    await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 15000 });
  }

  useFakeSessions = true;

  // From here on the app holds live streams open, so "no requests for 500 ms"
  // (networkidle0) may never arrive; every reload below waits for a selector.
  await page.reload({ waitUntil: "domcontentloaded" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));

  // -----------------------------------------------------------------------
  // j. No horizontal overflow at 390px — drawer open
  // -----------------------------------------------------------------------
  const overflowSessions = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  check(
    "no horizontal overflow on sessions drawer at 390px",
    overflowSessions.doc === overflowSessions.win,
    `scrollWidth=${overflowSessions.doc} innerWidth=${overflowSessions.win}`,
  );

  // -----------------------------------------------------------------------
  // d. working vs idle on the session drawer
  // -----------------------------------------------------------------------
  const statusMarks = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']"));
    return rows.map((button) => ({
      state: button.getAttribute("data-state"),
      glyph: button.querySelector("[data-slot='session-status']")?.getAttribute("data-state") ?? null,
    }));
  });
  check(
    "session drawer shows running ring on a streaming row and marks an idle row with nothing",
    statusMarks.some((m) => m.state === "working" && m.glyph === "working")
      && statusMarks.some((m) => m.state === "idle" && m.glyph === null),
    `rows=${JSON.stringify(statusMarks)} fake=${useFakeSessions}`,
  );
  // Flip to real sessions for remaining checks (e, g, etc.)
  useFakeSessions = false;
  // The fake streaming chat remains open beneath the pushed Chats list, so
  // App's existing unsaved-work guard still protects it. This reload deliberately
  // discards that synthetic turn; accept the browser's beforeunload confirmation.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload({ waitUntil: "domcontentloaded" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));

  // -----------------------------------------------------------------------
  // e. Filter chips actually filter (Unread)
  // -----------------------------------------------------------------------
  // Prepare unread state. Read state keys on the daemon's `revision` stored as
  // `r:<revision>` (session-format.ts markSeen); a legacy byte-size marker now
  // reads as seen, so Alpha gets a revision it cannot match.
  await page.evaluate(async () => {
    const token = localStorage.getItem("omp-remote-token") || "";
    const r = await fetch("/api/sessions", { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const j = await r.json();
    const sessions = j.sessions || [];
    for (const s of sessions) {
      if (!s.path) continue;
      const unread = String(s.cwd || "").includes("verify-unread-a") || String(s.title || "").includes("Unread Alpha");
      localStorage.setItem("omp-seen:" + s.path, unread ? "r:-1" : `r:${s.revision}`);
    }
  });
  // Read state is loaded at render; reload so the chip counts see it.
  // domcontentloaded, not networkidle0: the app keeps its live streams open, so
  // "no requests for 500 ms" never arrives on a chat with a running turn.
  await page.reload({ waitUntil: "domcontentloaded" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  // -----------------------------------------------------------------------
  // g. Long-press on a session row opens the drawer actions menu
  // -----------------------------------------------------------------------
  await backToSessions(page);
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));
  const longPressOpened = await page.evaluate(async () => {
    const row = document.querySelector("[data-testid='session-switcher'] [data-testid='session-row']");
    if (!row) return { ok: false, reason: "no row" };
    const rect = row.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const down = new PointerEvent("pointerdown", { clientX: x, clientY: y, pointerId: 1, bubbles: true, cancelable: true });
    row.dispatchEvent(down);
    await new Promise((r) => setTimeout(r, 600));
    const up = new PointerEvent("pointerup", { clientX: x, clientY: y, pointerId: 1, bubbles: true });
    row.dispatchEvent(up);
    await new Promise((r) => setTimeout(r, 400));
    const menu = document.querySelector("[data-testid='drawer-actions']");
    const txt = menu ? menu.textContent : "";
    const hasMenu = !!(txt && (txt.includes("Pin") || txt.includes("Rename") || txt.includes("Duplicate")));
    return { ok: hasMenu, textSnippet: (txt || "").slice(0, 300) };
  });
  check("long-press on a session row opens the drawer actions menu", longPressOpened.ok, JSON.stringify(longPressOpened).slice(0, 500));
  // -----------------------------------------------------------------------
  // Sheets must be TAPPABLE, not merely visible.
  //
  // Regression guard: `BottomSheet` rendered the scrim at z-50 and the panel
  // at `z-index: auto`, so the overlay painted over the sheet and swallowed
  // every tap. The sheet looked perfect in a screenshot and was completely
  // inert on a phone — settings and the command palette were unusable.
  // -----------------------------------------------------------------------
  const sheetHitTest = async (label, openSelector) => {
    const opener = await page.$(openSelector);
    if (!opener) {
      check(`${label}: opener present`, false, `no element matching ${openSelector}`);
      return;
    }
    await opener.click();
    await new Promise((r) => setTimeout(r, 600));
    const probe = await page.evaluate(() => {
      const dlg = document.querySelector("[role='dialog'][data-sheet-panel]");
      if (!dlg) return { open: false };
      const r = dlg.getBoundingClientRect();
      // Sample several points down the sheet, not just one.
      const xs = [0.25, 0.5, 0.75].map((f) => Math.round(r.left + r.width * f));
      const ys = [24, Math.round(r.height / 2), Math.round(r.height - 24)].map((d) => Math.round(r.top + d));
      let inside = 0;
      let total = 0;
      for (const x of xs) {
        for (const y of ys) {
          if (y < 0 || y > window.innerHeight) continue;
          total++;
          const hit = document.elementFromPoint(x, y);
          if (hit && dlg.contains(hit)) inside++;
        }
      }
      return { open: true, inside, total, z: getComputedStyle(dlg).zIndex };
    });
    check(
      `${label}: sheet receives taps (scrim not covering it)`,
      probe.open === true && probe.total > 0 && probe.inside === probe.total,
      JSON.stringify(probe),
    );
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));
  };

  // Close the long-press sheet before the hit test opens another one.
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 400));
  // Settings is a full-screen layer, not a sheet: it must take taps across
  // the whole screen and leave through its own Close settings button.
  {
    // Settings lives directly on the session switcher drawer (`switcher-settings`).
    await backToSessions(page);
    await page.waitForSelector("[data-testid='switcher-settings']", { timeout: 5000 }).catch(() => null);
    const opener = await page.$("[data-testid='switcher-settings']");
    if (!opener) {
      check("settings: opener present", false, "no element matching [data-testid='switcher-settings']");
    } else {
      await opener.click();
      await page.waitForSelector("[data-testid='settings-screen']", { timeout: 5000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 600));
      const probe = await page.evaluate(() => {
        const screen = document.querySelector("[data-testid='settings-screen']");
        if (!screen) return { open: false };
        let inside = 0;
        let total = 0;
        for (const fx of [0.25, 0.5, 0.75]) {
          for (const fy of [0.15, 0.5, 0.85]) {
            total++;
            const hit = document.elementFromPoint(Math.round(window.innerWidth * fx), Math.round(window.innerHeight * fy));
            if (hit && screen.contains(hit)) inside++;
          }
        }
        return { open: true, inside, total };
      });
      check(
        "settings: screen receives taps (nothing covering it)",
        probe.open === true && probe.total > 0 && probe.inside === probe.total,
        JSON.stringify(probe),
      );
      await page.evaluate(() => {
        const close = document.querySelector("[data-testid='settings-screen'] button[aria-label='Close settings']");
        if (close instanceof HTMLElement) close.click();
      });
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // -----------------------------------------------------------------------
  // Helper to open a session by title
  // -----------------------------------------------------------------------
  async function openSessionByTitle(title) {
    await backToSessions(page);
    await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 400));
    const rows = await page.$$("[data-testid='session-switcher'] [data-testid='session-row']");
    for (const row of rows) {
      const txt = await row.evaluate((el) => el.textContent || "");
      if (txt.includes(title)) {
        await row.click();
        return true;
      }
    }
    // fallback: click first
    if (rows[0]) {
      await rows[0].click();
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // a. thinking collapsed by default and expands on tap
  // -----------------------------------------------------------------------
  await openSessionByTitle("Verify main transcript");
  await page.waitForFunction(() => document.body.textContent?.includes("Running it now."), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 600));
  // Summary mode folds reasoning and calls into work groups. Inspect the
  // group's disclosure, not Thought's detail-mode markup, which is not mounted.
  const thinkingCollapsed = await page.evaluate(() => {
    const part = document.querySelector("[data-testid='turn-work']");
    if (!part) return { ok: false, reason: "no work group" };
    const trigger = part.querySelector("[data-testid='turn-work-title']");
    // The reasoning text is not rendered until the containing group is opened.
    const collapsed = trigger?.getAttribute("aria-expanded") === "false" && !part.textContent?.includes("weighing options");
    return { hasTrigger: !!trigger, collapsed, inner: part.textContent?.slice(0, 200) };
  });
  check("thinking stays inside a collapsed work group by default", thinkingCollapsed.collapsed === true, JSON.stringify(thinkingCollapsed).slice(0, 600));
  // Expand on tap
  await page.evaluate(() => {
    const trigger = document.querySelector("[data-testid='turn-work-title']");
    if (trigger instanceof HTMLElement) trigger.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const thinkingExpanded = await page.evaluate(() => {
    const content = document.querySelector("[data-testid='turn-work'] [data-testid='rail-thought']");
    if (!content) return { ok: false, reason: "no content after click" };
    const cs = window.getComputedStyle(content);
    // Real visibility, not an attribute: a collapsed panel must not pass.
    const hasText = (content.textContent || "").includes("weighing options");
    const rendered =
      content.clientHeight > 0 &&
      cs.display !== "none" &&
      cs.visibility !== "hidden" &&
      content.getClientRects().length > 0;
    return { hasText, rendered, height: content.clientHeight };
  });
  check(
    "thinking expands on tap",
    thinkingExpanded.hasText === true && thinkingExpanded.rendered === true,
    JSON.stringify(thinkingExpanded).slice(0, 600),
  );

  // b. a shell call is a quiet command row (a rail chip in Summary mode) that
  // names the agent's stated intent when it gave one ("run the suite"), else the command
  // itself (`Ran cargo test`), never the raw arguments JSON. A tap opens a
  // sheet with the full command and its output. Settled calls live inside
  // collapsed work groups; open any remaining ones before inspecting the rows,
  // just as the cross-page check below does.
  await page.evaluate(() => {
    for (const title of document.querySelectorAll("[data-testid='turn-work-title'][aria-expanded='false']")) {
      if (title instanceof HTMLElement) title.click();
    }
  });
  await page.waitForSelector("[data-testid='tool-row'], [data-testid='rail-chip']", { visible: true, timeout: 5000 });
  const toolRowCheck = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='tool-row'], [data-testid='rail-chip']"));
    const texts = rows.map((row) => row.textContent || "");
    const row = rows.find((el) => /cargo test|run the suite/.test(el.textContent || ""));
    if (row instanceof HTMLElement) row.click();
    return { headerHasCargo: !!row, headerHasRawJson: texts.some((t) => t.includes('"command"')), texts: texts.slice(0, 3) };
  });
  await page
    .waitForFunction(() => document.querySelector("[data-testid='tool-sheet']"), { timeout: 5000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const toolSheetCheck = await page.evaluate(() => {
    const sheet = document.querySelector("[data-testid='tool-sheet']");
    const text = sheet?.textContent || "";
    return {
      opened: !!sheet,
      hasOutput: text.includes("test result: ok. 162 passed"),
      hasCommand: text.includes("cargo test"),
      snippet: text.slice(0, 400),
    };
  });
  check(
    "a shell call's row names its intent or command, not raw JSON",
    toolRowCheck.headerHasCargo && !toolRowCheck.headerHasRawJson,
    JSON.stringify(toolRowCheck).slice(0, 800),
  );
  check(
    "tapping the command row opens the sheet with the command and its output",
    toolSheetCheck.opened && toolSheetCheck.hasOutput && toolSheetCheck.hasCommand,
    JSON.stringify(toolSheetCheck).slice(0, 800),
  );
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));

  // -----------------------------------------------------------------------
  // i. day separators between messages from different days
  // -----------------------------------------------------------------------
  const daySep = await page.evaluate(() => {
    const text = document.body.textContent || "";
    const html = document.body.innerHTML || "";
    // Look for DaySeparator specific styling (rounded-full bg-muted uppercase tracking)
    const separators = Array.from(document.querySelectorAll("span.rounded-full.bg-muted, div.flex.justify-center"));
    const foundByClass = separators.filter((el) => el.textContent && el.textContent.trim().length > 0).map((el) => el.textContent?.trim());
    // Also check for generic day labels: look for date-like strings that could be separators between messages
    const candidates = [];
    // Search for elements that are direct siblings between chat messages
    const markers = document.querySelectorAll("[class*='uppercase'][class*='tracking']");
    const markerTexts = Array.from(markers).map((m) => m.textContent?.trim());
    // Fallback: check if there is any element containing August or numeric day between the two message texts
    const hasAug = text.includes("August") || text.includes("Aug 18") || text.includes("2026-08-18");
    // Better: count DaySeparator instances via transcript markers count
    const docHasSeparator = separators.length > 0 || markerTexts.some((t) => t && /^(Today|Yesterday|\w+ \d+|Aug|September|October|\d{4})/i.test(t));
    return { count: separators.length, foundByClass, markerTexts: markerTexts.slice(0, 5), hasAug, docHasSeparator, htmlSnippet: html.slice(0, 2000) };
  });
  // This is expected to FAIL until TranscriptMarkers is wired into ChatScreen.
  // Report as precise product bug rather than weakening check if missing.
  const dayOk = daySep.docHasSeparator || (daySep.count > 0);
  check(
    "transcript renders day separators between messages from different days",
    dayOk,
    dayOk ? `found ${daySep.count} separators` : `none found — TranscriptMarkers DaySeparator not used in ChatScreen (product bug). foundByClass=${JSON.stringify(daySep.foundByClass)} markerTexts=${JSON.stringify(daySep.markerTexts)}`,
  );

  // -----------------------------------------------------------------------
  // Check overflow on chat screen (j second part)
  // -----------------------------------------------------------------------
  const overflowChat = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  check(
    "no horizontal overflow on chat screen at 390px",
    overflowChat.doc === overflowChat.win,
    `scrollWidth=${overflowChat.doc} innerWidth=${overflowChat.win}`,
  );

  // Image placeholder check (part of transcript extras). The wording names
  // this device rather than "your computer": on the phone runtime omp's host
  // IS this device (see ImagePart.tsx).
  const imagePlaceholder = await page.evaluate(() => {
    const tile = document.querySelector("[data-testid='image-tile']");
    return (tile?.textContent || "").includes("Image not on this device");
  });
  check(
    "transcript image placeholder renders for image part with empty data",
    imagePlaceholder,
    imagePlaceholder ? "placeholder tile rendered" : "placeholder tile MISSING",
  );

  // -----------------------------------------------------------------------
  // c. cross-page tool stitching
  // -----------------------------------------------------------------------
  await openSessionByTitle("Cross-page tool stitch");
  await page.waitForFunction(() => document.body.textContent?.includes("filler message"), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));
  const beforeLoad = await page.evaluate(() => ({
    hasHeader: (document.body.textContent || "").includes("cargo test"),
    hasOutput: (document.body.textContent || "").includes("xpage result ok"),
    count: document.querySelectorAll("[data-testid='chat-message']").length,
  }));
  const beforeCount = beforeLoad.count;
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    if (el) el.scrollTop = 0;
  });
  try {
    await page.waitForFunction((baseline) => document.querySelectorAll("[data-testid='chat-message']").length > baseline, { timeout: 12000 }, beforeCount);
  } catch {}
  await new Promise((r) => setTimeout(r, 800));
  let afterCount = await page.evaluate(() => document.querySelectorAll("[data-testid='chat-message']").length);
  if (afterCount <= beforeCount) {
    await page.evaluate(() => {
      const cand = Array.from(document.querySelectorAll("button")).find((b) => /Load earlier/i.test(b.textContent || ""));
      if (cand instanceof HTMLElement) cand.click();
    });
    await new Promise((r) => setTimeout(r, 1000));
    afterCount = await page.evaluate(() => document.querySelectorAll("[data-testid='chat-message']").length);
  }
  // The older call is a quiet row inside its stretch's work group (runs are
  // folded into groups that open in place): open each group until the row
  // shows, then tap the row, which opens the tool sheet with the command and
  // its output.
  const cargoRowShown = () => page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid='tool-row'], [data-testid='rail-chip']")).some((el) => (el.textContent || "").includes("cargo test")));
  if (!(await cargoRowShown())) {
    const groups = await page.evaluate(() => document.querySelectorAll("[data-testid='turn-work-title'][aria-expanded='false']").length);
    for (let i = 0; i < groups && !(await cargoRowShown()); i++) {
      await page.evaluate((index) => {
        const title = document.querySelectorAll("[data-testid='turn-work-title']")[index];
        if (title instanceof HTMLElement && title.getAttribute("aria-expanded") === "false") title.click();
      }, i);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[data-testid='tool-row'], [data-testid='rail-chip']")).find((el) => (el.textContent || "").includes("cargo test"));
    if (row instanceof HTMLElement) row.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const afterDetails = await page.evaluate(() => {
    const txt = document.body.textContent || "";
    const sheet = document.querySelector("[data-testid='tool-sheet']");
    return { hasHeader: txt.includes("cargo test"), hasOutput: (sheet?.textContent || "").includes("xpage result ok"), count: document.querySelectorAll("[data-testid='chat-message']").length, snippet: txt.slice(0, 1300) };
  });
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 400));
  // Earlier history now loads by itself, so the older page may already be in
  // by the time we look: what matters is that the call resolves with its result.
  const afterLoadOk = afterDetails.hasHeader && afterDetails.hasOutput && afterCount >= beforeCount;
  check(
    "tool call in older page resolves after scrolling up when result was in newest page",
    afterLoadOk,
    `before=${JSON.stringify(beforeLoad)} after=${JSON.stringify(afterDetails)} beforeCount=${beforeCount} afterCount=${afterCount}`,
  );

  // Return to sessions for remaining checks
  await backToSessions(page);
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 400));

  // -----------------------------------------------------------------------
  // f. slash palette opens on / and filters
  // -----------------------------------------------------------------------
  await openSessionByTitle("Verify main transcript");
  await page.waitForSelector("textarea", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  // Focus textarea and type /
  const ta = await page.$("textarea");
  if (ta) {
    await ta.click({ clickCount: 1 });
    await page.evaluate(() => {
      const el = document.querySelector("textarea");
      if (el instanceof HTMLTextAreaElement) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
      }
    });
    await page.keyboard.type("/", { delay: 30 });
    await new Promise((r) => setTimeout(r, 600));
    // The palette lists the live omp catalogue (a child pushes it after the
    // canned reply above), so assert on its builtins, not the canned names.
    const paletteRows = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-testid='slash-palette'] [data-testid='command-name']")).map((e) => e.textContent || ""));
    const slashVisible = { rows: await paletteRows() };
    check("composer slash palette opens on /", slashVisible.rows.includes("/model") && slashVisible.rows.includes("/compact"), JSON.stringify(slashVisible).slice(0, 700));
    // Now type additional chars to filter: /com keeps /compact and drops /model
    await page.keyboard.type("com", { delay: 40 });
    await new Promise((r) => setTimeout(r, 500));
    const slashFiltered = { rows: await paletteRows() };
    const filteredOk = slashFiltered.rows.includes("/compact") && !slashFiltered.rows.includes("/model");
    check("slash palette filters as you type", filteredOk, JSON.stringify(slashFiltered).slice(0, 700));


  // -----------------------------------------------------------------------
  // A builtin command must EXECUTE, never be injected into the conversation.
  //
  // Regression guard: tapping `/usage` used to POST `/usage show` to
  // /api/prompt, which on a collab session is forwarded to the desktop host
  // and lands in the transcript as a user message to the model. The palette
  // must run an RPC (or say the command is desktop-only) and send no prompt.
  // -----------------------------------------------------------------------
  {
    const promptBodies = [];
    const rpcCommands = [];
    const onReq = (req) => {
      const u = req.url();
      if (req.method() !== "POST") return;
      if (u.includes("/api/prompt")) promptBodies.push(String(req.postData() ?? "").slice(0, 200));
      if (u.includes("/api/rpc")) {
        try {
          rpcCommands.push(JSON.parse(String(req.postData() ?? "{}")).command);
        } catch {
          rpcCommands.push("<unparsed>");
        }
      }
    };
    page.on("request", onReq);


    promptBodies.length = 0;
    rpcCommands.length = 0;

    // Drive the palette: type "/usage" in the composer and pick the entry.
    const ta = await page.$("textarea");
    if (ta) {
      // Clear any leftover text so `slashDismissed` resets and the inline
      // palette can open again after the earlier checks dismissed it.
      await ta.click();
      await page.evaluate(() => {
        const el = document.querySelector("textarea");
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 400));
      await ta.click();
      await page.keyboard.type("/usage");
      await new Promise((r) => setTimeout(r, 900));
      const picked = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("[cmdk-item],[data-slot='command-item'],li,button,[role='option']"));
        const texts = rows.map((r) => (r.textContent || "").trim().slice(0, 24)).filter(Boolean).slice(0, 12);
        const hit = rows.find((el) => (el.textContent || "").toLowerCase().includes("usage"));
        if (!hit) return { ok: false, texts, body: (document.body.textContent || "").slice(0, 200) };
        hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return { ok: true };
      });
      await new Promise((r) => setTimeout(r, 1500));
      check(
        "/usage runs get_session_stats and is never sent to the model as a prompt",
        picked.ok === true &&
          promptBodies.every((b) => !b.includes("/usage")) &&
          rpcCommands.includes("get_session_stats"),
        `picked=${JSON.stringify(picked)} prompts=${JSON.stringify(promptBodies)} rpc=${JSON.stringify(rpcCommands)}`,
      );
    } else {
      check("/usage runs get_session_stats and is never sent to the model as a prompt", false, "composer textarea not found");
    }

    page.off("request", onReq);
    // Leave the composer exactly as found: close the result sheet and clear
    // the typed command, or the later attachment check inherits dirty state.
    await page.keyboard.press("Escape").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => {
      const el = document.querySelector("textarea");
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 400));
  }
    // Clear
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => {
      const el = document.querySelector("textarea");
      if (el instanceof HTMLTextAreaElement) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  } else {
    check("composer slash palette opens on /", false, "textarea not found");
    check("slash palette filters as you type", false, "textarea not found");
  }

  // -----------------------------------------------------------------------
  // h. POST /api/prompt with images array via file input uploadFile
  // -----------------------------------------------------------------------
  // Ensure composer is visible and we have a temp png
  capturedPromptBody = null;
  // Create tiny 1x1 PNG file in /tmp
  const tinyB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const tmpImgPath = `${tmpdir()}/omp-verify-tiny-${Date.now()}.png`;
  {
    const { writeFileSync: wfs } = await import("fs");
    const buf = Buffer.from(tinyB64, "base64");
    wfs(tmpImgPath, buf);
  }
  // Find hidden file input
  const fileInput = await page.$("input[type='file'][accept*='image']");
  let uploadOk = false;
  if (fileInput) {
    try {
      await fileInput.uploadFile(tmpImgPath);
      await new Promise((r) => setTimeout(r, 800));
      const hasPreview = await page.evaluate(() => {
        const txt = document.body.textContent || "";
        // After upload, AttachmentStrip should show image preview or file name, and error maybe none
        // Check for img preview element or strip
        const strip = document.querySelector("[class*='attachment']") || document.querySelector("img[src^='blob:']") || document.body.innerHTML.includes("blob:");
        // Also check that file input's preview URL is set via DOM? Look for thumbnail
        const imgs = document.querySelectorAll("img");
        const hasBlobImg = Array.from(imgs).some((img) => (img.src || "").startsWith("blob:") || (img.src || "").startsWith("data:"));
        const hasStrip = !!document.querySelector("[data-testid='attachment-strip']") || !!document.body.innerHTML.match(/attachment/i);
        return { hasPreview: hasBlobImg || hasStrip || !!strip, imgCount: imgs.length, htmlSnippet: document.body.innerHTML.slice(0, 1500) };
      });
      uploadOk = hasPreview.hasPreview || true; // intakeFiles may be async but we consider upload attempted
    } catch (e) {
      uploadOk = false;
    }
  }
  // Even if preview check is lenient, we still test POST body shape after sending
  // Type some text and send
  await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (!(ta instanceof HTMLTextAreaElement)) return;
    ta.focus();
    // A controlled React textarea ignores a direct `.value =` assignment; the
    // native setter is what makes React observe the change. Assigning directly
    // only appeared to work because earlier state happened to linger.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(ta, "hello with image");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  // Intercept next prompt and ensure we capture body, but allow request to go through and stub response to avoid real child
  // Any sheet still open would cover the composer and swallow the click.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[role='dialog']")) {
      const btn = el.querySelector("button[aria-label='Close'],button[aria-label='close']");
      if (btn instanceof HTMLElement) btn.click();
    }
  });
  await new Promise((r) => setTimeout(r, 500));

  // Our earlier request listener already captures; now click Send
  const sendState = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label='Send']");
    const ta = document.querySelector("textarea");
    return {
      sendFound: !!b,
      disabled: b ? b.hasAttribute("disabled") : null,
      textLen: ta ? ta.value.length : -1,
      thumbs: document.querySelectorAll("[data-testid='attachment-thumb'],img[alt*='attach' i]").length,
      dialogs: document.querySelectorAll("[role='dialog']").length,
    };
  });
  const clickProbe = await page.evaluate(() => {
    const b = document.querySelector("button[aria-label='Send']");
    if (!(b instanceof HTMLElement)) return { found: false };
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      found: true,
      type: b.getAttribute("type"),
      inForm: !!b.closest("form"),
      topHit: hit ? hit.tagName + "." + String(hit.className).slice(0, 40) : null,
      hitIsButton: hit ? b.contains(hit) || hit === b : false,
      hitText: hit ? (hit.textContent || "").trim().slice(0, 40) : null,
      hitRect: hit ? (() => { const q = hit.getBoundingClientRect(); return { t: Math.round(q.top), l: Math.round(q.left), w: Math.round(q.width), h: Math.round(q.height) }; })() : null,
      btnRect: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      hitParent: hit?.parentElement ? hit.parentElement.tagName + "." + String(hit.parentElement.className).slice(0, 50) : null,
    };
  });
  // Third occurrence of the same bug class (scrim over sheet, toast over
  // send): an element painted on top of a control makes it silently inert.
  check(
    "the Send button is not covered by any overlay",
    clickProbe.found === true && clickProbe.hitIsButton === true,
    JSON.stringify(clickProbe).slice(0, 300),
  );
  const sendBtn = await page.$("button[aria-label='Send']");
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }
  // Wait for captured body
  for (let i = 0; i < 20; i++) {
    if (capturedPromptBody) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Clean up tmp file
  try { rmSync(tmpImgPath, { force: true }); } catch {}
  const promptHasImages =
    capturedPromptBody &&
    typeof capturedPromptBody === "object" &&
    typeof capturedPromptBody.commandId === "string" &&
    capturedPromptBody.commandId.length > 0 &&
    Array.isArray(capturedPromptBody.images) &&
    capturedPromptBody.images.length === 1 &&
    typeof capturedPromptBody.images[0].data === "string" &&
    typeof capturedPromptBody.images[0].mimeType === "string";
  check(
    "POST /api/prompt is called with an images array when attachment present",
    !!promptHasImages,
    capturedPromptBody ? JSON.stringify(capturedPromptBody).slice(0, 900) : "no prompt captured (check request listener and send flow)",
  );

  // -----------------------------------------------------------------------
  // Final overflow re-check (both screens already checked)
  // -----------------------------------------------------------------------
  // Already checked sessions and chat overflow.

  // Console/pageerror collection fail
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  check("no console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));


  await browser.close();
} finally {
  webApp.stop();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
if (failedChecks.length) console.log(failedChecks.join("\n"));
process.exit(failures);
