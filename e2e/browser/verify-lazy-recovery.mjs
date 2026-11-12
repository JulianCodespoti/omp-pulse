#!/usr/bin/env node
// Real Chromium ESM module-map regression: abort a screen module download,
// restore the network, then recover through a draft-safe document reload.
// No model calls; all state belongs to the throwaway e2e daemon.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS || BASE.includes("7682")) {
  throw Error("Run through e2e/with-test-daemon.sh against a throwaway daemon, never the live daemon.");
}
const cwd = mkdtempSync(`${tmpdir()}/omp-lazy-recovery-project-`);
const directory = `${SESSIONS}/-tmp-verify-lazy-recovery`;
const id = "019ff400-0000-7000-0000-0000000000f8";
const title = "Lazy recovery draft fixture";
mkdirSync(directory, { recursive: true });
const path = `${directory}/2026-08-20T12-30-00-000Z_${id}.jsonl`;
writeFileSync(path, [
  { type: "title", title },
  { type: "session", id, cwd, title },
].map(entry => JSON.stringify(entry)).join("\n") + "\n");
const when = new Date(Date.now() - 120_000);
utimesSync(directory, when, when);

const puppeteer = await loadPuppeteer();
const webApp = await startWebApp({ base: BASE, port: 5361, vite: true });
const browserProfile = mkdtempSync(`${tmpdir()}/omp-lazy-recovery-browser-`);
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${browserProfile}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  let blockModule = true;
  let blocked = 0;
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (blockModule && new URL(request.url()).pathname.endsWith("/sessions/NewSessionScreen.tsx")) {
      blocked++;
      void request.abort("failed");
    } else {
      void request.continue();
    }
  });
  // Deep link: a cold start must land on the chat, not on the (lazy) home screen.
  await openPairedPage(page, `${webApp.url.replace(/#.*/, "")}#${new URLSearchParams({ s: path })}`, TOKEN, { waitUntil: "networkidle0" });
  const openFixtureFromList = async () => {
    await showSessionsList(page);
    const opened = await page.evaluate(expected => {
      const row = [...document.querySelectorAll('[data-testid="session-row"]')].find(node => node.textContent.includes(expected));
      row?.click();
      return Boolean(row);
    }, title);
    assert.equal(opened, true, "fixture conversation exists");
  };
  await page.waitForSelector('[data-testid="composer-input"]');
  const draft = "Keep this unsent conversation draft through recovery";
  await page.type('[data-testid="composer-input"]', draft);
  const openNewSession = async () => {
    await page.waitForFunction(() => !document.documentElement.dataset.nav);
    // The switcher is the header's ☰ button.
    await page.evaluate(() => document.querySelector('[data-testid="session-back"]').click());
    await page.waitForSelector('[data-testid="session-switcher"] [data-testid="switcher-new-chat"]', { visible: true });
    // The switcher sheet can still be sliding in, which puppeteer treats as unclickable.
    await page.evaluate(() => document.querySelector('[data-testid="session-switcher"] [data-testid="switcher-new-chat"]').click());
    // View-transition snapshots intercept pointer events until the push ends.
    await page.waitForFunction(() => !document.documentElement.dataset.nav);
  };
  const clickReload = () => page.evaluate(() => {
    const button = [...document.querySelectorAll('[data-screen="home"] button')].find(node => node.textContent === "Reload app");
    if (!button) throw Error("Reload app action is missing");
    button.click();
  });
  // New chat is the home base screen: opening it leaves the chat, and the failed
  // lazy import shows its recovery alert inside the "New chat" screen boundary.
  await openNewSession();
  await page.waitForSelector('[data-screen="home"] [role="alert"]');
  assert.equal(blocked > 0, true, "the actual screen module download was aborted");
  assert.equal(await page.$('[data-testid="new-session-input"]') === null, true, "failed module did not render its screen");
  assert.equal(await page.$eval('[data-screen="home"] h1', element => element.textContent), "New chat", "recovery alert sits in the New chat screen boundary");
  blockModule = false;

  // A rejected write must stop recovery instead of discarding an in-memory
  // new-session draft. This is a real owner/storage failure, not a stubbed barrier.
  const newDraft = "Keep this new-session draft too";
  await page.evaluate(async text => {
    const { getNewSessionDraft } = await import("/src/runtime/new-session-draft.ts");
    window.originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw Error("Injected storage failure"); };
    getNewSessionDraft().update({ text });
  }, newDraft);
  const before = await page.evaluate(() => performance.timeOrigin);
  await clickReload();
  await page.waitForFunction(() => document.querySelector('[data-screen="home"]')?.textContent.includes("The app was not reloaded."));
  assert.equal(await page.evaluate(() => performance.timeOrigin), before, "failed persistence refuses document reload");
  assert.equal(await page.$('[data-screen="home"] [role="alert"]') !== null, true, "failed recovery keeps the recovery alert visible");
  await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; });

  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), clickReload()]);
  await page.waitForSelector('[data-testid="session-row"], [data-testid="composer-input"], [data-testid="new-session-menu"]');
  await openFixtureFromList();
  await page.waitForSelector('[data-testid="composer-input"]');
  assert.equal(await page.$eval('[data-testid="composer-input"]', element => element.value), draft, "document recovery restores the conversation draft");
  await openNewSession();
  await page.waitForSelector('[data-testid="new-session-input"]');
  assert.equal(await page.$eval('[data-testid="new-session-input"]', element => element.value), newDraft, "restored network loads the real screen and preserves its draft");
  console.log("ok  real failed ESM screen download recovers through draft-safe reload; persistence failure refuses reload and preserves drafts");
} finally {
  await browser?.close();
  webApp.stop();
  rmSync(browserProfile, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
