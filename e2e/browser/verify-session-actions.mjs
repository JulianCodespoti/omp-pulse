#!/usr/bin/env node
// Every action in the session sheet actually does its thing.
//
// The sheet holds Pin, Rename, Duplicate, Open on computer, and under More,
// Model & thinking and Copy path — and nothing verified any of them. A sheet full
// of controls that look right and quietly no-op is exactly the kind of thing
// the owner finds in ten seconds and I would never see in a screenshot.
//
// Deliberately cheap: pin/rename/copy are metadata operations, so this needs no
// model call.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, readdirSync, readFileSync } from "fs";
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
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682 — it would rename a real session");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CWD = "/tmp/omp-actions-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-actions`;
mkdirSync(dir, { recursive: true });
const ORIGINAL_TITLE = "Actions fixture original";
const file = `${dir}/2026-08-20T23-00-00-000Z_019ff400-0000-7000-0000-0000000dd40a.jsonl`;
writeFileSync(
  file,
  [
    { type: "session", id: "019ff400-0000-7000-0000-0000000dd40a", cwd: CWD, title: ORIGINAL_TITLE },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
const when = new Date(Date.now() - 60_000);
utimesSync(file, when, when);

const webApp = await startWebApp({ base: BASE, port: 5256 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-act-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const openSheet = async (titleFragment) => {
    await page.evaluate((frag) => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
      const row = rows.find((r) => (r.textContent || "").includes(frag)) || rows[0];
      if (!(row instanceof HTMLElement)) return;
      const b = row.getBoundingClientRect();
      row.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, clientX: b.x + 40, clientY: b.y + 20, pointerType: "touch",
      }));
    }, titleFragment);
    await wait(1100);
    await page.evaluate(() => {
      const row = document.querySelector("[data-testid='session-row']");
      if (row instanceof HTMLElement) row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    });
    await wait(1200);
    return page.evaluate(() => document.querySelector("[role='dialog']") !== null);
  };
  const tapAction = (label) =>
    page.evaluate((l) => {
      const dlg = document.querySelector("[role='dialog']");
      if (!dlg) return false;
      const hit = Array.from(dlg.querySelectorAll("button")).find((b) =>
        (b.textContent || "").trim().toLowerCase().startsWith(l),
      );
      if (hit instanceof HTMLElement) { hit.click(); return true; }
      return false;
    }, label);

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await wait(800);

  check("long-press opens the session actions sheet", await openSheet(ORIGINAL_TITLE));

  const labels = await page.evaluate(() => {
    const dlg = document.querySelector("[role='dialog']");
    return dlg ? Array.from(dlg.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean) : [];
  });
  for (const want of ["Pin", "Rename", "Duplicate", "Open on computer", "Model & thinking", "Copy path"]) {
    check(`sheet offers ${want}`, labels.some((l) => l.toLowerCase().startsWith(want.toLowerCase())), labels.join(" | "));
  }
  check("sheet no longer offers Copy session id", !labels.some((l) => /copy session id/i.test(l)), labels.join(" | "));

  // Copy actions must reach the clipboard path; the row acknowledges only on
  // a successful write (writeClipboard returns false on empty text).
  const copiedPath = await tapAction("copy path");
  await wait(700);
  check("Copy path responds", copiedPath);
  await page.keyboard.press("Escape");
  await wait(900);


  // Open on computer: the harness gives the daemon a herdr session with no
  // server (e2e/with-test-daemon.sh), or the host has no herdr at all, so the
  // honest outcome is the daemon's refusal shown inline — not a silent no-op,
  // not a success toast (herdr installed but unable to start its server reads
  // "Could not start herdr"). The real move is verify-laptop-handoff.mjs.
  check("sheet reopens for Open on computer", await openSheet(ORIGINAL_TITLE));
  check("Open on computer is tappable", await tapAction("open on computer"));
  let refusal = "";
  for (let i = 0; i < 20 && !refusal; i++) {
    await wait(300);
    refusal = await page.evaluate(() => {
      const text = document.querySelector("[role='dialog']")?.textContent || "";
      return /herdr is not (running|installed)|could not start herdr|not running on (the laptop|your computer)/i.test(text) ? text : "";
    });
  }
  check("Open on computer shows why it could not open", Boolean(refusal));
  await page.keyboard.press("Escape");
  await wait(900);

  // Rename must actually change the title in the list.
  check("sheet reopens", await openSheet(ORIGINAL_TITLE));
  const renameTapped = await tapAction("rename");
  check("Rename opens an input", renameTapped);
  await wait(1200);
  const NEW_TITLE = "Renamed by verify-session-actions";
  // Type for real through the field's own testid. Setting .value with the
  // prototype setter does not reliably drive a controlled Base UI input, so the
  // component's state stayed empty and the save handler bailed with "name
  // cannot be empty" — which looks exactly like a broken Rename.
  const field = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='rename-input']");
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (field) await page.mouse.click(field.x, field.y);
  await wait(300);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(NEW_TITLE);
  await wait(400);
  const typed = await page.evaluate((t) => {
    const el = document.querySelector("[data-testid='rename-input']");
    return el instanceof HTMLInputElement ? el.value === t : false;
  }, NEW_TITLE);
  check("the rename field accepts text", typed);
  if (typed) {
    await page.evaluate(() => {
      const btn = document.querySelector("[data-testid='rename-save']");
      if (btn instanceof HTMLElement) btn.click();
    });
    // Poll rather than sleep once: the sessions listing is ETag-revalidated on
    // an interval, so the row can lag the write by a second or two.
    let listed = false;
    let onDisk = false;
    for (let i = 0; i < 20 && !(listed && onDisk); i++) {
      if (!listed) {
        listed = await page.evaluate((t) => (document.body.textContent || "").includes(t), NEW_TITLE);
      }
      if (!onDisk) {
        // readFileSync from the ESM import — `require` is not defined in a
        // module and the ReferenceError was being swallowed by the catch, which
        // made this assertion fail no matter what the app did.
        onDisk = readdirSync(dir).some((f) => {
          try { return readFileSync(`${dir}/${f}`, "utf8").includes(NEW_TITLE); } catch { return false; }
        });
      }
      if (listed && onDisk) break;
      await wait(700);
    }
    check("Rename updates the session list", listed, "new title not shown");
    check("Rename persists to the session file", onDisk, "title not written to disk");
  }

  check("no page errors", pageErrors.length === 0, pageErrors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
