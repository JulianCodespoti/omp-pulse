#!/usr/bin/env node
// Queued messages: while the agent is busy a second message waits in omp's
// follow-up queue. The phone must show it as a removable chip (omp's own
// queue_update, not a guess), and Remove must take it out again.
//
// Runs under e2e/with-test-daemon.sh. Spawns a real omp child and makes a real
// model call, so run it alone. Exit code = number of failures.

import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { loadPuppeteer, chromium, startWebApp, testModel } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
if (!BASE || !TOKEN) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682 — it would send a prompt into a real conversation");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A real directory for the new session to live in.
const CWD = "/tmp/omp-send-cwd";
mkdirSync(CWD, { recursive: true });

const webApp = await startWebApp({ base: BASE, port: 5246 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-send-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  let sessionPath = null;
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/new") {
      sessionPath = (await response.json()).sessionPath;
    }
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));
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
  await wait(2500);

  // 1. Create a session the way the owner would.
  check("new-session control is reachable", await clickLabel("new session"));
  await wait(1800);
  const sheetOpen = await page.evaluate(() =>
    (document.body.textContent || "").includes("New session"),
  );
  check("the new-session screen opens", sheetOpen);

  const started = await clickLabel("start without a message");
  check("a session can be started", started);
  await wait(9000);

  const inChat = await page.evaluate(
    () => document.querySelector("[data-testid='composer-input']") !== null,
  );
  check("starting a session lands in the chat view", inChat);
  if (sessionPath) {
    const want = await testModel({ base: BASE, token: TOKEN, sessionPath });
    const selected = await fetch(`${BASE}/api/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath, command: "set_model", params: { provider: want.provider, modelId: want.id } }),
    }).then((r) => r.json());
    if (!selected.ok) throw new Error(`Cannot select ${want.provider}/${want.id} for isolated test`);
    const response = await fetch(`${BASE}/api/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath, command: "get_state" }),
    }).then((r) => r.json());
    const model = response.data?.model;
    if (model?.provider !== want.provider || model?.id !== want.id)
      throw new Error(`Refusing a model-backed test without ${want.provider}/${want.id}`);
    console.log("      selected model:", JSON.stringify(model && {
      provider: model.provider, id: model.id, name: model.name, api: model.api,
    }));
  }

  // 2. Start a long turn so the agent stays busy.
  const box = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='composer-input']");
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (box) await page.mouse.click(box.x, box.y);
  await wait(500);
  await page.keyboard.type("Write the numbers from 1 to 400, one per line, with no other text.");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-testid='composer-stop-btn']", { timeout: 30_000 });
  check("the agent is busy (Stop is showing)", true);

  // 3. A second message while busy is held by omp and appears as a chip.
  // Mid-turn sends steer by default (TUI parity);
  // a steered message can be consumed at the next step before Remove lands,
  // so this journey picks Queue to keep proving the held follow-up.
  await page.click("[data-testid='composer-input']");
  await page.keyboard.type("second message held in the queue");
  const queueMode = await page
    .waitForSelector("[data-testid='send-mode'] [data-value='queue']", { timeout: 10_000 })
    .then(() => page.click("[data-testid='send-mode'] [data-value='queue']"))
    .then(() => true, () => false);
  check("Queue is offered while the agent works", queueMode);
  await page.click("[data-testid='composer-input']");
  await page.keyboard.press("Enter");
  const chip = await page
    .waitForFunction(
      () => Array.from(document.querySelectorAll("[data-testid='queued-message']")).some((el) => (el.textContent || "").includes("second message held in the queue")),
      { timeout: 20_000 },
    )
    .then(() => true, () => false);
  check("the held message shows as a queued chip", chip);

  // 4. Remove takes it out; the chip leaves because omp reports the new queue.
  if (chip) {
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("[data-testid='queued-message']")).find((el) => (el.textContent || "").includes("second message held in the queue"));
      row?.querySelector("button[aria-label='Remove queued message']")?.click();
    });
    const gone = await page
      .waitForFunction(() => document.querySelectorAll("[data-testid='queued-message']").length === 0, { timeout: 15_000 })
      .then(() => true, () => false);
    check("Remove drops the chip", gone);
  }
  await page.click("[data-testid='composer-stop-btn']").catch(() => {});

  check("no page errors during the journey", pageErrors.length === 0, pageErrors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
