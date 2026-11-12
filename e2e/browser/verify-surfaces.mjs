#!/usr/bin/env node
// The surfaces nothing else opens: session search, the chat's Files tab, and
// the timeline in its Tasks tab.
//
// All three are one tap away and none had coverage. A sheet that opens onto a
// permanent empty state, or a search that filters nothing, is the kind of thing
// that is invisible from the code and obvious the first time you use the app on
// a phone.
//
// Asserts real content, not just that a dialog appeared — "it opened" is
// satisfied equally well by a broken sheet showing its empty state.
//
// Runs under e2e/with-test-daemon.sh. No model call. Exit = failure count.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
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
  console.error("refusing to run against the live daemon on 7682");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A cwd with real files, so the Files sheet has something to list.
const CWD = "/tmp/omp-surfaces-cwd";
mkdirSync(`${CWD}/src`, { recursive: true });
writeFileSync(`${CWD}/README.md`, "# fixture\n");
writeFileSync(`${CWD}/src/main.ts`, "export const answer = 42;\n");
writeFileSync(`${CWD}/package.json`, '{"name":"surfaces-fixture"}\n');

const dir = `${SESSIONS}/-tmp-surfaces`;
mkdirSync(dir, { recursive: true });
const UNIQUE = "Zanzibar";
// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-21T01:05:00.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-21T01:05:00.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const file = `${dir}/2026-08-21T01-00-00-000Z_019ff400-0000-7000-0000-0000000ff60c.jsonl`;
const entries = [
  { type: "session", id: "019ff400-0000-7000-0000-0000000ff60c", cwd: CWD, title: `Surfaces fixture ${UNIQUE}` },
];
// Entries need a top-level `id` and `timestamp`: the transcript derives
// sourceEntryId from them, and the timeline's jump points are user turns that
// HAVE one. A fixture without ids renders "No turns yet" no matter how many
// messages it contains — which looks exactly like a broken timeline.
for (let i = 0; i < 6; i++) {
  const ts = shiftTs(`2026-08-21T01:0${i}:00.000Z`);
  entries.push({
    id: `e-u-${i}`, type: "message", timestamp: ts,
    message: { id: `m-u-${i}`, role: "user", content: [{ type: "text", text: `Turn ${i} question` }] },
  });
  entries.push({
    id: `e-a-${i}`, type: "message", timestamp: ts,
    message: { id: `m-a-${i}`, role: "assistant", content: [{ type: "text", text: `Turn ${i} answer.` }] },
  });
}
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 60_000);
utimesSync(file, when, when);

// A second session so search has something to filter OUT.
const other = `${dir}/2026-08-21T01-05-00-000Z_019ff400-0000-7000-0000-0000000ff70d.jsonl`;
writeFileSync(
  other,
  JSON.stringify({ type: "session", id: "019ff400-0000-7000-0000-0000000ff70d", cwd: CWD, title: "Unrelated other session" }) + "\n",
);
utimesSync(other, when, when);

const webApp = await startWebApp({ base: BASE, port: 5266 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-surf-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rowCount = () => page.evaluate(() => document.querySelectorAll("[data-testid='session-row']").length);

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await wait(900);

  // ── search ────────────────────────────────────────────────────────────────
  const before = await rowCount();
  const searchBox = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='session-search']");
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  check("the session search field exists", searchBox !== null);
  if (searchBox) {
    await page.mouse.click(searchBox.x, searchBox.y);
    await wait(300);
    await page.keyboard.type(UNIQUE);
    await wait(1400);
    const after = await rowCount();
    const showsMatch = await page.evaluate((u) => (document.body.textContent || "").includes(u), UNIQUE);
    check("search narrows the list", after < before && after > 0, `${before} -> ${after} rows`);
    check("search keeps the matching session", showsMatch);

    const clearPresent = await page.evaluate(
      () => document.querySelector("[data-testid='clear-search']") !== null,
    );
    check("a clear-search affordance appears while filtering", clearPresent);
    // Measures the EFFECTIVE target: the painted box unioned with an
    // absolutely-positioned ::after carrying negative insets. This control is
    // deliberately a compact 28px circle and reaches 44px that way.
    const clearTap = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='clear-search']");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const a = getComputedStyle(el, "::after");
      const px = (v) => (v && v.endsWith("px") ? parseFloat(v) : 0);
      const grow = a.content && a.content !== "none" && a.position === "absolute";
      const w = r.width + (grow ? -px(a.left) - px(a.right) : 0);
      const h = r.height + (grow ? -px(a.top) - px(a.bottom) : 0);
      return { w: Math.round(w), h: Math.round(h) };
    });
    check(
      "the clear-search control meets the 44px touch minimum",
      clearTap !== null && clearTap.w >= 44 && clearTap.h >= 44,
      clearTap ? `${clearTap.w}x${clearTap.h}` : "not found",
    );
    await page.evaluate(() => {
      const b = document.querySelector("[data-testid='clear-search']");
      if (b instanceof HTMLElement) b.click();
    });
    // The list re-queries and is ETag-revalidated, so poll rather than sleep.
    let restored = after;
    for (let i = 0; i < 15 && restored < before; i++) {
      await wait(600);
      restored = await rowCount();
    }
    check("clearing search restores the list", restored >= before, `${after} -> ${restored} rows (was ${before})`);

    // Refresh-while-filtered is a SECOND write site into the store, and it was
    // missed when the search effect was fixed: it replaced the rows without
    // dropping the controller's listing ETag, so the clear that followed got a
    // 304 and the list stayed filtered for good.
    const refilterBox = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='session-search']");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (refilterBox) await page.mouse.click(refilterBox.x, refilterBox.y);
    await page.keyboard.type("Zanzibar");
    await wait(1800);
    const filteredAgain = await rowCount();
    check("search narrows again", filteredAgain < before, `${filteredAgain} rows`);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) =>
        /refresh/i.test(x.getAttribute("aria-label") || ""),
      );
      if (b instanceof HTMLElement) b.click();
    });
    await wait(2500);
    await page.evaluate(() => {
      const b = document.querySelector("[data-testid='clear-search']");
      if (b instanceof HTMLElement) b.click();
    });
    let afterRefreshClear = await rowCount();
    for (let i = 0; i < 15 && afterRefreshClear < before; i++) {
      await wait(600);
      afterRefreshClear = await rowCount();
    }
    check(
      "clearing search still restores the list after a refresh while filtered",
      afterRefreshClear >= before,
      `${afterRefreshClear} rows (was ${before})`,
    );
  }

  // ── open the fixture session ──────────────────────────────────────────────
  await page.evaluate((u) => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes(u)) || rows[0];
    if (t instanceof HTMLElement) t.click();
  }, UNIQUE);
  await wait(3500);

  // Files and the timeline are pages of the chat's pinned tab row (Files, and
  // Tasks: the todo list, then one row per turn), NOT behind slash commands or
  // the header's "Session actions" sheet. /files is not a command at all and
  // /tree is not in the daemon's list, so reaching for the palette tested a
  // path that does not exist and reported the surfaces as broken.
  const openTab = async (value) => {
    const tapped = await page.evaluate((v) => {
      const tab = document.querySelector(`[data-testid='workspace-tabs'] [data-value='${v}']`);
      if (!(tab instanceof HTMLElement)) return false;
      tab.click();
      return true;
    }, value);
    if (!tapped) return false;
    return page
      .waitForSelector(`[data-testid='workspace-tabs'] [data-value='${value}'][aria-selected='true']`, { timeout: 8000 })
      .then(() => true, () => false);
  };

  // ── timeline ──────────────────────────────────────────────────────────────
  check("the Tasks tab is offered in the chat's tab row", await openTab("tasks"));
  // The tab mounts lazily and reads the tree after it shows: wait for rows (or
  // the empty state a broken timeline would settle on) instead of a fixed sleep.
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector("[data-testid='workspace-tab-tasks'] [data-testid='tasks-tab']");
        return !!el && (el.querySelector("[data-timeline-row-id]") || /no turns yet|no tasks yet/i.test(el.textContent || ""));
      },
      { timeout: 15000 },
    )
    .catch(() => undefined);
  const timeline = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='workspace-tab-tasks'] [data-testid='tasks-tab']");
    if (!el) return { open: false };
    const text = (el.textContent || "").trim();
    const rows = Array.from(el.querySelectorAll("[data-timeline-row-id]")).map((r) => (r.textContent || "").trim());
    return { open: true, empty: /no turns yet|no tasks yet/i.test(text), rows, text: text.slice(0, 80) };
  });
  check("the timeline opens in the Tasks tab", timeline.open);
  const listed = timeline.open ? [0, 1, 2, 3, 4, 5].filter((i) => timeline.rows.some((r) => r.includes(`Turn ${i} question`))) : [];
  check(
    "the timeline lists the session's turns, not an empty state",
    timeline.open && timeline.empty === false && listed.length === 6,
    timeline.empty ? "showed 'No turns yet' for a session with 6 turns" : `${listed.length} of 6 turns listed: ${timeline.text || "not open"}`,
  );

  // ── files ─────────────────────────────────────────────────────────────────
  check("the Files tab is offered in the chat's tab row", await openTab("files"));
  await page
    .waitForFunction(() => /README\.md|package\.json|no folder for this session|empty folder/i.test(document.querySelector("[data-testid='workspace-tab-files'] [data-testid='files-tab']")?.textContent || ""), { timeout: 15000 })
    .catch(() => undefined);
  const files = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='workspace-tab-files'] [data-testid='files-tab']");
    if (!el) return { open: false };
    const text = (el.textContent || "").trim();
    return {
      open: true,
      empty: /no folder for this session|empty folder/i.test(text),
      hasFixture: /README\.md|package\.json|src/.test(text),
      text: text.slice(0, 90),
    };
  });
  check("the files tab opens", files.open, "Files tapped but no files-tab in the DOM");
  check(
    "the files tab lists the session's directory",
    files.open && files.empty === false && files.hasFixture,
    files.text || "",
  );

  check("no page errors across these surfaces", pageErrors.length === 0, pageErrors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
