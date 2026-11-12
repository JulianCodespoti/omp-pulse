#!/usr/bin/env node
// Plugins, end to end through the product path: a plugin folder on the daemon
// machine is reviewed and switched on in Settings, draws into the drawer and its
// own page from a sandboxed worker, cannot reach the network, storage or the
// page, cannot freeze the app by looping, goes back to review when its files
// change, and disappears when switched off.
//
// WHY THIS EXISTS: a plugin is third-party script running next to the user's
// credential. The unit tests prove the pieces (manifest, hash, view validation);
// only a real browser proves the claims users rely on: the iframe really is
// sandboxed without allow-same-origin, the probes inside the worker really read
// "blocked", a runaway render is stopped by the host's 2000 ms budget, and an
// edited script is never run on the strength of an old approval.
//
// Selectors (all from the plugin work, none invented here):
//   settings-plugins, plugins-settings, plugin-row[data-plugin][data-status],
//   plugin-enable, plugin-disable, plugin-open  web/src/app/plugins/PluginsSettings.tsx
//                                               and SettingsScreen.tsx
//   plugin-slot-drawer, plugin-view[data-plugin], plugin-chip
//                                               web/src/app/plugins/PluginSlot.tsx, NodeView.tsx
//   plugin-page                                 web/src/app/plugins/PluginPage.tsx
//   switcher-settings, session-switcher         web/src/app/nav/SessionSwitcher.tsx
//   settings-screen, [data-settings-page]       web/src/app/SettingsScreen.tsx
//   new-session-menu, session-back              used the same way by verify-projects.mjs
//
// No model calls. Runs under e2e/with-test-daemon.sh, which points
// OMP_PULSE_PLUGINS_DIR at a scratch folder; the suite refuses to run without
// it, so it can never touch a developer's real plugins. Exit code is non-zero
// when any check fails.

import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const TEST_TMP = process.env.OMP_PULSE_TEST_TMP;
const PLUGINS_DIR = process.env.OMP_PULSE_PLUGINS_DIR;

if (!BASE || !TOKEN || !TEST_TMP) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-plugins.mjs");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}
// The plugins folder must be the harness's scratch one: linking and enabling
// plugins against a real folder would run a developer's real commands.
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

// ---- Scratch plugins -------------------------------------------------------

const scratch = mkdtempSync(path.join(TEST_TMP, "plugin-src-"));
const hostUsageDir = path.join(scratch, "host-usage");
const spinDir = path.join(scratch, "spin");
cpSync(path.join(ROOT, "examples", "plugins", "host-usage"), hostUsageDir, { recursive: true });
mkdirSync(spinDir);
writeFileSync(
  path.join(spinDir, "pulse-plugin.toml"),
  [
    "schema = 1",
    'id = "spin"',
    'name = "Spin"',
    'version = "0.0.1"',
    'description = "Loops forever to prove the host stops a runaway render"',
    'client = "client.js"',
    'slots = ["drawer"]',
    "",
  ].join("\n"),
);
writeFileSync(
  path.join(spinDir, "client.js"),
  'pulse.slot("drawer", () => {\n  for (;;) {}\n});\n',
);
for (const dir of [hostUsageDir, spinDir]) {
  // Inherits the harness environment, so the link lands in the scratch plugins folder.
  execFileSync(BINARY, ["plugin", "link", dir], { env: process.env, stdio: "pipe" });
}

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

// ---- 1. Before approval, over HTTP -----------------------------------------

{
  const listed = await api("/api/plugins");
  const entry = listed.json?.plugins?.find((p) => p.id === "host-usage");
  check(
    "catalogue lists host-usage as needs_review with a 64-hex hash",
    entry?.status === "needs_review" && /^[0-9a-f]{64}$/.test(entry?.hash ?? ""),
    JSON.stringify(entry ?? listed.text.slice(0, 200)),
  );
  const script = await api("/api/plugins/host-usage/client.js");
  check("script of an unreviewed plugin is 409 plugin_not_enabled", script.status === 409 && script.json?.code === "plugin_not_enabled", `${script.status} ${script.text.slice(0, 120)}`);
  const source = await api("/api/plugins/host-usage/sources/load");
  check("source of an unreviewed plugin is 409", source.status === 409, `${source.status} ${source.text.slice(0, 120)}`);
  const wrongHash = await api("/api/plugins/host-usage/state", { method: "POST", body: JSON.stringify({ enabled: true, hash: "0000" }) });
  check("enabling with a wrong hash is 409 plugin_hash_mismatch", wrongHash.status === 409 && wrongHash.json?.code === "plugin_hash_mismatch", `${wrongHash.status} ${wrongHash.text.slice(0, 120)}`);
  const unknown = await api("/api/plugins/no-such-plugin/client.js");
  check("an unknown plugin id is 404", unknown.status === 404, `${unknown.status}`);
  const stillReview = await catalogEntry("host-usage");
  check("a refused enable leaves the plugin in review", stillReview?.status === "needs_review", stillReview?.status);
}

// ---- Browser ---------------------------------------------------------------

const webApp = await startWebApp({ base: BASE, port: 5357 });
const profile = mkdtempSync(`${tmpdir()}/omp-verify-plugins-`);
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
  const ROW = (id, status) => `[data-testid='plugin-row'][data-plugin='${id}']${status ? `[data-status='${status}']` : ""}`;
  const DRAWER_VIEW = (id) => `[data-testid='plugin-slot-drawer'] [data-testid='plugin-view'][data-plugin='${id}']`;
  const click = (selector) => page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
  const tap = async (selector, timeout = WAIT) => {
    await page.waitForSelector(selector, { timeout });
    await click(selector);
  };

  // The drawer (SidePanel.tsx) is mounted all the time (keepMounted); while
  // closed Base UI renders its popup `hidden`. So "open" means the popup is
  // not hidden, has a box and is not under an inert layer. SessionSwitcher
  // mounts the drawer plugin slot as active only in that state, so a drawer
  // plugin runs only while this holds.
  const drawerOpen = () =>
    page.evaluate(() => {
      const el = document.querySelector("[data-testid='session-switcher']");
      return !!el && !el.hidden && el.getClientRects().length > 0 && !el.closest("[inert]");
    });
  const waitDrawer = (open) =>
    page.waitForFunction(
      (want) => {
        const el = document.querySelector("[data-testid='session-switcher']");
        const isOpen = !!el && !el.hidden && el.getClientRects().length > 0 && !el.closest("[inert]");
        return isOpen === want;
      },
      { timeout: WAIT },
      open,
    );
  // Open it the way verify-projects.mjs does: from home or from a chat.
  const openDrawer = async () => {
    if (!(await drawerOpen())) {
      const opener = (await page.$("[data-testid='new-session-menu']")) ?? (await page.$("[data-testid='session-back']"));
      if (!opener) throw new Error("no drawer opener on screen");
      await opener.click();
    }
    await waitDrawer(true);
  };
  const openPluginSettings = async () => {
    await openDrawer();
    await tap("[data-testid='switcher-settings']");
    await page.waitForSelector("[data-testid='settings-screen']", { timeout: WAIT });
    await tap("[data-testid='settings-plugins']");
    await page.waitForSelector("[data-testid='plugins-settings']", { timeout: WAIT });
  };
  // Back out of Settings one page at a time: the top page's header button is
  // "Back" on a detail page and "Close settings" on the root.
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
  const enableInUi = async (id) => {
    await page.waitForSelector(ROW(id, "needs_review"), { timeout: WAIT });
    await tap(`${ROW(id)} [data-testid='plugin-enable']`);
    await page.waitForSelector(ROW(id, "enabled"), { timeout: WAIT });
  };
  const drawerChips = (id) =>
    page.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-testid='plugin-chip']`)].map((n) => (n.textContent ?? "").trim()), DRAWER_VIEW(id));
  const hostUsageChipText = (text) => text.startsWith("load ") || text.startsWith("mem ") || text === "host usage unavailable";
  const waitForHostUsageChip = async () => {
    await page.waitForFunction(
      (sel) => [...document.querySelectorAll(`${sel} [data-testid='plugin-chip']`)].some((n) => {
        const t = (n.textContent ?? "").trim();
        return t.startsWith("load ") || t.startsWith("mem ") || t === "host usage unavailable";
      }),
      { timeout: 20000 },
      DRAWER_VIEW("host-usage"),
    );
  };

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid='new-session-menu']", { timeout: 20000 });

  // 2. Review and enable in the UI.
  try {
    await openPluginSettings();
    await page.waitForSelector(ROW("host-usage", "needs_review"), { timeout: WAIT });
    const reviewText = await page.$eval(ROW("host-usage"), (n) => n.textContent ?? "");
    check("review text shows the exact command", reviewText.includes("cat /proc/loadavg"), reviewText.slice(0, 200));
    await enableInUi("host-usage");
    check("Turn on moves host-usage to enabled", true);
    const decided = await pollUntil(async () => (await catalogEntry("host-usage"))?.status === "enabled");
    check("the daemon agrees host-usage is enabled", !!decided);
  } catch (e) {
    check("review and enable host-usage in Settings", false, String(e.message ?? e));
  }

  // 3. Drawer slot.
  try {
    await leaveSettings();
    await openDrawer();
    await waitForHostUsageChip();
    const chips = await drawerChips("host-usage");
    check("drawer slot shows host-usage chips", chips.some(hostUsageChipText), JSON.stringify(chips));
  } catch (e) {
    check("drawer slot shows host-usage chips", false, String(e.message ?? e));
  }

  // 4. Sandbox shape (the hidden iframe exists while a slot is retained).
  try {
    const frames = await page.$$eval("iframe", (nodes) => nodes.map((n) => ({ sandbox: n.getAttribute("sandbox"), src: n.getAttribute("src") ?? "" })));
    check(
      "a plugin iframe has sandbox exactly allow-scripts and a blob: source",
      frames.some((f) => f.sandbox === "allow-scripts" && f.src.startsWith("blob:")),
      JSON.stringify(frames),
    );
    check("no iframe is allowed same-origin", !frames.some((f) => (f.sandbox ?? "").split(/\s+/).includes("allow-same-origin")), JSON.stringify(frames));
  } catch (e) {
    check("sandbox shape", false, String(e.message ?? e));
  }

  // 5. Isolation, read from the plugin's own page.
  try {
    await openPluginSettings();
    await page.waitForSelector(ROW("host-usage", "enabled"), { timeout: WAIT });
    await tap(`${ROW("host-usage")} [data-testid='plugin-open']`);
    await page.waitForSelector("[data-testid='plugin-page']", { timeout: WAIT });
    const readChecks = () =>
      page.evaluate(() => {
        const card = [...document.querySelectorAll("[data-testid='plugin-page'] section")].find((s) => s.querySelector("h4")?.textContent?.trim() === "Sandbox check");
        if (!card) return null;
        const rows = {};
        for (const dt of card.querySelectorAll("dt")) rows[(dt.textContent ?? "").trim()] = (dt.nextElementSibling?.textContent ?? "").trim();
        return rows;
      });
    await page.waitForFunction(
      () => {
        const card = [...document.querySelectorAll("[data-testid='plugin-page'] section")].find((s) => s.querySelector("h4")?.textContent?.trim() === "Sandbox check");
        return !!card && card.querySelectorAll("dt").length >= 6;
      },
      { timeout: 20000 },
    );
    const rows = await readChecks();
    for (const key of ["fetch", "importScripts", "eval", "IndexedDB"]) {
      check(`sandbox probe ${key} reads blocked`, rows?.[key] === "blocked", `${key} = ${JSON.stringify(rows?.[key])}${rows?.[key] === "reachable" ? " — PLUGIN CODE CAN REACH IT" : ""}`);
    }
    check("sandbox probe origin reads null", rows?.origin === "null", `origin = ${JSON.stringify(rows?.origin)}`);
    check("sandbox probe native bridge reads none", rows?.["native bridge"] === "none", `native bridge = ${JSON.stringify(rows?.["native bridge"])}`);
    await tap("[data-testid='plugin-page'] button[aria-label='Back']");
    await page.waitForFunction(() => !document.querySelector("[data-testid='plugin-page']"), { timeout: WAIT });
    await leaveSettings();
  } catch (e) {
    check("sandbox isolation probes on the plugin page", false, String(e.message ?? e));
  }

  // 6. A runaway plugin: stopped by the host, app stays usable.
  try {
    await openPluginSettings();
    await enableInUi("spin");
    await leaveSettings();
    await openDrawer();
    // spin only starts while the drawer is open, and the host stops it after
    // its 2000 ms render budget. Keep the drawer open well past start-up plus
    // that budget while proving the page keeps answering: round-trip a frame
    // repeatedly and fail on any single stall. The window is measured on the
    // clock, not slept.
    const started = Date.now();
    let worstMs = 0;
    while (Date.now() - started < 5000) {
      const t0 = Date.now();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));
      worstMs = Math.max(worstMs, Date.now() - t0);
    }
    check("the page answers every frame while a plugin loops", worstMs < 1000, `worst frame round trip ${worstMs} ms`);
    check("the drawer stayed open for the whole runaway window", await drawerOpen());

    // The failure is shown on the plugin's row in Settings (kept until its hash changes).
    const navStart = Date.now();
    await openPluginSettings();
    await page.waitForSelector(`${ROW("spin")} [role='alert']`, { timeout: 20000 });
    const message = await page.$eval(`${ROW("spin")} [role='alert']`, (n) => (n.textContent ?? "").trim());
    check("the runaway plugin's row shows a failure message", message.length > 0, message.slice(0, 160));
    await leaveSettings();
    await openPluginSettings();
    const navMs = Date.now() - navStart;
    check("Settings opened, closed and reopened while a plugin had failed", navMs < 30000, `${navMs} ms`);
    await leaveSettings();
    await openDrawer();
    await waitForHostUsageChip();
    check("host-usage chips are still in the drawer afterwards", (await drawerChips("host-usage")).some(hostUsageChipText));
  } catch (e) {
    check("a runaway plugin is stopped and the app stays usable", false, String(e.message ?? e));
  }

  // 7. A changed plugin goes back to review.
  try {
    const before = await catalogEntry("host-usage");
    appendFileSync(path.join(hostUsageDir, "client.js"), "\n// changed after approval\n");
    await openPluginSettings();
    await page.waitForSelector(ROW("host-usage", "needs_review"), { timeout: WAIT });
    // Changed, not new: the row must say the approved plugin was edited (PluginsSettings.tsx data-changed).
    const changedShown = (await page.$(`${ROW("host-usage", "needs_review")}[data-changed='true']`)) !== null;
    check("the row says the plugin changed since it was turned on", changedShown);
    const after = await catalogEntry("host-usage");
    check("an edited plugin returns to needs_review", after?.status === "needs_review" && after.hash !== before?.hash, `${before?.status} -> ${after?.status}`);
    const script = await api("/api/plugins/host-usage/client.js");
    check("the edited script is 409 again", script.status === 409, `${script.status}`);
    await leaveSettings();
    await openDrawer();
    const gone = await page
      .waitForFunction((sel) => !document.querySelector(sel), { timeout: WAIT }, DRAWER_VIEW("host-usage"))
      .then(() => true, () => false);
    // Absence only means something while the drawer is verifiably open.
    check("the edited plugin's drawer view is gone", gone && (await drawerOpen()));
  } catch (e) {
    check("a changed plugin goes back to review", false, String(e.message ?? e));
  }

  // 8. Turning off clears views.
  try {
    await openPluginSettings();
    await enableInUi("host-usage");
    await leaveSettings();
    await openDrawer();
    await waitForHostUsageChip();
    check("re-enabling brings the chip back", (await drawerChips("host-usage")).some(hostUsageChipText));
    await openPluginSettings();
    await tap(`${ROW("host-usage", "enabled")} [data-testid='plugin-disable']`);
    await page.waitForSelector(ROW("host-usage", "disabled"), { timeout: WAIT });
    const status = await pollUntil(async () => (await catalogEntry("host-usage"))?.status === "disabled");
    check("the catalogue reports host-usage disabled", !!status);
    await leaveSettings();
    await openDrawer();
    const cleared = await page
      .waitForFunction((sel) => !document.querySelector(sel), { timeout: WAIT }, DRAWER_VIEW("host-usage"))
      .then(() => true, () => false);
    check("turning off clears the drawer view", cleared && (await drawerOpen()));
  } catch (e) {
    check("turning off clears views", false, String(e.message ?? e));
  }

  check("no page errors while using plugins", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
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
