#!/usr/bin/env node
// Objective UI audit across the surfaces a phone actually touches: text
// contrast, touch-target size, and text clipped by a fixed height.
//
// Written after a manual pass kept finding defects that were invisible in the
// source and obvious on screen. Its first run caught two real ones:
//   - "Forget pairing token" at 3.42:1, below AA. `--danger` was serving as
//     both fill and on-surface text; white-on-fill measures 4.55:1 so the fill
//     could not move, and the text role needed its own lifted token.
//   - eleven folder rows at 41px in the new-session sheet, under the 44px
//     floor this project holds every other control to.
//
// The probe itself lives in ../lib/ui-probe.mjs, shared with scripts/ui/states/.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
import { UI_PROBE } from "../lib/ui-probe.mjs";

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
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  if (!ok) failures++;
};

const dir = `${SESSIONS}/-tmp-verify-a11y`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/2026-08-20T12-50-00-000Z_019ff400-0000-7000-0000-0000000000e1.jsonl`;
const entries = [
  { type: "session", id: "019ff400-0000-7000-0000-0000000000e1", cwd: "/tmp/verify-a11y", title: "Accessibility audit fixture" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "Run a build and show me the diff" }] } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Here is the result.\n\n\`\`\`bash\nnpm run build\n\`\`\`\n\n${"Body text that wraps at 390px. ".repeat(10)}` }],
    },
  },
];
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(file, when, when);

const webApp = await startWebApp({ base: BASE, port: 5216 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-a11y-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickLabel = (needle) =>
    page.evaluate((n) => {
      const hit = Array.from(document.querySelectorAll("button,[role='button']")).find((e) =>
        `${e.getAttribute("aria-label") || ""} ${e.title || ""} ${e.textContent || ""}`.toLowerCase().includes(n),
      );
      if (hit instanceof HTMLElement) { hit.click(); return true; }
      return false;
    }, needle);

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await wait(900);

  const all = {};
  const scan = async (name) => { all[name] = await page.evaluate(UI_PROBE); };

  await scan("sessions");
  // New session is home now; Settings is a drawer row (≡ on home), and the list is a pushed page again afterwards.
  await clickLabel("new session"); await wait(1400); await scan("new-session");
  await page.click("[data-testid='new-session-menu']");
  await page.waitForSelector("[data-testid='switcher-settings']", { timeout: 5000 });
  await page.evaluate(() => document.querySelector("[data-testid='switcher-settings']")?.click());
  await wait(1400); await scan("settings");
  await page.keyboard.press("Escape"); await wait(900);
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Accessibility audit")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await wait(3000); await scan("chat");

  // The chat header: floating pills inside one landmark row. The menu button
  // opens the session drawer, there is no visible title (the h1 stays for
  // screen readers), and the ⋮ button announces the menu it opens.
  const header = await page.evaluate(() => {
    // The chat's own header landmark, not one left mounted by another screen.
    const el = document.querySelector("[data-testid='session-back']")?.closest("header");
    const attr = (id, name) => el?.querySelector(`[data-testid='${id}']`)?.getAttribute(name) ?? null;
    return {
      h1: el?.parentElement?.querySelector("h1")?.textContent ?? null,
      menu: attr("session-back", "aria-label"),
      newChat: attr("session-new-chat", "aria-label"),
      title: attr("session-actions", "aria-label"),
      workspace: attr("open-workspace", "aria-label"),
      actionsPopup: attr("session-actions", "aria-haspopup"),
    };
  });
  check("the chat keeps its title as the page heading", header.h1 === "Accessibility audit fixture", JSON.stringify(header));
  check("the menu button is named Open sessions and new chat is named", header.menu === "Open sessions" && header.newChat === "New chat", JSON.stringify(header));
  check(
    "the more button is named Session actions",
    !!header.title && header.title.startsWith("Session actions"),
    JSON.stringify(header),
  );
  // The workspace drawer's sections: one named tablist whose tabs each
  // control a panel, with exactly one selected.
  await page.click("[data-testid='open-workspace']");
  await page.waitForSelector("[data-testid='workspace-drawer'][data-open]", { timeout: 5000 }).catch(() => null);
  await wait(600);
  const tabs = await page.evaluate(() => {
    const list = document.querySelector("[role='tablist'][aria-label='Workspace sections']");
    const all = [...(list?.querySelectorAll("[role='tab']") ?? [])];
    return {
      count: all.length,
      selected: all.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.value),
      panels: all.every((t) => document.getElementById(t.getAttribute("aria-controls") ?? "")?.getAttribute("role") === "tabpanel"),
    };
  });
  await page.click("[data-testid='workspace-close']");
  await page.waitForFunction(() => !document.querySelector("[data-testid='workspace-drawer'][data-open]"), { timeout: 5000 }).catch(() => null);
  await wait(500);
  check("the workspace sections are one tablist, one selected, each tab controlling a panel", tabs.count === 5 && tabs.selected.length === 1 && tabs.panels, JSON.stringify(tabs));
  check("the more button announces a menu and the workspace button is named", header.actionsPopup === "menu" && !!header.workspace?.startsWith("Workspace"), JSON.stringify(header));

  // The ⋮ menu is a floating menu of menuitems, scanned like any other surface.
  await page.click("[data-testid='session-actions']"); await wait(900);
  const sheet = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='session-actions-sheet']");
    const items = el ? Array.from(el.querySelectorAll("[role='menuitem']")).map((b) => (b.textContent || "").trim()) : [];
    return { role: el?.getAttribute("role") ?? null, items };
  });
  check(
    "session actions open as a floating menu of menuitems",
    sheet.role === "menu" && sheet.items.some((t) => t.startsWith("Rename")) && sheet.items.some((t) => t.startsWith("Reload")),
    JSON.stringify(sheet),
  );
  await scan("chat-actions-sheet");
  await page.keyboard.press("Escape"); await wait(900);

  // Expand a tool card before scanning again. The scan only looks at VISIBLE
  // elements, so everything inside a collapsed card is invisible to it — which
  // is how a 28px copy button lived in the output panel while this suite
  // reported every touch target compliant.
  await page.evaluate(() => {
    const trig = Array.from(document.querySelectorAll("button")).find((x) =>
      (x.textContent || "").trim().startsWith("$"),
    );
    if (trig instanceof HTMLElement) trig.click();
  });
  await wait(1800); await scan("chat-tool-expanded");

  const gather = (key) =>
    Object.entries(all).flatMap(([s, r]) => (r[key] || []).map((x) => ({ surface: s, ...x })));

  const badContrast = gather("contrast");
  check(
    "all text meets WCAG AA contrast",
    badContrast.length === 0,
    badContrast.map((c) => `[${c.surface}] ${c.ratio}:1 (need ${c.need}) ${JSON.stringify(c.text)} ${c.color}`).join("\n      "),
  );

  const badTargets = gather("small");
  check(
    "every touch target is at least 44px",
    badTargets.length === 0,
    badTargets.map((t) => `[${t.surface}] effective ${t.w}x${t.h} (painted ${t.painted}) <${t.tag}> ${JSON.stringify(t.label)}`).join("\n      "),
  );

  const badClip = gather("clipped");
  check(
    "no text is clipped by a fixed height",
    badClip.length === 0,
    badClip.map((c) => `[${c.surface}] ${c.ch}px of ${c.sh}px ${JSON.stringify(c.text)}`).join("\n      "),
  );

  const sideways = Object.entries(all).filter(([, r]) => r.docOverflow).map(([s]) => s);
  check("no surface scrolls sideways", sideways.length === 0, sideways.join(", "));

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
