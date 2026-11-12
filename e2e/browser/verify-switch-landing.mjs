#!/usr/bin/env node
// Regression proof for landing at the bottom on IN-CHAT session switches
// (session switcher, branch target, any openSession while already in chat).
//
// The bug report: switching from the resume/recent panel "doesn't always
// take me to the bottom". The scroller element is reused across sessions, so
// a switch inherits the previous session's offset and only sometimes
// recovers. The fix remounts the scroller per session, putting every switch
// on the same mount path; this script switches mid-list twice and asserts
// the live edge both times. It also pins the switcher's order: the open chat
// first, then the sessions list's own order. No model calls.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-20T12:00:01.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:00:01.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-switch-landing.mjs");
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

const DIR = "-tmp-verify-switch-landing";
// `minute` offsets a session's message times: the list and the switcher
// rank by the newest message (activeAt), so two sessions with identical
// timestamps tie and their order is arbitrary.
const mkSession = (file, sid, title, turns, minute = 0) => {
  const entries = [
    { type: "title", title },
    { type: "session", id: sid, cwd: "/tmp/verify-switch-landing", title },
  ];
  for (let i = 1; i <= turns; i++) {
    const t = String(i).padStart(3, "0");
    entries.push({
      id: `${sid}-u-${t}`, type: "message", timestamp: shiftTs(`2026-08-20T12:0${minute}:00.000Z`),
      message: { id: `${sid}-mu-${t}`, role: "user", content: [{ type: "text", text: `${title} turn ${t}` }] },
    });
    entries.push({
      id: `${sid}-a-${t}`, type: "message", timestamp: shiftTs(`2026-08-20T12:0${minute}:01.000Z`),
      message: { id: `${sid}-ma-${t}`, role: "assistant", content: [{ type: "text", text: `${title} reply ${t}.` }] },
    });
  }
  writeFileSync(`${SESSIONS}/${DIR}/${file}`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

mkdirSync(`${SESSIONS}/${DIR}`, { recursive: true });
mkSession(
  "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000e1.jsonl",
  "019ff400-0000-7000-0000-0000000000e1",
  "Landing Alpha",
  60,
);
mkSession(
  "2026-08-20T12-11-00-000Z_019ff400-0000-7000-0000-0000000000e2.jsonl",
  "019ff400-0000-7000-0000-0000000000e2",
  "Landing Beta",
  60,
  1,
);
// The newest by activity and never opened: list order puts it above Beta,
// a most-recently-viewed order would put it below.
mkSession(
  "2026-08-20T12-12-00-000Z_019ff400-0000-7000-0000-0000000000e3.jsonl",
  "019ff400-0000-7000-0000-0000000000e3",
  "Landing Gamma",
  3,
  2,
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(`${SESSIONS}/${DIR}`, when, when);

const webApp = await startWebApp({ base: BASE, port: 5316 });

const profile = mkdtempSync(`${tmpdir()}/omp-switch-landing-`);
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
  const atBottom = () =>
    page.evaluate(() => {
      const el = document.querySelector(".chat-scroll");
      if (!(el instanceof HTMLElement)) return null;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 20000 });
  await sleep(800);
  const TITLES = ["Landing Alpha", "Landing Beta", "Landing Gamma"];
  // Titles in the order a container's session rows show them.
  const orderIn = (selector) =>
    page.evaluate(
      (selector, titles) =>
        Array.from(document.querySelectorAll(`${selector} [data-testid='session-row']`))
          .map((el) => titles.find((t) => (el.textContent || "").includes(t)))
          .filter(Boolean),
      selector,
      TITLES,
    );
  const listOrder = await orderIn("[data-testid='session-switcher']");

  const openFromList = async (title) => {
    await page.evaluate((title) => {
      const els = Array.from(document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']"));
      const t = els.find((r) => (r.textContent || "").includes(title)) || els[0];
      if (t instanceof HTMLElement) t.click();
    }, title);
    await page.waitForSelector("[data-testid='jump-next']", { timeout: 20000 });
    await sleep(1800);
  };

  // In-chat switch via the session switcher: header button -> left panel -> row.
  const openSwitcher = async () => {
    await page.evaluate(() => document.querySelector("[data-testid='session-back']")?.click());
    return page
      .waitForSelector("[data-testid='session-switcher'] [data-testid='session-row']", { timeout: 5000 })
      .then(() => true, () => false);
  };
  const switchViaSwitcher = async (title) => {
    if (!(await openSwitcher())) return false;
    // Let the 220ms panel slide finish before tapping a row in it.
    await sleep(400);
    const found = await page.evaluate((title) => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']"));
      const t = rows.find((el) => (el.textContent || "").includes(title));
      if (t instanceof HTMLElement) {
        t.click();
        return true;
      }
      return false;
    }, title);
    if (!found) return false;
    await sleep(2500);
    return true;
  };
  // The drawer stays mounted while closed (App.tsx keepMounted) and Base UI marks it `hidden`: closed means absent or hidden.
  const switcherOpen = () => page.evaluate(() => { const el = document.querySelector("[data-testid='session-switcher']"); return el !== null && el.closest("[hidden]") === null; });
  // At the live edge "Jump to latest" stays mounted but faded and inert.
  const jumpHidden = () =>
    page.evaluate(() => document.querySelector("[data-testid='jump-next']")?.getAttribute("aria-hidden") === "true");

  await openFromList("Landing Alpha");
  // Leave a stale offset behind: scroll up before switching, exactly the
  // state a reused scroller would otherwise inherit.
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    if (el) el.scrollTo({ top: 0 });
  });
  await sleep(600);

  check("switcher switch lands at the bottom", (await switchViaSwitcher("Landing Beta")) && (await atBottom()) === true);
  check("the switcher closes after a switch", (await switcherOpen()) === false);
  check("after the switch the jump-to-latest button is hidden (at the live edge)", await jumpHidden());
  await page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    if (el) el.scrollTo({ top: 0 });
  });
  await sleep(600);
  check("switching back lands at the bottom", (await switchViaSwitcher("Landing Alpha")) && (await atBottom()) === true);
  check("after switching back the jump-to-latest button is hidden", await jumpHidden());

  // List alignment: the drawer lists Recent newest activity first, the same
  // order as the sessions list, not the order they were viewed in: Gamma,
  // never opened, comes before Beta. The open chat is only marked current.
  await openSwitcher();
  await sleep(400);
  const switcherOrder = await orderIn("[data-testid='session-switcher']");
  const currentTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row'][aria-current='true']"))
      .map((r) => r.querySelector("[data-testid='session-title']")?.textContent?.trim()));
  const expected = listOrder;
  check(
    "the switcher mirrors the sessions list order",
    JSON.stringify(listOrder) === JSON.stringify(["Landing Gamma", "Landing Beta", "Landing Alpha"]) &&
      JSON.stringify(switcherOrder) === JSON.stringify(expected),
    JSON.stringify({ list: listOrder, switcher: switcherOrder }),
  );
  check("the open chat is the one row marked current", JSON.stringify(currentTitles) === JSON.stringify(["Landing Alpha"]), JSON.stringify(currentTitles));

  // Back order: Android Back closes the panel first and leaves the chat open.
  await page.evaluate(() => window.__ompNativeBack?.("commit"));
  await sleep(600);
  check(
    "Back closes the switcher before leaving the chat",
    (await switcherOpen()) === false && (await page.evaluate(() => document.querySelector(".chat-scroll") !== null)),
  );

  check("no page errors during switches", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
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
