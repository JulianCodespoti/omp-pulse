#!/usr/bin/env node
// Blob-image regression: tool-result image blocks and markdown image refs
// carrying `blob:sha256:…` must resolve through the authenticated blob fetch,
// never hit the browser as literal URLs ("Not allowed to load local
// resource"). The hash is unknown so /api/blob 404s; the UI must show its
// placeholder/pulse with zero page errors and zero blob: requests.
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS || BASE.includes("7682")) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}

const DIR = "-tmp-verify-tool-images";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000e6.jsonl";
const HASH = "aa".repeat(32);
const entries = [
  { type: "title", title: "Tool images fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000e6", cwd: "/tmp/tool-images", title: "Tool images fixture" },
  { id: "e-u-1", type: "message", timestamp: "2026-08-20T12:00:00.000Z",
    message: { id: "m-u-1", role: "user", content: [{ type: "text", text: "Screenshot please." }] } },
  { id: "e-a-1", type: "message", timestamp: "2026-08-20T12:00:01.000Z",
    message: { id: "m-a-1", role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "screenshot", arguments: {} }] } },
  { id: "e-t-1", type: "message", timestamp: "2026-08-20T12:00:02.000Z",
    message: { id: "m-t-1", role: "toolResult", toolCallId: "call_1", toolName: "screenshot",
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: `blob:sha256:${HASH}`, mimeType: "image/png" },
      ] } },
  { id: "e-a-2", type: "message", timestamp: "2026-08-20T12:00:03.000Z",
    message: { id: "m-a-2", role: "assistant",
      content: [{ type: "text", text: `Here it is:\n\n![shot](blob:sha256:${HASH})\n\nDone.` }] } },
];
const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/${FILE}`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(`${dir}/${FILE}`, when, when);

const webApp = await startWebApp({ base: BASE, port: 5346 });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const browser = await puppeteer.launch({ headless: true, executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-tool-images-`)}`] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const badRequests = [];
  page.on("requestfailed", (r) => { if ((r.url() || "").startsWith("blob:")) badRequests.push(r.url()); });
  page.on("console", (m) => {
    if ((m.text() || "").includes("blob:sha256")) badRequests.push(`console:${m.text().slice(0, 80)}`);
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = els.find((r) => (r.textContent || "").includes("Tool images")) || els[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  await sleep(4000);
  const snap = await page.evaluate(() => ({
    toolImgs: document.querySelectorAll("[data-testid='chat-message'] img").length,
    rawBlobImgs: Array.from(document.querySelectorAll("img")).filter((i) => (i.src || "").startsWith("blob:")).length,
    body: document.body.innerText.slice(0, 600),
  }));
  check("tool image block renders without a raw blob URL", snap.rawBlobImgs === 0, `raw=${snap.rawBlobImgs}`);
  check("no blob resource errors in console or network", badRequests.length === 0, badRequests.slice(0, 2).join(" | "));
  check("no page errors with blob images on screen", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
