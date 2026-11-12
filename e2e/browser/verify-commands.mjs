#!/usr/bin/env node
// Regression proof that omp's slash commands keep their laptop shapes on the phone.
//
// On the desktop each command behaves differently and that difference IS the
// product: `/model` opens a picker, `/compact` just runs, and a command that
// takes free text asks for it first. The phone must not flatten them.
//
// It also guards the bigger regression: 19 builtins used to be classified
// "desktop", so tapping them toasted "Runs in the desktop TUI" and did nothing.
// They were runnable the whole time — omp's rpc-mode `prompt` handler calls
// executeAcpBuiltinSlashCommand, and buildAvailableSlashCommands only lists
// builtins whose `handle` is defined.
//
// Runs under e2e/with-test-daemon.sh against a throwaway vite dev server.
// Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

const PALETTE_ITEMS = "[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])";
const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-commands.mjs");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
// Detail is failure evidence, so only print it on failure: an "ok" line
// followed by the reason it would have failed reads as a contradiction.
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const DIR = "-tmp-verify-commands";
const FILE = "2026-08-20T12-30-00-000Z_019ff400-0000-7000-0000-0000000000c1.jsonl";
const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const sessionFile = `${dir}/${FILE}`;
writeFileSync(
  sessionFile,
  [
    { type: "session", id: "019ff400-0000-7000-0000-0000000000c1", cwd: "/tmp/verify-commands", title: "Command shapes fixture" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(sessionFile, when, when);

const webApp = await startWebApp({ base: BASE, port: 5196 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-verify-cmds-`)}`,
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Command shapes")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // The palette is opened by typing "/" in the composer, same as the laptop.
  // Typing the name as well narrows the list: it is virtualized, so a command
  // that is not near the top simply is not in the DOM to assert on.
  const openPaletteFiltered = async (name) => {
    await page.evaluate(() => {
      const el = document.querySelector("textarea, [contenteditable='true']");
      if (el instanceof HTMLElement) el.focus();
    });
    await page.keyboard.type(`/${name}`);
    await new Promise((r) => setTimeout(r, 1200));
  };

  // Command rows as rendered: the inline slash list above the composer and the
  // command sheet. This used to match cmdk items, but neither list has used
  // cmdk since the Item rewrite, so every check here found zero rows.
  const paletteItems = () =>
    page.evaluate(
      (sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent || "").trim()),
      PALETTE_ITEMS,
    );

  const clearComposer = async () => {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await new Promise((r) => setTimeout(r, 500));
  };

  await openPaletteFiltered("model");
  let items = await paletteItems();
  check("slash opens the command palette", items.length > 0, `${items.length} items`);
  check("/model is offered", items.some((t) => t.startsWith("/model")), items.slice(0, 3).join(" | "));
  // The regression this file exists for: nothing may advertise itself as
  // laptop-only, because nothing is.
  check(
    "no command is labelled desktop only",
    !items.some((t) => /desktop only/i.test(t)),
    "a command still claims it cannot run here",
  );
  await clearComposer();

  await openPaletteFiltered("compact");
  items = await paletteItems();
  check("/compact is offered", items.some((t) => t.startsWith("/compact")), items.slice(0, 3).join(" | "));
  await clearComposer();

  // A free-text builtin must ASK for its arguments, exactly like the TUI
  // prompts before sending. This used to toast "Runs in the desktop TUI".
  await openPaletteFiltered("review");
  items = await paletteItems();
  check("/review is offered", items.some((t) => t.startsWith("/review")), items.slice(0, 3).join(" | "));

  const tapped = await page.evaluate((sel) => {
    const hit = Array.from(document.querySelectorAll(sel)).find(
      (el) => (el.textContent || "").trim().startsWith("/review"),
    );
    if (hit instanceof HTMLElement) {
      hit.click();
      return true;
    }
    return false;
  }, PALETTE_ITEMS);
  await new Promise((r) => setTimeout(r, 1200));
  const bodyText = await page.evaluate(() => document.body.textContent || "");
  check("tapping /review is not refused", tapped && !/desktop TUI/i.test(bodyText));
  const sheet = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='command-input-sheet']");
    return el ? (el.textContent || "").trim().slice(0, 120) : null;
  });
  check("/review asks for its arguments before sending", sheet !== null && sheet.includes("/review"), sheet ?? "no sheet");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
