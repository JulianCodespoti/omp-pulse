#!/usr/bin/env node
// When the computer goes away, the drawer must say so instead of loading
// forever, keep the chats it already had, and recover by itself when the link
// returns. The network is cut at the browser (setOfflineMode), which is what a
// phone with Tailscale off looks like: every request fails and the sockets die.
//
// No model calls.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-link-state.mjs");
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

const CWD = "/tmp/verify-link-state";
const dir = `${SESSIONS}/${CWD.replaceAll("/", "-")}`;
mkdirSync(dir, { recursive: true });
mkdirSync(CWD, { recursive: true });
const stamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
for (const [i, title] of ["Link Alpha", "Link Beta"].entries()) {
  const sid = `019ff500-0000-7000-0000-00000000000${i + 1}`;
  const entries = [
    { type: "title", title },
    { type: "session", id: sid, cwd: CWD, title },
    { id: `${sid}-u`, type: "message", timestamp: stamp, message: { id: `${sid}-mu`, role: "user", content: [{ type: "text", text: "hi" }] } },
  ];
  writeFileSync(`${dir}/2026-08-20T12-1${i}-00-000Z_${sid}.jsonl`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(dir, when, when);

const webApp = await startWebApp({ base: BASE, port: 5371 });
const profile = mkdtempSync(`${tmpdir()}/omp-verify-link-state-`);
try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  // Offline emulation fails new requests but leaves an open WebSocket delivering,
  // which a real dead link would not. Track the daemon's sockets so the cut can
  // drop them (not vite's HMR socket, whose loss reloads the page).
  await page.evaluateOnNewDocument(() => {
    const Native = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = new Proxy(Native, {
      construct(target, args) {
        const socket = new target(...args);
        if (/\/ws(\/|\?)/.test(String(args[0]))) window.__sockets.push(socket);
        return socket;
      },
    });
  });
  const cutLink = async () => {
    await page.setOfflineMode(true);
    await page.evaluate(() => window.__sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } }));
  };
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await page.evaluate(fn).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const rows = () => page.evaluate(() => document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']").length);

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid='new-session-menu']", { timeout: 20000 });
  await (await page.$("[data-testid='new-session-menu']")).click();
  await page.waitForSelector("[data-testid='session-switcher']", { timeout: 10000 });
  check("the drawer lists the chats while connected", await until(() => document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']").length >= 2, 15000));
  check("no connection banner while the link is live", (await page.$("[data-testid='link-banner']")) === null);
  const before = await rows();

  await cutLink();
  check("cutting the link raises the banner without a tap", await until(() => !!document.querySelector("[data-testid='link-banner']"), 20000));
  const state = await page.$eval("[data-testid='switcher-computer']", (n) => n.getAttribute("data-state")).catch(() => "");
  // cutLink() takes the browser's network away, so the one indicator reads "offline" (unreachable plus no network).
  check("the computer row says the link is down, as the one indicator reads it", state === "unreachable" || state === "offline", state);
  check("the chats it already had stay on screen", (await rows()) === before && before >= 2, `rows=${await rows()}/${before}`);
  check("no skeleton replaces them", (await page.$("[aria-label='Loading sessions']")) === null);

  await page.setOfflineMode(false);
  check("the banner clears by itself when the link returns", await until(() => !document.querySelector("[data-testid='link-banner']"), 45000));
  check("the computer row says Connected again", (await page.$eval("[data-testid='switcher-computer']", (n) => n.getAttribute("data-state")).catch(() => "")) === "ok");

  // The chat is where the old "Reconnecting to your computer…" spinner sat for
  // as long as the computer was away, saying nothing.
  await page.click("[data-testid='session-switcher'] [data-testid='session-row']");
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  check("a connected chat shows no connection pill", await until(() => !document.querySelector("[data-testid='chat-offline-hint']"), 15000));
  await cutLink();
  check("cutting the link puts the cause in the chat's pill", await until(() => /^(Can.t reach|You.re offline)/.test(document.querySelector("[data-testid='chat-offline-hint']")?.textContent ?? ""), 25000));
  check("the chat does not also raise a red timeout error beside the pill", await page.evaluate(() => !document.querySelector("[data-testid='chat-error']")));
  await page.click("[data-testid='session-back']").catch(() => undefined);
  check("one notice only: the drawer's banner is there and the chat's pill stands down", await until(() => !!document.querySelector("[data-testid='link-banner']") && !document.querySelector("[data-testid='chat-offline-hint']"), 10000));
  await page.setOfflineMode(false);
  check("the pill clears by itself when the link returns", await until(() => !document.querySelector("[data-testid='chat-offline-hint']"), 45000));
  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
