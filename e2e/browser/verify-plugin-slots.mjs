#!/usr/bin/env node
// Plugin slots, options and tap actions, end to end through the product path.
//
// One scratch plugin, `probe`, declares every slice 2 slot (session.row,
// session.menu, composer.actions, transcript.tool, transcript.message, page),
// one permission (session.compose only), a tool claim, a message claim, two
// options and one host action (`printf %s {arg}`). Each check drives the real
// app against the real daemon and reads what a person would see.
//
// WHY THIS EXISTS: the unit tests prove the pieces (claims, grants, view
// validation, context bounds). Only a browser proves that a plugin's chip lands
// on the right conversation row, that its menu items run on the row that was
// tapped, that a transcript card replaces only the call it claims and can be
// toggled back, that a refused permission sends nothing, and that a plugin
// cannot act without a tap.
//
// Selectors (contract: plugin-slice2-contract.md section E; files read):
//   plugin-row-badges[data-session]   web/src/app/nav/DrawerSessionRow.tsx
//   plugin-menu-item[data-plugin][data-item]  web/src/app/plugins/PluginMenuItems.tsx
//   plugin-tool-card[data-plugin][data-call], plugin-message-card[data-plugin],
//   plugin-show-original               web/src/app/plugins/PluginCard.tsx
//   plugin-option[data-option], plugin-review-sees/-can/-actions,
//   plugin-row, plugin-enable, plugin-open
//                                      web/src/app/plugins/PluginsSettings.tsx
//   plugin-chip                        web/src/app/plugins/NodeView.tsx
//   plugin-page                        web/src/app/plugins/PluginPage.tsx
//   session-actions, session-actions-sheet  web/src/app/chat/SessionHeader.tsx
//   composer-plus-btn, composer-plus-sheet, composer-input  web/src/app/composer/Composer.tsx
//   session-row                        used the same way by verify-session-actions.mjs
//   switcher-settings, session-switcher, settings-screen, [data-settings-page],
//   settings-plugins                   as in verify-plugins.mjs
//
// No model calls and no omp child is started on purpose: the permissions the
// plugin declares are session.compose only, so prompt, bash and rpc refusals
// happen in the host before anything is sent. Runs under
// e2e/with-test-daemon.sh, which points OMP_PULSE_PLUGINS_DIR at a scratch
// folder; the suite refuses to run without it. Exit code is non-zero when any
// check fails.

import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const TEST_TMP = process.env.OMP_PULSE_TEST_TMP;
const PLUGINS_DIR = process.env.OMP_PULSE_PLUGINS_DIR;

if (!BASE || !TOKEN || !SESSIONS || !TEST_TMP) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-plugin-slots.mjs");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}
// The plugins folder must be the harness's scratch one: linking and enabling a
// plugin against a real folder would run a developer's real commands.
const underTmp = (dir) => {
  const rel = path.relative(path.resolve(TEST_TMP), path.resolve(dir));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
if (!PLUGINS_DIR || !underTmp(PLUGINS_DIR)) {
  console.error(`refusing to run: OMP_PULSE_PLUGINS_DIR (${PLUGINS_DIR ?? "unset"}) is not inside OMP_PULSE_TEST_TMP (${TEST_TMP})`);
  console.error("  run through e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = path.join(ROOT, "target", "release", "omp-pulse");

// ---- Fixture conversation --------------------------------------------------

const TITLE = "Plugin probe chat";
const CWD = "/tmp/verify-plugin-slots"; // must exist, or omp cannot switch into it
mkdirSync(CWD, { recursive: true });
const SESSION_ID = "019ff400-0000-7000-0000-00000000b0b1";
const DIR = `${SESSIONS}/${CWD.replaceAll("/", "-")}`;
mkdirSync(DIR, { recursive: true });
const FILE = `${DIR}/2026-08-20T12-30-00-000Z_${SESSION_ID}.jsonl`;
{
  // Timestamps are recent: the list hides conversations whose newest message
  // is older than 7 days.
  let clock = Date.now() - 60 * 60 * 1000;
  const tick = () => new Date((clock += 60_000)).toISOString();
  const entries = [
    { type: "session", id: SESSION_ID, cwd: CWD, title: TITLE },
    { type: "title", title: TITLE },
    { type: "message", timestamp: tick(), message: { role: "user", content: [{ type: "text", text: "Run the probe tools" }] } },
    {
      type: "message", timestamp: tick(),
      message: { role: "assistant", content: [{ type: "toolCall", id: "call_probe_1", name: "probe_tool", intent: "Probing", arguments: { query: "alpha" } }] },
    },
    {
      type: "message", timestamp: tick(),
      message: { role: "toolResult", content: [{ type: "text", text: "probe output marker zebra" }], toolCallId: "call_probe_1", isError: false },
    },
    {
      type: "message", timestamp: tick(),
      message: { role: "assistant", content: [{ type: "toolCall", id: "call_other_1", name: "other_tool", intent: "Looking", arguments: { query: "beta" } }] },
    },
    {
      type: "message", timestamp: tick(),
      message: { role: "toolResult", content: [{ type: "text", text: "other output marker giraffe" }], toolCallId: "call_other_1", isError: false },
    },
    { type: "message", timestamp: tick(), message: { role: "assistant", content: [{ type: "text", text: "Both tools ran." }] } },
    {
      type: "custom_message", timestamp: tick(), customType: "probe:card", display: true,
      content: [{ type: "text", text: "Probe card message text" }],
      details: { marker: "quokka-42" },
    },
  ];
  // Chain ids the way the other fixtures do (the branch tree reads them).
  let prev = null;
  const chained = entries.map((entry, i) => {
    const id = `probe-e${i}`;
    const out = prev ? { ...entry, id, parentId: prev } : { ...entry, id };
    prev = id;
    return out;
  });
  writeFileSync(FILE, chained.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const when = new Date(Date.now() - 2 * 60 * 1000);
  utimesSync(FILE, when, when);
  utimesSync(DIR, when, when);
}

// ---- Scratch plugin --------------------------------------------------------

const scratch = mkdtempSync(path.join(TEST_TMP, "plugin-slots-src-"));
const probeDir = path.join(scratch, "probe");
mkdirSync(probeDir);
writeFileSync(
  path.join(probeDir, "pulse-plugin.toml"),
  [
    "schema = 1",
    'id = "probe"',
    'name = "Probe"',
    'version = "0.0.1"',
    'description = "Exercises every slot for the browser suite"',
    'client = "client.js"',
    'slots = ["session.row", "session.menu", "composer.actions", "transcript.tool", "transcript.message", "page", "workspace"]',
    'permissions = ["session.compose"]',
    'tools = ["probe_tool"]',
    'messages = ["probe:card"]',
    "",
    "[[options]]",
    'id = "label_prefix"',
    'label = "Label prefix"',
    'type = "text"',
    'default = "probe"',
    "",
    "[[options]]",
    'id = "loud"',
    'label = "Loud"',
    'type = "bool"',
    "default = false",
    "",
    "[[actions]]",
    'id = "echo"',
    'label = "Echo a word"',
    'command = ["printf", "%s", "{arg}"]',
    'arg_pattern = "[a-z]{1,16}"',
    "timeout_s = 5",
    "",
  ].join("\n"),
);
writeFileSync(
  path.join(probeDir, "client.js"),
  `// Browser-suite probe plugin: every slot, with output the suite can recognise.
const prefix = () => String((pulse.options && pulse.options.label_prefix) || "");

// A call WITHOUT a tap: the host must refuse it. The page shows the outcome.
let loadRun = "pending";
pulse.host.run("echo", "early").then((r) => {
  loadRun = r.ok ? "ran " + r.text : "refused " + r.error;
  pulse.refresh("page");
});

pulse.slot("session.row", (ctx) =>
  ctx.session ? pulse.ui.chip(prefix() + ":" + ctx.session.title, { tone: "muted" }) : null);

pulse.slot("session.menu", () =>
  pulse.ui.list(
    [
      { id: "alpha", label: prefix() + " echo alpha" },
      { id: "bravo", label: prefix() + " echo bravo" },
    ],
    { actions: { click: "menu" } },
  ));

pulse.slot("composer.actions", () =>
  pulse.ui.list(
    [
      { id: "insert", label: "Insert greeting" },
      { id: "prompt", label: "Try to send" },
    ],
    { actions: { click: "compose" } },
  ));

pulse.slot("transcript.tool", (ctx) =>
  ctx.call
    ? pulse.ui.col([
        pulse.ui.text("probe-card " + ctx.call.name, { strong: true }),
        pulse.ui.text("out " + String(ctx.call.output).slice(0, 60), { mono: true }),
      ])
    : null);

pulse.slot("transcript.message", (ctx) =>
  ctx.message
    ? pulse.ui.text("probe-message " + ctx.message.customType + " " + ((ctx.message.details && ctx.message.details.marker) || "no details"))
    : null);

pulse.slot("page", () =>
  pulse.ui.col([
    pulse.ui.card("Probe", [
      pulse.ui.text("prefix " + prefix()),
      pulse.ui.text("load run " + loadRun),
    ]),
  ]));

pulse.slot("workspace", () =>
  pulse.ui.col([
    pulse.ui.text("probe-workspace " + prefix()),
    pulse.ui.button("Tap", "ws-tap"),
  ]));

pulse.on("action", async (event) => {
  if (event.slot === "session.menu") {
    const r = await pulse.host.run("echo", event.item);
    pulse.toast("probe-echo: " + (r.ok ? r.text : "refused " + r.error));
  } else if (event.slot === "composer.actions") {
    if (event.item === "insert") {
      await pulse.composer.insert("hello from probe");
    } else if (event.item === "prompt") {
      const r = await pulse.session.prompt("should not send");
      pulse.toast("probe-prompt ok=" + r.ok + (r.ok ? "" : " " + r.error));
    }
  } else if (event.slot === "workspace") {
    pulse.toast("probe-workspace-tap");
  }
});
`,
);
// Inherits the harness environment, so the link lands in the scratch plugins folder.
execFileSync(BINARY, ["plugin", "link", probeDir], { env: process.env, stdio: "pipe" });

// ---- HTTP helpers ----------------------------------------------------------

const api = async (route, init = {}) => {
  const res = await fetch(`${BASE}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};
const catalogEntry = async (id) => (await api("/api/plugins")).json?.plugins?.find((p) => p.id === id);
const pollUntil = async (fn, timeoutMs = 15000, stepMs = 200) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

// ---- Browser ---------------------------------------------------------------

const webApp = await startWebApp({ base: BASE, port: 5358 });
const profile = mkdtempSync(`${tmpdir()}/omp-verify-plugin-slots-`);
try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  // Headless Chromium never advances the view transition's snapshot animations,
  // so with motion allowed every real click after one lands on a frozen snapshot.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  const WAIT = 15000;
  const SLOW = 25000; // a plugin sandbox has to start before it can draw
  const ROW = (status) => `[data-testid='plugin-row'][data-plugin='probe']${status ? `[data-status='${status}']` : ""}`;
  const click = (selector) => page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
  const tap = async (selector, timeout = WAIT) => {
    await page.waitForSelector(selector, { timeout });
    await click(selector);
  };
  // Toasts are drawn by the app's notice layer; textContent includes whatever
  // the layer renders, visible or not.
  const bodyHas = (text, timeout = WAIT) =>
    page.waitForFunction((t) => (document.body.textContent ?? "").includes(t), { timeout }, text);
  const text = (selector) => page.$eval(selector, (n) => n.textContent ?? "").catch(() => null);

  // The drawer is mounted all the time while closed (hidden); see
  // verify-plugins.mjs for why "open" is a real DOM condition.
  const drawerOpen = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-testid='session-switcher']");
      return !!el && !el.hidden && el.getClientRects().length > 0 && !el.closest("[inert]");
    });
  const openDrawer = async () => {
    if (!(await drawerOpen())) {
      const opener = (await page.$("[data-testid='new-session-menu']")) ?? (await page.$("[data-testid='session-back']"));
      if (!opener) throw new Error("no drawer opener on screen");
      await opener.click();
    }
    await page.waitForFunction(
      () => {
        const el = document.querySelector("[data-testid='session-switcher']");
        return !!el && !el.hidden && el.getClientRects().length > 0 && !el.closest("[inert]");
      },
      { timeout: WAIT },
    );
  };
  const openPluginSettings = async () => {
    await openDrawer();
    await tap("[data-testid='switcher-settings']");
    await page.waitForSelector("[data-testid='settings-screen']", { timeout: WAIT });
    await tap("[data-testid='settings-plugins']");
    await page.waitForSelector("[data-testid='plugins-settings']", { timeout: WAIT });
  };
  const leaveSettings = async () => {
    for (let i = 0; i < 4; i++) {
      const open = await page.evaluate(() => !!document.querySelector("[data-testid='settings-screen']"));
      if (!open) break;
      const before = await page.evaluate(() => [...document.querySelectorAll("[data-settings-page]:not([inert])")].map((n) => n.getAttribute("data-settings-page")).join(","));
      await page.evaluate(() => {
        const tops = [...document.querySelectorAll("[data-settings-page]:not([inert])")];
        tops[tops.length - 1]?.querySelector("header button")?.click();
      });
      await page.waitForFunction(
        (was) => {
          const now = [...document.querySelectorAll("[data-settings-page]:not([inert])")].map((n) => n.getAttribute("data-settings-page")).join(",");
          return !document.querySelector("[data-testid='settings-screen']") || now !== was;
        },
        { timeout: WAIT },
        before,
      );
    }
    await page.waitForFunction(() => !document.querySelector("[data-testid='settings-screen']"), { timeout: WAIT });
  };
  // The plugin's page, opened from its Settings row; Back returns to Settings.
  const openProbePage = async () => {
    // Buttons on the row are disabled while a save is pending; the daemon can report the
    // new value before the app's save promise settles, so wait for an enabled Open.
    await tap(`${ROW("enabled")} [data-testid='plugin-open']:not([disabled])`);
    await page.waitForSelector("[data-testid='plugin-page'][data-plugin='probe']", { timeout: WAIT });
  };
  const closeProbePage = async () => {
    await tap("[data-testid='plugin-page'] button[aria-label='Back']");
    await page.waitForFunction(() => !document.querySelector("[data-testid='plugin-page']"), { timeout: WAIT });
  };

  const badge = (cls = "") => `[data-testid='plugin-row-badges'][data-session="${FILE}"]${cls}`;
  const composerValue = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-testid='composer-input']");
      return el instanceof HTMLTextAreaElement ? el.value : null;
    });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid='new-session-menu'], [data-testid='session-back']", { timeout: 20000 });

  // 1. Review: what the plugin sees, can do, may run, and its options.
  try {
    await openPluginSettings();
    await page.waitForSelector(ROW("needs_review"), { timeout: WAIT });
    const sees = (await text(`${ROW()} [data-testid='plugin-review-sees']`)) ?? "";
    check(
      "review says the plugin sees conversation titles and names its claims",
      /conversation titles/i.test(sees) && sees.includes("probe_tool") && sees.includes("probe:card"),
      sees.slice(0, 240),
    );
    const can = (await text(`${ROW()} [data-testid='plugin-review-can']`)) ?? "";
    check(
      "review lists only the compose permission",
      /message box/i.test(can) && !/send messages/i.test(can) && !/shell/i.test(can) && !/settings/i.test(can),
      can.slice(0, 240),
    );
    const actions = (await text(`${ROW()} [data-testid='plugin-review-actions']`)) ?? "";
    check(
      "review shows the printf argv and the argument pattern",
      actions.includes("printf %s {arg}") && actions.includes("[a-z]{1,16}"),
      actions.slice(0, 240),
    );
    const options = await page.$$eval(`${ROW()} [data-testid='plugin-option']`, (nodes) => nodes.map((n) => n.getAttribute("data-option")));
    check("review offers the two declared options", options.length === 2 && options.includes("label_prefix") && options.includes("loud"), JSON.stringify(options));
    await tap(`${ROW()} [data-testid='plugin-enable']`);
    await page.waitForSelector(ROW("enabled"), { timeout: WAIT });
    const decided = await pollUntil(async () => (await catalogEntry("probe"))?.status === "enabled");
    check("the daemon agrees probe is enabled", !!decided);
  } catch (e) {
    check("review and enable the probe plugin", false, String(e.message ?? e));
  }

  // 5 (UI half, run first so the plugin is live for the option check). The
  // plugin calls pulse.host.run once at load with no tap: the host refuses.
  try {
    await openProbePage();
    await bodyHas("load run refused", SLOW);
    const pageText = (await text("[data-testid='plugin-page']")) ?? "";
    check("a host action at load without a tap is refused as needing a tap", /load run refused.*needs a tap/i.test(pageText), pageText.replace(/\s+/g, " ").slice(0, 200));
    check("the page shows the default option value", pageText.includes("prefix probe"), pageText.replace(/\s+/g, " ").slice(0, 200));
    await closeProbePage();
  } catch (e) {
    check("a host action at load without a tap is refused", false, String(e.message ?? e));
  }

  // 2. Options: saved from Settings, reported by the daemon, picked up live.
  try {
    const input = `${ROW()} [data-testid='plugin-option'][data-option='label_prefix'] input`;
    await page.waitForSelector(input, { timeout: WAIT });
    await page.focus(input);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    const emptied = await page.$eval(input, (n) => n.value);
    check("the option field is empty before typing", emptied === "", JSON.stringify(emptied));
    await page.keyboard.type("zed");
    await page.keyboard.press("Enter");
    const saved = await pollUntil(async () => (await catalogEntry("probe"))?.optionValues?.label_prefix === "zed");
    check("the daemon reports the new option value", !!saved, JSON.stringify((await catalogEntry("probe"))?.optionValues));
    await openProbePage();
    await bodyHas("prefix zed", SLOW);
    check("the running plugin picked the option up without a reload", true);
    await closeProbePage();
    await leaveSettings();
  } catch (e) {
    check("changing an option in Settings", false, String(e.message ?? e));
  }

  // 5 (HTTP half). Host action refusals, with the plugin enabled.
  try {
    const hash = (await catalogEntry("probe"))?.hash ?? "";
    const post = (action, body) => api(`/api/plugins/probe/actions/${action}`, { method: "POST", body: JSON.stringify(body) });
    const wrongHash = await post("echo", { hash: "0000", arg: "abc" });
    check("a host action with the wrong hash is 409 plugin_hash_mismatch", wrongHash.status === 409 && wrongHash.json?.code === "plugin_hash_mismatch", `${wrongHash.status} ${wrongHash.text.slice(0, 120)}`);
    const badArg = await post("echo", { hash, arg: "ABC-1" });
    check("an argument that does not match the pattern is 400", badArg.status === 400, `${badArg.status} ${badArg.text.slice(0, 120)}`);
    const noArg = await post("echo", { hash });
    check("a missing {arg} is 400", noArg.status === 400, `${noArg.status} ${noArg.text.slice(0, 120)}`);
    const unknown = await post("nope", { hash, arg: "abc" });
    check("an unknown action is 404 action_not_found", unknown.status === 404 && unknown.json?.code === "action_not_found", `${unknown.status} ${unknown.text.slice(0, 120)}`);
    const good = await post("echo", { hash, arg: "abc" });
    check("a valid host action runs the declared command", good.status === 200 && good.json?.result?.ok === true && good.json?.result?.text === "abc", `${good.status} ${good.text.slice(0, 160)}`);
  } catch (e) {
    check("host action refusals over HTTP", false, String(e.message ?? e));
  }

  // 3. session.row: the chip is built from the row's own conversation.
  // The drawer row button carries the tap, long-press, session path, and
  // inline plugin badges (DrawerSessionRow.tsx).
  const ROWBTN = `[data-testid='session-row'][data-session-path="${FILE}"]`;
  let rowSelector = null;
  try {
    await showSessionsList(page);
    await page.waitForSelector(badge(), { timeout: SLOW });
    const chips = await page.$$eval(`${badge()} [data-testid='plugin-chip']`, (nodes) => nodes.map((n) => (n.textContent ?? "").trim()));
    check("the conversation row carries a plugin chip built from its own title", chips.some((c) => c === `zed:${TITLE}`), JSON.stringify(chips));
    check("the chip is on the fixture's own row, not another", await page.evaluate(([badgeSel, buttonSel]) => {
      const owner = document.querySelector(badgeSel)?.getAttribute("data-session");
      const button = document.querySelector(buttonSel);
      return !!owner && !!button && button.getAttribute("data-session-path") === owner;
    }, [badge(), ROWBTN]));
    rowSelector = ROWBTN;
  } catch (e) {
    check("session.row chips on the Chats list", false, String(e.message ?? e));
  }

  // 4a. session.menu in the row's long-press actions sheet.
  try {
    if (!rowSelector) throw new Error("no row to long-press");
    // Scroll the row into view first: a row outside the viewport cannot be long-pressed.
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), rowSelector);
    // The open-sheet sequence of verify-session-actions.mjs, verbatim in shape:
    // pointerdown, 1100 ms, pointerup, 1200 ms, then look for the dialog.
    await page.evaluate((sel) => {
      const row = document.querySelector(sel);
      if (!(row instanceof HTMLElement)) return;
      const b = row.getBoundingClientRect();
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: b.x + 40, clientY: b.y + 20, pointerType: "touch" }));
    }, rowSelector);
    await new Promise((r) => setTimeout(r, 1100));
    await page.evaluate((sel) => {
      const row = document.querySelector(sel);
      if (!(row instanceof HTMLElement)) return;
      row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      // A real finger's release also produces a click; the row swallows exactly that
      // one after a long press, so send it or the next real click is the one swallowed.
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, rowSelector);
    await new Promise((r) => setTimeout(r, 1200));
    await page.waitForSelector("[data-testid='drawer-action-more']", { timeout: WAIT });
    await click("[data-testid='drawer-action-more']");
    await page.waitForSelector("[data-testid='action-sheet']", { timeout: WAIT });
    check("a long press on the row opens the drawer menu and More opens the actions sheet", true);
    const item = "[data-testid='action-sheet'] [data-testid='plugin-menu-item'][data-plugin='probe'][data-item='alpha']";
    try {
      await page.waitForSelector(item, { timeout: SLOW });
    } catch (e) {
      const dialogText = await page.evaluate(() => (document.querySelector("[data-testid='action-sheet']")?.textContent ?? "(no sheet)").replace(/\s+/g, " ").slice(0, 300));
      throw new Error(`${e.message ?? e} — sheet text: ${dialogText}`);
    }
    check("the row's actions sheet shows the plugin's menu item", true);
    await click(item);
    await bodyHas("probe-echo: alpha", WAIT);
    check("tapping the sheet item runs the host action and the plugin toasts its output", true);
  } catch (e) {
    check("session.menu in the row's actions sheet", false, String(e.message ?? e));
  }

  // Open the conversation for the rest.
  let chatOpen = false;
  try {
    await page.waitForFunction(() => !document.querySelector("[role='dialog']"), { timeout: WAIT }).catch(() => {});
    await page.evaluate((sel) => document.querySelector(sel)?.click(), rowSelector ?? ROWBTN);
    await page.waitForSelector("[data-testid='composer-input']", { timeout: 25000 });
    chatOpen = true;
  } catch (e) {
    check("open the fixture conversation", false, String(e.message ?? e));
  }

  // 7. transcript.tool.
  try {
    if (!chatOpen) throw new Error("conversation not open");
    const card = "[data-testid='plugin-tool-card'][data-plugin='probe'][data-call='call_probe_1']";
    await page.waitForSelector(card, { timeout: SLOW });
    const cardText = (await text(card)) ?? "";
    check("the claimed tool call is drawn as the plugin's card with context-only text", cardText.includes("probe-card probe_tool") && cardText.includes("zebra"), cardText.replace(/\s+/g, " ").slice(0, 200));
    const unclaimed = await page.$("[data-testid='plugin-tool-card'][data-call='call_other_1']");
    check("an unclaimed tool call in the same conversation has no plugin card", unclaimed === null);
    // In the default Tool calls mode the card sits in the chat flow and its
    // Show original opens the stock detail sheet for the call (contract F).
    await tap(`${card} [data-testid='plugin-show-original']`);
    await page.waitForSelector("[data-testid='tool-sheet'] [data-testid='tool-detail']", { timeout: WAIT });
    const detail = (await text("[data-testid='tool-sheet']")) ?? "";
    check("Show original opens the stock detail sheet with the call's output", detail.includes("zebra"), detail.replace(/\s+/g, " ").slice(0, 200));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid='tool-sheet']"), { timeout: WAIT });
    check("closing the sheet leaves the plugin card in the flow", (await page.$(card)) !== null);
  } catch (e) {
    check("transcript.tool card and Show original", false, String(e.message ?? e));
  }

  // 8. transcript.message.
  try {
    if (!chatOpen) throw new Error("conversation not open");
    const card = "[data-testid='plugin-message-card'][data-plugin='probe']";
    await page.waitForSelector(card, { timeout: SLOW });
    const cardText = (await text(card)) ?? "";
    check("the probe:card message is drawn as the plugin's card with a value from details", cardText.includes("probe-message probe:card quokka-42"), cardText.replace(/\s+/g, " ").slice(0, 200));
    await tap(`${card} [data-testid='plugin-show-original']`);
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: WAIT }, card);
    await page.waitForSelector("[data-testid='plugin-show-original'][aria-pressed='true']", { timeout: WAIT });
    check("Show original brings back the stock message", true);
    await tap("[data-testid='plugin-show-original'][aria-pressed='true']");
    await page.waitForSelector(card, { timeout: WAIT });
    check("pressing again returns to the message card", true);
  } catch (e) {
    check("transcript.message card and Show original", false, String(e.message ?? e));
  }

  // 4b. session.menu in the chat header menu.
  try {
    if (!chatOpen) throw new Error("conversation not open");
    await tap("[data-testid='session-actions']");
    const item = "[data-testid='session-actions-sheet'] [data-testid='plugin-menu-item'][data-plugin='probe'][data-item='bravo']";
    await page.waitForSelector(item, { timeout: SLOW });
    check("the chat header menu shows the plugin's menu item", true);
    await click(item);
    await bodyHas("probe-echo: bravo", WAIT);
    check("tapping the header item runs the host action and the plugin toasts its output", true);
  } catch (e) {
    check("session.menu in the chat header menu", false, String(e.message ?? e));
  }

  // 6. composer.actions: insert puts text in the composer; prompt is refused and sends nothing.
  try {
    if (!chatOpen) throw new Error("conversation not open");
    const openPlus = async (item) => {
      await tap("[data-testid='composer-plus-btn']");
      const sel = `[data-testid='composer-plus-sheet'] [data-testid='plugin-menu-item'][data-plugin='probe'][data-item='${item}']`;
      await page.waitForSelector(sel, { timeout: SLOW });
      return sel;
    };
    await click(await openPlus("insert"));
    await page.waitForFunction(
      () => {
        const el = document.querySelector("[data-testid='composer-input']");
        return el instanceof HTMLTextAreaElement && el.value.includes("hello from probe");
      },
      { timeout: WAIT },
    );
    check("composer.insert puts the text in the composer's field", (await composerValue())?.includes("hello from probe") === true, JSON.stringify(await composerValue()));

    // Count user messages, not bytes: opening the conversation lets the daemon's
    // omp child append its own setup entries (model, thinking level) at any time.
    const userMessages = () => readFileSync(FILE, "utf8").split("\n").filter((line) => /"role"\s*:\s*"user"/.test(line)).length;
    const before = userMessages();
    await click(await openPlus("prompt"));
    await bodyHas("probe-prompt ok=false", WAIT);
    const pageText = await page.evaluate(() => document.body.textContent ?? "");
    const refusal = pageText.slice(pageText.indexOf("probe-prompt ok=false"), pageText.indexOf("probe-prompt ok=false") + 120);
    check("an undeclared session.prompt is refused to the plugin", true, refusal.replace(/\s+/g, " "));
    // Nothing reached the conversation: neither the file nor the transcript changed.
    const after = userMessages();
    check(
      "nothing was sent: no new user message in the session file or the transcript",
      after === before && !pageText.includes("should not send"),
      `user messages ${before} -> ${after}`,
    );
  } catch (e) {
    check("composer.actions insert and refused prompt", false, String(e.message ?? e));
  }

  // 9. workspace: the drawer's Plugins tab, after Terminal, draws the plugin's view; a tap reaches it.
  try {
    if (!chatOpen) throw new Error("conversation not open");
    const tab = "[data-testid='workspace-tabs'] [data-value='plugins']";
    await page.waitForSelector(tab, { timeout: WAIT });
    const order = await page.$$eval("[data-testid='workspace-tabs'] [role='tab']", (nodes) => nodes.map((n) => n.getAttribute("data-value")).join(","));
    check("the workspace dock ends with a Plugins tab", order === "agents,tasks,changes,files,terminal,plugins", order);
    await click(tab);
    const view = "[data-testid='workspace-tab-plugins'] [data-testid='plugin-view'][data-plugin='probe']";
    await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent ?? "").includes("probe-workspace zed"), { timeout: SLOW }, view);
    const title = ((await text("[data-testid='workspace-title']")) ?? "").trim();
    check("the Plugins tab draws the plugin's view under the plugin's name", title === "Probe", title);
    await tap(`${view} [data-testid='plugin-button']`);
    await bodyHas("probe-workspace-tap", WAIT);
    check("a tap on the workspace view reaches the plugin", true);
    await click("[data-testid='workspace-close']");
  } catch (e) {
    check("workspace: the Plugins tab", false, String(e.message ?? e));
  }

  // The plugin must not have been able to do anything the manifest did not declare.
  check("no page errors while using plugin slots", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  check("no console.error from the app", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
