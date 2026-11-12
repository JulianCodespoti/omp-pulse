#!/usr/bin/env node
// Verifies the phone against a TERMINAL-OWNED session — the normal case on the
// owner's machine, and the one the other suites never covered.
//
// Every other harness spawns sessions the daemon itself owns, so every
// session-scoped RPC succeeds there. In real life the desktop omp holds the
// session file open, `src/authority/guard.rs` refuses to spawn a second writer, and
// `get_subagents` / `get_session_stats` / `get_state` fail permanently. That
// difference is why the owner saw a raw `session_owned_by_terminal: … pid …
// --mode rpc …` string inside the Agents sheet.
//
// This suite simulates the foreign owner (a process whose argv0 stems to `omp`
// holding the session file open, which is what `looks_like_omp` matches) and
// asserts two things:
//   1. no internal error code, pid or command line ever reaches the screen
//   2. the surfaces that CAN work from the transcript still do
import { spawn } from "child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "fs";
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

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// Fixture: a session carrying real `usage` / `contextSnapshot` shapes so the
// derived-stats path has something truthful to compute from.
// ---------------------------------------------------------------------------
const dir = `${SESSIONS}/-tmp-owned`;
mkdirSync(dir, { recursive: true });
const sessionFile = `${dir}/owned.jsonl`;
// The project folder must exist: project routes never fall back to HOME, so a
// missing one leaves the command catalogue empty.
const projectDir = `${process.env.OMP_PULSE_TEST_TMP}/owned`;
mkdirSync(projectDir, { recursive: true });
const entries = [
  { type: "session", id: "owned-1", cwd: projectDir, title: "Terminal owned session" },
  {
    type: "message",
    timestamp: "2026-08-29T00:00:01.000Z",
    message: { id: "u1", role: "user", content: [{ type: "text", text: "run the audit" }] },
  },
  {
    type: "message",
    timestamp: "2026-08-29T00:00:02.000Z",
    message: {
      id: "a1",
      role: "assistant",
      model: "anthropic/claude-opus-5",
      content: [
        { type: "text", text: "Spawning a reviewer." },
        { type: "toolCall", id: "call_task_1", name: "task", arguments: { agent: "reviewer", i: "Review the diff" }, intent: "Review the diff" },
      ],
      usage: {
        input: 12, output: 340, cacheRead: 120000, cacheWrite: 900,
        totalTokens: 121252,
        cost: { input: 0.0001, output: 0.0085, cacheRead: 0.06, cacheWrite: 0.0056, total: 0.0742 },
      },
      contextSnapshot: { promptTokens: 121000, nonMessageTokens: 4000, compactionEpoch: 1 },
    },
  },
  {
    type: "message",
    timestamp: "2026-08-29T00:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call_task_1", toolName: "task", content: "reviewer finished: 2 findings", isError: false },
  },
];
writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

// ---------------------------------------------------------------------------
// The foreign owner. `src/authority/guard.rs::looks_like_omp` matches on argv0's file
// stem being `omp`, and the fd layer sees the open descriptor.
// ---------------------------------------------------------------------------
const fakeBin = mkdtempSync(`${tmpdir()}/omp-fakebin-`);
const fakeOmp = `${fakeBin}/omp`;
// `looks_like_omp` matches on argv0's file STEM being `omp`, so a shebang
// script is not enough — the kernel would report the interpreter. `exec -a`
// sets argv0 explicitly, which is what makes the guard's argv layer match,
// while the open descriptor satisfies its fd layer.
// `exec -a` sets argv0 so the guard's argv layer matches; the trailing `:`
// stops bash tail-call-exec'ing into `sleep`, which would replace argv0 and
// hide the process. The open descriptor satisfies the guard's fd layer.
//
// The holder must NOT inherit this process's terminal identity. Adoption
// resolves a session owner's pane from /proc/<pid>/environ, and an
// owner-resolved pane skips the content fingerprint by design — so a holder
// that inherited the developer's HERDR_PANE_ID was resolved to the REAL pane
// running their conversation: the daemon typed `/collab` into it and forwarded
// this suite's prompt into it as a guest on the live relay (measured
// 2026-09-14, the exact class of leak the harness header warns about).
// A synthetic owner has no pane, and its environment must say so.
const TERMINAL_ENV_VARS = [
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "KITTY_LISTEN_ON",
  "KITTY_WINDOW_ID",
  "TMUX",
  "TMUX_PANE",
];
const fixtureEnv = { ...process.env };
for (const key of TERMINAL_ENV_VARS) delete fixtureEnv[key];
const holder = spawn(
  "bash",
  ["-c", `exec -a "${fakeOmp}" /bin/bash -c 'exec 3< "$1"; sleep 600; :' _ "${sessionFile}"`],
  { stdio: "ignore", env: fixtureEnv },
);
await new Promise((r) => setTimeout(r, 900));

// Probed, not fixed: a hardcoded port attaches the suite to whatever unrelated
// dev server already owns it (verify-sync timed out that way on 5188).
const webApp = await startWebApp({ base: BASE, port: 5195 });

try {
  // Confirm the daemon really does refuse — otherwise this suite proves nothing.
  const rpcProbe = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionPath: sessionFile, command: "get_session_stats", params: {} }),
  }).then((r) => r.json());
  const refused = String(rpcProbe?.code ?? "") === "session_owned_by_terminal";
  check(
    "fixture reproduces a terminal-owned session",
    refused,
    refused ? "daemon refused a session RPC as expected" : `daemon did NOT refuse: ${JSON.stringify(rpcProbe).slice(0, 200)}`,
  );
  if (!refused) {
    console.log("\nCannot verify owned-session UX without a real refusal.");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-owned-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });

  const openOwned = async () => {
    const ok = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
      const hit = rows.find((r) => (r.textContent || "").includes("Terminal owned session"));
      if (!hit) return false;
      hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    });
    await new Promise((r) => setTimeout(r, 1800));
    return ok;
  };
  check("terminal-owned session opens", await openOwned());

  // The transcript itself must render — it is file-tailed, no child needed.
  const transcript = await page.evaluate(() => document.body.textContent || "");
  check(
    "transcript renders for a terminal-owned session",
    transcript.includes("run the audit") && transcript.includes("Spawning a reviewer"),
    transcript.slice(0, 120),
  );

  // The load-bearing assertion: nothing internal may ever be on screen.
  const LEAKS = ["session_owned_by_terminal", "--mode rpc", "/proc/", "session file is held open"];
  const scanForLeaks = async (label) => {
    const text = await page.evaluate(() => document.body.innerText || "");
    const found = LEAKS.filter((l) => text.includes(l));
    const pidLeak = /\bpid\s+\d{3,}/i.test(text);
    check(
      `${label}: no internal error text on screen`,
      found.length === 0 && !pidLeak,
      found.length || pidLeak ? `leaked ${JSON.stringify(found)}${pidLeak ? " + a pid" : ""}` : "clean",
    );
  };

  // ⋯ opens the session actions sheet; its rows are plain buttons keyed by
  // testid (no menu items any more).
  const openSessionAction = async (testId) => {
    await page.evaluate(() => {
      const b = document.querySelector("[data-testid='session-actions']");
      if (b instanceof HTMLElement) b.click();
    });
    await page.waitForSelector("[data-testid='session-actions-sheet']", { timeout: 5000 }).catch(() => null);
    const clicked = await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid='session-actions-sheet'] [data-testid='${id}']`);
      if (!(row instanceof HTMLElement) || row.hasAttribute("disabled") || row.hasAttribute("data-disabled") || row.getAttribute("aria-disabled") === "true") return false;
      row.click();
      return true;
    }, testId);
    await new Promise((r) => setTimeout(r, 1600));
    return clicked;
  };

  const closeSheets = async () => {
    await page.keyboard.press("Escape").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("[role='dialog']")) {
        const btn = el.querySelector("button[aria-label='Close'],button[aria-label='close']");
        if (btn instanceof HTMLElement) btn.click();
      }
    });
    await new Promise((r) => setTimeout(r, 400));
  };

  // Agents are a page of the chat's tab row.
  await page.waitForSelector("[data-testid='workspace-tabs'] [data-value='agents']", { timeout: 8000 }).catch(() => null);
  await page.evaluate(() => {
    const tab = document.querySelector("[data-testid='workspace-tabs'] [data-value='agents']");
    if (tab instanceof HTMLElement) tab.click();
  });
  const agentsTab = await page
    .waitForSelector("[data-testid='workspace-tab-agents'] [data-testid='agents-tab']", { timeout: 8000 })
    .catch(() => null);
  if (agentsTab) {
    // The live roster read is refused for a terminal-owned session; wait for
    // the tab to settle out of its loading skeleton before reading it.
    await page
      .waitForFunction(() => !document.querySelector("[data-testid='workspace-tab-agents'] [data-testid='agents-loading']"), { timeout: 10000 })
      .catch(() => undefined);
    await scanForLeaks("agents tab");
    const agents = await page.evaluate(() => {
      const tab = document.querySelector("[data-testid='workspace-tab-agents']");
      return {
        text: tab instanceof HTMLElement ? tab.innerText || "" : "",
        retry: Array.from(tab?.querySelectorAll("button") ?? []).some((b) => /^retry$/i.test((b.textContent || "").trim())),
      };
    });
    check(
      "agents tab lists this chat's agent from the transcript instead of erroring",
      /From this chat/i.test(agents.text) && /reviewer|Review the diff/i.test(agents.text) && !/Couldn.t load agents/i.test(agents.text),
      agents.text.slice(0, 200).replace(/\s+/g, " "),
    );
    check("agents tab offers no impossible Retry", !agents.retry, agents.text.slice(0, 200).replace(/\s+/g, " "));
  } else {
    check("agents tab reachable from the tab row", false, "the Agents tab not found");
  }
  await page.evaluate(() => document.querySelector("[data-testid='workspace-close']")?.click());
  await new Promise((r) => setTimeout(r, 600));

  if (await openSessionAction("session-settings")) {
    const opened = await page.waitForSelector("[data-testid='session-settings-sheet']", { timeout: 5000 }).catch(() => null);
    check("⋯ → Session settings opens the session settings sheet", opened !== null);
    await scanForLeaks("session settings sheet");
  } else {
    check("⋯ → Session settings opens the session settings sheet", false, "session-settings row not found or disabled");
  }
  await closeSheets();

  // /usage must produce numbers even though its RPC can never succeed.
  const ta = await page.$("textarea");
  if (ta) {
    await ta.click();
    await page.evaluate(() => {
      const el = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(el, "");
      el?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ta.click();
    await page.keyboard.type("/usage");
    await new Promise((r) => setTimeout(r, 900));
    const picked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[cmdk-item],[data-slot='command-item'],li,button,[role='option']"));
      const hit = rows.find((el) => (el.textContent || "").toLowerCase().includes("usage"));
      if (!hit) return false;
      hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    });
    await new Promise((r) => setTimeout(r, 1600));
    const usageText = await page.evaluate(() => document.body.innerText || "");
    check("/usage answers on a terminal-owned session", picked && /121|token/i.test(usageText), picked ? "rendered" : "palette row not found");
    await scanForLeaks("usage result");
  } else {
    check("/usage answers on a terminal-owned session", false, "composer not found");
  }
  await closeSheets();

  // The refusal is the message the owner reported as useless: "it just says
  // this conversation is held on my desktop" — while the laptop's collab box
  // was visibly open, i.e. the share looked like it had worked. The daemon
  // appends WHY automatic sharing failed after the guard's boilerplate, and the
  // phone used to render only the boilerplate. Nothing here asserts the guard's
  // own wording: it asserts the screen says sharing failed at all — and
  // `scanForLeaks` below is what asserts the boilerplate (pid, command line,
  // `/proc/`) never reaches it.
  const input = await page.$("[data-testid='composer-input']");
  if (input) {
    // Clear any refusal already on screen from an earlier step, so the
    // assertion below is about THIS send and not a stale banner.
    const REFUSAL = /(auto|automatic)[- ]?sharing failed/i;
    for (let i = 0; i < 20; i++) {
      const dismissed = await page.evaluate(() => {
        const b = document.querySelector("[data-testid='chat-error'] button[aria-label='Dismiss']");
        if (b instanceof HTMLElement) b.click();
        return Boolean(b);
      });
      const still = await page.evaluate(() => document.body.innerText || "");
      if (!REFUSAL.test(still)) break;
      await new Promise((r) => setTimeout(r, 200));
      if (!dismissed) break;
    }
    const box = await input.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await new Promise((r) => setTimeout(r, 400));
    }
    await page.evaluate(() => {
      const el = document.querySelector("[data-testid='composer-input']");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(el, "");
      el?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.keyboard.type("can you continue this?");
    await new Promise((r) => setTimeout(r, 500));
    const tapped = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) =>
        /^send$/i.test(x.getAttribute("aria-label") || ""),
      );
      if (!(b instanceof HTMLElement) || b.disabled) return false;
      b.click();
      return true;
    });
    let refusal = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      refusal = await page.evaluate(() => document.body.innerText || "");
      if (REFUSAL.test(refusal)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
        check(
      "send to a desktop-owned session is refused with the reason",
      tapped && REFUSAL.test(refusal),
      tapped
        ? refusal.replace(/\s+/g, " ").slice(0, 240)
        : "no enabled Send button — the composer never became sendable",
    );
    await scanForLeaks("send refusal");
  } else {
    check("send to a desktop-owned session is refused with the reason", false, "composer not found");
  }

  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  await browser.close();
} finally {
  webApp.stop();
  try {
    holder.kill("SIGKILL");
  } catch {}
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures);
