#!/usr/bin/env node
// Regression proof against duplicate sends: a double-tap (or Enter repeat)
// before the first render lands reuses the same closure text and must not
// POST twice. The composer carries an in-flight guard; the controller adds a
// 1200ms same-text backstop for every other entry point.
//
// Deterministic by construction: both taps dispatch synchronously in one
// task, so only the guards — never timing — decide the POST count. /api/prompt
// is stubbed at the browser (no model call): what matters is that exactly one
// request leaves the phone.

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
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-double-send.mjs");
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

const DIR = "-tmp-verify-double-send";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000e4.jsonl";
const entries = [
  { type: "title", title: "Double send fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000e4", cwd: "/tmp/verify-double-send", title: "Double send fixture" },
  {
    id: "d-e-u-1", type: "message", timestamp: "2026-08-20T12:00:00.000Z",
    message: { id: "d-m-u-1", role: "user", content: [{ type: "text", text: "Hello." }] },
  },
  {
    id: "d-e-a-1", type: "message", timestamp: "2026-08-20T12:00:01.000Z",
    message: { id: "d-m-a-1", role: "assistant", content: [{ type: "text", text: "Hi there." }] },
  },
];

const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/${FILE}`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(`${dir}/${FILE}`, when, when);

const webApp = await startWebApp({ base: BASE, port: 5326 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-double-send-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Stub the send: count POSTs and return the real receipt envelope without a
  // model call. The request still has to carry a durable command id.
  const promptCalls = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url().includes("/api/prompt") && req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      promptCalls.push(body);
      const now = Date.now();
      void req.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          receipt: {
            commandId: body.commandId,
            sessionPath: body.sessionPath,
            state: "accepted",
            createdAt: now,
            updatedAt: now,
          },
        }),
      });
    } else {
      void req.continue();
    }
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = els.find((r) => (r.textContent || "").includes("Double send")) || els[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await sleep(1500);
  check("chat opens with a composer", true);

  await page.click("[data-testid='composer-input']");
  await page.type("[data-testid='composer-input']", "hello double", { delay: 10 });
  await sleep(300);
  const sendEnabled = await page.evaluate(() => {
    const btn = document.querySelector("[data-testid='composer-send-btn']");
    return btn instanceof HTMLButtonElement && !btn.disabled;
  });
  check("typed text enables send", sendEnabled);

  // Two taps, one task: only guards — never timing — decide the POST count.
  await page.evaluate(() => {
    const btn = document.querySelector("[data-testid='composer-send-btn']");
    if (btn instanceof HTMLElement) {
      btn.click();
      btn.click();
    }
  });
  await sleep(2500);
  check(
    "double tap sends exactly one POST with a command id",
    promptCalls.length === 1 && typeof promptCalls[0]?.commandId === "string" && promptCalls[0].commandId.length > 0,
    `posts=${promptCalls.length}`,
  );

  const cleared = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="message"]');
    return ta instanceof HTMLTextAreaElement && ta.value === "";
  });
  check("composer clears after send", cleared);

  check("no page errors during double send", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
