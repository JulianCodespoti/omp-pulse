#!/usr/bin/env node
// Holding a key must not outrun the composer.
//
// Reported: holding BACKSPACE sometimes stopped updating the text box. The
// cause was the multiline-detect effect depending on [text], so every single
// keystroke tore down and rebuilt a ResizeObserver, re-added an input
// listener, and re-ran a measurement that forces TWO synchronous layouts —
// getComputedStyle is a style recalc and scrollHeight is a reflow. The
// observer and the listener both called back into setIsMultiline, whose
// render changed text, which re-ran the effect. Android key repeat is roughly
// 30/s, and that loop starved the main thread.
//
// This asserts the thing the user actually experiences: every keypress lands.
// It runs under a 4x CPU throttle, because on an unthrottled desktop the loop
// is fast enough to hide the bug completely.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

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
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CWD = "/tmp/verify-composer-input";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-verify-composer-input`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/2026-08-20T12-55-00-000Z_019ff400-0000-7000-0000-0000000000f1.jsonl`;
writeFileSync(
  file,
  [
    { type: "session", id: "019ff400-0000-7000-0000-0000000000f1", cwd: CWD, title: "Composer input fixture" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(file, when, when);

const webApp = await startWebApp({ base: BASE, port: 5226 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-composer-`)}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const cdp = await page.createCDPSession();
  // A phone-class main thread. Unthrottled, the old code kept up and the
  // regression this guards is invisible.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 30000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Composer input")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });

  const ta = 'textarea[name="message"]';
  await page.waitForSelector(ta, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));

  // Seed through the native setter so React's onChange sees it, exactly as
  // typing would, without spending 70 keypresses to get there.
  const START = "the quick brown fox jumps over the lazy dog again and again and again";
  await page.focus(ta);
  await page.evaluate(
    (sel, s) => {
      const t = document.querySelector(sel);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(t, s);
      t.dispatchEvent(new Event("input", { bubbles: true }));
    },
    ta,
    START,
  );
  await new Promise((r) => setTimeout(r, 1500));
  const before = await page.evaluate((sel) => document.querySelector(sel).value.length, ta);
  check("the composer accepted the seed text", before === START.length, `${before} of ${START.length}`);

  // ~30/s, which is Android's key-repeat rate.
  const N = 45;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) await page.keyboard.press("Backspace", { delay: 12 });
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 2000));
  const after = await page.evaluate((sel) => document.querySelector(sel).value.length, ta);
  const deleted = before - after;
  check(
    "every backspace in a held repeat lands",
    deleted === N,
    `deleted ${deleted} of ${N} in ${elapsed}ms (dropped ${N - deleted})`,
  );

  // The visible box and React's state must agree afterwards. A drift here is
  // how the old loop presented: the DOM stopped moving while state ran ahead.
  const settled = await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    return { dom: t.value, len: t.value.length };
  }, ta);
  check(
    "the box shows exactly what survived",
    settled.dom === START.slice(0, START.length - N),
    JSON.stringify(settled).slice(0, 120),
  );

  await browser.close();
} finally {
  webApp.stop();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures);
