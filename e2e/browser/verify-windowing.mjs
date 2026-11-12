#!/usr/bin/env node
// Regression proof for transcript windowing: the phone holds a WINDOW into the
// session file, not the file.
//
// Fixture: 300 turns (600 messages) against a 400-message cap, so paging to
// the top must evict, the jump pill must count the dropped tail, returning to
// the bottom must read the dropped span back by cursor, and the evicted span
// must reload by cursor.
//
// Covers, in order:
//   1. Paging up past the cap keeps rows bounded (far-end eviction).
//   2. Bottom-evicted rows surface in the jump pill while scrolled up.
//   3. Returning home slides the window forward by cursor: no hole, no
//      tail reseed, rows capped (LoadLater).
//   4. Live growth at the bottom sheds the oldest pages (top eviction).
//   5. Scrolling back to the top reloads the evicted span by cursor, on its
//      own: there is no placeholder to press (ChatScreen, LoadEarlier).
//   6. Jump-to-latest reseeds from the tail (no middle gap, evictions clear).

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { JUMP_TO_LATEST } from "../lib/jump-latest.mjs";


import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-windowing.mjs");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- fixture: 300 turns = 600 messages, over the 400-message window --------
// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-20T13:00:01.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T13:00:01.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const DIR = "-tmp-verify-windowing";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000d2.jsonl";
const TURNS = 300;

const entries = [
  { type: "title", title: "Windowing fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000d2", cwd: "/tmp/verify-windowing", title: "Windowing fixture" },
];
for (let i = 1; i <= TURNS; i++) {
  const t = String(i).padStart(3, "0");
  entries.push({
    id: `w-e-u-${t}`,
    type: "message",
    timestamp: shiftTs(`2026-08-20T12:00:00.000Z`),
    message: { id: `w-m-u-${t}`, role: "user", content: [{ type: "text", text: `WINDOWING TURN ${t}` }] },
  });
  entries.push({
    id: `w-e-a-${t}`,
    type: "message",
    timestamp: shiftTs(`2026-08-20T12:00:01.000Z`),
    message: { id: `w-m-a-${t}`, role: "assistant", content: [{ type: "text", text: `Reply ${t}: steady-state text with no surprises.` }] },
  });
}

const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const fixture = `${dir}/${FILE}`;
writeFileSync(fixture, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(fixture, when, when);

const webApp = await startWebApp({ base: BASE, port: 5216 });

const profile = mkdtempSync(`${tmpdir()}/omp-windowing-`);
try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const rows = () => page.evaluate(() => document.querySelectorAll("[data-testid='chat-message']").length);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The fixture turns on screen (live turns appended later number on from
  // TURNS): the oldest, the newest, and whether every turn between them is
  // there (a window with nothing missing from its middle).
  const span = () =>
    page.evaluate((base) => {
      const turns = Array.from(document.querySelectorAll("[data-testid='chat-message']"))
        .map((el) => /(WINDOWING|LIVE) TURN (\d+)/.exec(el.textContent || ""))
        .filter(Boolean)
        .map((m) => (m[1] === "LIVE" ? base : 0) + Number(m[2]));
      if (turns.length === 0) return { oldest: null, newest: null, contiguous: false };
      const oldest = Math.min(...turns);
      const newest = Math.max(...turns);
      return { oldest, newest, contiguous: new Set(turns).size === newest - oldest + 1 };
    }, TURNS);
  // Shown only for a span dropped with no reload cursor (trimmedTop).
  const trimmedShown = () =>
    page.evaluate(() => (document.body.textContent || "").includes("trimmed to save memory"));
  let earlierReads = 0;
  let forwardReads = 0;
  let tailReads = 0;
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("/api/history")) return;
    if (url.includes("before=")) earlierReads++;
    else if (url.includes("after=")) forwardReads++;
    else tailReads++;
  });
  // The jump-to-latest count chip ("N new", 99+ cap); null when nothing is counted.
  const pillText = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-testid='latest-messages-count']");
      return el ? (el.textContent || "").trim() : null;
    });
  const jumpLabel = () =>
    page.evaluate(() => document.querySelector("[data-testid='jump-next']")?.getAttribute("aria-label") ?? null);
  // How a reader leaves the live edge: an upward wheel (or touch) gesture,
  // which the transcript viewport (transcript-viewport.tsx) always takes as
  // escaping its bottom lock. A bare programmatic scrollTo is ignored as an
  // escape while content is resizing (live growth, a prepended page), and the
  // lock then pulls the view back to the bottom, where a dropped tail reseeds
  // the window.
  const scrollToTop = () =>
    page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      if (!el) return;
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      el.scrollTo({ top: 0 });
    });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = els.find((r) => (r.textContent || "").includes("Windowing fixture")) || els[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='jump-next']", { timeout: 20000 });
  await sleep(1500);

  // An open shows a short first page (FIRST_HISTORY_PAGE, 20) and the idle
  // prefetch adds one page above it (HISTORY_PAGE, 50): never the whole file.
  const initial = await rows();
  check("tail opens bounded (first page plus one prefetched page)", initial > 0 && initial <= 70, `rows=${initial}`);


  // Page to the very top: the window must hold the oldest 400 while the
  // dropped 200-newest surface in the jump pill.
  let last = initial;
  let stable = 0;
  for (let i = 0; i < 20 && stable < 2; i++) {
    await scrollToTop();
    await sleep(900);
    const n = await rows();
    if (n === last) stable++;
    else stable = 0;
    last = n;
  }
  check("deep scrollback stays capped", last <= 430, `rows=${last}`);
  const pillUp = await pillText();
  check("dropped tail counted in the jump pill", pillUp !== null && /^(\d+|99\+) new$/.test(pillUp), `pill=${pillUp}`);
  const labelUp = await jumpLabel();
  check(
    "the jump button announces the count",
    !!labelUp && /^Jump to latest, \d+ new$/.test(labelUp),
    `aria-label=${labelUp}`,
  );

  // Scroll home with a dropped tail: the window reads the dropped span back by
  // cursor as the reader nears it (the mirror of paging up), rather than
  // swapping every row for a fresh tail, which read as the bottom loading in
  // again. The reader never meets a hole, and rows stay bounded throughout.
  const readsBeforeHome = { tail: tailReads, forward: forwardReads };
  let homeRows = 0;
  let homeMax = 0;
  let homeContiguous = true;
  for (let i = 0; i < 25; i++) {
    await page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      if (!el) return;
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true }));
      el.scrollTo({ top: el.scrollHeight });
    });
    await sleep(700);
    homeRows = await rows();
    homeMax = Math.max(homeMax, homeRows);
    const s = await span();
    if (!s.contiguous) homeContiguous = false;
    if ((await pillText()) === null && s.newest === TURNS) break;
  }
  const home = await span();
  check("returning home slides forward by cursor, with no tail reseed", forwardReads > readsBeforeHome.forward && tailReads === readsBeforeHome.tail, `forward reads +${forwardReads - readsBeforeHome.forward}, tail reads +${tailReads - readsBeforeHome.tail}`);
  check("returning home reaches the live edge and clears the pill", home.newest === TURNS && (await pillText()) === null, JSON.stringify(home));
  check("the window never shows a hole on the way home and stays capped", homeContiguous && homeMax <= 430, `max rows=${homeMax}, contiguous=${homeContiguous}`);

  // Page up until ~350 rows are held (under the 400 cap): nothing may evict.
  // (Adaptive, not a fixed page count: the scroll listener can fire an extra
  // prefetch while the thread settles.)
  let paged = await rows();
  for (let i = 0; i < 10 && paged < 340; i++) {
    await scrollToTop();
    await sleep(900);
    paged = await rows();
  }
  check("paging loads history", paged > 300, `rows=${paged}`);
  check("window holds under the cap", paged <= 400, `rows=${paged}`);
  const stateLine = async () =>
    `rows=${await rows()} span=${JSON.stringify(await span())} trimmed=${await trimmedShown()} pill=${await pillText()}`;
  const held = await span();
  check(
    "under-cap paging evicts nothing",
    held.contiguous && held.newest === TURNS && !(await trimmedShown()) && (await pillText()) === null,
    await stateLine(),
  );

  // Scroll home with nothing evicted: the window holds, no reseed.
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    if (el) el.scrollTo({ top: el.scrollHeight });
  });
  await sleep(1200);
  check("returning home holds the window", (await rows()) === paged, await stateLine());
  // Append 150 entries straight to the session file: the daemon watcher
  // forwards them as live entries, so growth past the cap at the live edge
  // must shed the oldest whole pages (evictedTop, reloadable by cursor).
  const oldestHeld = held.oldest;
  const { appendFileSync } = await import("fs");
  const extra = [];
  for (let i = 1; i <= 75; i++) {
    const t = String(i).padStart(3, "0");
    extra.push({ id: `w2-e-u-${t}`, type: "message", timestamp: shiftTs("2026-08-20T13:00:00.000Z"), message: { id: `w2-m-u-${t}`, role: "user", content: [{ type: "text", text: `LIVE TURN ${t}` }] } });
    extra.push({ id: `w2-e-a-${t}`, type: "message", timestamp: shiftTs("2026-08-20T13:00:01.000Z"), message: { id: `w2-m-a-${t}`, role: "assistant", content: [{ type: "text", text: `Live reply ${t}.` }] } });
  }
  appendFileSync(fixture, extra.map((e) => JSON.stringify(e)).join("\n") + "\n");
  let grown = await span();
  for (let i = 0; i < 25 && !(grown.oldest > oldestHeld); i++) {
    await sleep(800);
    grown = await span();
  }
  check("live growth past the cap evicts the top", grown.oldest > oldestHeld, `oldest turn ${oldestHeld} -> ${grown.oldest}`);
  const capped = await rows();
  check("window stays capped under live growth", capped <= 430, `rows=${capped}`);

  // Reload the evicted span by cursor. A real reader scrolls back to the top
  // and the span loads by itself as he nears it (LoadEarlier calls
  // reloadEvictedTop): there is nothing to press. The window then slides,
  // dropping the live tail into the pill.
  const readsBefore = earlierReads;
  let back = grown;
  for (let i = 0; i < 20 && !(back.oldest <= oldestHeld); i++) {
    await scrollToTop();
    await sleep(900);
    back = await span();
  }
  check(
    "scrolling to the top reloads the evicted span by cursor",
    back.oldest !== null && back.oldest <= oldestHeld && earlierReads > readsBefore,
    `oldest turn ${grown.oldest} -> ${back.oldest} (evicted from ${oldestHeld}), before= reads ${earlierReads - readsBefore}`,
  );
  await sleep(1500);
  // Sliding window: the span returns up top while the same count leaves
  // from the live tail, so rows stay capped and the pill takes over.
  check("window stays capped across reload", (await rows()) <= 430, await stateLine());
  check("slid window counts the tail in the pill", (await pillText()) !== null, await stateLine());

  // Jump to latest reseeds the window from anywhere: bounded tail, eviction
  // state clear, reader on the live edge with the button faded out.
  const beforeJump = await page.evaluate(() => document.querySelector("[data-testid='jump-next']")?.getAttribute("aria-hidden") ?? null);
  check("away from the live edge the jump button is shown", beforeJump === "false", `aria-hidden=${beforeJump}`);
  await page.evaluate(JUMP_TO_LATEST);
  // Wait for the landing the way a reader does: until the view sits on the
  // live edge with the button faded out, or 12 s. The gaps on the way down are
  // recorded, so a view that stops short reads differently from a slow one.
  const edgeNow = () =>
    page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      const btn = document.querySelector("[data-testid='jump-next']");
      return {
        gap: el instanceof HTMLElement ? Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) : -1,
        hidden: btn ? btn.getAttribute("aria-hidden") : null,
      };
    });
  const jumpedAt = Date.now();
  const gaps = [];
  let edge = await edgeNow();
  while (!(edge.gap >= 0 && edge.gap <= 8 && edge.hidden === "true") && Date.now() - jumpedAt < 12_000) {
    if (gaps.at(-1) !== edge.gap) gaps.push(edge.gap);
    await sleep(250);
    edge = await edgeNow();
  }
  const landedMs = Date.now() - jumpedAt;
  await sleep(500);
  const reseeded = await rows();
  const tail = await span();
  const evictionClear = (await pillText()) === null && !(await trimmedShown());
  check("jump-to-latest reseeds a bounded tail", reseeded <= 120, `rows=${reseeded}`);
  check(
    "reseed clears eviction state",
    evictionClear && tail.contiguous && tail.newest === TURNS + 75,
    `pill and trimmed note gone=${evictionClear}, span=${JSON.stringify(tail)}`,
  );
  check(
    "jump-to-latest lands on the live edge and hides the button",
    edge.gap >= 0 && edge.gap <= 8 && edge.hidden === "true",
    JSON.stringify({ ...edge, afterMs: landedMs, gapsOnTheWay: gaps.slice(0, 12) }),
  );

  check("no page errors during windowing", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
