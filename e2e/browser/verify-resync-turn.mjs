#!/usr/bin/env node
// A turn whose end frames the socket never delivered must still end on screen.
//
// WHY: when a phone stops reading (screen off, app switched, slow link) its
// per-client queue in ws.rs overflows, and the daemon CLEARS it — the turn's
// `agent_end` and idle `activity` frames included — and hands it one `resync`
// order. The client answered a resync by refetching history only, so the chat
// kept "Writing…" with a clock counting from the finished turn, and Stop stayed
// up (every send refused as busy) until the conversation was reopened. The live
// daemon had counted 1,896 resyncs in two hours when this was found
// (2026-09-25). History pages now carry the daemon's word on the turn
// (`running`, `now`), and the client settles from them.
//
// Deterministic by construction: a WebSocket shim installed before the app
// loads does to the conversation socket exactly what ws.rs does to a stalled
// client (drop the turn-end frames, then deliver one resync order). The rest is
// real: vite client, test daemon, phone-driven omp child, real model calls.
// Checked against the old client: Stop stayed up 8 s after stopping and
// through the next turn.
//
// Runs under e2e/with-test-daemon.sh; two short model calls. Run it alone.

import { mkdirSync, writeFileSync, mkdtempSync } from "fs";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { loadPuppeteer, chromium, startWebApp, testModel } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const TMP = process.env.OMP_PULSE_TEST_TMP;
if (!BASE || !TOKEN || !SESSIONS || !TMP) {
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The cwd must exist: omp cannot switch into a missing directory, and the
// prompt then fails silently behind a 200 (see verify-stop.mjs).
const CWD = `${TMP}/resync-turn`;
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-resync-turn`;
mkdirSync(dir, { recursive: true });
const TITLE = "Resync turn fixture";
writeFileSync(
  `${dir}/2026-09-25T03-00-00-000Z_019ff400-0000-7000-0000-0000000f00a1.jsonl`,
  [
    { type: "session", version: 3, id: "019ff400-0000-7000-0000-0000000f00a1", timestamp: "2026-09-25T03:00:00.000Z", cwd: CWD, title: TITLE },
    { type: "message", id: "u0", parentId: null, timestamp: "2026-09-25T03:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1790305201000 } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n",
);

const webApp = await startWebApp({ base: BASE, port: 5256 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${TMP}/resync-ui-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));

  // What ws.rs does to a client over its queue ceilings, applied to the turn's
  // end frames while `dropEnds` is set (sessionStorage: shared with the page's
  // world, unlike a window global — see AGENTS.md).
  await page.evaluateOnNewDocument(() => {
    const Real = window.WebSocket;
    const END = /"type":"(agent_end|turn_end|sessions)"|"type":"activity"[^]*"now":null/;
    window.WebSocket = class extends Real {
      constructor(...args) {
        super(...args);
        const self = this;
        let pending = false;
        let handler = null;
        Object.defineProperty(this, "onmessage", {
          get: () => handler,
          set: (fn) => {
            handler = fn;
            super.onmessage = (ev) => {
              if (sessionStorage.getItem("dropEnds") === "1" && typeof ev.data === "string" && END.test(ev.data)) {
                if (!pending) {
                  pending = true;
                  setTimeout(() => {
                    pending = false;
                    handler?.call(self, new MessageEvent("message", { data: '{"type":"resync","reason":"queue overflow"}' }));
                  }, 400);
                }
                return;
              }
              handler?.call(self, ev);
            };
          },
        });
      }
    };
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate((t) => {
    const row = Array.from(document.querySelectorAll("[data-testid='session-row']")).find((r) => (r.textContent || "").includes(t));
    if (row instanceof HTMLElement) row.click();
  }, TITLE);
  await wait(3000);
  const sessionPath = `${dir}/2026-09-25T03-00-00-000Z_019ff400-0000-7000-0000-0000000f00a1.jsonl`;
  const want = await testModel({ base: BASE, token: TOKEN, sessionPath });
  await fetch(`${BASE}/api/rpc`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionPath, command: "set_model", params: { provider: want.provider, modelId: want.id } }) });
  const modelState = await fetch(`${BASE}/api/rpc`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ sessionPath, command: "get_state" }) }).then(r => r.json());
  if (modelState.data?.model?.provider !== want.provider || modelState.data?.model?.id !== want.id) throw new Error(`Refusing model-backed test without ${want.provider}/${want.id}`);

  // The live turn is the newest turn footer: `data-state="running"` while the
  // turn works (step text + elapsed clock), done|stopped|error once it ends.
  // Every sample also records the connection: the footer must never claim a
  // running turn while the offline indicator says the socket is not open.
  const runningWhileDisconnected = [];
  const state = async () => {
    const s = await page.evaluate(() => {
      const footers = document.querySelectorAll('[data-testid="turn-footer"]');
      const newest = footers[footers.length - 1] ?? null;
      const turn = newest?.getAttribute("data-state") ?? null;
      return {
        stop: document.querySelector('button[aria-label="Stop"]') !== null,
        turn,
        step: turn === "running" ? (newest.textContent || "").trim() : "",
        disconnected: document.querySelector('[data-testid="chat-offline-hint"]') !== null,
      };
    });
    if (s.disconnected && s.turn === "running") runningWhileDisconnected.push(s.step);
    return s;
  };
  const send = async (text) => {
    const box = await page.$("textarea, [contenteditable='true']");
    await box.click();
    await page.keyboard.type(text);
    await wait(300);
    await page.keyboard.press("Enter");
  };
  // Resolves the settled sample (no Stop, newest footer not running) or null.
  const settles = async (secs) => {
    for (let i = 0; i < secs * 2; i++) {
      const s = await state();
      if (!s.stop && s.turn !== "running") return s;
      await wait(500);
    }
    return null;
  };

  await page.evaluate(() => sessionStorage.setItem("dropEnds", "1"));

  // 1. Stop with the end frames lost.
  await send("Write the numbers 1 to 400 in words, one per line. No tools.");
  let started = null;
  for (let i = 0; i < 60 && !started; i++) {
    const s = await state();
    if (s.stop && s.turn === "running") started = s;
    else await wait(500);
  }
  check("a phone turn starts (Stop shows, newest turn footer is running)", started !== null, JSON.stringify(await state()));
  await wait(2000);
  await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Stop"]');
    if (b instanceof HTMLElement) b.click();
  });
  const stopped = await settles(6);
  check(
    "Stop clears although agent_end was dropped (newest footer settles, not running)",
    stopped !== null && stopped.turn !== null,
    JSON.stringify(stopped ?? (await state())),
  );

  // 2. A turn that finishes with its end frames lost.
  await send("Reply with exactly one word: OK");
  let second = false;
  for (let i = 0; i < 40 && !second; i++) {
    const s = await state();
    second = s.stop || s.turn === "running";
    if (!second) await wait(500);
  }
  // A gate, not the assertion: without a started turn the next check passes
  // vacuously.
  check("the second turn starts", second);
  const finished = await settles(60);
  check(
    "a finished turn stops showing Stop and its footer reads done, not running",
    finished !== null && finished.turn === "done",
    JSON.stringify(finished ?? (await state())),
  );
  check(
    "the turn footer never claims a running turn while the connection is not open",
    runningWhileDisconnected.length === 0,
    runningWhileDisconnected.slice(0, 3).join(" | "),
  );

  check("no page errors", pageErrors.length === 0, pageErrors[0] || "");
  await browser.close();
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e));
} finally {
  webApp.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures);
