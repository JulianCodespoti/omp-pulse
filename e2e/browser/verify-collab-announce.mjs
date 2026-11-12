#!/usr/bin/env node
// Regression proof for zero-link collab introduction: a host announces
// (sessionId, link) and the phone attaches with no scan, paste, or terminal
// ceremony. No live host exists here, so this proves the contract edges:
// validation, persistence of the mapping, harmless background auto-attach
// (file viewing intact), and a fast stable failure for explicit attach with
// nothing to join. No model calls.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";


const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through the isolated harness:");
  console.error("  e2e/run.sh e2e/browser/verify-collab-announce.mjs");
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

const SID = "019ff400-0000-7000-0000-0000000000a1";
// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-20T12:00:00.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:00:00.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const DIR = "-tmp-verify-collab-announce";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000a1.jsonl";
const entries = [
  { type: "title", title: "Announce fixture" },
  { type: "session", id: SID, cwd: "/tmp/verify-collab-announce", title: "Announce fixture" },
  {
    id: "n-e-u-1", type: "message", timestamp: shiftTs("2026-08-20T12:00:00.000Z"),
    message: { id: "n-m-u-1", role: "user", content: [{ type: "text", text: "Hello." }] },
  },
];

const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const fixture = `${dir}/${FILE}`;
writeFileSync(fixture, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(fixture, when, when);

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
};

// A structurally valid link to a dead room (discard port: refused fast, no
// 30s waits). Announce validates + stores; it never dials out.
const room = "eeeeeeeeeeeeeeeeeeeeee";
const key = randomBytes(32).toString("base64url");
const deadLink = `ws://127.0.0.1:9/r/${room}.${key}`;

const missing = await post("/api/collab/announce", { link: deadLink });
check("announce requires sessionId", missing.ok === false, JSON.stringify(missing).slice(0, 80));
const junk = await post("/api/collab/announce", { sessionId: SID, link: "not-a-link" });
check("announce rejects junk links", junk.ok === false, JSON.stringify(junk).slice(0, 80));
const announced = await post("/api/collab/announce", { sessionId: SID, link: deadLink });
check("announce accepts a valid link", announced.ok === true && announced.room === room, JSON.stringify(announced).slice(0, 80));
const reannounced = await post("/api/collab/announce", { sessionId: SID, link: deadLink });
check("re-announce is idempotent", reannounced.ok === true);

// The phone opens the session while a (dead) announcement exists: viewing
// must work off the file, and the background attach attempt must not break it.
const webApp = await startWebApp({ base: BASE, port: 5346 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-collab-announce-`)}`],
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
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = els.find((r) => (r.textContent || "").includes("Announce fixture")) || els[0];
    if (t instanceof HTMLElement) t.click();
  });
  // The chat is open once its header and transcript are: the header is the
  // one 56px row whose title button opens the session actions.
  await page.waitForSelector("[data-testid='session-actions']", { timeout: 20000 });
  await page.waitForSelector("[data-testid='chat-message']", { timeout: 20000 });
  await sleep(2000);
  const view = await page.evaluate(() => ({
    rows: document.querySelectorAll("[data-testid='chat-message']").length,
    title: document.querySelector("[data-testid='session-actions']")?.getAttribute("title") ?? null,
    // A dead room never asks anything: no question sheet, no strip chip.
    question: !!document.querySelector("[data-testid='collab-dialog'], [data-testid='collab-banner']"),
  }));
  check("viewing works with a dead announcement around", view.rows > 0 && view.title === "Announce fixture", JSON.stringify(view));
  check("a dead announcement raises no question", !view.question, JSON.stringify(view));

  // Explicit attach with nothing live: stored (none) -> announced (dead,
  // refused fast) -> adoption (no terminal) -> stable error, no hang.
  const t0 = Date.now();
  const attached = await post("/api/collab/attach", { sessionPath: fixture });
  const elapsed = Date.now() - t0;
  check(
    "attach with no live host fails clean",
    attached.ok === false && typeof attached.error === "string" && attached.error.includes("terminal"),
    `${elapsed}ms ${JSON.stringify(attached).slice(0, 100)}`,
  );
  check("failed attach returns promptly", elapsed < 25000, `${elapsed}ms`);

  // Runtime-dir introduction (upstream proposal shape): drop a host file for
  // the same session and confirm viewing stays intact. The mapping itself is
  // proven by unit tests (ingest round-trip); here the watcher must pick the
  // file up without disturbing the open session. e2e/with-test-daemon.sh
  // gives the run a private XDG_RUNTIME_DIR, so the file never reaches a real one.
  {
    const xdg = process.env.XDG_RUNTIME_DIR ?? "";
    const annDir = `${xdg}/omp/collab`;
    const annRoom = "ffffffffffffffffffffff";
    const annKey = randomBytes(32).toString("base64url");
    mkdirSync(annDir, { recursive: true });
    writeFileSync(
      `${annDir}/424242.json`,
      JSON.stringify({ sessionId: SID, link: `ws://127.0.0.1:9/r/${annRoom}.${annKey}`, cwd: "/tmp/x" }),
    );
    await sleep(2500);
    const rowsAfter = await page.evaluate(() => document.querySelectorAll("[data-testid='chat-message']").length);
    check("runtime-dir announcement leaves viewing intact", rowsAfter > 0, `rows=${rowsAfter}`);
  }

  check("no page errors during announce flow", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
