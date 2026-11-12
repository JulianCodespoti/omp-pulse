#!/usr/bin/env node
// Regression proof for live viewing without collab: the daemon streams the
// session file's unterminated tail as `partial` frames, and the transcript
// must render them as a provisional in-flow row — never raw JSON, never only
// a floating blob.
//
// Covers:
//   1. A complete-but-unterminated message line renders its text (parsed).
//   2. A torn mid-string line renders the growing tail (extracted, no JSON).
//   3. Completing the line with a newline commits it: provisional row leaves,
//      committed message row arrives.

import { mkdirSync, writeFileSync, appendFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { spawn } from "child_process";
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
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-partial.mjs");
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

// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-20T12:00:03.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:00:03.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const DIR = "-tmp-verify-partial";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000d3.jsonl";

const entries = [
  { type: "title", title: "Partial fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000d3", cwd: "/tmp/verify-partial", title: "Partial fixture" },
  {
    id: "p-e-u-1", type: "message", timestamp: shiftTs("2026-08-20T12:00:00.000Z"),
    message: { id: "p-m-u-1", role: "user", content: [{ type: "text", text: "Say hello slowly." }] },
  },
  {
    id: "p-e-a-1", type: "message", timestamp: shiftTs("2026-08-20T12:00:01.000Z"),
    message: { id: "p-m-a-1", role: "assistant", content: [{ type: "text", text: "First answer." }] },
  },
];

const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const fixture = `${dir}/${FILE}`;
writeFileSync(fixture, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
// Foreign-owned, like every laptop-driven session in production: a holder that
// looks like a terminal omp (argv0 `…/omp`, launched naming the file, with it
// open) makes the daemon refuse its own writer (src/authority/guard.rs
// foreign_session_owner, checked in src/omp/child.rs do_open), so no RPC child
// second-guesses the file while the test appends torn bytes. Without this a
// real omp child boots against the synthetic entries on open (command
// catalogue) and its distress chatter swamps the exact frames under test.
//
// The holder reads its stdin until EOF, so it lives exactly as long as this
// process and cannot die mid-run. It used to be a sidecar naming PID 1, which
// needs /proc/1 and a start time computed from /proc/stat: neither is readable
// in containers such as proot. Its environment is minimal on purpose: an owner
// carrying a terminal identity (HERDR_PANE_ID, ...) is resolved to that pane.
// Scratch for the holder's argv0 and home and the browser profile; removed at exit.
const scratch = mkdtempSync(`${tmpdir()}/omp-partial-`);
const holder = spawn(
  "/bin/bash",
  ["-c", 'exec -a "$1/omp" /bin/bash -c \'exec 3< "$1"; while read -r line; do :; done\' _ "$2"', "_", scratch, fixture],
  { env: { PATH: "/usr/bin:/bin", HOME: scratch }, stdio: ["pipe", "ignore", "ignore"] },
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(fixture, when, when);

const webApp = await startWebApp({ base: BASE, port: 5226 });

try {
  // The daemon must really refuse its own writer, or the frames below are not
  // the ones a laptop-driven session produces.
  let probe = null;
  for (let i = 0; i < 20 && probe?.code !== "session_owned_by_terminal"; i++) {
    if (i) await new Promise((r) => setTimeout(r, 250));
    probe = await fetch(`${BASE}/api/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath: fixture, command: "get_session_stats", params: {} }),
    }).then((r) => r.json());
  }
  check("the fixture is owned by a terminal omp", probe?.code === "session_owned_by_terminal", JSON.stringify(probe).slice(0, 160));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${scratch}/profile`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inTranscriptPartial = () =>
    page.evaluate(() => {
      const el = document.querySelector(".chat-scroll [data-testid='partial-line']");
      return el ? el.textContent : null;
    });
  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = els.find((r) => (r.textContent || "").includes("Partial fixture")) || els[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='session-actions']", { timeout: 20000 });
  await page.waitForSelector("[data-testid='chat-message']", { timeout: 20000 });
  await sleep(1500);
  // A settled turn ends in one quiet footer: done, with Copy and ⋯ for its
  // prose reply. The fixture's every assistant message belongs to one turn.
  const footers = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".chat-scroll [data-testid='turn-footer']")).map((el) => ({
        state: el.getAttribute("data-state"),
        copy: !!el.querySelector("[data-testid='turn-copy']"),
        more: !!el.querySelector("[data-testid='message-more']"),
      })),
    );
  const settledFooter = async () => {
    const all = await footers();
    return { ok: all.length === 1 && all[0].state === "done" && all[0].copy && all[0].more, all };
  };
  const idle = await settledFooter();
  check("idle transcript ends in a done turn footer", idle.ok, JSON.stringify(idle.all));
  // 1. Complete line, no trailing newline: parses whole, renders its text.
  // The live edge takes over while the turn's line is still growing.
  const whole = {
    id: "p-e-a-2", type: "message", timestamp: shiftTs("2026-08-20T12:00:02.000Z"),
    message: { id: "p-m-a-2", role: "assistant", content: [{ type: "text", text: "Hello partial world" }] },
  };
  appendFileSync(fixture, JSON.stringify(whole));
  let prose = null;
  for (let i = 0; i < 15 && !prose; i++) {
    await sleep(800);
    prose = await inTranscriptPartial();
  }

  // Terminating the line commits it: provisional retires, message arrives.
  appendFileSync(fixture, "\n");
  let retired = false;
  for (let i = 0; i < 15 && !retired; i++) {
    await sleep(800);
    retired = (await inTranscriptPartial()) === null;
  }
  check("provisional row retires on commit", retired);

  // 2. Torn mid-string line: the growing tail renders, JSON stays out.
  const torn =
    `{"id":"p-e-a-3","type":"message","timestamp":"${shiftTs("2026-08-20T12:00:03.000Z")}",` +
    `"message":{"id":"p-m-a-3","role":"assistant","content":[{"type":"text","text":"Streaming the tail`;
  appendFileSync(fixture, torn);
  let tail = null;
  for (let i = 0; i < 15 && !tail?.includes("Streaming the tail"); i++) {
    await sleep(800);
    tail = await inTranscriptPartial();
  }
  check("torn partial line renders the growing tail", tail !== null && tail.includes("Streaming the tail"), (tail ?? "").slice(0, 80));
  check("torn tail hides the JSON envelope", tail === null || !tail.includes('"content"'), (tail ?? "").slice(0, 80));

  // 3. Newline completes the torn line: provisional leaves, committed arrives.
  appendFileSync(fixture, '"}]}}\n');
  let committed = false;
  let provisionalGone = false;
  for (let i = 0; i < 15 && !(committed && provisionalGone); i++) {
    await sleep(800);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid='chat-message']")).length);
    committed = rows >= 4;
    provisionalGone = (await inTranscriptPartial()) === null;
  }
  check("completed line commits to the transcript", committed);
  check("torn provisional retires on commit", provisionalGone);
  let settled = await settledFooter();
  for (let i = 0; i < 10 && !settled.ok; i++) {
    await sleep(800);
    settled = await settledFooter();
  }
  check("the turn footer settles back to done when the edge settles", settled.ok, JSON.stringify(settled.all));

  check("no page errors during partial streaming", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
  holder.kill();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
