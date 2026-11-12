#!/usr/bin/env node
// Regression proof for drafts shared by two views of one conversation.
//
// Reproduced fault: both windows mount the same empty composer, one types and
// saves, and the untouched window's blur or close wrote its own empty snapshot
// back over the saved draft. Send cleanup had the same shape — it removed the
// saved draft outright, so a draft another view wrote while the send was in
// flight was erased with it.
//
// Two real same-origin documents, one real composer, one real session. No model
// call: the send-cleanup contract is checked on the module the composer calls.
// Run through e2e/with-test-daemon.sh like every other suite.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-shared-drafts.mjs");
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

const DIR = "-tmp-verify-shared-drafts";
const SID = "019ff400-0000-7000-0000-0000000000f1";
const TITLE = "Shared Draft Alpha";
const sessionPath = `${SESSIONS}/${DIR}/2026-08-20T12-30-00-000Z_${SID}.jsonl`;
mkdirSync(`${SESSIONS}/${DIR}`, { recursive: true });
writeFileSync(
  sessionPath,
  [
    { type: "title", title: TITLE },
    { type: "session", id: SID, cwd: "/tmp/verify-shared-drafts", title: TITLE },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(`${SESSIONS}/${DIR}`, when, when);

// vite: the page imports web/src/app/composer/use-draft.ts directly.
const webApp = await startWebApp({ base: BASE, port: 5346, vite: true });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-shared-drafts-`)}`],
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const origin = webApp.url;
  const pageErrors = [];

  const openConversation = async (page) => {
    await openPairedPage(page, origin, TOKEN, { waitUntil: "networkidle0" });
    await page.reload({ waitUntil: "networkidle0" });
    await showSessionsList(page);
    await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
    const opened = await page.evaluate((title) => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
      const row = rows.find((r) => (r.textContent || "").includes(title)) || rows[0];
      if (row instanceof HTMLElement) {
        row.click();
        return true;
      }
      return false;
    }, TITLE);
    if (!opened) throw new Error("fixture session row not found");
    await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
    await sleep(1200);
  };

  const composerText = (page) =>
    page.evaluate(() => {
      const el = document.querySelector("[data-testid='composer-input']");
      return el instanceof HTMLTextAreaElement ? el.value : null;
    });

  const savedDraft = (page) =>
    page.evaluate(async (path) => {
      const draft = await import("/src/app/composer/use-draft.ts");
      return draft.readDraft(path);
    }, sessionPath);

  // Taking focus is a real window focus and visibility change: it is what a
  // user switching back to this view does.
  const focusComposer = async (page) => {
    await page.bringToFront();
    const box = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='composer-input']");
      if (!(el instanceof HTMLElement)) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    if (!box) throw new Error("composer input not found");
    await page.mouse.click(box.x, box.y);
  };

  /**
   * Typing into one view must not take focus away from another: bringing a
   * view to the front would flush the other one, which is the opposite of two
   * people editing at once. Typing over the whole selection replaces it in a
   * single edit, so a view never publishes an empty draft on the way.
   */
  const typeInto = async (page, text) => {
    await page.evaluate(() => {
      const el = document.querySelector("[data-testid='composer-input']");
      if (el instanceof HTMLElement) el.focus();
    });
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.type(text);
  };

  const newView = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 140)));
    await openConversation(page);
    return page;
  };

  const first = await newView();
  const second = await newView();
  check("both views open the same conversation",
    (await composerText(first)) === (await composerText(second)));

  // 1. One view edits. The other has typed nothing at all.
  await typeInto(first, "alpha draft");
  await sleep(900);
  const savedByFirst = await savedDraft(first);
  check("the editing view saved its draft", savedByFirst === "alpha draft", JSON.stringify(savedByFirst));

  // 2. The untouched view loses focus and takes it back. It must not write.
  await focusComposer(first);
  await sleep(500);
  await focusComposer(second);
  await sleep(700);
  const afterBlur = await savedDraft(first);
  check("an untouched view's blur does not erase the saved draft",
    afterBlur === "alpha draft", JSON.stringify(afterBlur));
  const followed = await composerText(second);
  check("the untouched view follows the saved draft",
    followed === "alpha draft", JSON.stringify(followed));

  // 3. Closing an untouched view must not write either.
  const third = await newView();
  await third.close();
  await sleep(800);
  const afterClose = await savedDraft(first);
  check("closing an untouched view does not erase the saved draft",
    afterClose === "alpha draft", JSON.stringify(afterClose));

  // A successful save ends edit ownership. A later edit in the other view
  // must not be merged with this view's already-saved, obsolete text on blur.
  await typeInto(second, "replacement draft");
  await sleep(900);
  await first.evaluate(() => window.dispatchEvent(new Event("blur")));
  await sleep(700);
  check("a previously edited view cannot resurrect its saved snapshot on blur",
    (await savedDraft(first)) === "replacement draft"
      && (await composerText(first)) === "replacement draft"
      && (await composerText(second)) === "replacement draft");

  // 4. Both views type before either has saved. Neither may lose its words.
  await typeInto(first, "alpha concurrent");
  await sleep(150);
  await typeInto(second, "beta concurrent");
  await sleep(1800);
  const merged = await savedDraft(first);
  check("two views editing keep both texts",
    merged.includes("alpha concurrent") && merged.includes("beta concurrent"),
    JSON.stringify(merged));

  // 5. Send cleanup only clears the snapshot it submitted. A draft written
  //    since then is newer unsent work and must survive.
  const cleanup = await first.evaluate(async (path) => {
    const draft = await import("/src/app/composer/use-draft.ts");
    const namespace = draft.getDraftNamespace();
    const before = draft.readDraft(path);
    draft.removeDraft(path, namespace, "text that was already sent");
    const afterStale = draft.readDraft(path);
    draft.removeDraft(path, namespace, before);
    return { before, afterStale, afterMatch: draft.readDraft(path) };
  }, sessionPath);
  check("send cleanup with a stale snapshot keeps the newer draft",
    cleanup.afterStale === cleanup.before, JSON.stringify(cleanup));
  check("send cleanup clears the draft it actually sent",
    cleanup.afterMatch === "", JSON.stringify(cleanup));

  check("no page errors during the shared-draft journey",
    pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
