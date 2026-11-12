#!/usr/bin/env node
// Batch-pill regression: two identical prompts sent while the first is still
// in flight must render one status card per row, not every card under every
// same-text row. /api/prompt is stubbed accepted (no model call); what matters
// is the pill-to-row assignment.
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS || BASE.includes("7682")) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}

const DIR = "-tmp-batch-dupe";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000e5.jsonl";
const entries = [
  { type: "title", title: "Batch dupe fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000e5", cwd: "/tmp/batch-dupe", title: "Batch dupe fixture" },
  { id: "e-u-1", type: "message", timestamp: "2026-08-20T12:00:00.000Z",
    message: { id: "m-u-1", role: "user", content: [{ type: "text", text: "First." }] } },
  { id: "e-a-1", type: "message", timestamp: "2026-08-20T12:00:01.000Z",
    message: { id: "m-a-1", role: "assistant", content: [{ type: "text", text: "Hello." }] } },
];
const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/${FILE}`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(`${dir}/${FILE}`, when, when);

const webApp = await startWebApp({ base: BASE, port: 5336 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => console.log(JSON.stringify(o));
try {
  const browser = await puppeteer.launch({ headless: true, executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-batch-dupe-`)}`] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  // Respond accepted immediately (server took it, agent working): both entries
  // coexist non-terminally — the real batch-while-busy shape.
  const promptCalls = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url().includes("/api/prompt") && req.method() === "POST") {
      const body = JSON.parse(req.postData() || "{}");
      promptCalls.push(body);
      const now = Date.now();
      void req.respond({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, receipt: { commandId: body.commandId,
          sessionPath: body.sessionPath, state: "accepted", createdAt: now, updatedAt: now } }) });
    } else void req.continue();
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = els.find((r) => (r.textContent || "").includes("Batch dupe")) || els[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await sleep(1500);

  const sendOnce = async (text) => {
    await page.click("[data-testid='composer-input']");
    await page.type("[data-testid='composer-input']", text, { delay: 5 });
    await sleep(300);
    await page.evaluate(() => document.querySelector("[data-testid='composer-send-btn']")?.click());
    await sleep(2000);
  };
  await sendOnce("batch probe");
  await sendOnce("batch probe"); // past the 1200ms same-text backstop: a genuine second request
  await sleep(2000);

  const snap = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='chat-message']"))
      .filter((el) => (el.textContent || "").includes("batch probe"));
    const pills = Array.from(document.querySelectorAll("[data-testid='chat-message'] [role='status']")).length;
    return { posts: 0, bubbles: rows.length,
      pillsPerRow: rows.map((el) => el.querySelectorAll("[role='status']").length),
      pills, pillTexts: Array.from(document.querySelectorAll("[data-testid='chat-message'] [role='status']"))
        .map((el) => (el.textContent || "").slice(0, 60)) };
  });
  snap.posts = promptCalls.length;
  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(name);
  };
  check("both batched prompts POST as distinct commands",
    promptCalls.length === 2 && promptCalls[0].commandId !== promptCalls[1].commandId,
    `posts=${promptCalls.length}`);
  check("two user bubbles render", snap.bubbles === 2, `bubbles=${snap.bubbles}`);
  check("one status card per row",
    snap.pillsPerRow.length === 2 && snap.pillsPerRow.every((n) => n === 1),
    `per-row=${JSON.stringify(snap.pillsPerRow)}`);
  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}
if (typeof failures !== "undefined" && failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
