#!/usr/bin/env node
// Proof that branching works at all.
//
// It never did. `DaemonApi.branch` read `data.sessionPath` from the reply, but
// omp's branch RPC returns `{ selectedText, cancelled }` and nothing else
// (rpc-mode.ts:487, agent-session.ts:7816) — so the client threw
// "branch: missing sessionPath" on all four call sites, every time. The only
// existing coverage checked that the word "Fork" appeared in a sheet.
//
// What omp actually does: `session.branch(entryId)` creates a new session file
// and moves the child onto it IN PLACE, then hands back the text of the user
// message you branched at so the editor can restore it for you to amend and
// resend. The timeline offers it from each row's menu as "Rewind into a new
// chat", next to "Go here", which moves the SAME chat back in place.
//
// So there are three things to prove, and the second and third are the ones
// that were wrong:
//   1. the daemon really does create a new session,
//   2. the client finds its path (get_state.sessionFile) instead of throwing,
//   3. the branched message comes back in the composer, as it does on the
//      laptop.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, readdirSync, readFileSync } from "fs";
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
  console.error("refusing to run against the live daemon on 7682 — branching rewrites a real session");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CWD = "/tmp/omp-branch-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-branch`;
mkdirSync(dir, { recursive: true });
// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates aged this fixture out.
// Offsets relative to 2026-08-21T12:09:00.000Z (the newest stamp) are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-21T12:09:00.000Z");
const shiftTs = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const sessionPath = `${dir}/2026-08-21T12-00-00-000Z_019ff400-0000-7000-0000-00000013080e.jsonl`;
const entries = [{ id: "e-s", type: "session", cwd: CWD, title: "Branch fixture" }];
// The timeline's jump points are user turns that HAVE a sourceEntryId, which
// the transcript derives from the entry's own id + timestamp. Omit those and
// the sheet renders "No turns yet" no matter how many messages exist.
const QUESTIONS = ["First question", "Second question", "Third question"];
QUESTIONS.forEach((q, i) => {
  const ts = shiftTs(`2026-08-21T12:0${i}:00.000Z`);
  entries.push({
    id: `e-u-${i}`,
    type: "message",
    timestamp: ts,
    message: { id: `m-u-${i}`, role: "user", content: [{ type: "text", text: q }] },
  });
  entries.push({
    id: `e-a-${i}`,
    type: "message",
    timestamp: ts,
    message: { id: `m-a-${i}`, role: "assistant", content: [{ type: "text", text: `Answer ${i}` }] },
  });
});
writeFileSync(sessionPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 60_000);
utimesSync(sessionPath, when, when);

const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
await fetch(`${BASE}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ sessionPath }) });
await new Promise((r) => setTimeout(r, 13_000));

const listSessions = async () => {
  const r = await fetch(`${BASE}/api/sessions`, { headers: H });
  const j = await r.json();
  return (j.sessions || []).map((s) => s.path);
};
const before = await listSessions();

const webApp = await startWebApp({ base: BASE, port: 5252 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-br-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20_000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Branch fixture")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await wait(4000);

  // The timeline is part of the chat's Tasks tab (todo list, then one row per
  // turn), a page of the pinned tab row under the header.
  const opened = await page.evaluate(() => {
    const tab = document.querySelector("[data-testid='workspace-tabs'] [data-value='tasks']");
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  });
  const shown = opened
    ? await page
        .waitForSelector("[data-testid='workspace-tab-tasks'] [data-testid='timeline-row-menu']", { timeout: 15_000 })
        .then(() => true, () => false)
    : false;
  check("the timeline is reachable from the chat's Tasks tab", opened && shown);

  const turns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="timeline-row-menu"]'))
      .map((b) => b.getAttribute("aria-label") || ""),
  );
  check("the timeline offers a rewind point per user turn", turns.length >= 3, JSON.stringify(turns));

  // Branch at the SECOND question, so a correct implementation restores
  // "Second question" and not merely the newest message.
  const target = turns.find((l) => l.includes("Second question"));
  check("the turn we want to rewind to is listed", Boolean(target), JSON.stringify(turns));

  // A stray native dialog would hang the renderer outright, so fail loudly
  // rather than silently accepting one: rewind must stay inside the app.
  let nativeDialog = null;
  page.on("dialog", async (d) => {
    nativeDialog = d.message();
    await d.accept();
  });

  const tap = async (label) =>
    page.evaluate((l) => {
      const b = Array.from(document.querySelectorAll('[data-testid="timeline-row-menu"]')).find(
        (x) => (x.getAttribute("aria-label") || "") === l,
      );
      if (!(b instanceof HTMLElement)) return false;
      b.scrollIntoView({ block: "center" });
      b.click();
      return true;
    }, label);

  check("the row menu is tappable", await tap(target));
  await wait(1200);

  // The row's ⋯ opens the turn's actions; Rewind is one choice, next to Go here.
  const rewindOffered = await page.evaluate(() => {
    const b = document.querySelector("[data-testid='timeline-row-actions'] [data-testid='timeline-rewind-new']");
    if (!(b instanceof HTMLElement)) return false;
    b.click();
    return true;
  });
  check("the row menu offers Rewind into a new chat", rewindOffered);
  await wait(1200);

  const asked = await page.evaluate(() =>
    Boolean(document.querySelector("[data-testid='confirm-sheet-confirm']")),
  );
  check("choosing Rewind asks in a confirm sheet instead of a system dialog", asked);
  check(
    "no native browser dialog is used",
    nativeDialog === null,
    nativeDialog ? `window.confirm: "${nativeDialog}"` : "",
  );

  check("the rewind can be confirmed", await page.evaluate(() => {
    const b = document.querySelector("[data-testid='confirm-sheet-confirm']");
    if (!b) return false;
    b.click();
    return true;
  }));
  await wait(7000);

  const errText = await page.evaluate(() => {
    const t = document.body.textContent || "";
    const m = t.match(/branch: [^\n]{0,60}/);
    return m ? m[0] : null;
  });
  check(
    "branching does not fail with the missing-sessionPath error",
    errText === null,
    errText ? `saw "${errText}"` : "",
  );

  // Ground truth, from disk: the daemon wrote a NEW session file next to the
  // source (src/sessions/branch.rs builds it from the source file, which is never
  // written), the phone moved onto it, and it holds only the turn before the
  // branch point. The source's own child never moves any more, so asking it
  // for `get_state` would prove nothing.
  const branchFile = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && `${dir}/${f}` !== sessionPath)
    .map((f) => `${dir}/${f}`)[0];
  const hashPath = await page.evaluate(() => decodeURIComponent((location.hash.match(/s=([^&]+)/) || [])[1] || ""));
  check(
    "the phone moved onto a new session file",
    !!branchFile && hashPath === branchFile,
    `${(branchFile || "none").split("/").pop()} vs ${hashPath.split("/").pop()}`,
  );
  const branchMessages = branchFile
    ? readFileSync(branchFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "message").length
    : -1;
  check(
    "the conversation was rewound to the branch point, not left whole",
    branchMessages === 2,
    `messages=${branchMessages} (fixture had 6)`,
  );

  // The listing is served from a short stale-while-revalidate snapshot, so poll.
  let after = await listSessions();
  for (let i = 0; i < 12 && after.length <= before.length; i++) {
    await wait(1000);
    after = await listSessions();
  }
  check(
    "the new session shows up in the session list",
    after.length === before.length + 1,
    `${before.length} -> ${after.length}`,
  );

  const composer = await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="message"]');
    return ta instanceof HTMLTextAreaElement ? ta.value : null;
  });
  check(
    "the branched message is restored into the composer, ready to amend",
    composer === "Second question",
    JSON.stringify(composer),
  );

  check("no page errors while branching", errors.length === 0, errors.join(" | "));

  await browser.close();
} finally {
  webApp.stop();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures);
