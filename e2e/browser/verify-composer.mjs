#!/usr/bin/env node
// Proof for three composer behaviours that failed silently.
//
//   1. Drafts survived a leisurely session switch but not a quick one. The
//      restore effect overwrote `pendingRef` with the incoming session and THEN
//      asked whether the pending write belonged to the incoming session — true
//      by construction — so it always cancelled the outgoing session's
//      debounce. Type in A, tap B within 300ms, come back: your text was gone.
//
//   2. Pasting text and an image together dropped the text. Both arrive in one
//      clipboard event, and preventDefault (needed to attach the image)
//      cancelled the whole paste.
//
//   3. Where dictation cannot run — plain HTTP, or a WebView without
//      MediaRecorder — the microphone button removed itself and said nothing.
//      The code computed a reason and then discarded it with `void reason`.
//
// No model calls: everything here is fixtures and local interaction.
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { backToSessions, showSessionsList } from "../lib/chat-nav.mjs";

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

const CWD = "/tmp/omp-composer-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-composer`;
mkdirSync(dir, { recursive: true });
const mkSession = (n, title) => {
  const p = `${dir}/2026-08-21T17-0${n}-00-000Z_019ff400-0000-7000-0000-0000001a0${n}ae.jsonl`;
  writeFileSync(
    p,
    [
      { id: `e-s-${n}`, type: "session", cwd: CWD, title },
      {
        id: `e-u-${n}`,
        type: "message",
        timestamp: `2026-08-21T17:0${n}:00.000Z`,
        message: { id: `m-${n}`, role: "user", content: [{ type: "text", text: `Turn in ${title}` }] },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const when = new Date(Date.now() - (10 - n) * 60_000);
  utimesSync(p, when, when);
  return p;
};
const sessionA = mkSession(1, "Composer Alpha");
mkSession(2, "Composer Beta");

const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
await fetch(`${BASE}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ sessionPath: sessionA }) });
await new Promise((r) => setTimeout(r, 13_000));

const webApp = await startWebApp({ base: BASE, port: 5300 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    protocolTimeout: 30_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-cp-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20_000 });

  const openSession = async (title) => {
    await page.evaluate((t) => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
      const hit = rows.find((r) => (r.textContent || "").includes(t));
      if (hit instanceof HTMLElement) hit.click();
    }, title);
    await wait(3500);
  };
  const goBack = async () => {
    await backToSessions(page);
    await wait(2000);
  };
  const composerValue = () =>
    page.evaluate(() => {
      const ta = document.querySelector('textarea[name="message"]');
      return ta instanceof HTMLTextAreaElement ? ta.value : null;
    });

  // ── 1. draft survives a switch made inside the debounce window ──
  await openSession("Composer Alpha");
  const box = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="message"]');
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  check("the composer is present", box !== null);
  await page.mouse.click(box.x, box.y);
  await page.keyboard.type("half-written thought");
  // Leave immediately: the write is debounced by 300ms and must not be lost.
  await backToSessions(page);
  await wait(1500);
  await openSession("Composer Beta");
  const betaValue = await composerValue();
  check("the draft does not leak into the other session", betaValue === "", JSON.stringify(betaValue));
  await goBack();
  await openSession("Composer Alpha");
  const alphaValue = await composerValue();
  check(
    "a draft survives switching away inside the debounce window",
    alphaValue === "half-written thought",
    JSON.stringify(alphaValue),
  );

  // ── 2. pasting text and an image keeps both ──
  await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="message"]');
    if (ta instanceof HTMLTextAreaElement) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  });
  const pasted = await page.evaluate(async () => {
    const ta = document.querySelector("textarea[name='message']");
    if (!(ta instanceof HTMLTextAreaElement)) return false;
    // 1x1 PNG
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "shot.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    dt.setData("text/plain", " AND PASTED WORDS");
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  });
  check("a paste event can be delivered to the composer", pasted);
  await wait(2500);
  const afterPaste = await composerValue();
  check(
    "pasting an image alongside text keeps the text",
    typeof afterPaste === "string" && afterPaste.includes("AND PASTED WORDS"),
    JSON.stringify(afterPaste),
  );

  await browser.close();

  // ── 3. dictation that cannot run explains itself ──
  //
  // The page CSP forbids unsafe-eval, so evaluateOnNewDocument with an eval'd
  // stub never installs. Use the CDP call directly, and only AFTER Page.enable
  // or it is a silent no-op.
  const browser2 = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    protocolTimeout: 30_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-cp2-`)}`],
  });
  const page2 = await browser2.newPage();
  await page2.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const cdp = await page2.createCDPSession();
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "try { Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true }); } catch (e) {}",
  });
  await openPairedPage(page2, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page2.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page2);
  await page2.waitForSelector("[data-testid='session-row']", { timeout: 20_000 });
  await page2.evaluate(() => {
    const r = document.querySelector("[data-testid='session-row']");
    if (r instanceof HTMLElement) r.click();
  });
  await wait(3500);

  // Headless Chromium exposes no capture device, so canRecord() already fails
  // on getUserMedia; the MediaRecorder stub above covers the other half of the
  // gate. Either way the hook reports "unsupported", which is the state under
  // test — assert the user-visible outcome rather than the mechanism.
  // An unavailable microphone stays visible as an enabled help button: its
  // title gives the reason and a tap opens the explanation sheet.
  const mic = await page2.evaluate(() => {
    const hit = document.querySelector("[data-testid='voice-button']");
    if (!hit) return null;
    return { label: hit.getAttribute("aria-label"), title: hit.getAttribute("title"), disabled: hit.disabled };
  });
  check(
    "the microphone stays visible and says why it cannot be used",
    mic !== null && mic.disabled === false && /voice input help/i.test(mic.label || "") && /not supported|secure context|unavailable|microphone/i.test(mic.title || ""),
    JSON.stringify(mic),
  );

  check("no page errors across the composer surfaces", errors.length === 0, errors.join(" | "));
  await browser2.close();
} finally {
  webApp.stop();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures);
