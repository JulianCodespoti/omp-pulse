#!/usr/bin/env node
// Regression proof for per-session attachment trays: photos attached in one
// conversation must survive a trip to another conversation and back —
// re-attaching up to 8 photos after an accidental tap is data loss.
//
// Covers: attach in A, switch to B (tray swaps, nothing leaks across),
// switch back to A (tray restored). No model calls (nothing is sent).

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-image-stash.mjs");
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

const DIR = "-tmp-verify-image-stash";
const mkSession = (file, sid, title) => {
  const entries = [
    { type: "title", title },
    { type: "session", id: sid, cwd: "/tmp/verify-image-stash", title },
    {
      id: `${sid}-u`, type: "message", timestamp: "2026-08-20T12:00:00.000Z",
      message: { id: `${sid}-mu`, role: "user", content: [{ type: "text", text: "hi" }] },
    },
  ];
  writeFileSync(`${SESSIONS}/${DIR}/${file}`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

mkdirSync(`${SESSIONS}/${DIR}`, { recursive: true });
mkSession(
  "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000e5.jsonl",
  "019ff400-0000-7000-0000-0000000000e5",
  "Stash Alpha",
);
mkSession(
  "2026-08-20T12-11-00-000Z_019ff400-0000-7000-0000-0000000000e6.jsonl",
  "019ff400-0000-7000-0000-0000000000e6",
  "Stash Beta",
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(`${SESSIONS}/${DIR}`, when, when);

// A real decodable PNG for the intake (canvas downscale runs in-browser).
const png = `${tmpdir()}/omp-stash-test.png`;
execFileSync("python3", ["-c", "from PIL import Image; Image.new('RGB', (800, 600), (200, 40, 40)).save('__PNG__')".replace("__PNG__", png)]);

const webApp = await startWebApp({ base: BASE, port: 5336 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-image-stash-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const trayHas = (name) =>
    page.evaluate((name) => !!document.querySelector(`img[alt="${name}"]`), name);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = els.find((r) => (r.textContent || "").includes("Stash Alpha")) || els[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await sleep(1500);

  // Attach a photo in Alpha via the + sheet's "Add image" row.
  await page.evaluate(() => {
    const btn = document.querySelector("[data-testid='composer-plus-btn']");
    if (btn instanceof HTMLElement) btn.click();
  });
  await page.waitForSelector("[data-testid='composer-add-image']", { timeout: 5000 });
  // The sheet slides up as it opens: let it settle before tapping.
  await sleep(700);
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 8000 }),
    page.evaluate(() => document.querySelector("[data-testid='composer-add-image']")?.click()),
  ]);
  await chooser.accept([png]);
  await page.waitForSelector('img[alt="omp-stash-test.png"]', { timeout: 15000 });
  check("photo attaches in Alpha", true);

  const switchViaSwitcher = async (title) => {
    // The switcher is the header's ☰ button.
    await page.evaluate(() => document.querySelector("[data-testid='session-back']")?.click());
    // The 220ms panel slide finishes before a row is tapped.
    await sleep(700);
    const found = await page.evaluate((title) => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']"));
      const t = rows.find((el) => (el.textContent || "").includes(title));
      if (t instanceof HTMLElement) {
        t.click();
        return true;
      }
      return false;
    }, title);
    await sleep(2000);
    return found;
  };

  check("switch to Beta works", await switchViaSwitcher("Stash Beta"));
  check("Beta tray starts empty", !(await trayHas("omp-stash-test.png")));
  check("switch back to Alpha works", await switchViaSwitcher("Stash Alpha"));
  check("Alpha tray restores the photo", await trayHas("omp-stash-test.png"));

  check("no page errors during stash round-trip", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
