#!/usr/bin/env node
// Behavioural proof for the web/ client's sync fundamentals. Runs against the
// isolated test daemon (e2e/with-test-daemon.sh) and asserts the four things
// that were broken or absent:
//
//   1. scroll-up pagination actually fetches older pages
//   2. prepending does not move the viewport (scroll anchoring)
//   3. the session list refreshes itself, with 304s in the steady state
//   4. an append to the open session arrives over the websocket
//
// Exit code is the number of failed checks.
import { mkdirSync, writeFileSync, appendFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { backToSessions, showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A transcript long enough to need several pages: the daemon caps a page at
// 200 entries and defaults to 50.
const LONG_DIR = `${SESSIONS}/-home-dev-Coding-omp-pulse`;
const LONG_FILE = `${LONG_DIR}/2026-08-12T00-00-00-000Z_019ff400-0000-7000-0000-0000000000aa.jsonl`;
mkdirSync(LONG_DIR, { recursive: true });
// Recent base: the Sessions screen hides conversations whose newest message is older
// than 7 days (RECENT_WINDOW_MS); fixed 2026-08-12 stamps aged this fixture out of the list.
// Same 1s-per-turn spacing as before, ending ~1h57m ago.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const TURNS = 200;
const lines = [
  { type: "session", id: "019ff400-0000-7000-0000-0000000000aa", cwd: "/home/dev/Coding/omp-pulse", title: "Long transcript" },
];
for (let i = 0; i < TURNS; i++) {
  lines.push({
    type: "message",
    timestamp: new Date(BASE_MS + i * 1000).toISOString(),
    message: { id: `u${i}`, role: "user", content: [{ type: "text", text: `question number ${i}` }] },
  });
  lines.push({
    type: "message",
    timestamp: new Date(BASE_MS + i * 1000 + 500).toISOString(),
    message: {
      id: `a${i}`,
      role: "assistant",
      content: [{ type: "text", text: `Answer ${i}. ${"Detail sentence. ".repeat(6)}` }],
    },
  });
}
writeFileSync(LONG_FILE, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const old = new Date(Date.now() - 120000);
utimesSync(LONG_FILE, old, old);

// Probe rather than hardcode: a fixed port silently attached this suite to an
// unrelated dev server that happened to own 5188, and every run timed out
// waiting for session rows that app could never render.
// vite: the page imports web/src/runtime/omp-store.ts directly.
const webApp = await startWebApp({ base: BASE, port: 5188, vite: true });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-verify-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  // Count history requests and session revalidations off the wire.
  const historyCalls = [];
  const sessionStatuses = [];
  page.on("response", (res) => {
    const u = res.url();
    if (u.includes("/api/history")) historyCalls.push(u);
    if (u.includes("/api/sessions")) sessionStatuses.push(res.status());
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });

  // --- 1. open the long session -------------------------------------------
  // A chat opens on a short first page (FIRST_HISTORY_PAGE, 20 entries) and
  // then prefetches ONE backward page (50) once idle, anchored like any
  // scroll-up page. Wait for that page and its anchoring to settle: scrolling
  // while the anchor is still being re-asserted is undone by it.
  await page.click("[data-testid='session-row']");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid='chat-message']").length > 5, {
    timeout: 20000,
  });
  for (let i = 0; i < 100 && !historyCalls.some((u) => u.includes("before=")); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.evaluate(async () => {
    const el = document.querySelector('.chat-scroll');
    let last = -1;
    for (let stable = 0, i = 0; stable < 10 && i < 200; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      stable = el && el.scrollHeight === last ? stable + 1 : 0;
      last = el?.scrollHeight ?? -1;
    }
  });
  await new Promise((r) => setTimeout(r, 600));

  const initial = await page.evaluate(() => {
    const el = document.querySelector('.chat-scroll');
    return {
      messages: document.querySelectorAll("[data-testid='chat-message']").length,
      scrollTop: el?.scrollTop ?? -1,
      scrollHeight: el?.scrollHeight ?? -1,
      clientHeight: el?.clientHeight ?? -1,
    };
  });
  check(
    "opens with a short page plus one prefetched page, not the whole file",
    initial.messages > 0 && initial.messages <= 70,
    `${initial.messages} messages rendered of ${TURNS * 2}`,
  );
  check(
    "opens pinned to the newest message",
    Math.abs(initial.scrollHeight - initial.clientHeight - initial.scrollTop) < 8,
    `scrollTop=${initial.scrollTop} of ${initial.scrollHeight - initial.clientHeight}`,
  );

  // --- 2. scroll up: pagination + anchoring --------------------------------
  // Growth is measured on the rows themselves (scroll-content top to the
  // bottom of the newest row), not scrollHeight: the transcript's bottom
  // clearance grows once the reader leaves the bottom (room for the jump
  // button), and that is not content prepended above the viewport.
  const before = await page.evaluate(() => {
    const el = document.querySelector('.chat-scroll');
    if (!el) return null;
    el.scrollTop = 0;
    const rows = document.querySelectorAll("[data-testid='chat-message']");
    const last = rows[rows.length - 1];
    return {
      rowsHeight: last ? last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop : -1,
      messages: rows.length,
    };
  });
  await page.waitForFunction(
    (baseline) => document.querySelectorAll("[data-testid='chat-message']").length > baseline,
    { timeout: 15000 },
    before.messages,
  );
  await new Promise((r) => setTimeout(r, 600));

  const after = await page.evaluate(() => {
    const el = document.querySelector('.chat-scroll');
    const rows = document.querySelectorAll("[data-testid='chat-message']");
    const last = rows[rows.length - 1];
    return {
      messages: rows.length,
      scrollTop: el?.scrollTop ?? -1,
      rowsHeight: el && last ? last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop : -1,
    };
  });
  check(
    "scrolling up loads an older page",
    after.messages > before.messages,
    `${before.messages} -> ${after.messages} messages`,
  );
  // Anchoring: content grew above the viewport, so scrollTop must have grown
  // by the same amount. If it stayed at 0 the view jumped to the new top.
  const grew = after.rowsHeight - before.rowsHeight;
  check(
    "prepending does not move the viewport",
    grew > 0 && Math.abs(after.scrollTop - grew) < 24,
    `content grew ${grew}px, scrollTop moved to ${after.scrollTop}`,
  );
  check(
    "older pages are fetched with a before cursor",
    historyCalls.some((u) => u.includes("before=")),
    historyCalls.map((u) => u.replace(/^.*\/api\//, "/api/")).join(" | ") || "no history calls",
  );

  // --- 3. live append over the websocket -----------------------------------
  const countBefore = await page.evaluate(
    () => document.querySelectorAll("[data-testid='chat-message']").length,
  );
  appendFileSync(
    LONG_FILE,
    JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: { id: "live-append", role: "assistant", content: [{ type: "text", text: "APPENDED_LIVE" }] },
    }) + "\n",
  );
  const sawAppend = await page
    .waitForFunction(() => document.body.textContent?.includes("APPENDED_LIVE"), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("websocket delivers an append to the open session", sawAppend);
  const countAfter = await page.evaluate(
    () => document.querySelectorAll("[data-testid='chat-message']").length,
  );
  check(
    "the append does not discard paged-in history",
    countAfter >= countBefore + 1,
    `${countBefore} -> ${countAfter} messages`,
  );

  // --- 4. session list refreshes itself ------------------------------------
  await backToSessions(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 15000 });
  const rowsBefore = await page.evaluate(
    () => document.querySelectorAll("[data-testid='session-row']").length,
  );

  const newDir = `${SESSIONS}/-home-dev-Coding-fresh`;
  mkdirSync(newDir, { recursive: true });
  writeFileSync(
    `${newDir}/2026-08-12T00-00-00-000Z_019ff400-0000-7000-0000-0000000000bb.jsonl`,
    [
      { type: "session", id: "019ff400-0000-7000-0000-0000000000bb", cwd: "/home/dev/Coding/fresh", title: "Appeared without a tap" },
      { type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

  const appeared = await page
    .waitForFunction(() => document.body.textContent?.includes("Appeared without a tap"), {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false);
  check("session list picks up a new session with no user action", appeared, `${rowsBefore} rows before`);

  // Steady-state polls must be bodyless 304s; only a genuine listing change
  // costs a 200. Sampled across the whole run, not a single 5s window.
  const revalidated = sessionStatuses.filter((s) => s === 304).length;
  check(
    "listing polls are ETag-revalidated",
    revalidated > 0,
    `${sessionStatuses.length} listing requests, ${revalidated} answered 304`,
  );
  check(
    "listing polling stays bounded",
    sessionStatuses.length <= 40,
    `${sessionStatuses.length} requests over the run`,
  );

  // --- 5. optimistic echo reconciliation ------------------------------------
  // Driven through the real store module (vite serves the TS directly): the
  // send path is deliberately not exercised end to end because POST
  // /api/prompt spawns a real omp child and bills a model call.
  const echo = await page.evaluate(async () => {
    const { createOmpStore } = await import("/src/runtime/omp-store.ts");
    const store = createOmpStore();
    // Well-formed UiMessages: `parts` is required, and the store merges tool
    // parts across revisions of one message.
    store.getState().appendMessage({ id: "local:abc", role: "user", text: "warm the pool", parts: [] });
    store.getState().mergeMessages([
      { id: "u-real", role: "user", text: "warm the pool", parts: [] },
      { id: "a-real", role: "assistant", text: "on it", parts: [] },
    ]);
    const messages = store.getState().messages;
    return { texts: messages.map((m) => `${m.role}:${m.id}`), count: messages.length };
  });
  check(
    "the daemon's entry replaces the optimistic echo instead of duplicating it",
    echo.count === 2 && echo.texts[0] === "user:u-real",
    echo.texts.join(" , "),
  );

  await browser.close();
} finally {
  webApp.stop();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures);
