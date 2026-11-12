#!/usr/bin/env node
// The running state must not hide or disable the follow-up send path.
//
// Mounts the real Composer from the Vite dev server on a blank page. No
// daemon: transcription is stubbed and every other API/WebSocket request is refused.
// Exercises Enter and button sends while busy, the separate Stop action, and
// draft/attachment durability across delayed saves and session changes.
//   node e2e/browser/verify-composer-busy-enter.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { loadPuppeteer, chromium } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const imageFixture = `${tmpdir()}/omp-composer-image-${process.pid}.png`;
writeFileSync(imageFixture, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1QAAAABJRU5ErJggg==", "base64"));

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: new URL("../../web/", import.meta.url),
    env: { ...process.env, OMP_PULSE_WEB_TARGET: "http://127.0.0.1:9" },
    stdio: "ignore",
  },
);
const origin = `http://127.0.0.1:${port}`;
let browser;
try {
  for (let i = 0; i < 200; i++) {
    if (vite.exitCode !== null) throw new Error(`vite exited: ${vite.exitCode}`);
    try {
      if ((await fetch(`${origin}/`)).ok) break;
    } catch {}
    await sleep(100);
  }
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-busy-enter-`)}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/__harness")
      return request.respond({
        contentType: "text/html",
        body: '<!doctype html><html><body><div id="root"></div></body></html>',
      });
    if (path === "/api/transcribe")
      return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, text: "voice transcript" }) });
    if (path.startsWith("/api") || path.startsWith("/ws")) return request.abort();
    return request.continue();
  });
  await page.goto(`${origin}/__harness`);
  // optimized-deps URLs the app entry uses, which is what Composer gets too.
  const mounted = await page.evaluate(async (base) => {
    // The preamble Vite injects into index.html; @vitejs/plugin-react
    // refuses to evaluate components without it.
    const { injectIntoGlobalHook } = await import(new URL("/@react-refresh", base).href);
    injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    window.MediaRecorder = class { constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; } start() { this.state = "recording"; } stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(new Event("stop")); } };
    const entry = await (await fetch("/src/main.tsx")).text();
    const dep = (name) =>
      new RegExp(`/node_modules/\\.vite/deps/${name}\\.js\\?v=[\\w-]+`).exec(entry)?.[0];
    const reactUrl = dep("react");
    const clientUrl = dep("react-dom_client");
    if (!reactUrl || !clientUrl) return "no optimized react imports in the transformed entry";
    // Optimized CommonJS deps expose their exports on `default`.
    const React = (await import(new URL(reactUrl, base).href)).default;
    const { createRoot } = (await import(new URL(clientUrl, base).href)).default;
    const { Composer } = await import(new URL("/src/app/composer/Composer.tsx", base).href);
    window.__stops = 0;
    window.__sends = [];
    window.__sentImageCounts = [];
    window.__delaySave = false;
    window.__pendingSaves = [];
    window.__voiceFail = false;
    window.__rejectVoice = null;
    const root = createRoot(document.getElementById("root"));
    window.__render = (busy, path = "/tmp/busy-enter.jsonl") =>
      root.render(
        React.createElement(Composer, {
          sessionPath: path,
          busy,
          commands: [],
          onSend: async (text, images, _target, onSaved) => {
            window.__sends.push(text);
            window.__sentImageCounts.push(images.length);
            if (window.__delaySave) {
              await new Promise((resolve) =>
                window.__pendingSaves.push(() => {
                  onSaved();
                  resolve();
                }),
              );
            } else if (!window.__skipSaved) onSaved();
            if (window.__voiceFail && text.endsWith("voice transcript"))
              await new Promise((_resolve, reject) => { window.__rejectVoice = () => reject(new Error("saved interruption")); });
          },
          onStop: () => {
            window.__stops++;
          },
        }),
      );
    window.__render(true);
    return "mounted";
  }, origin);
  check("the real Composer mounts", mounted === "mounted", mounted);

  const box = 'textarea[name="message"]';
  await page.waitForSelector(box, { timeout: 15_000 });
  await sleep(300); // attachment-draft restore settles
  await page.focus(box);
  await page.keyboard.type("and also check the tests");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__sends.length === 1);
  const busyEnter = await page.evaluate((sel) => ({
    stops: window.__stops,
    sends: window.__sends,
    draft: document.querySelector(sel).value,
    sendVisible: !!document.querySelector("[data-testid='composer-send-btn']"),
    stopVisible: !!document.querySelector("[data-testid='composer-stop-btn']"),
  }), box);
  check("Enter while the agent works steers without stopping the turn", busyEnter.stops === 0 && busyEnter.sends[0] === "and also check the tests", JSON.stringify(busyEnter));
  check("the busy Send clears only the durably saved draft", busyEnter.draft === "", JSON.stringify(busyEnter.draft));
  check("Stop takes the action slot back once the draft is sent", busyEnter.stopVisible && !busyEnter.sendVisible, JSON.stringify(busyEnter));

  await page.focus(box);
  await page.keyboard.type("button follow-up");
  check("typing while busy turns the slot into Send", await page.evaluate(() => !!document.querySelector("[data-testid='composer-send-btn']") && !document.querySelector("[data-testid='composer-stop-btn']")));
  await page.click("[data-testid='composer-send-btn']");
  await page.waitForFunction(() => window.__sends.length === 2);
  check("the busy Send button steers the draft into the turn",
    await page.evaluate(() => window.__sends[1]) === "button follow-up");
  await page.click("[data-testid='composer-stop-btn']");
  await sleep(200);
  const stopped = await page.evaluate(() => window.__stops);
  check("Stop in the empty slot stops the turn", stopped === 1, `stops=${stopped}`);

  await page.evaluate(() => window.__render(false));
  await sleep(200);
  await page.focus(box);
  await page.keyboard.type("idle send");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__sends.length === 3);
  const idleEnter = await page.evaluate((sel) => ({ sends: window.__sends, stops: window.__stops, draft: document.querySelector(sel).value }), box);
  check("once the turn ends, Enter still sends normally",
    idleEnter.sends[2] === "idle send" && idleEnter.draft === "" && idleEnter.stops === 1, JSON.stringify(idleEnter));
  await page.evaluate(() => { window.__delaySave = true; window.__render(true, "/tmp/send-durable.jsonl"); });
  await sleep(300);
  await page.focus(box);
  await page.keyboard.type("durable original");
  await page.click("[data-testid='composer-send-btn']");
  await page.waitForFunction(() => window.__sends.length === 4);
  await page.focus(box);
  await page.keyboard.press("Enter");
  await sleep(100);
  const pendingSend = await page.evaluate((sel) => ({
    count: window.__sends.length,
    text: document.querySelector(sel).value,
    disabled: document.querySelector("[data-testid='composer-send-btn']").disabled,
    saves: window.__pendingSaves.length,
  }), box);
  check("a duplicate Enter during durable enqueue does not send twice or blank the draft",
    pendingSend.count === 4 && pendingSend.text === "durable original" && pendingSend.disabled && pendingSend.saves === 1, JSON.stringify(pendingSend));
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.type("new draft during save");
  await page.evaluate(() => window.__pendingSaves[0]());
  await page.waitForFunction(() => !document.querySelector("[data-testid='composer-send-btn']").disabled);
  await sleep(350);
  const delayedSave = await page.evaluate((sel) => ({
    text: document.querySelector(sel).value,
    stored: Object.entries(localStorage).find(([key]) => key.endsWith("/tmp/send-durable.jsonl"))?.[1] ?? null,
    count: window.__sends.length,
  }), box);
  check("a durable enqueue preserves edits made while its save was pending",
    delayedSave.text === "new draft during save" && delayedSave.stored === delayedSave.text && delayedSave.count === 4, JSON.stringify(delayedSave));
  await page.evaluate(() => { window.__delaySave = false; window.__render(false); });
  await sleep(250);
  // Dictation: a tap on the mic records; "Insert and send" sends the whole
  // draft through the ordinary durable send.
  const dictateAndSend = async () => {
    await page.click("[data-testid=voice-button]");
    await page.waitForSelector("[data-testid=dictation-send]", { timeout: 10_000 });
    await page.click("[data-testid=dictation-send]");
  };
  await page.evaluate(() => { window.__voiceFail = true; });
  await dictateAndSend();
  await page.waitForFunction(() => window.__sends.includes("voice transcript"), { timeout: 10_000 });
  await page.focus(box);
  await page.keyboard.type("newer typed draft");
  await page.evaluate(() => window.__rejectVoice?.());
  await sleep(300);
  const sameSession = await page.$eval(box, (el) => el.value);
  check("saved voice failure preserves the newer same-session draft without restoring dictation", sameSession === "newer typed draft", JSON.stringify(sameSession));

  await page.evaluate(() => { window.__render(false, "/tmp/voice-old.jsonl"); });
  await sleep(250);
  await page.evaluate(() => { window.__voiceFail = true; });
  await dictateAndSend();
  await page.waitForFunction(() => window.__sends.filter((text) => text === "voice transcript").length === 2, { timeout: 10_000 });
  await page.evaluate(() => window.__render(false, "/tmp/voice-new.jsonl"));
  await sleep(250);
  await page.focus(box);
  await page.keyboard.type("new-session draft");
  await page.evaluate(() => window.__rejectVoice?.());
  await sleep(300);
  const switched = await page.evaluate((sel) => ({ draft: document.querySelector(sel).value, oldDrafts: Object.entries(localStorage).filter(([key]) => key.endsWith("/tmp/voice-old.jsonl")).map(([, value]) => value) }), box);
  check("saved voice failure after session switch keeps the new draft and does not restore the old transcript", switched.draft === "new-session draft" && !switched.oldDrafts.includes("voice transcript"), JSON.stringify(switched));
  // Before durability is acknowledged, the same failure must keep the words.
  await page.evaluate(() => { window.__skipSaved = true; window.__rejectVoice = null; });
  await dictateAndSend();
  await page.waitForFunction(() => window.__rejectVoice !== null, { timeout: 10_000 });
  check("Insert and send sends the existing draft with the dictated words",
    await page.evaluate(() => window.__sends.at(-1)) === "new-session draft voice transcript");
  await page.evaluate(() => window.__rejectVoice());
  await page.waitForFunction(() => document.querySelector("textarea[name=message]").value === "new-session draft voice transcript");
  check("voice failure before saving retains dictation alongside the existing draft",
    await page.$eval(box, el => el.value) === "new-session draft voice transcript");
  await page.evaluate(() => window.__render(false, "/tmp/image-source.jsonl"));
  await sleep(300);
  const imageInput = await page.$("input[type='file']:not([capture])");
  await imageInput.uploadFile(imageFixture);
  await page.waitForSelector("img[alt^='omp-composer-image-']", { timeout: 10_000 });
  await sleep(350);
  await page.evaluate(() => window.__render(false, "/tmp/image-other.jsonl"));
  await sleep(300);
  const otherSessionImages = await page.$$eval("img[alt^='omp-composer-image-']", (imgs) => imgs.length);
  check("an attachment does not leak into another session", otherSessionImages === 0, `images=${otherSessionImages}`);
  await page.evaluate(() => window.__render(false, "/tmp/image-source.jsonl"));
  await sleep(300);
  const restoredImage = await page.$$eval("img[alt^='omp-composer-image-']", (imgs) => imgs.length);
  check("the attachment draft returns to its owning session", restoredImage === 1, `images=${restoredImage}`);
  await page.evaluate(() => window.__render(true, "/tmp/image-source.jsonl"));
  await sleep(100);
  const beforeImageSend = await page.evaluate(() => window.__sends.length);
  await page.click("[data-testid='composer-send-btn']");
  await page.waitForFunction((count) => window.__sends.length === count + 1, {}, beforeImageSend);
  const imageSend = await page.evaluate(() => ({ count: window.__sends.length, images: window.__sentImageCounts.at(-1) }));
  check("image-only send durably submits the selected attachment once", imageSend.count === beforeImageSend + 1 && imageSend.images === 1, JSON.stringify(imageSend));
  await sleep(350);
  await page.evaluate(() => window.__render(false, "/tmp/image-other.jsonl"));
  await sleep(250);
  await page.evaluate(() => window.__render(false, "/tmp/image-source.jsonl"));
  await sleep(250);
  const sourceAfterSend = await page.$$eval("img[alt^='omp-composer-image-']", (imgs) => imgs.length);
  check("a durably sent attachment is removed only from its own draft", sourceAfterSend === 0, `images=${sourceAfterSend}`);
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  rmSync(imageFixture, { force: true });
}
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
