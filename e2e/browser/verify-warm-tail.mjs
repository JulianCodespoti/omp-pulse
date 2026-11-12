#!/usr/bin/env node
// The warm tail is alive, and the authoritative page does not cost the reader
// his place.
//
// Two bugs this file exists to keep dead. Both were in openSession:
//   1. The warm paint was disabled by a 999999ms delay constant, so opening a
//      session over Tailscale showed nothing at all until the round trip
//      finished. The cached tail had been written on every load the whole time
//      and was only ever read after the network had already failed.
//   2. The offline fallback did `await optimistic` on that same timer, so an
//      open with no daemon reachable sat blank for 16.7 minutes before showing
//      the cache and the offline state.
//
// The fix is a content latch, not a longer timer: openSession records WHAT is
// on screen and exactly WHICH content (last message id + count), and when the
// authoritative page turns out to be that same tail it adopts the page's
// cursors, ledger and markers while skipping the list write. The write is what
// costs the reader his anchor — verify-nav-paging caught the old turn-by-turn
// up-walk going 119, 118, 119, 118 when the transcript was written twice.
//
// /api/history is held back 4s here, which is the only way any of this is
// observable on loopback where the daemon answers in ~28ms.
//
// NOT observable from here, by construction: when the page equals the painted
// tail, skipping the write and doing it are identical in the DOM, and the
// socket's bundle frame merges the authoritative entries BY ID within ms of
// the open anyway, so a doctored cache heals immediately. The skip itself was
// measured with temporary in-source instrumentation: keepListIfKey === tailKey(page), no
// setHistory call. What this file pins down is everything around it.
//
// No model calls: the fixture is a session file and every check is metadata,
// paint timing or scroll geometry.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
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
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682 — it would cache a real session on this profile");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- fixture: 30 turns, 60 entries: more than the 20-entry first page of an
// open (FIRST_HISTORY_PAGE), so the idle prefetch of the page above has work.
// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-20T12:15:59.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:15:59.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const DIR = "-tmp-verify-warm-tail";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000f1.jsonl";
const TURNS = 30;
const PROBE = "STALE CACHE PROBE";

const filler = (n) =>
  Array.from(
    { length: n },
    () => "Filler text that wraps at 390px and gives this assistant turn real height on a phone.",
  ).join("\n\n");

const entries = [
  { type: "title", title: "Warm tail fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000f1", cwd: "/tmp/verify-warm-tail", title: "Warm tail fixture" },
];
for (let i = 1; i <= TURNS; i++) {
  const t = String(i).padStart(2, "0");
  const mm = String(Math.floor(i / 2)).padStart(2, "0");
  const ss = String((i * 7) % 60).padStart(2, "0");
  entries.push({
    id: `e-u-${t}`,
    type: "message",
    timestamp: shiftTs(`2026-08-20T12:${mm}:${ss}.000Z`),
    message: { id: `m-u-${t}`, role: "user", content: [{ type: "text", text: `WARM TURN ${t}` }] },
  });
  entries.push({
    id: `e-a-${t}`,
    type: "message",
    timestamp: shiftTs(`2026-08-20T12:${mm}:${String((i * 7 + 3) % 60).padStart(2, "0")}.000Z`),
    message: { id: `m-a-${t}`, role: "assistant", content: [{ type: "text", text: filler(i % 4 === 0 ? 8 : 2) }] },
  });
}

const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const fixture = `${dir}/${FILE}`;
writeFileSync(fixture, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(fixture, when, when);

const webApp = await startWebApp({ base: BASE, port: 5406 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(`${tmpdir()}/omp-warm-tail-`);
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

  // Exercise the delayed HTTP fallback with a real socket that does not
  // negotiate bundle history. Otherwise a fast bundle wins before the warm
  // timer, and delaying /api/history proves nothing about cached painting.
  await page.evaluateOnNewDocument(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        const endpoint = new URL(url, location.href);
        if (endpoint.pathname === "/ws") {
          endpoint.searchParams.set("caps", (endpoint.searchParams.get("caps") || "")
            .split(",").filter((cap) => cap !== "bundle").join(","));
        }
        super(endpoint, protocols);
      }
    };
  });
  // Every backward read is held while the delay is set: the opening tail page
  // and the idle prefetch of the page above it (LoadEarlier, a `before=` read
  // that follows the tail page at once). Holding the prefetch keeps the parked
  // reader's measurements about the authoritative page alone.
  let historyDelayMs = 0;
  let tailResponses = 0;
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const isTail = req.url().includes("/api/history") && !req.url().includes("after=");
    if (isTail) {
      if (historyDelayMs > 0) await sleep(historyDelayMs);
    }
    try {
      await req.continue();
    } catch {}
  });
  // Only the opening tail page (no cursor) counts as "the page landed";
  // `before=` reads are the pages above it.
  let earlierResponses = 0;
  page.on("response", (res) => {
    const url = res.url();
    if (!url.includes("/api/history") || url.includes("after=")) return;
    if (url.includes("before=")) earlierResponses++;
    else tailResponses++;
  });

  const rendered = () => page.evaluate(() => document.querySelectorAll("[data-entry-id]").length);
  const hasProbe = (probe) =>
    page.evaluate((p) => (document.querySelector(".chat-scroll")?.textContent ?? "").includes(p), probe);
  // The ONE offline indicator: a status line above the transcript. The header
  // no longer carries connection words.
  const offlineHint = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-testid='chat-offline-hint']");
      return {
        text: el ? (el.textContent || "").trim() : null,
        role: el ? el.getAttribute("role") : null,
        header: (document.querySelector("[data-testid='session-back']")?.closest("header")?.textContent ?? "").toLowerCase(),
      };
    });
  // The VIEW, not the raw offset. The authoritative page legitimately reveals
  // the Load-earlier control above the reader, which moves scrollTop while
  // keeping the same content under his eyes — so the assertion is "same turn,
  // same distance from the top of the scroller", the way verify-nav-paging
  // measures landings.
  const viewState = () =>
    page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      if (!(el instanceof HTMLElement)) return null;
      const top = el.getBoundingClientRect().top;
      let first = null;
      for (const row of document.querySelectorAll("[data-entry-id]")) {
        const m = (row.textContent || "").match(/WARM TURN (\d+)/);
        if (!m) continue;
        const off = row.getBoundingClientRect().top - top;
        if (off > -40 && (first === null || off < first.off)) first = { turn: +m[1], off: Math.round(off) };
      }
      return {
        scrollTop: Math.round(el.scrollTop),
        count: document.querySelectorAll("[data-entry-id]").length,
        first,
      };
    });
  const openRow = async () => {
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
      const t = rows.find((r) => (r.textContent || "").includes("Warm tail")) || rows[0];
      if (t instanceof HTMLElement) t.click();
    });
  };
  const backToList = async () => {
    await backToSessions(page);
    await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
    await sleep(400);
  };
  // Tap to first rendered transcript row. Polled rather than slept: the whole
  // point of the warm paint is WHEN it happens.
  const timeToPaint = async (budgetMs) => {
    const t0 = Date.now();
    await openRow();
    for (let i = 0; i < budgetMs / 25; i++) {
      if ((await rendered()) > 0) return Date.now() - t0;
      await sleep(25);
    }
    return Infinity;
  };
  // No version argument: open whatever version the app created (offline-cache.ts
  // DB_VERSION). Pinning 1 failed with VersionError once the schema moved on,
  // which read as "the open wrote no cache".
  const readCache = () =>
    page.evaluate(
      () =>
        new Promise((res) => {
          const rq = indexedDB.open("omp-pulse-offline");
          rq.onsuccess = () => {
            const all = rq.result.transaction("history", "readonly").objectStore("history").getAll();
            all.onsuccess = () => {
              const rec = all.result[0];
              res(rec ? { count: rec.messages.length, lastId: rec.messages[rec.messages.length - 1]?.id } : null);
            };
            all.onerror = () => res(null);
          };
          rq.onerror = () => res(null);
        }),
    );
  // Rewrite the cached tail so its (lastMessageId, count) cannot match the
  // authoritative page: keep the three OLDEST messages and stamp a probe into
  // one of them, so "the cache is on screen" is distinguishable from "the page
  // is on screen" for the mismatching case.
  const staleCache = (probe) =>
    page.evaluate(
      (p) =>
        new Promise((res) => {
          const rq = indexedDB.open("omp-pulse-offline");
          rq.onsuccess = () => {
            const db = rq.result;
            const rd = db.transaction("history", "readonly").objectStore("history").getAll();
            rd.onsuccess = () => {
              const rec = rd.result[0];
              if (!rec || rec.messages.length < 5) return res(null);
              rec.messages = rec.messages.slice(0, 3);
              rec.messages[0] = { ...rec.messages[0], text: p, parts: [{ kind: "text", text: p }] };
              const wr = db.transaction("history", "readwrite").objectStore("history").put(rec);
              wr.onsuccess = () => res(rec.messages.length);
              wr.onerror = () => res(null);
            };
            rd.onerror = () => res(null);
          };
          rq.onerror = () => res(null);
        }),
      probe,
    );

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await sleep(500);

  // No cached history exists on the first open. The HTTP fallback must paint
  // the authoritative page and persist it for the following warm openings.
  const coldPaint = await timeToPaint(20000);
  await page.waitForSelector("[data-testid='jump-next']", { timeout: 20000 });
  for (let i = 0; i < 200 && earlierResponses === 0; i++) await sleep(100);
  await sleep(1500); // let saveTail land
  // The cold open's whole window: the first page plus the page the idle
  // prefetch adds above it.
  const authoritativeRows = await rendered();
  check(
    "cold open paints the authoritative page",
    authoritativeRows > 0 && coldPaint < 5000,
    `${authoritativeRows} rows in ${coldPaint}ms`,
  );
  const cached = await readCache();
  check("the open wrote a cached tail", !!cached && cached.count > 0, `cache=${JSON.stringify(cached)}`);

  // --- warm open on a slow network. The cache now holds exactly what the page
  // will return, which is the case the content latch exists for.
  await backToList();
  historyDelayMs = 4000;
  const resBefore = tailResponses;
  const warmPaint = await timeToPaint(20000);
  check(
    "the cached tail paints while the page is still in flight",
    warmPaint < 900 && tailResponses === resBefore,
    `paint=${warmPaint}ms, page already back=${tailResponses !== resBefore}`,
  );
  // Park the reader mid-list and let layout settle BEFORE the page lands, so
  // the comparison measures the page's effect and not lazy markdown reflow.
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    if (el instanceof HTMLElement) el.scrollTop = Math.round(el.scrollHeight * 0.45);
  });
  await sleep(1200);
  const parked = await viewState();
  for (let i = 0; i < 300 && tailResponses === resBefore; i++) await sleep(50);
  await sleep(1800);
  const after = await viewState();
  check(
    "the parked reader keeps the same content in view",
    !!parked &&
      !!after &&
      after.first?.turn === parked.first?.turn &&
      Math.abs((after.first?.off ?? 0) - (parked.first?.off ?? 0)) <= 12,
    `turn ${parked?.first?.turn}@${parked?.first?.off}px -> ${after?.first?.turn}@${after?.first?.off}px (scrollTop ${parked?.scrollTop}->${after?.scrollTop})`,
  );
  check(
    "the transcript window is unchanged by the authoritative page",
    !!parked && !!after && after.count === parked.count,
    `${parked?.count} -> ${after?.count} rows`,
  );
  // Load-bearing: the skipped list write must NOT skip the page's cursors. If
  // historyCursor and the page ledger were dropped with it, scroll-up paging
  // would silently die and catch-up would refetch from offset 0. Scrolling to
  // the top is the only paging gesture: the LoadEarlier sentinel fetches the
  // next page by cursor.
  historyDelayMs = 0;
  const beforePaging = await rendered();
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      if (!(el instanceof HTMLElement)) return;
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      el.scrollTop = 0;
    });
    await sleep(500);
  }
  await sleep(1500);
  const afterPaging = await rendered();
  check(
    "the warm open still adopted the page cursors (scrolling to the top pages in)",
    afterPaging > beforePaging,
    `${beforePaging} -> ${afterPaging} rows`,
  );

  // --- stale cache. A tail whose key does not match must still paint warm,
  // then converge on the authoritative window: the latch skips a write, it
  // never suppresses one that is needed.
  await backToList();
  const staleCount = await staleCache(PROBE);
  check("cache replaced with a mismatching tail", staleCount === 3, `${staleCount} cached messages`);
  historyDelayMs = 4000;
  const resBeforeStale = tailResponses;
  const stalePaint = await timeToPaint(20000);
  const staleRows = await rendered();
  const probeOnPaint = await hasProbe(PROBE);
  check(
    "the stale tail paints warm too",
    stalePaint < 900 && staleRows === 3 && probeOnPaint,
    `paint=${stalePaint}ms with ${staleRows} rows, probe=${probeOnPaint}`,
  );
  for (let i = 0; i < 300 && tailResponses === resBeforeStale; i++) await sleep(50);
  // A cold open's window includes the idle prefetch, so release it once the
  // page has landed and give it the time a loaded machine needs.
  historyDelayMs = 0;
  let staleAfterRows = 0;
  let probeAfter = true;
  for (let i = 0; i < 50 && (probeAfter || staleAfterRows !== authoritativeRows); i++) {
    await sleep(200);
    staleAfterRows = await rendered();
    probeAfter = await hasProbe(PROBE);
  }
  check(
    "a mismatching tail converges on the authoritative window",
    !probeAfter && staleAfterRows === authoritativeRows,
    `probe still present=${probeAfter}, ${staleRows} -> ${staleAfterRows} rows (cold open: ${authoritativeRows})`,
  );

  // --- offline open. The cached tail plus the offline state, promptly. This is
  // the 16.7-minute stall: under the old catch arm this screen stayed blank.
  historyDelayMs = 0;
  await backToList();
  await page.setOfflineMode(true);
  const t0 = Date.now();
  await openRow();
  let offlineRows = 0;
  let hint = { text: null, role: null, header: "" };
  for (let i = 0; i < 120; i++) {
    offlineRows = await rendered();
    hint = await offlineHint();
    if (offlineRows > 0 && hint.text && /saved copy/i.test(hint.text)) break;
    await sleep(50);
  }
  const offlineMs = Date.now() - t0;
  check(
    "offline open shows the cached tail promptly",
    offlineRows > 0 && offlineMs < 4000,
    `${offlineRows} rows in ${offlineMs}ms`,
  );
  check(
    "offline open names the cause and says it is showing a saved copy",
    hint.role === "status" &&
      /^((Can.t reach [^·]*|You.re offline|Connecting…) · saved copy|Showing a saved copy)(Retry|Retrying…)?$/.test(hint.text ?? ""),
    `hint="${hint.text}" role=${hint.role}`,
  );
  check(
    "the header stays quiet about connection state",
    !/\b(offline|reconnecting|connected)\b/.test(hint.header),
    `header="${hint.header.slice(0, 80)}"`,
  );
  await page.setOfflineMode(false);

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join("; ") || "none");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}

process.exit(failures === 0 ? 0 : 1);
