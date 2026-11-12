#!/usr/bin/env node
// Subagent transcripts must be readable from the phone: create a session the
// way the owner would, spawn one real subagent through a real model call,
// open the chat's Agents tab, open the subagent's row, and read its reply in
// the read-only conversation. Costs model calls by construction; run alone.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS || BASE.includes("7682")) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const webApp = await startWebApp({ base: BASE, port: 5356 });
try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-agent-transcript-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  let sessionPath = null;
  page.on("response", async (response) => {
    try {
      if (new URL(response.url()).pathname === "/api/new") {
        sessionPath = (await response.json()).sessionPath;
      }
    } catch {}
  });
  const clickLabel = (needle) =>
    page.evaluate((n) => {
      const hit = Array.from(document.querySelectorAll("button,[role='button']")).find((e) =>
        `${e.getAttribute("aria-label") || ""} ${e.title || ""} ${e.textContent || ""}`.toLowerCase().includes(n),
      );
      if (hit instanceof HTMLElement) {
        hit.click();
        return true;
      }
      return false;
    }, needle);

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await sleep(2500);
  check("new-session control is reachable", await clickLabel("new session"));
  await sleep(1800);
  check("a session can be started", await clickLabel("start without a message"));
  await sleep(9000);
  await page.waitForSelector("[data-testid='composer-input']", { timeout: 20000 });
  check("session created with a daemon path", typeof sessionPath === "string" && sessionPath.length > 0);

  const receipt = await fetch(`${BASE}/api/prompt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionPath,
      commandId: randomUUID(),
      text: "Use the task tool to spawn exactly one subagent. Tell it: reply with only the word MANGOSTEEN and nothing else. When it finishes, you reply with only the word DONE and nothing else.",
    }),
  }).then((r) => r.json());
  check("prompt accepted for dispatch", receipt?.ok === true && receipt?.receipt?.state !== "failed",
    JSON.stringify(receipt?.receipt ?? receipt).slice(0, 140));

  let done = false;
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const hist = await fetch(
      `${BASE}/api/history?session=${encodeURIComponent(sessionPath)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    ).then((r) => r.json()).catch(() => null);
    const texts = JSON.stringify(hist?.entries ?? hist ?? "");
    if (texts.includes("DONE") && texts.includes("MANGOSTEEN")) {
      done = true;
      break;
    }
  }
  check("subagent ran and reported (history has canary)", done);

  // Agents is a page of the chat's pinned tab row (SessionPager), in the chat
  // view we already hold.
  const agentsOpened = await page.evaluate(() => {
    const tab = document.querySelector("[data-testid='workspace-tabs'] [data-value='agents']");
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  });
  const agentsShown = agentsOpened && await page
    .waitForSelector("[data-testid='workspace-tabs'] [data-value='agents'][aria-selected='true']", { timeout: 8000 })
    .then(() => true, () => false);
  check("the Agents tab opens", agentsShown);
  await page.waitForSelector("[data-testid='workspace-tab-agents'] [data-testid='agents-tab']", { timeout: 20000 });

  // The phone's own child serves the live roster; each row opens that agent's
  // conversation. The roster read follows the tab opening, so wait for it.
  const row = await page
    .waitForSelector("[data-testid='workspace-tab-agents'] [data-rpc-agent]", { timeout: 20000 })
    .catch(() => null);
  const expanded = row
    ? await page.evaluate(() => {
        const r = document.querySelector("[data-testid='workspace-tab-agents'] [data-rpc-agent]");
        if (!(r instanceof HTMLElement)) return { found: false };
        r.click();
        return { found: true };
      })
    : {
        found: false,
        body: await page.evaluate(() => (document.querySelector("[data-testid='workspace-tab-agents'] [data-testid='agents-tab']")?.textContent || "").slice(0, 300)),
      };
  check("the subagent's row opens its conversation", expanded.found, expanded.found ? "" : (expanded.body ?? ""));
  // The task text names the canary too, so only the agent's own message
  // (not the "Task" one) proves the reply is readable. A subagent answers
  // through its `yield` tool, which the conversation draws as a quiet tool
  // row: a tap opens the call in a sheet, and so do its Details.
  const AGENT = "[data-testid='agent-transcript'] [data-agent-message]:not([data-agent-role='user'])";
  const replies = () =>
    page.evaluate((sel) => {
      const sheet = document.querySelector("[data-testid='tool-sheet']")?.textContent || "";
      return [...Array.from(document.querySelectorAll(sel)).map((el) => el.textContent || ""), sheet].join(" | ");
    }, AGENT);
  let seen = "";
  for (let i = 0; expanded.found && i < 40 && !seen.includes("MANGOSTEEN"); i++) {
    await page.evaluate((sel) => {
      const open = (el) => {
        if (!(el instanceof HTMLElement) || el.dataset.e2eOpened) return;
        el.dataset.e2eOpened = "1";
        el.click();
      };
      for (const message of document.querySelectorAll(sel)) {
        for (const row of message.querySelectorAll("[data-testid='tool-row']")) open(row);
      }
      for (const details of document.querySelectorAll("[data-testid='tool-sheet'] [data-testid='tool-args'] button")) open(details);
    }, AGENT);
    await sleep(500);
    seen = await replies();
  }
  check("subagent reply readable in transcript", seen.includes("MANGOSTEEN"), seen.slice(0, 160) || "no agent message");
  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await browser.close();
} finally {
  webApp.stop();
}
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
