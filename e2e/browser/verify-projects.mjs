#!/usr/bin/env node
// Projects are folders, and a folder is where a chat runs. This proves the
// whole way in: the drawer lists the folders chats live in, a folder opens
// exactly its own chats (one exact cwd, never a name prefix), and that page
// starts a new chat with the folder already chosen. The older module listed
// projects as a filter chip on a page that also had its own New button and a
// large title; the chip, the grouping toggle and the saved filter are gone, so
// this drives the drawer instead.
//
// No model calls. The fixture spans two projects whose paths share a prefix,
// so a prefix match would show up as an extra row.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;

if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-projects.mjs");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Fixture timestamps are shifted to be recent: the list hides conversations
// whose newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates
// age out.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:00:00.000Z");
const ts = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const PROJECT = "/tmp/verify-projects";
const SIBLING = "/tmp/verify-projects-sibling";
const PROJECT_NAME = "verify-projects";
// Sessions live in a directory named after their cwd, the way omp files them.
const dirOf = (cwd) => `${SESSIONS}/${cwd.replaceAll("/", "-")}`;
const mkSession = (file, sid, title, cwd = PROJECT) => {
  const entries = [
    { type: "title", title },
    { type: "session", id: sid, cwd, title },
    {
      id: `${sid}-u`, type: "message", timestamp: ts("2026-08-20T12:00:00.000Z"),
      message: { id: `${sid}-mu`, role: "user", content: [{ type: "text", text: "hi" }] },
    },
  ];
  mkdirSync(dirOf(cwd), { recursive: true });
  writeFileSync(`${dirOf(cwd)}/${file}`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

mkSession(
  "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000f1.jsonl",
  "019ff400-0000-7000-0000-0000000000f1",
  "Filter Alpha",
);
mkSession(
  "2026-08-20T12-11-00-000Z_019ff400-0000-7000-0000-0000000000f2.jsonl",
  "019ff400-0000-7000-0000-0000000000f2",
  "Filter Beta",
);
mkSession(
  "2026-08-20T12-12-00-000Z_019ff400-0000-7000-0000-0000000000f3.jsonl",
  "019ff400-0000-7000-0000-0000000000f3",
  "Filter Gamma",
  SIBLING,
);
const when = new Date(Date.now() - 2 * 60 * 1000);
for (const cwd of [PROJECT, SIBLING]) utimesSync(dirOf(cwd), when, when);

const webApp = await startWebApp({ base: BASE, port: 5356 });

const profile = mkdtempSync(`${tmpdir()}/omp-verify-projects-`);
try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${profile}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  // This suite is about which chats a folder shows, not about the slide. With
  // motion allowed, headless Chromium never advances the view transition's
  // snapshot animations (no composited frames), so every real click after one
  // lands on the frozen snapshot instead of the page.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = () => page.evaluate(() => document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']").length);
  const openDrawer = async () => {
    if (!(await page.$("[data-testid='session-switcher'][data-open]"))) {
      const opener = await page.$("[data-testid='new-session-menu']") ?? await page.$("[data-testid='session-back']");
      await opener.click();
    }
    await page.waitForSelector("[data-testid='session-switcher'][data-open]", { timeout: 10000 });
    await page.waitForSelector("[data-testid='switcher-project']", { timeout: 15000 });
    await sleep(500);
  };

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  // Home is the start; the drawer is where projects live.
  await page.waitForSelector("[data-testid='new-session-menu']", { timeout: 20000 });
  await openDrawer();

  const listed = await page.$$eval("[data-testid='switcher-project']", (nodes) => nodes.map((node) => node.getAttribute("data-cwd")));
  check("the drawer lists the folders chats run in", JSON.stringify([...listed].sort()) === JSON.stringify([PROJECT, SIBLING]), JSON.stringify(listed));
  check("a project row carries its exact cwd, not a display name", listed.includes(PROJECT) && listed.includes(SIBLING), JSON.stringify(listed));

  await page.click(`[data-testid='switcher-project'][data-cwd='${PROJECT}']`);
  await page.waitForSelector("[data-testid='project-new-chat']", { timeout: 15000 });
  await sleep(900);
  const title = await page.evaluate(() => document.querySelector("[data-testid='session-switcher'] header h2")?.textContent ?? "");
  check("a project scopes the drawer header to its folder", title === PROJECT_NAME, title);
  check("the scoped drawer holds exactly that folder's chats", (await rows()) === 2, `rows=${await rows()}`);

  await page.click("[data-testid='project-new-chat']");
  await page.waitForSelector("[data-testid='new-session-project']", { timeout: 15000 });
  await sleep(600);
  const chip = await page.evaluate(() => document.querySelector("[data-testid='new-session-project']")?.textContent ?? "");
  check("New chat arrives home with that folder already chosen", chip.includes(PROJECT_NAME), chip);
  await openDrawer();
  await page.click("[data-testid='switcher-projects']");
  await page.waitForSelector(`[data-testid='project-row'][data-cwd='${SIBLING}']`, { timeout: 15000 });
  await sleep(300);
  const listedAll = await page.$$eval("[data-testid='project-row']", (nodes) => nodes.map((node) => node.getAttribute("data-cwd")));
  check("All projects lists every folder", JSON.stringify([...listedAll].sort()) === JSON.stringify([PROJECT, SIBLING]), JSON.stringify(listedAll));

  await page.evaluate((cwd) => document.querySelector(`[data-testid='project-row'][data-cwd='${cwd}']`)?.click(), SIBLING);
  await sleep(900);
  await page.waitForSelector("[data-testid='project-new-chat']", { timeout: 15000 });
  await sleep(900);
  check("a folder from the list opens its own chats", (await rows()) === 1, `rows=${await rows()}`);

  check("no page errors while moving through projects", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
