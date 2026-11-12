#!/usr/bin/env node
// Regression: earlier history must load by itself as the reader scrolls up, with
// no button press, on a transcript shaped like real sessions (hundreds of tool
// entries per conversation, so one 50-entry page is a handful of collapsed rows).
//
// Two shapes matter:
//   A. scrolled content: the reader scrolls to the top repeatedly and every older
//      page must arrive on its own until the first turn is on screen.
//   B. a tail that does NOT overflow the viewport: the newest page is one
//      collapsed run of tool steps, so there is nothing to scroll and a scroll
//      listener never fires. Older pages must still arrive without any gesture,
//      or the reader is stuck with a button (or nothing) at the top.
//
// Runs under e2e/with-test-daemon.sh. No model calls. Exit code = number of failures.

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
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const BASE_MS = Date.now() - 3 * 60 * 60 * 1000;
let tick = 0;
const stamp = () => new Date(BASE_MS + tick++ * 1000).toISOString();

function buildSession({ turns, toolsPerTurn, tailTools, title }) {
  const entries = [
    { type: "title", title },
    { type: "session", id: "019ff400-0000-7000-0000-0000000000e1", cwd: "/tmp/verify-history-autoload", title },
  ];
  let n = 0;
  const user = (text) => entries.push({ id: `e${n++}`, type: "message", timestamp: stamp(), message: { role: "user", content: [{ type: "text", text }] } });
  const tool = (turn, k) => {
    const id = `call_${turn}_${k}`;
    entries.push({ id: `e${n++}`, type: "message", timestamp: stamp(), message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: `echo ${turn}-${k}` }, intent: `Checking step ${k} of turn ${turn}` }] } });
    entries.push({ id: `e${n++}`, type: "message", timestamp: stamp(), message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text: `ok ${turn}-${k}` }] } });
  };
  for (let t = 1; t <= turns; t++) {
    user(`HISTORY TURN ${String(t).padStart(2, "0")}`);
    for (let k = 1; k <= toolsPerTurn; k++) tool(t, k);
    entries.push({ id: `e${n++}`, type: "message", timestamp: stamp(), message: { role: "assistant", content: [{ type: "text", text: `Answer for turn ${t}. ` + "Some prose that wraps on a phone. ".repeat(6) }] } });
  }
  // The newest turn ends in a long run of tool calls and no prose: one collapsed
  // run row, which cannot overflow the viewport.
  user(`HISTORY TURN ${String(turns + 1).padStart(2, "0")}`);
  for (let k = 1; k <= tailTools; k++) tool(turns + 1, k);
  return entries;
}

const DIR = "-tmp-verify-history-autoload";
const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000e1.jsonl";
const fixture = `${dir}/${FILE}`;
writeFileSync(fixture, buildSession({ turns: 40, toolsPerTurn: 8, tailTools: 40, title: "History autoload fixture" }).map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(fixture, when, when);

const webApp = await startWebApp({ base: BASE, port: 5216 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-hist-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const historyCalls = [];
  page.on("request", (r) => { if (r.url().includes("/api/history")) historyCalls.push(r.url()); });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("History autoload")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await wait(2500);

  const turnsOnPage = () => page.evaluate(() => {
    const txt = document.body.textContent || "";
    return new Set(Array.from(txt.matchAll(/HISTORY TURN (\d+)/g)).map((m) => Number(m[1]))).size;
  });
  const overflow = () => page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
  });
  const loadButton = () => page.evaluate(() => Array.from(document.querySelectorAll("button")).some((b) => /load earlier/i.test(b.textContent || "")));

  // --- B: the newest page is one collapsed run: nothing to scroll ------------
  // No scrolling, no clicking. Whatever the fixture's first screen looked like,
  // the app must fetch older pages by itself until the screen is full of
  // readable turns (a scroll listener never fires on a thread that does not
  // overflow, which is how the reader got stuck on a dead button).
  const requestsAtOpen = historyCalls.length;
  let readable = 0;
  for (let i = 0; i < 30 && readable < 3; i++) {
    await wait(500);
    readable = await turnsOnPage();
  }
  const geometry = await overflow();
  check("older turns appear by themselves, with no gesture", readable >= 3, `turns on page=${readable}, geometry=${JSON.stringify(geometry)}`);
  check("the thread now fills the screen (nothing left to scroll to trigger a load)", geometry && geometry.scrollHeight > geometry.clientHeight, JSON.stringify(geometry));
  check("history was fetched without any interaction", historyCalls.length > requestsAtOpen || requestsAtOpen > 1, `requests ${requestsAtOpen} -> ${historyCalls.length}`);

  // --- A: scrolling up pulls older pages in, no button -------------------------
  let reachedFirst = false;
  let lastCount = await turnsOnPage();
  for (let i = 0; i < 80 && !reachedFirst; i++) {
    await page.evaluate(() => { const el = document.querySelector(".chat-scroll"); if (el) el.scrollTop = 0; });
    await wait(450);
    const c = await turnsOnPage();
    reachedFirst = await page.evaluate(() => (document.body.textContent || "").includes("HISTORY TURN 01"));
    lastCount = c;
  }
  check("scrolling to the top repeatedly reaches the very first turn without pressing anything", reachedFirst, `turns on page=${lastCount}, history requests=${historyCalls.length}`);
  check("no 'Load earlier' button is left once everything is loaded", !(await loadButton()));

  // --- Jump to latest: away from the live edge, one button returns there -----
  // The jump pill stays mounted and fades in (aria-hidden="false") while the
  // reader is up; holding its down half reloads any evicted tail and lands on
  // the newest turn (a tap does the same).
  const latest = () => page.evaluate(() => {
    const el = document.querySelector(".chat-scroll");
    const btn = document.querySelector("[data-testid='jump-next']");
    return {
      mounted: btn !== null,
      hidden: btn?.getAttribute("aria-hidden") ?? null,
      fromBottom: el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null,
      newest: (document.body.textContent || "").includes("HISTORY TURN 41"),
    };
  });
  const atTop = await latest();
  check("jump to latest shows while the reader is at the top", atTop.mounted && atTop.hidden === "false", JSON.stringify(atTop));
  await page.evaluate(JUMP_TO_LATEST);
  let landed = await latest();
  for (let i = 0; i < 20 && !(landed.newest && landed.fromBottom !== null && landed.fromBottom <= 70 && landed.hidden === "true"); i++) {
    await wait(500);
    landed = await latest();
  }
  check(
    "tapping jump to latest returns to the newest turn and hides the button",
    landed.newest && landed.fromBottom !== null && landed.fromBottom <= 70 && landed.hidden === "true",
    JSON.stringify(landed),
  );
  check("no page errors", pageErrors.length === 0, pageErrors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}
process.exit(failures === 0 ? 0 : 1);
