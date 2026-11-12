#!/usr/bin/env node
// Regression proof that the jump control (`jump-next`: a tap or a hold goes
// to the latest message) lands accurately.
// Runs under e2e/with-test-daemon.sh against a throwaway vite dev server.
//
// Fixture: 12 user turns with deliberately uneven assistant heights so
// `content-visibility:auto` estimated heights are wrong over long jumps: a
// jump from the oldest turn must still end exactly on the newest row and stay
// there, the button must be inert at the live edge and real away from it, and
// a wheel during the jump must hand control back. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
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
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-nav.mjs");
  process.exit(2);
}
if (/^http:\/\/127\.0\.0\.1:7682/.test(BASE) || BASE.includes("7682")) {
  console.error("refusing to run against live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
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

// ---------------------------------------------------------------------------
// Fixture: 12 user turns with wildly varying assistant heights
// ---------------------------------------------------------------------------
function longParagraphs(n) {
  const line = "This is a line of filler text to increase the rendered height of this assistant turn. It repeats to form a paragraph that will wrap and consume vertical space at 390px.";
  return Array.from({ length: n }, () => line).join("\n\n");
}
function codeBlock(lines) {
  const body = Array.from({ length: lines }, (_, i) => `function example${String(i).padStart(2, "0")}(n) { const x = n * n + ${i}; console.log("value:", x); return x * 2; }`).join("\n");
  return `Here is a large code example:\n\n\`\`\`javascript\n${body}\n\`\`\`\n\nEnd of block.`;
}

// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates age out of the list.
// Offsets relative to 2026-08-20T12:10:26.000Z are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:10:26.000Z");
const ts = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const NAV_DIR = "-tmp-verify-nav";
const NAV_FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000b1.jsonl";

const entries = [];
entries.push({ type: "title", title: "Nav regression fixture" });
entries.push({ type: "session", id: "019ff400-0000-7000-0000-0000000000b1", cwd: "/tmp/verify-nav", title: "Nav regression fixture" });

const assistantTexts = [
  "Got it.", // 01 after USER 01
  longParagraphs(70), // 02 long
  codeBlock(55), // 03 code tall
  "Okay, noted.", // 04 one-liner
  longParagraphs(62), // 05 long
  codeBlock(52), // 06 code tall
  "Sure — continuing.", // 07
  longParagraphs(68), // 08 long
  codeBlock(50), // 09 code tall
  "Acknowledged.", // 10
  longParagraphs(72), // 11 very tall — the settle-loop proof
];

for (let i = 1; i <= 12; i++) {
  const turn = String(i).padStart(2, "0");
  const tsMin = String(i * 2).padStart(2, "0");
  entries.push({
    id: `e-u-${turn}`,
    type: "message",
    timestamp: ts(`2026-08-20T12:10:${tsMin}.000Z`),
    message: {
      id: `m-u-${turn}`,
      role: "user",
      content: [{ type: "text", text: `USER TURN ${turn}` }],
    },
  });
  if (i <= 11) {
    const aTurn = String(i).padStart(2, "0");
    const tsMinA = String(i * 2 + 1).padStart(2, "0");
    entries.push({
      id: `e-a-${aTurn}`,
      type: "message",
      timestamp: ts(`2026-08-20T12:10:${tsMinA}.000Z`),
      message: {
        id: `m-a-${aTurn}`,
        role: "assistant",
        content: [{ type: "text", text: assistantTexts[i - 1] }],
      },
    });
  }
}
// Trailing tall spacer after the final user turn so the newest turn can be
// scrolled to the landing position while the scroller is still at the bottom.
entries.push({
  id: `e-a-12`,
  type: "message",
  timestamp: ts(`2026-08-20T12:10:26.000Z`),
  message: {
    id: `m-a-12`,
    role: "assistant",
    content: [{ type: "text", text: longParagraphs(20) }],
  },
});

writeSession(NAV_DIR, NAV_FILE, "Nav regression fixture", "/tmp/verify-nav", entries, 2 * 60 * 1000);

// ---------------------------------------------------------------------------
// Vite + puppeteer
// ---------------------------------------------------------------------------
const webApp = await startWebApp({ base: BASE, port: 5188 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-verify-nav-`)}`],
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

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 600));

  // Open the nav fixture session — search by title
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const target = rows.find((r) => (r.textContent || "").includes("Nav regression")) || rows[0];
    if (target instanceof HTMLElement) target.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.waitForSelector(".chat-scroll", { timeout: 15000 });
  await page.waitForSelector("[data-testid='jump-next']", { timeout: 15000 });
  await page.waitForSelector("[data-entry-id]", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 800));

  const userCount = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-entry-id]"));
    return rows.filter((el) => (el.textContent || "").includes("USER TURN")).length;
  });
  if (userCount !== 12) {
    console.log(`(fixture) expected 12 user turns, found ${userCount}`);
  }

  async function waitSettled(timeoutMs = 2000) {
    await page.evaluate(async (timeout) => {
      const s = document.querySelector(".chat-scroll");
      if (!(s instanceof HTMLElement)) return;
      let last = s.scrollTop;
      let stable = 0;
      const start = performance.now();
      while (performance.now() - start < timeout) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const cur = s.scrollTop;
        if (Math.abs(cur - last) < 0.5) stable += 1;
        else stable = 0;
        last = cur;
        if (stable >= 2) break;
      }
    }, timeoutMs);
    await new Promise((r) => setTimeout(r, 80));
  }

  async function scrollToBottom() {
    await page.evaluate(() => {
      const s = document.querySelector(".chat-scroll");
      if (s instanceof HTMLElement) s.scrollTop = s.scrollHeight;
    });
    await waitSettled(2200);
  }

  // A reader scroll: the wheel releases the transcript viewport's bottom lock
  // exactly as a finger would, then the offset is set directly.
  async function scrollToOffset(top) {
    await page.evaluate((t) => {
      const s = document.querySelector(".chat-scroll");
      if (!(s instanceof HTMLElement)) return;
      s.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
      s.scrollTop = t;
    }, top);
    await waitSettled(2000);
  }

  async function latestState() {
    return page.evaluate(() => {
      const s = document.querySelector(".chat-scroll");
      const btn = document.querySelector("[data-testid='jump-next']");
      const rows = Array.from(document.querySelectorAll("[data-entry-id]"));
      const last = rows[rows.length - 1];
      const sr = s instanceof HTMLElement ? s.getBoundingClientRect() : null;
      const lr = last instanceof HTMLElement ? last.getBoundingClientRect() : null;
      return {
        found: btn instanceof HTMLButtonElement,
        ariaHidden: btn ? btn.getAttribute("aria-hidden") : null,
        ariaBusy: btn ? btn.getAttribute("aria-busy") : null,
        tabIndex: btn instanceof HTMLElement ? btn.tabIndex : null,
        label: btn ? btn.getAttribute("aria-label") : null,
        count: document.querySelector("[data-testid='latest-messages-count']")?.textContent?.trim() ?? null,
        gap: s instanceof HTMLElement ? Math.round(s.scrollHeight - s.clientHeight - s.scrollTop) : -1,
        scrollTop: s instanceof HTMLElement ? Math.round(s.scrollTop) : -1,
        // The newest row's bottom edge must be inside the viewport after a jump.
        newestBottomInView: !!(sr && lr && lr.bottom <= sr.bottom + 2 && lr.bottom > sr.top),
        failedToast: /Couldn.t reach the latest messages/.test(document.body.innerText || ""),
      };
    });
  }

  // Hold the jump control (latest) and wait for the jump to finish (aria-busy
  // clears); returns the elapsed time in ms, measured in the page.
  async function jumpToLatest() {
    const t0 = await page.evaluate(() => performance.now());
    await page.evaluate(JUMP_TO_LATEST);
    const t1 = await page.evaluate(async () => {
      const deadline = performance.now() + 6000;
      await new Promise((r) => requestAnimationFrame(() => r()));
      while (performance.now() < deadline) {
        const btn = document.querySelector("[data-testid='jump-next']");
        if (!btn || btn.getAttribute("aria-busy") !== "true") break;
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
      return performance.now();
    });
    await waitSettled(1500);
    return Math.round(t1 - t0);
  }

  async function getNearestUserTurn() {
    return page.evaluate(() => {
      const scroller = document.querySelector(".chat-scroll");
      if (!(scroller instanceof HTMLElement)) return null;
      const scRect = scroller.getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll("[data-entry-id]"));
      let best = null;
      let bestDist = Infinity;
      for (const el of rows) {
        if (!(el instanceof HTMLElement)) continue;
        const txt = el.textContent || "";
        const m = txt.match(/USER TURN (\d+)/);
        if (!m) continue;
        const r = el.getBoundingClientRect();
        const offset = r.top - scRect.top;
        const dist = Math.abs(offset - 12);
        if (dist < bestDist) {
          bestDist = dist;
          best = { el, offset, text: txt, num: parseInt(m[1], 10), id: el.getAttribute("data-entry-id") };
        }
      }
      if (!best) return null;
      return { num: best.num, offset: Math.round(best.offset), text: best.text.trim().slice(0, 80), id: best.id, dist: Math.round(bestDist) };
    });
  }

  async function getTurnInfo(num) {
    return page.evaluate((n) => {
      const scroller = document.querySelector(".chat-scroll");
      if (!(scroller instanceof HTMLElement)) return null;
      const scRect = scroller.getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll("[data-entry-id]"));
      const pad = String(n).padStart(2, "0");
      for (const el of rows) {
        if (!(el instanceof HTMLElement)) continue;
        const txt = el.textContent || "";
        if (!txt.includes(`USER TURN ${pad}`)) continue;
        const r = el.getBoundingClientRect();
        const topContent = r.top - scRect.top + scroller.scrollTop;
        return {
          offset: Math.round(r.top - scRect.top),
          topContent: Math.round(topContent),
          id: el.getAttribute("data-entry-id"),
          text: txt.trim().slice(0, 80),
        };
      }
      return null;
    }, num);
  }

  async function scrollNearTurn(num) {
    const info = await getTurnInfo(num);
    if (!info) return false;
    await scrollToOffset(info.topContent - 12);
    return true;
  }

  // -----------------------------------------------------------------------
  // 1. At the live edge the jump button is mounted but inert
  // -----------------------------------------------------------------------
  await scrollToBottom();
  await new Promise((r) => setTimeout(r, 600));
  const atEdge = await latestState();
  check(
    "at the live edge the jump button is hidden and out of the tab order",
    atEdge.found && atEdge.ariaHidden === "true" && atEdge.tabIndex === -1 && atEdge.count === null,
    JSON.stringify(atEdge),
  );

  // -----------------------------------------------------------------------
  // 2. Scrolled away it is a real control; nothing arrived, so no count.
  // Down only ever means the latest (message stepping was removed).
  // -----------------------------------------------------------------------
  await scrollNearTurn(9);
  await new Promise((r) => setTimeout(r, 600));
  const away = await latestState();
  check(
    "scrolled away the jump button is shown, focusable and labelled without a count",
    away.found && away.ariaHidden === "false" && away.tabIndex === 0 && away.label === "Jump to latest" && away.count === null,
    JSON.stringify(away),
  );

  // -----------------------------------------------------------------------
  // 3. A jump from the oldest turn lands exactly on the newest row, despite
  //    content-visibility estimates being wrong for every tall turn between
  // -----------------------------------------------------------------------
  await scrollToOffset(0);
  const fromTop = await getNearestUserTurn();
  const longJumpMs = await jumpToLatest();
  const landed = await latestState();
  check(
    "a jump from the oldest turn lands exactly at the live edge",
    landed.gap >= 0 && landed.gap <= 8 && landed.newestBottomInView && !landed.failedToast,
    `from turn ${fromTop ? fromTop.num : "?"}; gap=${landed.gap}px newestInView=${landed.newestBottomInView} failedToast=${landed.failedToast}`,
  );
  check(
    "after arriving the jump button hides again",
    landed.ariaHidden === "true" && landed.ariaBusy !== "true" && landed.tabIndex === -1,
    `aria-hidden=${landed.ariaHidden} aria-busy=${landed.ariaBusy} tabIndex=${landed.tabIndex}`,
  );

  // -----------------------------------------------------------------------
  // 4. The landing holds: late re-measurement of skipped turns never drifts
  //    the reader off the live edge
  // -----------------------------------------------------------------------
  const drift = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 250));
    drift.push((await latestState()).gap);
  }
  check(
    "the landing holds at the live edge (no drift after re-measurement)",
    drift.every((g) => g >= 0 && g <= 8),
    `gaps over 1.5s=${JSON.stringify(drift)}`,
  );

  // -----------------------------------------------------------------------
  // 5. Manual scrolling between jumps never desyncs it: every start point
  //    ends on the same live edge
  // -----------------------------------------------------------------------
  const starts = [5, 2, 11];
  const ends = [];
  for (const turn of starts) {
    const ok = await scrollNearTurn(turn);
    const near = await getNearestUserTurn();
    await jumpToLatest();
    const s = await latestState();
    ends.push({ turn, ok, near: near ? near.num : null, gap: s.gap, inView: s.newestBottomInView, hidden: s.ariaHidden });
  }
  check(
    "jumps from manually scrolled positions all land on the live edge",
    ends.every((e) => e.ok && e.near === e.turn && e.gap >= 0 && e.gap <= 8 && e.inView && e.hidden === "true"),
    JSON.stringify(ends),
  );

  // -----------------------------------------------------------------------
  // 6. A wheel during the jump hands control back to the reader
  // -----------------------------------------------------------------------
  await scrollToOffset(0);
  await page.evaluate(async () => {
    const btn = document.querySelector("[data-testid='jump-next']");
    const s = document.querySelector(".chat-scroll");
    if (!(btn instanceof HTMLElement) || !(s instanceof HTMLElement)) return;
    // Hold past the long-press delay: the jump to latest fires on the hold.
    const r = btn.getBoundingClientRect();
    const o = { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    btn.dispatchEvent(new PointerEvent("pointerdown", o));
    // The jump arms its cancel listeners when the hold fires (aria-busy turns true); the wheel must land
    // before the spring has covered the distance, so wait for that state rather than a fixed delay.
    const t0 = performance.now();
    while (btn.getAttribute("aria-busy") !== "true" && performance.now() - t0 < 2000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    s.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    btn.dispatchEvent(new PointerEvent("pointerup", o));
  });
  await waitSettled(2500);
  await new Promise((r) => setTimeout(r, 400));
  const cancelled = await latestState();
  check(
    "a wheel during the jump cancels it and leaves the reader where they are",
    cancelled.gap > 844 && cancelled.ariaHidden === "false" && cancelled.ariaBusy !== "true" && !cancelled.failedToast,
    JSON.stringify(cancelled),
  );

  // -----------------------------------------------------------------------
  // 7. Responsiveness: the long-distance jump (step 3) finishes promptly
  // -----------------------------------------------------------------------
  check("responsiveness: long-distance jump completes under 2000ms", longJumpMs < 2000, `elapsed=${longJumpMs}ms`);

  // -----------------------------------------------------------------------
  // 8. No page errors / console errors
  // -----------------------------------------------------------------------
  const noErrors = pageErrors.length === 0 && consoleErrors.length === 0;
  check(
    "no page errors / console errors",
    noErrors,
    `pageErrors=${pageErrors.length} consoleErrors=${consoleErrors.length} ${[...pageErrors, ...consoleErrors].slice(0, 2).join(" | ").slice(0, 400)}`,
  );

  await browser.close();
} finally {
  webApp.stop();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures);
