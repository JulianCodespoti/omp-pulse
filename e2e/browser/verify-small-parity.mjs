#!/usr/bin/env node
// The smaller omp parity surfaces, end to end against a REAL omp child:
//   - `/context` prints omp's breakdown with no terminal escapes left in it;
//   - todo edits through the exact `/todo` lines the board sends persist in the
//     session (get_state.todoPhases follows append/start/done);
//   - slow mode round-trips through get_state (skipped when the model has none);
//   - `/api/export` returns omp's HTML and leaves no file behind;
//   - a background job (bash `async: true`) raises `backgroundWork` and the
//     chat's "Background job running" line, refuses delete while it runs, and
//     both clear when omp reports the session settled;
//   - delete removes the idle conversation.
// One or two model calls. Runs under e2e/with-test-daemon.sh. Exit code = failures.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { todoCommand } from "../../web/src/app/tools/todo-edit.ts";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { loadPuppeteer, chromium } from "../lib/env.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const STATE = process.env.OMP_PULSE_TEST_STATE_DIR;
if (!BASE || !TOKEN || !SESSIONS || !STATE) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}
if (BASE.includes("7682") || BASE.includes("7681")) {
  console.error("refusing to run against a live daemon");
  process.exit(2);
}
const puppeteer = await loadPuppeteer();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const skip = (name, why) => console.log(`skip  ${name} — ${why}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, type, body: type.startsWith("application/json") ? await res.json() : await res.text() };
};

const CWD = "/tmp/night-sandbox/small/verify-parity";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-night-sandbox-small-verify-parity`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/2026-10-15T01-00-00-000Z_019ff500-0000-7000-0000-0000000000a1.jsonl`;
writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "019ff500-0000-7000-0000-0000000000a1", cwd: CWD, title: "Small parity fixture", timestamp: new Date().toISOString() })}\n`);
const command = (text) => post("/api/command", { sessionPath: file, text });
const state = async () => (await post("/api/rpc", { sessionPath: file, command: "get_state" })).body?.data ?? {};
const row = async () => {
  const res = await fetch(`${BASE}/api/sessions?limit=200`, { headers: H });
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.sessions ?? data.rows ?? data.items ?? [];
  return list.find((s) => s.path === file);
};

// 1. /context: omp's own breakdown, clean.
const context = await command("/context");
const out = String(context.body?.output ?? "");
check("/context runs in the session's own agent", context.body?.ok === true, JSON.stringify(context.body).slice(0, 200));
check("/context prints the category breakdown", /^Context window: \d+ tokens \(\d+% used\)/.test(out) && /tokens$/m.test(out), out.slice(0, 160));
check("/context output carries no terminal escapes", !/[\u001b\u009b]/.test(out));

// 2. Todo edits through the board's own command lines.
const task = "Write the release notes";
const tasks = (s) => (Array.isArray(s.todoPhases) ? s.todoPhases : []).flatMap((p) => p.tasks ?? []);
await command(todoCommand("append", task.toLowerCase()));
let found = tasks(await state()).find((t) => t.content === task);
check("todo append lands in the session board", found?.status === "pending", JSON.stringify(found));
await command(todoCommand("start", task));
found = tasks(await state()).find((t) => t.content === task);
check("todo start marks it in progress", found?.status === "in_progress", JSON.stringify(found));
await command(todoCommand("done", task));
found = tasks(await state()).find((t) => t.content === task);
check("todo done marks it completed", found?.status === "completed", JSON.stringify(found));

// 3. Slow mode round-trip.
const before = await state();
if (before.slowModeSupported === true) {
  await post("/api/rpc", { sessionPath: file, command: "set_slow_mode", params: { enabled: !before.slowModeEnabled } });
  const flipped = await state();
  check("slow mode switch reaches get_state", flipped.slowModeEnabled === !before.slowModeEnabled);
  await post("/api/rpc", { sessionPath: file, command: "set_slow_mode", params: { enabled: before.slowModeEnabled === true } });
  check("slow mode switches back", (await state()).slowModeEnabled === (before.slowModeEnabled === true));
} else {
  skip("slow mode round-trip", `model ${before.model?.provider}/${before.model?.id} reports slowModeSupported=false`);
}

// 4. Export download.
const exported = await post("/api/export", { sessionPath: file });
check("/api/export returns omp's HTML", exported.status === 200 && exported.type.startsWith("text/html") && /<html/i.test(String(exported.body)), `${exported.status} ${exported.type}`);
const exportDir = `${STATE}/exports`;
check("the export file is gone once served", !existsSync(exportDir) || readdirSync(exportDir).length === 0);

// 5. Background job: projection, chat line, delete refusal, settle.
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/small-parity-`)}`],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await post("/api/prompt", {
    sessionPath: file,
    commandId: `small-parity-${Date.now()}`,
    text: "Call the bash tool exactly once with command `sleep 120` and async: true. Do not wait for it. Then reply with the single word started.",
  });
  let pending = false;
  for (let i = 0; i < 90 && !pending; i++) {
    await wait(1000);
    pending = (await row())?.sessionState?.backgroundWork === true;
  }
  check("an async job raises backgroundWork in the session state", pending);
  if (pending) {
    // The line is for the quiet stretch: the turn has yielded, the job runs.
    let quiet = false;
    for (let i = 0; i < 60 && !quiet; i++) {
      const r = await row();
      quiet = r?.sessionState?.backgroundWork === true && r?.sessionState?.turn !== "running";
      if (!quiet) await wait(1000);
    }
    check("the turn yields while the job keeps running", quiet);
    // Opened once the conversation has messages, so the deep link lands on it.
    await openPairedPage(page, `${BASE}/app/#s=${encodeURIComponent(file)}`, TOKEN, { waitUntil: "networkidle0" });
    const line = await page.waitForSelector("[data-testid='background-work']", { timeout: 30000 }).then(() => true, () => false);
    check("the chat shows 'Background job running'", line, line ? "" : `${(await page.evaluate(() => document.querySelector("[data-testid='live-turn-status']")?.getAttribute("aria-label") ?? "no status line"))} | row backgroundWork=${(await row())?.sessionState?.backgroundWork} turn=${(await row())?.sessionState?.turn}`);
    if (line) {
      // The line is status only (docs/internals/web-client.md, "Known
      // `backgroundWork:true`"); the job list is `/jobs` from the composer.
      await page.click("textarea");
      await page.keyboard.type("/jobs");
      await page.keyboard.press("Enter");
      const sheet = await page.waitForSelector("[data-testid='command-result-sheet']", { timeout: 20000 }).then(() => true, () => false);
      check("/jobs opens its output while the job runs", sheet);
      await page.keyboard.press("Escape");
    }
    const refused = await post("/api/session/delete", { sessionPath: file });
    check("delete is refused while the job runs", refused.status === 409 && existsSync(file), `${refused.status} ${JSON.stringify(refused.body)}`);
    let settled = false;
    for (let i = 0; i < 300 && !settled; i++) {
      await wait(1000);
      const r = await row();
      settled = r?.sessionState?.backgroundWork !== true && r?.sessionState?.turn !== "running";
    }
    check("backgroundWork clears when omp settles", settled);
    const gone = await page.waitForSelector("[data-testid='background-work']", { hidden: true, timeout: 15000 }).then(() => true, () => false);
    check("the background line clears", gone);
  }
} finally {
  await browser.close();
}

// 6. Delete the idle conversation.
const deleted = await post("/api/session/delete", { sessionPath: file });
check("delete removes the idle conversation", deleted.body?.ok === true && !existsSync(file), JSON.stringify(deleted.body));

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures);
