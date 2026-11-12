#!/usr/bin/env node
// The composer does what the omp TUI editor does (parity P-2, P-3, P-5, P-6),
// against a real omp child, and stays calm at large text (U-19, U-21).
//
//   1. `/session` + Enter prints omp's output in a sheet. A builtin typed out
//      in full used to open its subcommand menu, and a typed `/cmd args`
//      reached omp through /api/prompt, whose command_output nothing renders.
//   2. `/todo append …` (a builtin with arguments) reaches omp and prints.
//   3. `!cmd` runs as a user shell command in the Terminal tab, omp records
//      it, and the transcript shows it after a reload. `!!cmd` says it stays
//      out of context.
//   4. Up/Down on an empty composer walks prompts this device sent.
//   5. + → History lists them, merges the user's transcript messages, and a
//      tap fills the composer without sending.
//   6. `@` lists files in the session folder, filters as you type, and
//      inserts a path omp inlines.
//   7. The empty field is one row at 100% and 150% text. The composer is two
//      tiers (field above, toolbar below) with one action slot that always
//      holds Send: empty or a lone `/`, Send is disabled beside the mic.
//
// No model calls: builtins and shell commands run locally in omp.
// Runs under e2e/with-test-daemon.sh. Paths resolve from this checkout, so it
// runs on a laptop or the phone. COMPOSER_PARITY_SHOTS=<dir> saves screenshots.
// The web app and browser come from e2e/lib/env.mjs (OMP_PULSE_E2E_APP,
// OMP_PULSE_CHROMIUM, ...). Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run under e2e/with-test-daemon.sh");
  process.exit(2);
}
if (BASE.includes("7682") || BASE.includes("7681")) {
  console.error("refusing a live daemon port");
  process.exit(2);
}
const SHOTS = process.env.COMPOSER_PARITY_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CWD = "/tmp/verify-composer-parity";
mkdirSync(`${CWD}/src`, { recursive: true });
writeFileSync(`${CWD}/src/alpha.txt`, "alpha\n");
writeFileSync(`${CWD}/README.md`, "# fixture\n");
const ID = "019ff400-0000-7000-0000-0000000000c7";
const dir = `${SESSIONS}/-tmp-verify-composer-parity`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/2026-08-20T12-56-00-000Z_${ID}.jsonl`;
const NEEDLE = "parity transcript needle about deployment";
// No assistant row: omp restores the model from the newest assistant message,
// and one without provider/model makes it refuse to open the session
// ("Could not restore model undefined/undefined").
writeFileSync(
  file,
  [
    { type: "session", version: 3, id: ID, timestamp: new Date(Date.now() - 600_000).toISOString(), cwd: CWD, title: "Composer parity fixture" },
    { type: "message", id: "u1", parentId: null, timestamp: new Date(Date.now() - 590_000).toISOString(), message: { role: "user", content: [{ type: "text", text: NEEDLE }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n",
);
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(file, when, when);

// Builtins and bash need a live child; warm it and wait for the catalogue.
const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
await fetch(`${BASE}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ sessionPath: file }) });
for (let i = 0; i < 60; i++) {
  const r = await fetch(`${BASE}/api/commands?session=${encodeURIComponent(file)}`, { headers: H }).then((x) => x.json()).catch(() => ({}));
  if (Array.isArray(r.commands) && r.commands.length > 10) break;
  await wait(1000);
}
// The child itself must be up before the browser leans on it: a builtin
// answers only once omp has booted (slow on a loaded phone).
const t0 = Date.now();
let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  const r = await fetch(`${BASE}/api/command`, { method: "POST", headers: H, body: JSON.stringify({ sessionPath: file, text: "/session" }) })
    .then((x) => x.json()).catch(() => ({}));
  ready = r.ok === true && typeof r.output === "string" && r.output.includes("Session");
  if (!ready) await wait(1000);
}
console.log(`omp child ${ready ? "ready" : "NOT ready"} after ${Date.now() - t0} ms`);

const webApp = await startWebApp({ base: BASE, port: 5266 });
// The browser profile (~125 MB once Chromium has cached the app) goes with
// the run, passed or failed.
const profile = mkdtempSync(`${tmpdir()}/omp-composer-parity-`);

const INPUT = "[data-testid='composer-input']";
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
  const sent = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "POST" && ["/api/command", "/api/prompt", "/api/bash"].includes(u.pathname)) {
      sent.push(`${u.pathname} ${(r.postData() || "").replace(/"sessionPath":"[^"]*",?/, "").slice(0, 100)}`);
    }
  });
  const replies = [];
  page.on("response", async (r) => {
    const u = new URL(r.url());
    if (["/api/command", "/api/bash", "/api/search", "/api/files"].includes(u.pathname)) {
      replies.push(`${u.pathname} ${r.status()} ${(await r.text().catch(() => "")).slice(0, 160)}`);
    }
  });
  const dialogText = () => page.evaluate(() => Array.from(document.querySelectorAll("[role='dialog']")).map((d) => (d.textContent ?? "").slice(0, 200)));

  const shot = async (name) => {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
  };
  const openChat = async () => {
    // A reload lands back in the open chat (its deep link); a cold start opens
    // home or the latest chat, so reach the All chats page when no chat opened.
    await page.waitForSelector(`${INPUT}, [data-testid='new-session-screen'], [data-testid='session-row']`, { timeout: 120000 });
    if (!page.url().includes("#s=")) {
      await showSessionsList(page);
      await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
        const t = rows.find((r) => (r.textContent || "").includes("Composer parity")) || rows[0];
        if (t instanceof HTMLElement) t.click();
      });
    }
    await page.waitForSelector(INPUT, { timeout: 120000 });
    await wait(2500);
  };
  const value = () => page.$eval(INPUT, (t) => t.value);
  const focusInput = () => page.evaluate((sel) => document.querySelector(sel)?.focus(), INPUT);
  const typeAndEnter = async (text) => {
    await focusInput();
    await page.keyboard.type(text, { delay: 15 });
    await wait(400);
    await page.keyboard.press("Enter");
  };
  // Lazy sheets compile on first use under the vite dev server; give them time.
  const waitFor = async (fn, arg, tries = 180) => {
    for (let i = 0; i < tries; i++) {
      const got = await page.evaluate(fn, arg);
      if (got) return got;
      await wait(500);
    }
    return null;
  };
  const closeSheet = async () => {
    await page.keyboard.press("Escape");
    await wait(700);
  };
  // `!cmd` opens the Terminal workspace tab; the composer lives under the drawer.
  const backToChat = async () => {
    await page.evaluate(() => document.querySelector("[data-testid='workspace-close']")?.click());
    await page.waitForSelector("[data-testid='workspace-drawer']:not([data-open])", { timeout: 10000 });
    await wait(700);
  };
  const setRootFont = (percent) => page.evaluate((p) => { document.documentElement.style.fontSize = `${p}%`; }, percent);
  const controls = () => page.evaluate(() => ({
    send: !!document.querySelector("[data-testid='composer-send-btn']"),
    sendEnabled: document.querySelector("[data-testid='composer-send-btn']")?.disabled === false,
    mic: !!document.querySelector("[data-testid='voice-button'], [aria-label*='ictat'], [aria-label*='voice' i]"),
  }));
  // The composer card is two rows (field above, toolbar below); this measures
  // the FIELD: one line + padding, or its minimum height where that is taller.
  const emptyRow = () => page.evaluate((sel) => {
    const t = document.querySelector(sel);
    const cs = getComputedStyle(t);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const card = t.closest("[data-testid='composer-card']") ?? t.parentElement;
    return {
      height: t.getBoundingClientRect().height,
      single: Math.max(line + pad, parseFloat(cs.minHeight) || 0),
      line,
      card: card.getBoundingClientRect().height,
      fontSize: cs.fontSize,
    };
  }, INPUT);

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await openChat();

  // 7. Resting composer: a one-line field over the toolbar (mic, disabled Send), at 100% and 150% text.
  await shot("empty-360");
  for (const percent of [100, 150]) {
    await setRootFont(percent);
    await wait(500);
    const row = await emptyRow();
    check(`empty composer field is one line at ${percent}% text`, row.height <= row.single + 2, JSON.stringify(row));
    if (percent === 150) await shot("empty-360-font150");
  }
  await setRootFont(100);
  await wait(300);
  const idle = await controls();
  check("the empty composer shows the mic and a disabled send", idle.mic && idle.send && !idle.sendEnabled, JSON.stringify(idle));
  await focusInput();
  await page.keyboard.type("Draft words");
  await wait(400);
  const typing = await controls();
  check("typing enables send beside the mic", typing.sendEnabled && typing.mic, JSON.stringify(typing));
  await shot("typing-360");
  await setRootFont(150);
  await wait(400);
  await shot("typing-360-font150");
  await setRootFont(100);
  await page.$eval(INPUT, (t) => { t.select(); });
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await wait(400);
  const slashOnly = await controls();
  check("a lone / cannot be sent: send stays disabled beside the mic", slashOnly.send && !slashOnly.sendEnabled && slashOnly.mic, JSON.stringify(slashOnly));
  await page.keyboard.press("Backspace");
  await wait(300);

  // 1. `/session` typed out, Enter: omp's own output in the result sheet.
  const before = sent.length;
  await typeAndEnter("/session");
  const sessionOut = await waitFor(() => document.querySelector("[data-testid='command-output']")?.textContent ?? null);
  check("/session + Enter prints omp's session info", !!sessionOut && sessionOut.includes("Composer parity fixture") && sessionOut.includes("verify-composer-parity"), JSON.stringify({ sessionOut, sent: sent.slice(before), replies: replies.slice(-2), dialog: await dialogText() }));
  check("/session went to /api/command, not the model", sent.slice(before).some((s) => s.startsWith("/api/command") && s.includes("/session")) && !sent.slice(before).some((s) => s.startsWith("/api/prompt")), JSON.stringify(sent.slice(before)));
  check("the composer cleared after the command", (await value()) === "");
  await closeSheet();

  // 2. A builtin with arguments reaches omp and prints.
  const beforeTodo = sent.length;
  await typeAndEnter("/todo append Parity task");
  const todoOut = await waitFor(() => document.querySelector("[data-testid='command-output']")?.textContent ?? null);
  check("/todo with arguments shows omp's output", !!todoOut && /Appended/i.test(todoOut), JSON.stringify({ todoOut, sent: sent.slice(beforeTodo), replies: replies.slice(-2), dialog: await dialogText() }));
  await wait(500);
  check("omp recorded the todo edit", readFileSync(file, "utf8").includes("user_todo_edit"));
  await closeSheet();

  // 3. `!cmd`: the Terminal tab runs it, omp records it, and the transcript keeps it.
  await typeAndEnter("!echo parity-hi");
  const bashOut = await waitFor(() => {
    const tab = document.querySelector("[data-testid='terminal-tab']");
    const out = tab?.querySelector("[data-testid='bash-output']");
    return out && /parity-hi\s*$/m.test(out.querySelector("pre")?.textContent ?? "") ? out.textContent : null;
  });
  check("!echo prints its output in the Terminal tab", !!bashOut, JSON.stringify({ sent: sent.slice(-2), replies: replies.slice(-2), dialog: await dialogText() }));
  check("!echo used the user shell, not the model", sent.some((s) => s.startsWith("/api/bash") && s.includes("echo parity-hi") && !s.includes("excludeFromContext")));
  await shot("bash-360");
  await backToChat();
  check("omp wrote the run into the session", /"role":"bashExecution","command":"echo parity-hi"/.test(readFileSync(file, "utf8")));
  await typeAndEnter("!!echo parity-quiet");
  const quiet = await waitFor(() => document.querySelector("[data-testid='terminal-tab'] [data-testid='bash-excluded']")?.textContent ?? null);
  check("!!echo says it is not added to the conversation", !!quiet && /Not added/.test(quiet));
  check("!!echo asks the daemon to keep it out of context", sent.some((s) => s.startsWith("/api/bash") && s.includes("parity-quiet") && s.includes('"excludeFromContext":true')));
  await backToChat();
  await page.reload({ waitUntil: "networkidle0" });
  await openChat();
  // The reload reconnects the socket; requests made while the app still says
  // "reconnecting" are queued or fail, which is not what this suite measures.
  await waitFor(() => !/reconnecting/i.test(document.body.innerText), undefined, 120);
  const transcript = await waitFor(() => (document.body.innerText.includes("echo parity-hi") ? document.body.innerText : null), undefined, 20);
  check("after a reload the transcript shows the !cmd run", !!transcript && transcript.includes("parity-hi"));

  // 4. Up/Down history on an empty composer.
  await focusInput();
  await page.keyboard.press("ArrowUp");
  await wait(250);
  const up1 = await value();
  await page.keyboard.press("ArrowUp");
  await wait(250);
  const up2 = await value();
  await page.keyboard.press("ArrowDown");
  await wait(250);
  const down1 = await value();
  await page.keyboard.press("ArrowDown");
  await wait(250);
  const down2 = await value();
  check("ArrowUp recalls the last prompt sent", up1 === "!!echo parity-quiet", up1);
  check("ArrowUp again steps further back", up2 === "!echo parity-hi", up2);
  check("ArrowDown walks forward and back to an empty field", down1 === "!!echo parity-quiet" && down2 === "", JSON.stringify([down1, down2]));

  // 5. History sheet: device prompts plus transcript messages; a tap fills, never sends.
  await page.click("[data-testid='composer-plus-btn']");
  await page.waitForSelector("[data-testid='composer-plus-sheet'] [data-testid='composer-history']", { timeout: 5000 });
  // The + menu is a floating popover that fades in: tap once it has settled.
  await wait(400);
  await page.evaluate(() => document.querySelector("[data-testid='composer-history']")?.click());
  await page.waitForSelector("[data-testid='history-sheet']", { timeout: 10000 });
  await wait(600);
  const rows = await page.$$eval("[data-testid='history-row']", (els) => els.map((e) => e.textContent ?? ""));
  check("History lists prompts this device sent, newest first", rows[0]?.includes("!!echo parity-quiet") && rows.some((r) => r.includes("/todo append Parity task")), JSON.stringify(rows.slice(0, 5)));
  await page.type("[data-testid='history-search']", "needle");
  const merged = await waitFor(() => Array.from(document.querySelectorAll("[data-testid='history-row']")).map((e) => e.textContent ?? "").find((t) => t.includes("parity transcript needle")) ?? null);
  check("History search finds the user's earlier transcript message", !!merged, JSON.stringify({ merged, replies: replies.filter((r) => r.startsWith("/api/search")).slice(-2) }));
  await shot("history-360");
  await setRootFont(150);
  await wait(500);
  await shot("history-360-font150");
  await setRootFont(100);
  const prompts = sent.filter((s) => s.startsWith("/api/prompt")).length;
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[data-testid='history-row']")).find((e) => (e.textContent ?? "").includes("parity transcript needle"));
    row?.click();
  });
  await wait(900);
  check("a History tap fills the composer", (await value()) === NEEDLE, await value());
  check("a History tap sends nothing", sent.filter((s) => s.startsWith("/api/prompt")).length === prompts && !(await page.$("[data-testid='history-sheet']")));
  await page.$eval(INPUT, (t) => t.select());
  await page.keyboard.press("Backspace");

  // 6. `@` file picker.
  await focusInput();
  // A bare `@` browses the session folder; typed names search the whole
  // project (flat rows: file name, then its folder), so folder stepping starts
  // from the bare listing.
  await page.keyboard.type("look at @");
  const picker = await waitFor(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='mention-row']")).map((e) => e.textContent ?? "");
    return rows.length ? rows : null;
  }, undefined, 60);
  check("@ lists matching files from the session folder", !!picker && picker.some((r) => r.startsWith("src/")), JSON.stringify({ picker, replies: replies.filter((r) => r.startsWith("/api/files")).slice(-2) }));
  check("only one popover shows", !(await page.$("[data-testid='slash-palette']")));
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[data-testid='mention-row']")).find((e) => (e.textContent ?? "").startsWith("src/"));
    row?.click();
  });
  await wait(400);
  check("picking a folder steps into it", (await value()) === "look at @src/", await value());
  await page.keyboard.type("al");
  const inner = await waitFor(() => Array.from(document.querySelectorAll("[data-testid='mention-row']")).map((e) => e.textContent ?? "").find((t) => t.includes("alpha.txt")) ?? null, undefined, 20);
  check("the picker filters inside the folder", !!inner);
  await shot("mention-360");
  await setRootFont(150);
  await wait(500);
  await shot("mention-360-font150");
  await setRootFont(100);
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[data-testid='mention-row']")).find((e) => (e.textContent ?? "").includes("alpha.txt"));
    row?.click();
  });
  await wait(400);
  check("tapping a file inserts its path", (await value()) === "look at @src/alpha.txt ", await value());
  check("the picker closes after a file", !(await page.$("[data-testid='mention-picker']")));

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser?.close().catch(() => {});
  webApp.stop();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures);
