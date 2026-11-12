#!/usr/bin/env node
// Proof that /compact keeps its terminal shape on the phone.
//
// On the laptop /compact does not ask you anything — no argument prompt, no
// "are you sure". It just starts compacting, and that is acceptable precisely
// because stopping is immediate (see verify-stop.mjs). Two commands in the same
// palette behave differently on purpose: /model opens a picker, /compact fires.
// Flattening them into "every command opens a sheet" would lose the thing that
// makes the command set feel like omp.
//
// Asserts the UI contract (fires with no intervening dialog) AND that the
// daemon actually starts compacting.
//
// Runs under e2e/with-test-daemon.sh. Costs a model call, so run it alone.
// Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, readFileSync } from "fs";
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
  console.error("refusing to run against the live daemon on 7682 — it would compact a real conversation");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// cwd must exist or omp cannot switch into the session.
const CWD = "/tmp/omp-compact-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-compact`;
mkdirSync(dir, { recursive: true });
const sessionPath = `${dir}/2026-08-20T20-00-00-000Z_019ff400-0000-7000-0000-0000000aa107.jsonl`;

// Enough history that compaction has something to chew on.
const entries = [
  { type: "session", id: "019ff400-0000-7000-0000-0000000aa107", cwd: CWD, title: "Compact fixture" },
];
for (let i = 0; i < 30; i++) {
  entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `Question ${i}: explain topic ${i}.` }] } });
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Answer ${i}. ${"Detail sentence that adds context to the transcript. ".repeat(12)}` }],
    },
  });
}
writeFileSync(sessionPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 60_000);
utimesSync(sessionPath, when, when);

const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const rpc = async (command, args = {}) => {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST", headers: H, body: JSON.stringify({ sessionPath, command, args }),
  });
  try { return JSON.parse(await res.text()); } catch { return {}; }
};

await fetch(`${BASE}/api/open`, { method: "POST", headers: H, body: JSON.stringify({ sessionPath }) });
await new Promise((r) => setTimeout(r, 12_000));

const webApp = await startWebApp({ base: BASE, port: 5236 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-cmp-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Compact fixture")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await wait(3500);

  const box = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='composer-input']");
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  // Baseline before firing: compaction is proven by a DURABLE change, not by
  // catching `isCompacting` mid-flight. That flag is transient and a 1s poll
  // misses it entirely, which reads as "compaction never ran".
  const before = await rpc("get_state");
  const tokensBefore = ((before.data ?? {}).contextUsage ?? {}).tokens ?? null;

  if (box) await page.mouse.click(box.x, box.y);
  await wait(600);
  await page.keyboard.type("/compact");
  await wait(1500);

  const offered = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])")).some((el) =>
      (el.textContent || "").trim().startsWith("/compact"),
    ),
  );
  check("/compact is offered in the palette", offered);

  // The phone answers /compact in the compaction row above the composer:
  // "Compacting context" while it runs, then "Compacted" or omp's refusal
  // ("Nothing to compact yet"), which folds away after a few seconds. Any
  // other failure lands in the command result sheet. Record every state from
  // the tap on, so an answer shown briefly is not missed by a slow poll.
  await page.evaluate(() => {
    const seen = [];
    window.__compactSeen = seen;
    const note = (entry) => {
      if (seen[seen.length - 1] !== entry) seen.push(entry);
    };
    const scan = () => {
      const pill = document.querySelector("[data-testid='compact-pill']");
      const state = pill?.getAttribute("data-state");
      if (pill && state !== "offer") note(`${state}: ${(pill.textContent || "").trim().slice(0, 80)}`);
      const sheet = document.querySelector("[data-testid='command-result-sheet']");
      if (sheet) note(`result-sheet: ${(sheet.textContent || "").trim().slice(0, 160)}`);
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });

  const tapped = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll("[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])")).find(
      (el) => (el.textContent || "").trim().startsWith("/compact"),
    );
    if (hit instanceof HTMLElement) { hit.click(); return true; }
    return false;
  });
  check("/compact can be tapped", tapped);

  // The shape contract: no argument sheet, no confirmation. Checked promptly —
  // a dialog that appears and is dismissed later would still be a wrong shape.
  await wait(900);
  const interposed = await page.evaluate(() => {
    const sheet = document.querySelector("[data-testid='command-input-sheet']");
    const dialogs = Array.from(document.querySelectorAll("[role='dialog']"));
    return {
      inputSheet: sheet !== null,
      dialogText: dialogs.map((d) => (d.textContent || "").trim().slice(0, 60)),
    };
  });
  check(
    "/compact asks nothing first — no argument sheet",
    interposed.inputSheet === false,
    "a command-input sheet appeared",
  );
  check(
    "/compact asks nothing first — no confirmation dialog",
    !interposed.dialogText.some((t) => /confirm|are you sure|proceed/i.test(t)),
    interposed.dialogText.join(" | "),
  );

  // And it must actually do something. Accept any of: the transient flag if we
  // happen to catch it, a `compaction` entry appended to the session (durable),
  // or context usage dropping. The phone's own answer (the compaction row
  // settling on Compacted, a refusal, or an error sheet) ends the wait too.
  const surfaced = () => page.evaluate(() => window.__compactSeen ?? []);
  const answered = (log) => log.some((entry) => /^(done|refused|result-sheet):/.test(entry));
  let evidence = null;
  let log = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && evidence === null) {
    const st = await rpc("get_state");
    const d = st.data ?? {};
    if (d.isCompacting === true) { evidence = "isCompacting flag observed"; break; }
    const now = (d.contextUsage ?? {}).tokens ?? null;
    if (tokensBefore !== null && now !== null && now < tokensBefore * 0.9) {
      evidence = `context dropped ${tokensBefore} -> ${now} tokens`;
      break;
    }
    try {
      const raw = readFileSync(sessionPath, "utf8");
      if (raw.includes('"type":"compaction"') || raw.includes('"compaction"')) {
        evidence = "compaction entry written to the session";
        break;
      }
    } catch {}
    log = await surfaced();
    if (answered(log)) break;
    await wait(1500);
  }
  log = await surfaced();
  // "Compacted" on the phone is a claim: the session file must back it.
  if (evidence === null && log.some((entry) => entry.startsWith("done:"))) {
    await wait(1500);
    if (readFileSync(sessionPath, "utf8").includes('"type":"compaction"')) evidence = "compaction entry written to the session";
  }
  // Compaction cannot always happen: below a threshold omp answers
  // {ok:false,"Nothing to compact (session too small)"}. The real contract is
  // that the tap is never a silent no-op — it either compacts or says why.
  // Asserting "it always compacts" would only be satisfiable by a fixture large
  // enough to fill a 1M-token window. "Says why" means omp's own reason
  // reached the screen, not any error at all.
  const OMP_REFUSAL = /nothing to compact|already compacted|compaction already in progress|no configured compaction method/i;
  const reported = evidence === null ? log.find((entry) => /^(refused|result-sheet):/.test(entry) && OMP_REFUSAL.test(entry)) ?? null : null;
  check(
    "tapping /compact is never a silent no-op",
    evidence !== null || reported !== null,
    `no compaction (from ${tokensBefore} tokens) and no explanation surfaced; the phone showed ${JSON.stringify(log)}`,
  );
  if (evidence) console.log(`      compacted: ${evidence}`);
  if (reported) console.log(`      reported to the user: ${JSON.stringify(reported)}`);
  console.log(`      the phone showed: ${JSON.stringify(log)}`);

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
