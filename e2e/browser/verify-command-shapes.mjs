#!/usr/bin/env node
// Proof that a command's SHAPE survives onto the phone.
//
// On the laptop the commands do not all behave the same way, and that
// difference IS the product. /models opens a picker page. /goal makes you type
// the objective before it sends anything. /compact just goes. A mobile client
// that treats all 125 as "tap and send" is the tell that nobody actually used
// it.
//
// Two shapes were broken here:
//
//   1. Tapping a drill command in the inline slash palette did NOTHING. That
//      palette lists top-level commands and has no subcommand UI, so it called
//      onRun with no subcommand name and handlePaletteRun returned immediately.
//      /todo, /mcp, /memory, /security, /marketplace, /ssh, /plugins and eight
//      others were dead on tap — no sheet, no toast, no feedback at all.
//
//   2. resolveDrill dropped a subcommand's declared `usage`. Skills and
//      RPC-backed commands collected the argument; plain builtins hardcoded
//      shape:"prompt" and sent the bare subcommand. `/todo start <task>` went
//      out as `/todo start` with no task — 29 subcommands, ~20 of them with a
//      REQUIRED argument, could not do the thing they name.
//
// /todo itself has since become a picker: the phone has a real board (the
// chat's Tasks tab) whose controls send those exact `/todo` lines (proved by
// verify-small-parity.mjs), so tapping /todo opens the board. The drill and
// its required argument are proved here with `/mcp test <name>`, a builtin
// drill whose subcommand is read-only.
//
// The assertion that matters is the last one in each block: the exact bytes
// POSTed to the daemon (/api/prompt for a message to the agent, /api/command
// for a builtin that prints). A sheet that opens and collects text and then
// sends the argument-less command would pass every check but the real one.
//
// Needs a live omp child, so it runs under e2e/with-test-daemon.sh.
// Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
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
  console.error("refusing to run against the live daemon on 7682 — it would send commands into a real session");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The cwd must exist on disk or omp fails switch_session while /api/* still
// answers 200 — the only evidence is the daemon log.
const CWD = "/tmp/omp-cmd-shapes-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-cmd-shapes`;
mkdirSync(dir, { recursive: true });
// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-21T07:00:01.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-21T07:00:01.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const sessionPath = `${dir}/2026-08-21T07-00-00-000Z_019ff400-0000-7000-0000-0000000ee30e.jsonl`;
writeFileSync(
  sessionPath,
  [
    { id: "e-s", type: "session", cwd: CWD, title: "Command shapes fixture" },
    {
      id: "e-u-0",
      type: "message",
      timestamp: shiftTs("2026-08-21T07:00:00.000Z"),
      message: { id: "m-u-0", role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      id: "e-a-0",
      type: "message",
      timestamp: shiftTs("2026-08-21T07:00:01.000Z"),
      message: { id: "m-a-0", role: "assistant", content: [{ type: "text", text: "hi" }] },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
const when = new Date(Date.now() - 60_000);
utimesSync(sessionPath, when, when);

// Boot the child up front: the palette is populated from get_available_commands.
await fetch(`${BASE}/api/open`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ sessionPath }),
});
await new Promise((r) => setTimeout(r, 13_000));

const webApp = await startWebApp({ base: BASE, port: 5240 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-cs-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));

  // The real assertion: what actually goes out on the wire. A skill is a
  // message to the agent (POST /api/prompt, with a commandId for the outbox);
  // a builtin prints, so it runs through POST /api/command and its output
  // opens a sheet instead of landing in the chat as a user message.
  const prompts = [];
  let commandsInFlight = 0;
  const isCommand = (req) => req.method() === "POST" && /\/api\/command(?:[?#]|$)/.test(req.url());
  page.on("request", (req) => {
    const endpoint = req.method() === "POST" ? (req.url().match(/\/api\/(prompt|command)(?:[?#]|$)/) || [])[1] : undefined;
    if (!endpoint) return;
    if (endpoint === "command") commandsInFlight++;
    try {
      const body = JSON.parse(req.postData() || "{}");
      if (typeof body.text === "string") prompts.push({ endpoint, ...body });
    } catch {}
  });
  page.on("requestfinished", (req) => { if (isCommand(req)) commandsInFlight--; });
  page.on("requestfailed", (req) => { if (isCommand(req)) commandsInFlight--; });
  const wentOut = (body, text) =>
    body.text.trim() === text && (body.endpoint === "command" || (typeof body.commandId === "string" && body.commandId.length > 0));
  // A printed result opens a sheet once omp answers and stays up until
  // dismissed; the next command needs the composer.
  const closeResultSheet = async () => {
    for (let i = 0; i < 100 && commandsInFlight > 0; i++) await wait(200);
    await wait(600);
    for (let i = 0; i < 20; i++) {
      if (!(await page.evaluate(() => !!document.querySelector("[data-testid='command-result-sheet']")))) return;
      if (i % 5 === 0) await page.keyboard.press("Escape");
      await wait(300);
    }
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20_000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Command shapes")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await wait(4000);

  // Setting .value via the prototype setter does not drive a controlled Base UI
  // input; the component state stays empty. Click the field and type.
  const typeCommand = async (text) => {
    const box = await page.evaluate(() => {
      const ta = document.querySelector('textarea[name="message"]');
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    await page.keyboard.type(text);
    await wait(1200);
    return true;
  };

  const clearComposer = async () => {
    await page.evaluate(() => {
      const ta = document.querySelector('textarea[name="message"]');
      if (ta instanceof HTMLTextAreaElement) ta.focus();
    });
    for (let i = 0; i < 40; i++) await page.keyboard.press("Backspace");
    await wait(400);
  };

  // cmdk items respond to real pointer input; a synthetic .click() from
  // page.evaluate does not fire their onSelect. Locate the row, then click its
  // centre with the mouse. Subcommand rows are labelled with the full
  // "/todo start", not the bare subcommand name.
  const tapItem = async (prefix) => {
    const box = await page.evaluate((pfx) => {
      const items = Array.from(document.querySelectorAll("[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])"));
      const hit = items.find((x) => (x.textContent || "").trim().toLowerCase().startsWith(pfx.toLowerCase()));
      if (!hit) return null;
      hit.scrollIntoView({ block: "center" });
      const r = hit.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, prefix);
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    await wait(1600);
    return true;
  };

  // ── a picker command: /todo opens the board ──
  const typed = await typeCommand("/todo");
  check("the composer accepts a slash command", typed);

  const paletteRowTapped = await tapItem("/todo");
  check("the inline palette offers /todo", paletteRowTapped);
  const board = await page
    .waitForSelector("[data-testid='workspace-tabs'] [data-value='tasks'][aria-selected='true']", { timeout: 8000 })
    .then(() => true, () => false);
  check("tapping /todo opens the Tasks board instead of printing text", board);
  await page.evaluate(() => document.querySelector("[data-testid='workspace-close']")?.click());
  await page
    .waitForSelector("[data-testid='workspace-drawer']:not([data-open])", { timeout: 8000 })
    .catch(() => undefined);
  await clearComposer();
  await wait(600);

  // ── a drill command tapped from the inline palette ──
  check("the composer accepts a drill command", await typeCommand("/mcp"));
  check("the inline palette offers /mcp", await tapItem("/mcp"));

  const drilled = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])")).map((x) =>
      (x.textContent || "").trim(),
    );
    return {
      add: rows.some((r) => r.startsWith("/mcp add")),
      list: rows.some((r) => r.startsWith("/mcp list")),
      test: rows.some((r) => r.startsWith("/mcp test")),
    };
  });
  check(
    "tapping a drill command reveals its subcommands instead of doing nothing",
    drilled.add && drilled.list && drilled.test,
    JSON.stringify(drilled),
  );

  // ── a subcommand with a REQUIRED argument ──
  const subTapped = await tapItem("/mcp test");
  check("the subcommand list is selectable", subTapped);

  const sheet = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='command-input-sheet']");
    if (!el) return null;
    const ta = el.querySelector("textarea");
    const btn = Array.from(el.querySelectorAll("button")).find((b) => /send/i.test(b.textContent || ""));
    return {
      open: true,
      placeholder: ta ? ta.getAttribute("placeholder") : "",
      sendDisabled: btn ? btn.disabled : null,
    };
  });
  check("/mcp test collects its argument rather than firing bare", sheet !== null);
  check(
    "the sheet shows omp's own usage string",
    sheet !== null && (sheet.placeholder || "").includes("<name>"),
    sheet ? `placeholder="${sheet.placeholder}"` : "no sheet",
  );
  check(
    "a required argument blocks the send until it is supplied",
    sheet !== null && sheet.sendDisabled === true,
    sheet ? `disabled=${sheet.sendDisabled}` : "no sheet",
  );

  // A server name that does not exist: omp answers "not found" and changes nothing.
  const SERVER = "omp-pulse-e2e-missing";
  await page.evaluate(() => {
    const el = document.querySelector("[data-testid='command-input-sheet'] textarea");
    if (el instanceof HTMLTextAreaElement) el.focus();
  });
  await page.keyboard.type(SERVER);
  await wait(700);

  const enabled = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='command-input-sheet']");
    const btn = el ? Array.from(el.querySelectorAll("button")).find((b) => /send/i.test(b.textContent || "")) : null;
    return btn ? !btn.disabled : false;
  });
  check("supplying the argument enables the send", enabled);

  const before = prompts.length;
  await page.evaluate(() => {
    const el = document.querySelector("[data-testid='command-input-sheet']");
    const btn = el ? Array.from(el.querySelectorAll("button")).find((b) => /send/i.test(b.textContent || "")) : null;
    if (btn instanceof HTMLElement) btn.click();
  });
  await wait(2500);

  const sent = prompts.slice(before);
  check(
    `the argument reaches the wire — /mcp test ${SERVER}, not a bare /mcp test`,
    sent.some((body) => wentOut(body, `/mcp test ${SERVER}`)),
    JSON.stringify(sent),
  );
  await closeResultSheet();

  // ── a subcommand whose argument is OPTIONAL fires bare, with no sheet ──
  //
  // `/advisor dump [raw]` is valid bare, so it runs on tap exactly like
  // /compact (PARITY-07: only a REQUIRED argument earns a sheet). The send
  // happens during the tap, so the wire count is taken before it.
  await clearComposer();
  await wait(800);
  const typed2 = await typeCommand("/advisor");
  check("the composer accepts a second command", typed2);

  check("the inline palette offers /advisor", await tapItem("/advisor"));
  const before2 = prompts.length;
  check("the /advisor subcommand list is selectable", await tapItem("/advisor dump"));

  const optionalSheet = await page.evaluate(() => !!document.querySelector("[data-testid='command-input-sheet']"));
  check("an optional argument does not force a sheet — /advisor dump is valid bare", !optionalSheet);

  await wait(900);
  const sent2 = prompts.slice(before2);
  check(
    "the bare optional command goes out clean",
    sent2.some((body) => wentOut(body, "/advisor dump")),
    JSON.stringify(sent2),
  );
  await wait(1500);
  await closeResultSheet();

  // ── a command the phone cannot run ──
  //
  // Typing "/goal ship it" once showed NOTHING and then went to the model as an
  // ordinary chat message — verified: the agent started running git against the
  // objective text. Silently doing something else is the worst outcome
  // available; the composer has to say so. /goal itself is no longer the
  // example: omp now exposes it over RPC, so the phone lists it and runs it.
  // A typo is the case that can never become valid, so it keeps this honest.
  await clearComposer();
  await wait(600);
  await typeCommand("/comapct");
  const unknownBare = await page.evaluate(() => !!document.querySelector("[data-testid='uncatalogued-command']"));
  check("a command outside the catalogue says OMP will resolve it, instead of showing nothing", unknownBare);

  await page.keyboard.type(" soft");
  await wait(900);
  const unknownWithArgs = await page.evaluate(() => !!document.querySelector("[data-testid='uncatalogued-command']"));
  check("the notice survives typing the argument, which is when it matters", unknownWithArgs);

  // An uncatalogued /word warns but never blocks: the catalogue can be stale or
  // incomplete, and an extension or project command that is missing from it
  // must still reach OMP, which owns command resolution. The notice must not
  // capture keys for a KNOWN command, which the Enter-picks check below covers.
  const beforeUnknown = prompts.length;
  const sendDisabled = await page.evaluate(() => document.querySelector("[data-testid='composer-send-btn']")?.disabled === true);
  await page.keyboard.press("Enter");
  await wait(1500);
  const sentUnknown = prompts.slice(beforeUnknown);
  check(
    "an uncatalogued command is not blocked: Send is enabled and Enter sends it once",
    !sendDisabled && sentUnknown.length === 1,
    JSON.stringify({ sendDisabled, sentUnknown }),
  );

  // A partial command is not an error: /mod is on its way to /model.
  await clearComposer();
  await wait(600);
  await typeCommand("/mod");
  const partial = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])")).map((x) =>
      (x.textContent || "").trim(),
    );
    return { warned: !!document.querySelector("[data-testid='uncatalogued-command']"), matches: rows.length };
  });
  check(
    "a half-typed command still lists its matches instead of being called unknown",
    partial.warned === false && partial.matches > 0,
    JSON.stringify(partial),
  );

  // A real command with arguments must not be accused of not existing.
  await clearComposer();
  await wait(600);
  await typeCommand("/todo start something");
  const knownWithArgs = await page.evaluate(() => !!document.querySelector("[data-testid='unknown-command']"));
  check("a real command with arguments is not flagged", knownWithArgs === false);

  await clearComposer();
  await wait(400);

  // ── Enter picks the highlighted command ──
  //
  // The composer swallowed it. Its textarea handler called stopPropagation on
  // Enter while the palette was open, and the palette listens on `window`, so
  // the native event never reached the picker: Enter did nothing at all — no
  // pick, no send. Only a mouse tap worked.
  await clearComposer();
  await wait(600);
  await typeCommand("/mod");
  const listed = await page.evaluate(
    () => document.querySelectorAll("[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])").length,
  );
  check("the palette lists matches for a partial command", listed > 0, `${listed} rows`);
  await page.keyboard.press("Enter");
  await wait(2500);
  const picked = await page.evaluate(() => ({
    picker: document.querySelector("[data-testid='model-picker']") !== null,
    composer: (document.querySelector('textarea[name="message"]') || {}).value ?? "",
  }));
  check(
    "Enter picks the highlighted command instead of doing nothing",
    picked.picker === true,
    JSON.stringify(picked),
  );

  check("no page errors across the command surfaces", errors.length === 0, errors.join(" | "));

  await browser.close();
} finally {
  webApp.stop();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures);
