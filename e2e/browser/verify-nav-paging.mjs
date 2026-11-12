#!/usr/bin/env node
// Regression proof for history paging and the way back to the live edge.
// Scrolling to the top of what is loaded is the paging gesture (LoadEarlier's
// sentinel fetches the next page by cursor); the jump control (`jump-nav`:
// one Down button, tap or hold for the latest) is the way back down.
//
// The original report was about the old Up button: "when I click up
// and it hasn't paginated, then it sometimes will stall for a while. Maybe it
// will go up, maybe it won't." The invariants behind it still hold here:
//   1. Reaching the top of the loaded window always pages in earlier history,
//      all the way to the first message, and then stops asking.
//   2. A page lands ABOVE the reader: the row under their eyes does not move
//      (no jump), across every page seam.
//   3. One page is fetched once — no duplicate request for the same page —
//      and a page never stalls.
//   4. Loading is visible while a page is in flight.
//   5. Away from the live edge, the jump control is shown and counts rows
//      that arrive meanwhile without moving the reader; holding it returns
//      to the live edge and fades the control out again.
//
// The verify-nav fixture has ~24 entries — under the 50-row page limit — so
// it never paginates and never exercises any of this.

import { mkdirSync, writeFileSync, appendFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { backToSessions, showSessionsList } from "../lib/chat-nav.mjs";
import { JUMP_TO_LATEST } from "../lib/jump-latest.mjs";


import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-nav-paging.mjs");
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

// --- fixture: 40 user turns, far more than one 50-entry page ----------------
// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates age out of the list.
// Offsets relative to 2026-08-20T13:00:03.000Z are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T13:00:03.000Z");
const ts = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();
// Minute 60 (turn 120) is past 12:59; Date.UTC normalises it instead of yielding an invalid date.
const at = (mm, ss) => new Date(Date.UTC(2026, 7, 20, 12, mm, ss) + SHIFT_MS).toISOString();

const DIR = "-tmp-verify-nav-paging";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000d1.jsonl";
const TURNS = 120;

const filler = (n) =>
  Array.from(
    { length: n },
    () => "Filler text that wraps at 390px and gives this assistant turn real height on a phone.",
  ).join("\n\n");

const entries = [
  { type: "title", title: "Nav paging fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000d1", cwd: "/tmp/verify-nav-paging", title: "Nav paging fixture" },
];
for (let i = 1; i <= TURNS; i++) {
  const t = String(i).padStart(2, "0");
  const mm = String(Math.floor(i / 2)).padStart(2, "0");
  const ss = String((i * 7) % 60).padStart(2, "0");
  entries.push({
    id: `e-u-${t}`,
    type: "message",
    timestamp: at(Number(mm), Number(ss)),
    message: { id: `m-u-${t}`, role: "user", content: [{ type: "text", text: `PAGING TURN ${t}` }] },
  });
  entries.push({
    id: `e-a-${t}`,
    type: "message",
    timestamp: at(Number(mm), (i * 7 + 3) % 60),
    message: { id: `m-a-${t}`, role: "assistant", content: [{ type: "text", text: filler(i % 4 === 0 ? 8 : 2) }] },
  });
}

const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const fixture = `${dir}/${FILE}`;
writeFileSync(fixture, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(fixture, when, when);

const webApp = await startWebApp({ base: BASE, port: 5206 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-nav-paging-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // Count history fetches so a double-load is detectable.
  const historyCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/history")) historyCalls.push(r.url());
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Nav paging")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='jump-next']", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadedRows = () =>
    page.evaluate(() => document.querySelectorAll("[data-entry-id]").length);
  const hasRow = (re) =>
    page.evaluate(
      (src) => Array.from(document.querySelectorAll("[data-entry-id]")).some((r) => new RegExp(src).test(r.textContent || "")),
      re.source,
    );

  // The topmost row in view and its offset from the scroller's top edge.
  const topRow = () =>
    page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      const top = el.getBoundingClientRect().top;
      for (const r of Array.from(document.querySelectorAll("[data-entry-id]"))) {
        const off = r.getBoundingClientRect().top - top;
        if (off >= -1) return { id: r.getAttribute("data-entry-id"), off: Math.round(off) };
      }
      return null;
    });
  const offsetOf = (id) =>
    page.evaluate((id) => {
      const el = document.querySelector(".chat-scroll");
      const row = document.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
      return row ? Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top) : null;
    }, id);

  const latest = () =>
    page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      const btn = document.querySelector("[data-testid='jump-next']");
      const rows = Array.from(document.querySelectorAll("[data-entry-id]"));
      const last = rows[rows.length - 1];
      const sr = el.getBoundingClientRect();
      const lr = last ? last.getBoundingClientRect() : null;
      return {
        ariaHidden: btn ? btn.getAttribute("aria-hidden") : null,
        ariaBusy: btn ? btn.getAttribute("aria-busy") : null,
        label: btn ? btn.getAttribute("aria-label") : null,
        count: document.querySelector("[data-testid='latest-messages-count']")?.textContent?.trim() ?? null,
        gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop),
        lastText: last ? (last.textContent || "").trim().slice(0, 40) : null,
        lastInView: !!lr && lr.bottom <= sr.bottom + 2 && lr.bottom > sr.top,
      };
    });

  // A page is done when nothing is loading and the row count and scroll
  // offset have held still for a few polls.
  const pageSettled = async (budgetMs = 8000) => {
    const t0 = Date.now();
    let last = "";
    let stable = 0;
    while (Date.now() - t0 < budgetMs) {
      const s = await page.evaluate(() => {
        const el = document.querySelector(".chat-scroll");
        const loading = Array.from(document.querySelectorAll("[role='status']")).some((n) =>
          (n.textContent || "").includes("Loading earlier messages"),
        );
        return `${loading}|${document.querySelectorAll("[data-entry-id]").length}|${Math.round(el.scrollTop)}`;
      });
      stable = s === last && s.startsWith("false|") ? stable + 1 : 0;
      last = s;
      if (stable >= 3) break;
      await sleep(150);
    }
    return Date.now() - t0;
  };

  // The loading pill can be on screen for a single frame on loopback; watch
  // the DOM for it instead of polling.
  await page.evaluate(() => {
    window.__sawLoadingEarlier = false;
    new MutationObserver(() => {
      if (window.__sawLoadingEarlier) return;
      const hit = Array.from(document.querySelectorAll("[role='status']")).some((n) =>
        (n.textContent || "").includes("Loading earlier messages"),
      );
      if (hit) window.__sawLoadingEarlier = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  // --- 1-4: scroll to the top of what is loaded until the first message ----
  const startRows = await loadedRows();
  const callsBefore = historyCalls.length;
  const drifts = [];
  let maxPage = 0;
  let reachedFirst = await hasRow(/PAGING TURN 01\b/);
  for (let i = 0; i < 14 && !reachedFirst; i++) {
    const t0 = Date.now();
    // Scroll and record the row under the reader in the same task, before the
    // sentinel's observer can fire and prepend anything.
    const anchor = await page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
      el.scrollTop = 0;
      const top = el.getBoundingClientRect().top;
      for (const r of Array.from(document.querySelectorAll("[data-entry-id]"))) {
        const off = r.getBoundingClientRect().top - top;
        if (off >= -1) return { id: r.getAttribute("data-entry-id"), off: Math.round(off) };
      }
      return null;
    });
    await sleep(300);
    await pageSettled();
    maxPage = Math.max(maxPage, Date.now() - t0);
    if (anchor) {
      const after = await offsetOf(anchor.id);
      drifts.push(after === null ? Infinity : Math.abs(after - anchor.off));
    }
    reachedFirst = await hasRow(/PAGING TURN 01\b/);
  }
  const endRows = await loadedRows();
  const pageCalls = historyCalls.slice(callsBefore);
  const duplicateCalls = pageCalls.length - new Set(pageCalls).size;
  const sawLoading = await page.evaluate(() => window.__sawLoadingEarlier === true);

  check(
    "scrolling to the top pages in earlier history down to the first message",
    endRows > startRows && reachedFirst,
    `${startRows} -> ${endRows} rendered entries, ${pageCalls.length} history request(s), first message rendered=${reachedFirst}`,
  );
  check(
    "every page lands above the reader: the row in view never moves",
    drifts.length > 0 && drifts.every((d) => d <= 4),
    `drift per page=[${drifts.join(",")}]px`,
  );
  check(
    "no page was fetched twice",
    duplicateCalls === 0,
    `${duplicateCalls} duplicate request(s) among ${pageCalls.length}`,
  );
  check("no page stalled", maxPage < 6000, `slowest page=${maxPage}ms`);
  check("a loading indicator showed while a page was in flight", sawLoading);

  // At the first message there is nothing left to ask for.
  const callsAtFirst = historyCalls.length;
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
    el.scrollTop = 0;
  });
  await sleep(1500);
  check(
    "at the first message scrolling up requests nothing more",
    historyCalls.length === callsAtFirst,
    `${historyCalls.length - callsAtFirst} extra request(s)`,
  );

  // --- 5: jump to latest from the far end -----------------------------------
  // User turns sit below the reader, so the control steps to the next one on a
  // tap and goes to the latest on a hold; its label says both.
  const away = await latest();
  check(
    "far from the live edge the jump button is shown without a count",
    away.ariaHidden === "false" && away.label === "Jump to latest" && away.count === null,
    JSON.stringify(away),
  );

  // New rows while the reader is away: the daemon's watcher forwards appended
  // entries as live ones. They are counted, and the reader stays put.
  const LIVE = 3;
  const live = [];
  for (let i = 1; i <= LIVE; i++) {
    live.push({ id: `live-u-${i}`, type: "message", timestamp: at(61, i * 2), message: { id: `live-mu-${i}`, role: "user", content: [{ type: "text", text: `LIVE TURN ${i}` }] } });
    live.push({ id: `live-a-${i}`, type: "message", timestamp: at(61, i * 2 + 1), message: { id: `live-ma-${i}`, role: "assistant", content: [{ type: "text", text: `Live reply ${i}.` }] } });
  }
  const readerBefore = await topRow();
  appendFileSync(fixture, live.map((e) => JSON.stringify(e)).join("\n") + "\n");
  let counted = await latest();
  for (let i = 0; i < 60 && counted.count !== `${live.length} new`; i++) {
    await sleep(250);
    counted = await latest();
  }
  await sleep(600);
  counted = await latest();
  const readerAfter = readerBefore ? await offsetOf(readerBefore.id) : null;
  check(
    "rows arriving while away are counted on the jump button",
    counted.count === `${live.length} new` && counted.label === `Jump to latest, ${live.length} new` && counted.ariaHidden === "false",
    JSON.stringify(counted),
  );
  check(
    "arrivals never pull the reader away from what they are reading",
    !!readerBefore && readerAfter !== null && Math.abs(readerAfter - readerBefore.off) <= 4,
    `row ${readerBefore?.id} ${readerBefore?.off}px -> ${readerAfter}px`,
  );

  const tJump = Date.now();
  await page.evaluate(JUMP_TO_LATEST);
  let jumped = await latest();
  for (let i = 0; i < 40 && (jumped.ariaBusy === "true" || jumped.gap > 8); i++) {
    await sleep(150);
    jumped = await latest();
  }
  const jumpMs = Date.now() - tJump;
  await sleep(800);
  jumped = await latest();
  check(
    "jump to latest returns to the live edge and shows the newest row",
    jumped.gap >= 0 && jumped.gap <= 8 && jumped.lastInView && /Live reply 3/.test(jumped.lastText ?? ""),
    `${jumpMs}ms, ${JSON.stringify(jumped)}`,
  );
  check(
    "at the live edge the button fades out and the count clears",
    jumped.ariaHidden === "true" && jumped.ariaBusy !== "true" && jumped.count === null,
    JSON.stringify(jumped),
  );

  // --- 6: reopening a chat re-reads no history ------------------------------
  // The reopen is the path a phone takes constantly and its cost is invisible
  // (data use, not a stall): the cached tail paints while the socket bundle is
  // in flight, and whichever of the two lands first serves the first screen.
  // Measured: the FIRST open of a 2,600-entry chat costs one 35 KB tail GET; a
  // reopen costs zero when the bundle wins (the live app) and at most one
  // bounded tail when the HTTP fallback wins (here). What must never come back
  // is the paged walk — 4 requests and 240 entries to show what the reader
  // already had.
  await backToSessions(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await sleep(600);
  const beforeReopen = historyCalls.length;
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Nav paging")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-entry-id]", { timeout: 20000 });
  await sleep(1500);
  const reopened = await page.evaluate(() => ({
    rows: document.querySelectorAll("[data-entry-id]").length,
    newest: Array.from(document.querySelectorAll("[data-entry-id]")).at(-1)?.textContent?.trim().slice(0, 30) ?? null,
  }));
  const reopenedCalls = historyCalls.length - beforeReopen;
  check(
    "reopening a chat never re-walks its history",
    reopenedCalls <= 1,
    `${reopenedCalls} request(s) (one bounded tail is the fallback; the up-walk took 4)`,
  );
  check(
    "the reopened chat paints its transcript without paging",
    reopened.rows > 0 && /Live reply 3/.test(reopened.newest ?? ""),
    JSON.stringify(reopened),
  );

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join("; ") || "none");
  await browser.close();
} finally {
  webApp.stop();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
