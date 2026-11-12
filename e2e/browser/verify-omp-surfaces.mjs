#!/usr/bin/env node
// Proof that data omp already gives the phone is actually visible.
//
// Four things were present on the wire and invisible on screen:
//   1. The agent's todo list (the `todo` tool result carries the whole list).
//   2. Desktop `!cmd` runs (`bashExecution` rows hold `output`, not `content`,
//      so they rendered blank).
//   3. Compaction / branch summaries (only a one-word marker was drawn).
//   4. What a slash command prints (`command_output`; the store kept it and no
//      screen showed it, so /usage and friends looked like no-ops).
//
// No model calls: the fixture is a session file and the only live child answers
// /usage locally. Runs under e2e/with-test-daemon.sh. Exit code = failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CWD = "/tmp/verify-omp-surfaces";
mkdirSync(CWD, { recursive: true });
let clock = Date.now() - 20 * 60 * 1000;
const at = () => new Date((clock += 1000)).toISOString();
const phases = [
  { name: "Build", tasks: [
    { content: "Write the parser", status: "completed" },
    { content: "Wire the sheet", status: "in_progress", notes: "needs the header entry" },
  ] },
  { name: "Ship", tasks: [{ content: "Deploy to the phone", status: "pending" }] },
];
const entries = [
  { type: "session", id: "019ff400-0000-7000-0000-0000000000e1", cwd: CWD, title: "Omp surfaces fixture", timestamp: at() },
  { type: "message", id: "u1", timestamp: at(), message: { role: "user", content: [{ type: "text", text: "Plan the work" }] } },
  { type: "message", id: "a1", timestamp: at(), message: { role: "assistant", content: [
    { type: "text", text: "Planning." },
    { type: "toolCall", id: "call-todo-1", name: "todo", arguments: { op: "init" } },
  ] } },
  { type: "message", id: "r1", timestamp: at(), message: { role: "toolResult", toolCallId: "call-todo-1", toolName: "todo", content: [{ type: "text", text: "Todo list updated." }], details: { op: "init", phases } } },
  { type: "message", id: "b1", timestamp: at(), message: { role: "bashExecution", command: "ls /fixture", output: "alpha-file\nbeta-file\n", exitCode: 2 } },
  { type: "compaction", id: "c1", timestamp: at(), summary: "SUMMARY-CARRIED-FORWARD: the parser is done.", tokensBefore: 182000, tokensAfter: 31000 },
  { type: "message", id: "u2", timestamp: at(), message: { role: "user", content: [{ type: "text", text: "Continue" }] } },
  { type: "message", id: "a2", timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: "Continuing." }] } },
];
const dir = `${SESSIONS}/-tmp-verify-omp-surfaces`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/2026-08-20T12-40-00-000Z_019ff400-0000-7000-0000-0000000000e1.jsonl`;
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(file, when, when);

// /usage needs a live omp child to run the builtin.
const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
await fetch(`${BASE}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ sessionPath: file }) });
await wait(12_000);

const webApp = await startWebApp({ base: BASE, port: 5206 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-surfaces-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));
  // What the phone sent: commands must go to /api/command, never /api/prompt.
  const sent = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "POST" && (u.pathname === "/api/command" || u.pathname === "/api/prompt")) sent.push(`${u.pathname} ${(r.postData() || "").replace(/"sessionPath":"[^"]*",?/, "").slice(0, 80)}`);
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Omp surfaces")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await wait(4000);

  // 2. A desktop `!cmd` run shows its command and output, and its failure.
  const text = await page.evaluate(() => document.body.innerText);
  check("desktop bash run shows its output", text.includes("alpha-file") && text.includes("beta-file"), text.slice(0, 200));
  check("desktop bash run shows the command and exit status", text.includes("$ ls /fixture") && text.includes("exit 2"));

  // 3. A compaction marker opens its summary on tap.
  const toggled = await page.evaluate(() => {
    const t = document.querySelector("[data-testid='marker-detail-toggle']");
    if (!(t instanceof HTMLElement)) return null;
    const label = t.textContent;
    t.click();
    return label;
  });
  check("compaction marker is tappable and reads in plain words", !!toggled && /^Context compacted$/.test(toggled.trim()), String(toggled));
  await wait(400);
  const detail = await page.evaluate(() => document.querySelector("[data-testid='marker-detail']")?.textContent ?? null);
  check("tapping the compaction marker shows the summary", !!detail && detail.includes("SUMMARY-CARRIED-FORWARD"), String(detail));

  // A task's note lives in the todo call's own sheet. The Tasks tab below
  // shows omp's live board, and omp's todo snapshot drops task notes
  // (docs rpc.md, `set_todos`), so it cannot show them.
  const todoNote = await page.evaluate(async () => {
    const row = Array.from(document.querySelectorAll("[data-testid='tool-row']")).find((r) => /tasks/i.test(r.textContent ?? ""));
    if (!(row instanceof HTMLElement)) return null;
    row.click();
    for (let i = 0; i < 30; i++) {
      const board = document.querySelector("[data-testid='todo-board']");
      if (board) return board.textContent ?? "";
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  });
  check("a task's note is shown", todoNote?.includes("needs the header entry") === true, String(todoNote));
  await page.keyboard.press("Escape");
  await wait(500);
  // 1. The todo board: the Tasks tab's badge counts what is left of the
  // plan, and the tab shows the board.
  const trackTasks = await page.evaluate(() => {
    const tab = document.querySelector("[data-testid='workspace-tabs'] [data-value='tasks']");
    if (!(tab instanceof HTMLElement)) return null;
    const label = tab.getAttribute("aria-label");
    tab.click();
    return label;
  });
  check("the Tasks tab announces the todo progress", trackTasks === "Tasks, 1 of 3 done", String(trackTasks));
  await wait(800);
  const board = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid='workspace-tab-tasks'] [data-testid='todo-task']")).map((el) => ({ text: el.textContent, status: el.getAttribute("data-status") })));
  check("the workspace Tasks tab lists every task with its status", board.length === 3 && board[0].status === "completed" && board[1].status === "in_progress" && board[2].status === "pending", JSON.stringify(board));
  const sheetText = await page.evaluate(() => document.querySelector("[data-testid='workspace-tab-tasks'] [data-testid='todo-list']")?.textContent ?? "");
  check("the board states progress", /1 of 3 done/.test(sheetText), sheetText.slice(0, 120));
  if (process.env.OMP_SURFACES_SHOTS) await page.screenshot({ path: `${process.env.OMP_SURFACES_SHOTS}/todo-tab.png` });
  // Tasks is a page of the workspace drawer, not a sheet: Escape closes the
  // whole drawer. Close it, back to the chat where the composer lives.
  await page.evaluate(() => document.querySelector("[data-testid='workspace-close']")?.click());
  await wait(800);

  const before = readFileSync(file, "utf8");
  // 4. /usage: session figures, then the provider quota omp prints.
  await page.evaluate(() => {
    const input = document.querySelector("[data-testid='composer-input']");
    if (input instanceof HTMLElement) input.focus();
  });
  await page.keyboard.type("/usage");
  await wait(600);
  const pickedUsage = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[data-testid='slash-palette'] button, [data-testid='slash-palette'] [role='option']")).find((el) => (el.textContent || "").trim().startsWith("/usage"));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  });
  check("/usage can be run from the composer", pickedUsage, await page.evaluate(() => JSON.stringify({ palette: (document.querySelector("[data-testid='slash-palette']")?.textContent ?? "none").slice(0, 160), input: document.querySelector("[data-testid='composer-input']")?.value ?? null, active: document.activeElement?.tagName })));
  await wait(1000);
  if (process.env.OMP_SURFACES_SHOTS) await page.screenshot({ path: `${process.env.OMP_SURFACES_SHOTS}/usage-sheet.png` });
  // No button to press: the quota loads by itself under the session figures.
  let limits = null;
  for (let i = 0; i < 60 && !limits; i++) {
    await wait(500);
    limits = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='usage-limits'], [data-testid='usage-limits-error']");
      // Each quota window is a `meter` row (CommandResultSheet LimitMeter) holding its bar.
      return el ? { text: (el.textContent || "").slice(0, 200), bars: el.querySelectorAll("[role='meter']").length, error: el.getAttribute("data-testid") === "usage-limits-error" } : null;
    });
  }
  check("omp's provider quota loads without a button", limits !== null && !limits.error, JSON.stringify(limits));
  if (process.env.OMP_SURFACES_SHOTS) await page.screenshot({ path: `${process.env.OMP_SURFACES_SHOTS}/usage-limits.png` });
  check("provider limits are drawn as bars, not a text dump", limits !== null && limits.bars > 0, JSON.stringify(limits));
  await page.keyboard.press("Escape");
  await wait(1500);

  // 5. Another printing builtin: its output opens in a sheet, and neither command
  // became a chat message or a transcript entry (the daemon ran them directly).
  await page.evaluate(() => {
    const input = document.querySelector("[data-testid='composer-input']");
    if (input instanceof HTMLElement) input.focus();
  });
  await page.keyboard.type("/tools");
  await wait(900);
  const toolsRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='slash-palette'] button"));
    const row = rows.find((el) => (el.textContent || "").trim().startsWith("/tools"));
    const seen = rows.map((el) => (el.textContent || "").trim().slice(0, 20));
    if (row instanceof HTMLElement) row.click();
    return { found: row instanceof HTMLElement, seen };
  });
  let printed = null;
  for (let i = 0; i < 30 && !printed; i++) {
    await wait(500);
    printed = await page.evaluate(() => document.querySelector("[data-testid='command-output']")?.textContent ?? null);
  }
  check("a printing builtin opens its output in a sheet", printed !== null && printed.trim().length > 0, JSON.stringify({ printed, sent, toolsRow }));
  await page.keyboard.press("Escape");
  await wait(600);
  const userBubbles = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid='chat-message'].is-user")).map((el) => (el.textContent || "").trim()));
  check("running commands sent no chat message", !userBubbles.some((t) => t.startsWith("/")) && !sent.some((s) => s.startsWith("/api/prompt")), JSON.stringify({ userBubbles, sent }));
  check("commands went to /api/command", sent.some((s) => s.startsWith("/api/command") && s.includes("/usage")) && sent.some((s) => s.startsWith("/api/command") && s.includes("/tools")), JSON.stringify(sent));
  // Compare transcript entries, not bytes. The fixture is legacy-format and
  // names no model, so once the child holds it omp rewrites it in its own
  // format (ids, parentIds, a title entry) and records the model the open fell
  // back to (model_change). Those come from opening; no command may add an
  // entry of its own.
  const after = readFileSync(file, "utf8");
  const shape = (text) => text.trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "title" && entry.type !== "model_change")
    .map((entry) => `${entry.type}:${entry.message?.role ?? ""}`)
    .join(",");
  check("running commands wrote nothing to the session file", shape(after) === shape(before), `${shape(before)} -> ${shape(after)}`);
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
