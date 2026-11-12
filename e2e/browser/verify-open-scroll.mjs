#!/usr/bin/env node
// Regression proof for the transcript's one scroll owner (transcript-viewport.tsx).
//
// Measured before it existed, on a 150-turn chat in headless Chromium:
//   - opening painted 5,546 px above the newest message and travelled there
//     for 730-790 ms (the reader watched the whole chat scroll past);
//   - a reader who scrolled up while history paged in was pulled back 236-964 px
//     (the follow lock re-armed within 70 px of the end on any downward movement).
// This suite asserts the opposite: a chat opens AT the newest message, and a reader
// who left the end stays where they left it. No model calls.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-open-scroll.mjs");
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

const DIR = "-tmp-verify-open-scroll";
const CWD = "/tmp/verify-open-scroll";
const TITLE = "Open Scroll Long";
const SID = "019ff500-0000-7000-0000-0000000000a1";
const TURNS = 150;
const PARAGRAPH =
  "The retry budget is read once per request and then decremented on every attempt, so a request that fails three times stops instead of looping. ";

mkdirSync(CWD, { recursive: true });
mkdirSync(`${SESSIONS}/${DIR}`, { recursive: true });
const start = Date.now() - 2 * 60 * 60 * 1000;
const entries = [
  { type: "title", title: TITLE },
  { type: "session", id: SID, cwd: CWD, title: TITLE },
];
for (let i = 1; i <= TURNS; i++) {
  const t = String(i).padStart(3, "0");
  entries.push({
    id: `${SID}-u-${t}`, type: "message", timestamp: new Date(start + i * 2000).toISOString(),
    message: { id: `${SID}-mu-${t}`, role: "user", content: [{ type: "text", text: `${TITLE} question ${t}` }] },
  });
  entries.push({
    id: `${SID}-a-${t}`, type: "message", timestamp: new Date(start + i * 2000 + 1000).toISOString(),
    message: { id: `${SID}-ma-${t}`, role: "assistant", content: [{ type: "text", text: `${TITLE} answer ${t}. ${PARAGRAPH.repeat(2)}` }] },
  });
}
writeFileSync(
  `${SESSIONS}/${DIR}/2026-08-20T12-10-00-000Z_${SID}.jsonl`,
  entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(`${SESSIONS}/${DIR}`, when, when);

const webApp = await startWebApp({ base: BASE, port: 5318 });
const profile = mkdtempSync(`${tmpdir()}/omp-open-scroll-`);
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });

  // Sample the distance from the newest message once per frame, from the tap on.
  // The sample runs after the frame has been painted (a task queued from the
  // frame callback): a callback inside the frame reads layout before the
  // resize observers have re-pinned it, and reported rows the reader never saw.
  await page.evaluate(() => {
    window.__open = [];
    window.__openRun = true;
    const sample = () => {
      const el = document.querySelector(".chat-scroll");
      if (el && el.querySelector("[data-entry-id]")) {
        window.__open.push(Math.round(el.scrollHeight - el.clientHeight - el.scrollTop));
      }
    };
    const tick = () => {
      setTimeout(sample, 0);
      if (window.__openRun) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const clicked = await page.evaluate((title) => {
    const row = [...document.querySelectorAll("[data-testid='session-row']")].find((r) => (r.textContent || "").includes(title));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  }, TITLE);
  check("the long fixture is listed", clicked);
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await sleep(2500);
  const samples = await page.evaluate(() => { window.__openRun = false; return window.__open; });
  const worst = samples.length ? Math.max(...samples) : -1;
  // The very first painted rows may be sampled before the viewport has pinned them (one frame);
  // after that the chat must never be far from the newest message again.
  const settled = samples.slice(Math.min(2, samples.length));
  check("rows were painted", samples.length > 0, `${samples.length} frames`);
  check(
    "a chat opens at the newest message, without travelling to it",
    settled.length > 0 && Math.max(...settled) <= 40,
    `furthest after the first frames ${settled.length ? Math.max(...settled) : "n/a"} px (first frame ${samples[0]} px, overall ${worst} px); trail ${samples.filter((_, i) => i === 0 || samples[i] !== samples[i - 1]).slice(0, 14).join(" > ")}`,
  );

  // A reader who leaves the end stays where they left it while history pages in.
  const left = await page.evaluate(async () => {
    const el = document.querySelector(".chat-scroll");
    if (!el) return null;
    el.scrollTo({ top: el.scrollTop - 1500 });
    await new Promise((r) => setTimeout(r, 150));
    return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
  });
  check("the reader could leave the end", left !== null && left >= 1000, `${left} px from the newest message`);
  let lowest = Infinity;
  for (let i = 0; i < 12; i++) {
    await sleep(250);
    const d = await page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      return el ? Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) : -1;
    });
    lowest = Math.min(lowest, d);
  }
  check(
    "the reader is not pulled back towards the newest message",
    left !== null && lowest >= left - 24,
    `left at ${left} px, closest afterwards ${lowest} px`,
  );

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
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
