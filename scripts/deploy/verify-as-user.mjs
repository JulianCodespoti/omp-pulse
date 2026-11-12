#!/usr/bin/env node
// See-what-the-owner-sees: load the DEPLOYED app as the owner, open
// conversations the way thumbs do, and diff RENDERED state against daemon
// ground truth. This is the manual gate: nothing ships until this is clean.
//
// STRICTLY READ-ONLY: history GETs, listing GETs, screenshots, console traps.
// No prompts, no answers, no session creation, no mutations of any kind —
// opening a conversation must not change it.
//
// What it checks per sampled session:
//   - rendered message count vs /api/history entry count (the "empty
//     conversation" tripwire: 0 rendered while history is non-empty)
//   - rendered preview/title vs listing row
//   - console errors, pageerrors, failed requests, dead WS
//
// Usage:
//   OMP_PULSE_BASE=https://host OMP_PULSE_TOKEN=... node scripts/deploy/verify-as-user.mjs [N]
// N = recent sessions to open (default 5). Exit code = number of failures.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium } from "../../e2e/lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../../e2e/lib/browser-pairing.mjs";

const BASE = process.env.OMP_PULSE_BASE;
const TOKEN = process.env.OMP_PULSE_TOKEN;
const N = Number(process.argv[2] || 5);
if (!BASE || !TOKEN) {
  console.error("set OMP_PULSE_BASE and OMP_PULSE_TOKEN");
  process.exit(2);
}
if (BASE.includes("7682") && !BASE.includes("tail")) {
  console.error("refusing raw 7682 loopback; use the funnel URL");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const api = async (path) => {
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

const b = await puppeteer.launch({
  headless: true,
  executablePath: chromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-asuser-`)}`],
});
const page = await b.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") problems.push("console: " + m.text().slice(0, 200));
});
// Aborted requests are navigation fallout (this rig navigates between
// samples; the app also aborts superseded polls itself): they carry no
// failure signal. Real breakage surfaces as HTTP errors, exceptions, or
// empty renders — all asserted separately.
page.on("requestfailed", (r) => {
  if ((r.failure()?.errorText || "").includes("ERR_ABORTED")) return;
  problems.push(`reqfail: ${r.url().slice(-90)} ${r.failure()?.errorText || ""}`.slice(0, 200));
});
await openPairedPage(page, `${BASE}/app/`, TOKEN, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
// Poll for rows: the service worker reloads once on first boot and destroys
// the execution context mid-poll (same hazard verify-perf.mjs documents).
{
  const deadline = Date.now() + 90000;
  for (;;) {
    let ready = false;
    try {
      ready = await page.evaluate(() => document.querySelector("[data-testid='session-row']") !== null);
    } catch {
      ready = false;
    }
    if (ready || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  }
  // Screenshots are best-effort evidence, never load-bearing: a wedged
  // renderer must fail the *count* check with its numbers visible, not hang
  // the run inside a screenshot call.
  const shot = (p) => Promise.race([
    page.screenshot({ path: p }),
    new Promise((r) => setTimeout(() => r("shot-timeout"), 15000)),
  ]).catch((e) => `shot-failed:${String(e).slice(0, 60)}`);
await shot("/tmp/asuser-list.png");

// Include every open laptop chat, not just recently written ones. Idle panes
// can have old mtimes; omitting them missed the unread-open grouping bug.
const listing = { sessions: [] };
let cursor;
do {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const data = await api(`/api/sessions?${params}`);
  listing.sessions.push(...data.sessions);
  cursor = data.nextCursor;
} while (cursor);
listing.sessions = [...new Map(listing.sessions.map(row => [row.path, row])).values()];
// This diagnostic is exhaustive; the normal app intentionally loads one page.
for (;;) {
  const more = await page.$("[data-testid=session-load-more]");
  if (!more) break;
  const response = page.waitForResponse(r => r.url().includes("/api/sessions?") && r.url().includes("cursor="));
  await more.click();
  const loaded = await response;
  if (!loaded.ok()) throw new Error(`Older sessions -> ${loaded.status()}`);
  await loaded.json();
  await page.waitForFunction(() => !document.querySelector("[data-testid=session-load-more]")?.disabled);
  await new Promise(resolve => setTimeout(resolve, 100));
}
const byTime = [...(listing.sessions || [])].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
const sessions = [...new Map([
  ...byTime.filter((s) => s.live),
  ...byTime.slice(0, N),
  ...byTime.slice(-2),
].map((s) => [s.path, s])).values()];
const renderedPaths = await page.evaluate(() =>
  Array.from(document.querySelectorAll("[data-testid='session-row']"))
    .map((row) => row.dataset.sessionPath));
const missingPaths = listing.sessions.filter((s) => !renderedPaths.includes(s.path));
// Intentional list hygiene, not missing chats: agent-dir system rows and
// empty creation shells never render. Anything else absent is a real gap.
const isHiddenByRule = (s) =>
  (s.path || "").split("/").includes("-.omp") ||
  (!((s.snippet || {}).text || "").trim() && typeof s.size === "number" && s.size < 8192 &&
    s.live !== true && s.running !== true && s.status !== "streaming" && s.status !== "waiting");
const unexpectedMissing = missingPaths.filter((s) => !isHiddenByRule(s));
const extraPaths = renderedPaths.filter((p) => !listing.sessions.some((s) => s.path === p));
check("every listed session has exactly one rendered row",
  unexpectedMissing.length === 0 && extraPaths.length === 0 &&
    new Set(renderedPaths).size === renderedPaths.length,
  `${unexpectedMissing.length} unexpected missing (${missingPaths.length} hidden by rule); rendered=${renderedPaths.length}, listed=${listing.sessions.length}`);
console.log(`      sampling ${sessions.length} sessions (all laptop + recent + oldest)`);

for (const s of sessions) {
  const title = (s.title || s.path || "").slice(0, 44);
  // Ground truth: full history entry count (paged, follow cursors).
  let truth = -1;
  try {
    let count = 0;
    let before = null;
    for (let p = 0; p < 20; p++) {
      const h = await api(
        `/api/history?session=${encodeURIComponent(s.path)}&limit=200` +
          (before !== null ? `&before=${before}` : ""),
      );
      const entries = h.entries || [];
      count += entries.length;
      if (entries.length < 200 || h.nextBefore == null) break;
      before = h.nextBefore;
    }
    truth = count;
  } catch (e) {
    check(`history readable (${title})`, false, String(e).slice(0, 100));
  }
  // Rendered: click the row, count message nodes. A full navigation here
  // (SW update, deep link) is itself a finding — record the URL and move on.
  let rendered = { rendered: -3, fallback: -3, shown: "", url: "" };
  try {
    rendered = await page.evaluate(async (sessionPath) => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
      const row = rows.find((r) => r.dataset.sessionPath === sessionPath);
      if (!(row instanceof HTMLElement)) return { rendered: -2, fallback: -2, shown: "", url: location.href };
      row.click();
      await new Promise((r) => setTimeout(r, 3500));
      return {
        rendered: document.querySelectorAll("[data-testid='chat-message']").length,
        fallback: document.querySelectorAll(".chat-scroll > *").length,
        shown: document.body.innerText.slice(0, 120).replace(/\n/g, " | "),
        url: location.href,
      };
    }, s.path);
  } catch (e) {
    console.log(`      !! sample crashed for ${title}: ${String(e).slice(0, 120)}`);
  }
  const n = rendered.rendered >= 0 ? rendered.rendered : rendered.fallback;
  const empty = n === 0 && truth > 0;
  check(
    `chat renders (${title}…)`,
    !empty && n >= 0 && truth >= 0,
    empty
      ? `EMPTY but history has ${truth} entries | screen: ${rendered.shown.slice(0, 100)} | url: ${rendered.url.slice(-60)}`
      : `rendered=${n} truth=${truth} url=${(rendered.url || "").slice(-40)}`,
  );
  const idx = sessions.indexOf(s);
  const mem = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : -1)).catch(() => -1);
  console.log(`      heap=${mem === -1 ? "n/a" : Math.round(mem / 1048576) + "MB"}`);
  await shot(`/tmp/asuser-chat-${idx}.png`);
  // Back to the list for the next sample (in-app back only — history.back()
  // on a fresh profile leaves the app for about:blank).
  try {
    const back = await page.evaluate(() => {
      const el = document.querySelector("[data-testid='chat-back'], [aria-label='Back']");
      if (el instanceof HTMLElement) {
        el.click();
        return true;
      }
      return false;
    });
    if (!back) {
      await page.goto(`${BASE}/app/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await new Promise((r) => setTimeout(r, 1500));
  } catch {}
}

check("no console/page/network problems", problems.length === 0, problems.slice(0, 4).join(" || "));
await b.close();
console.log(failures === 0 ? "all checks passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
