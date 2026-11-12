#!/usr/bin/env node
// Plan mode, in-place tree moves, labels and `!!` from the phone, through a
// REAL omp child loading the daemon's child extension (src/omp/child/extension.rs,
// extensions/omp-pulse-child.ts).
//
// omp's RPC has none of these; each one rides on an extension command whose
// reply never reaches the phone. The suite drives the embedded app the way
// the owner would and checks the session FILE, because every one of these
// features is only real if it lands in the journal omp (and the TUI) read:
//   - Go here moves the branch in the SAME file (no new session) and puts
//     the rewound prompt back in the composer;
//   - a label is an omp `label` entry and shows in the Timeline;
//   - `!!` output is recorded with excludeFromContext, so the model never
//     sees it;
//   - plan mode is a mode_change entry, survives a reload, asks the phone to
//     approve the plan and leaves plan mode once approved.
//
// The tree/label/bash half needs no model call (fixture session). The plan
// half makes 1-2 cheap model calls. Runs under e2e/with-test-daemon.sh with
// the worktree's release binary, so build web + daemon first. Exit code =
// number of failures.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, testModel } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const STATE = process.env.OMP_PULSE_TEST_STATE_DIR;
if (!BASE || !TOKEN || !SESSIONS || !STATE) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}
if (/:(7681|7682)\b/.test(BASE)) {
  console.error("refusing to run against a live daemon port");
  process.exit(2);
}

let failures = 0;
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) }).then((r) => r.json());
const rpc = (sessionPath, command, params = {}) => post("/api/rpc", { sessionPath, command, params });

// --- Fixture: a three-turn conversation in omp's v3 journal format. --------
const CWD = process.env.OMP_PULSE_PLAN_TREE_CWD || `${tmpdir()}/night-sandbox/buildext/plan-tree-cwd`;
mkdirSync(CWD, { recursive: true });
let clock = Date.now() - 30 * 60 * 1000;
const at = () => new Date((clock += 2000)).toISOString();
const sessionId = "019ff400-0000-7000-0000-00000000p1a7";
const turns = [
  ["u1", "a1", "FIRST-QUESTION about the parser", "First answer."],
  ["u2", "a2", "SECOND-QUESTION about the sheet", "Second answer."],
  ["u3", "a3", "THIRD-QUESTION about deploying", "Third answer."],
];
const dir = join(SESSIONS, "--plan-tree--");
mkdirSync(dir, { recursive: true });
const file = join(dir, `2026-10-15T00-00-00-000Z_${sessionId}.jsonl`);
// omp restores the session's model from its last assistant message and
// refuses to open on one it does not know, so the fixture names a real,
// cheap, tool-capable model; the same one runs the planning turn below.
const writeFixture = (model) => {
  const entries = [{ type: "session", version: 3, id: sessionId, timestamp: at(), cwd: CWD, title: "Plan tree fixture" }];
  let parent = null;
  for (const [u, a, question, answer] of turns) {
    entries.push({ type: "message", id: u, parentId: parent, timestamp: at(), message: { role: "user", content: [{ type: "text", text: question }], timestamp: clock } });
    entries.push({ type: "message", id: a, parentId: u, timestamp: at(), message: { role: "assistant", content: [{ type: "text", text: answer }], api: model.api ?? "anthropic-messages", provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: clock } });
    parent = a;
  }
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
};
writeFixture({ provider: "anthropic", id: "placeholder" });
// A session-less catalogue child answers this; the fixture is not opened yet.
const models = (await rpc(file, "get_available_models")).data?.models ?? [];
const requestedModel = process.env.OMP_PULSE_TEST_MODEL ? await testModel() : undefined;
const model = requestedModel
  ? models.find((m) => m.provider === requestedModel.provider && m.id === requestedModel.id)
  : [/haiku-4/i, /sonnet-4/i, /haiku/i, /flash/i, /mini/i]
      .map((re) => models.find((m) => re.test(`${m.id} ${m.name ?? ""}`)))
      .find(Boolean) ?? models[0];
if (!model) {
  console.error("no model available to the test daemon's omp");
  process.exit(2);
}
console.log(`      model: ${model.provider}/${model.id}`);
writeFixture(model);
const journal = () =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return {}; }
  });
const filesInDir = () => readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length;

// 1. The extension is materialized, versioned, and the child loaded it.
const extFiles = (() => { try { return readdirSync(join(STATE, "child-extension")); } catch { return []; } })();
check("the child extension is written to the state dir, versioned by content", extFiles.some((n) => /^omp-pulse-child-[0-9a-f]{16}\.ts$/.test(n)), JSON.stringify(extFiles));
await post("/api/open", { sessionPath: file });
let catalogue = null;
for (let i = 0; i < 40 && !catalogue?.ok; i++) {
  await wait(1000);
  catalogue = await rpc(file, "get_available_commands").catch(() => null);
}
const names = (catalogue?.data?.commands ?? []).map((c) => String(c.name ?? c).replace(/^\/+/, ""));
check("the child loaded the extension (its commands are in omp's catalogue)", names.includes("pulse-plan") && names.includes("pulse-goto"), JSON.stringify(names.filter((n) => n.startsWith("pulse")).slice(0, 6)));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-plan-tree-`)}`],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
  const bodyText = () => page.evaluate(() => document.body.innerText);
  const composerValue = () => page.evaluate(() => document.querySelector("[data-testid='composer-input']")?.value ?? null);
  const clickTestId = (id) =>
    page.evaluate((testId) => {
      const el = document.querySelector(`[data-testid='${testId}']`);
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    }, id);
  const until = async (fn, ms = 15000, step = 250) => {
    for (let t = 0; t < ms; t += step) {
      const v = await fn();
      if (v) return v;
      await wait(step);
    }
    return null;
  };
  const typeInComposer = async (text) => {
    await page.evaluate(() => {
      const input = document.querySelector("[data-testid='composer-input']");
      if (input instanceof HTMLElement) input.focus();
    });
    await page.keyboard.type(text);
    await wait(700);
  };
  const pickPaletteRow = (prefix) =>
    page.evaluate((p) => {
      const rows = Array.from(document.querySelectorAll("[data-testid='slash-palette'] button"));
      const row = rows.find((el) => (el.textContent || "").trim().toLowerCase().startsWith(p));
      if (!(row instanceof HTMLElement)) return false;
      row.click();
      return true;
    }, prefix);
  // Clear by keyboard, as a user would: Escape would also dismiss the slash
  // palette for the next command typed.
  const clearComposer = async () => {
    await page.evaluate(() => {
      const input = document.querySelector("[data-testid='composer-input']");
      if (input instanceof HTMLElement) input.focus();
    });
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await wait(400);
  };
  // omp does not advertise its TUI-only `/tree` over RPC, so the Timeline is
  // reached the way the owner reaches it: the chat's Tasks tab, which lists
  // the todo board and then one row per turn.
  const openTimeline = async () => {
    await clearComposer();
    await page.evaluate(() => {
      const tab = document.querySelector("[data-testid='workspace-tabs'] [data-value='tasks']");
      if (tab instanceof HTMLElement) tab.click();
    });
    return until(() => page.evaluate(() => document.querySelectorAll("[data-testid='workspace-tab-tasks'] [data-timeline-row-id]").length > 0), 10000);
  };
  // The tabs are pages of the workspace drawer, not sheets: closing the drawer
  // returns to the chat.
  const backToChat = async () => {
    await page.evaluate(() => document.querySelector("[data-testid='workspace-close']")?.click());
    return until(() => page.evaluate(() => !document.querySelector("[data-testid='workspace-drawer'][data-open]")), 5000);
  };
  const rowMenu = async (rowId, itemTestId) => {
    const opened = await page.evaluate((id) => {
      const button = document.querySelector(`[data-timeline-row-id='${id}'] [data-testid='timeline-row-menu']`);
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    }, rowId);
    if (!opened) return false;
    await wait(500);
    return Boolean(await until(() => clickTestId(itemTestId), 3000));
  };

  await openPairedPage(page, `${BASE}/app/`, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 30000 });
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[data-testid='session-row']")).find((r) => (r.textContent || "").includes("Plan tree fixture"));
    if (row instanceof HTMLElement) row.click();
  });
  await until(async () => (await bodyText()).includes("THIRD-QUESTION"), 20000);

  // 2. Internal commands never show in the phone's palette (a user skill may
  // legitimately be called `skill:pulse-…`; only our four are internal).
  await typeInComposer("/pulse");
  const paletteText = await page.evaluate(() => document.querySelector("[data-testid='slash-palette']")?.textContent ?? "");
  check("the extension's commands are hidden from the slash palette", !/\/pulse-(plan|goto|label|bash)/i.test(paletteText), paletteText.slice(0, 120));
  await clearComposer();

  // 3. Go here: same file, earlier position, prompt back in the composer.
  const filesBefore = filesInDir();
  check("the Timeline opens with the fixture's turns", Boolean(await openTimeline()));
  const moved = await rowMenu("u2", "timeline-go-here");
  check("Go here is offered on an earlier turn", moved);
  const moveChosen = moved && Boolean(await until(() => clickTestId("timeline-move-no-summary"), 3000));
  check("Go here waits for an explicit branch-summary choice", Boolean(moveChosen));
  const draft = await until(async () => ((await composerValue()) || "").includes("SECOND-QUESTION") && (await composerValue()), 15000);
  check("Go here puts the rewound prompt in the composer", Boolean(draft), String(await composerValue()));
  const marker = await until(() => journal().find((e) => e.type === "custom" && e.customType === "omp-pulse-goto"), 10000);
  check("the move lands in the SAME session file (no new file)", Boolean(marker) && filesInDir() === filesBefore, `${filesBefore} -> ${filesInDir()}`);
  check("the move's new position is just before the rewound prompt", marker?.parentId === "a1", JSON.stringify(marker));
  const reloaded = await until(async () => {
    const text = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid='chat-message']")).map((el) => el.textContent || "").join("\n"));
    return text.includes("FIRST-QUESTION") && !text.includes("THIRD-QUESTION") && !text.includes("Second answer.");
  }, 15000);
  check("the transcript reloads to the new position", Boolean(reloaded));
  const tree = await fetch(`${BASE}/api/tree?session=${encodeURIComponent(file)}&limit=50`, { headers: H }).then((r) => r.json());
  const current = (tree.rows ?? []).find((r) => r.current);
  check("the Timeline's current turn follows the move", current?.id === "u1", JSON.stringify((tree.rows ?? []).map((r) => [r.id, r.current, r.active])));

  // 4. Labels: set from the Timeline, shown there, filterable.
  await openTimeline();
  const labelOpened = await rowMenu("u1", "timeline-label");
  const inputReady = labelOpened && (await until(() => page.evaluate(() => document.querySelector("[data-testid='timeline-label-input']") !== null), 3000));
  if (inputReady) {
    await page.focus("[data-testid='timeline-label-input']");
    await page.keyboard.type("parser start");
    await page.keyboard.press("Enter");
  }
  const labelEntry = await until(() => journal().find((e) => e.type === "label" && e.targetId === "u1" && e.label === "parser start"), 10000);
  check("a label set in the Timeline is an omp label entry", Boolean(labelEntry), String(inputReady));
  const shown = await until(() => page.evaluate(() => document.querySelector("[data-timeline-row-id='u1'] [data-testid='timeline-row-label']")?.textContent ?? null), 8000);
  check("the Timeline shows the label", Boolean(shown) && shown.includes("parser start"), String(shown));
  const filtered = (await clickTestId("timeline-labeled-filter"))
    ? await until(() => page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll("[data-timeline-row-id]")).map((el) => el.getAttribute("data-timeline-row-id"));
        return ids.length === 1 && ids[0] === "u1" ? ids : null;
      }), 3000)
    : null;
  check("the Labeled filter shows only labelled turns", Boolean(filtered));
  await backToChat();
  await wait(600);

  // 5. `!!cmd`: output comes back, the journal marks it excluded.
  const bang = await post("/api/bash", { sessionPath: file, command: "echo pulse-bang-hi", excludeFromContext: true });
  check("!! returns the command output in the normal bash shape", bang.ok === true && /pulse-bang-hi/.test(bang.result?.output ?? "") && bang.result?.exitCode === 0, JSON.stringify(bang).slice(0, 200));
  const plain = await post("/api/bash", { sessionPath: file, command: "echo pulse-plain-hi" });
  const execs = await until(() => {
    const rows = journal().filter((e) => e.type === "message" && e.message?.role === "bashExecution");
    return rows.length >= 2 ? rows : null;
  }, 8000);
  const bangRow = execs?.find((e) => e.message.command === "echo pulse-bang-hi");
  const plainRow = execs?.find((e) => e.message.command === "echo pulse-plain-hi");
  check("!! output is recorded but kept out of the model's context", bangRow?.message?.excludeFromContext === true && plain.ok === true && plainRow?.message?.excludeFromContext !== true, JSON.stringify({ bang: bangRow?.message?.excludeFromContext, plain: plainRow?.message?.excludeFromContext }));

  // 6. Plan mode: palette toggle, chip, journal entry, survives a reload.
  await clearComposer();
  await typeInComposer("/plan");
  const pickedPlan = await pickPaletteRow("/plan");
  const chip = await until(() => page.evaluate(() => document.querySelector("[data-testid='plan-chip']") !== null), 15000);
  check("/plan from the palette turns plan mode on (chip shows)", pickedPlan && Boolean(chip));
  const planEntry = await until(() => journal().filter((e) => e.type === "mode_change").at(-1)?.mode === "plan", 8000);
  check("plan mode is a mode_change entry in the journal", Boolean(planEntry));
  check("no literal /plan was sent to the agent", !journal().some((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("/plan")));
  await page.reload({ waitUntil: "networkidle0" });
  const chipAfterReload = await until(() => page.evaluate(() => document.querySelector("[data-testid='plan-chip']") !== null), 20000);
  check("plan mode is still shown after a reload", Boolean(chipAfterReload));

  await typeInComposer("Plan only: one short step to print today's date with `date`. Write the plan file, then propose it. After approval just run `date` once and reply done.");
  await page.evaluate(() => {
    const send = Array.from(document.querySelectorAll("button")).find((b) => /^send$/i.test(b.getAttribute("aria-label") || ""));
    if (send instanceof HTMLElement) send.click();
  });
  const dialog = await until(() => page.evaluate(() => {
    const text = document.body.innerText;
    return text.includes("Plan ready") && text.includes("Approve and run") ? text.slice(text.indexOf("Plan ready"), text.indexOf("Plan ready") + 160) : null;
  }), 240000, 1000);
  check("the agent's plan arrives as an approval dialog on the phone", Boolean(dialog), String(dialog ?? await page.evaluate(() => document.body.innerText.slice(-600))));
  const approved = dialog
    ? await page.evaluate(() => {
        const option = Array.from(document.querySelectorAll("[data-testid='extension-dialog-option']")).find((el) => (el.textContent || "").includes("Approve and run"));
        if (!(option instanceof HTMLElement)) return false;
        option.click();
        return true;
      })
    : false;
  // Multiple configured execution roles add a native select dialog. A single
  // configured choice skips it and proceeds directly to mode restoration.
  const executionChosen = approved && await until(async () => {
    const selected = await page.evaluate(() => {
      const option = document.querySelector('[role="group"][aria-label="Continue with execution model"] [data-testid="extension-dialog-option"]:not(:disabled)');
      if (!(option instanceof HTMLElement)) return false;
      option.click();
      return true;
    });
    return selected || journal().filter((e) => e.type === "mode_change").at(-1)?.mode === "none";
  }, 30000, 250);
  check("approval accepts the configured execution choice when offered", Boolean(executionChosen));
  const exited = approved && (await until(() => journal().filter((e) => e.type === "mode_change").at(-1)?.mode === "none", 30000, 500));
  check("approving leaves plan mode (journal and chip)", Boolean(exited) && Boolean(await until(() => page.evaluate(() => document.querySelector("[data-testid='plan-chip']") === null), 15000)));
  const ran = await until(() => journal().some((e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "bash"), 120000, 1000);
  check("after approval the agent runs the plan with full tools", Boolean(ran));

  // 7. The chip opens Session settings, whose switch turns plan mode off.
  await until(() => rpc(file, "get_state").then((s) => s.data?.isStreaming === false), 120000, 1000);
  await typeInComposer("/plan");
  await pickPaletteRow("/plan");
  const chipAgain = await until(() => page.evaluate(() => document.querySelector("[data-testid='plan-chip']") !== null), 15000);
  const switchState = chipAgain && (await clickTestId("plan-chip"))
    ? await until(() => page.evaluate(() => document.querySelector("[data-testid='plan-mode-switch']")?.getAttribute("aria-checked") ?? null), 10000)
    : null;
  check("the plan chip opens Session settings with the switch on", switchState === "true", String(switchState));
  await clickTestId("plan-mode-switch");
  const offEntry = await until(() => journal().filter((e) => e.type === "mode_change").at(-1)?.mode === "none", 15000);
  const switchOff = await until(() => page.evaluate(() => document.querySelector("[data-testid='plan-mode-switch']")?.getAttribute("aria-checked") === "false"), 10000);
  check("the Session settings switch turns plan mode off", Boolean(offEntry) && Boolean(switchOff));
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(failures === 0 ? `\nall ${checks} checks passed` : `\n${failures} of ${checks} failed`);
process.exit(failures);
