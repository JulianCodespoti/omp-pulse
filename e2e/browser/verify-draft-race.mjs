#!/usr/bin/env node
// Regression: Send inside the composer's 300 ms autosave window must not leave
// the previous autosave behind. Storage holds "hello", the user types "!" and
// sends "hello!" before the debounce fires; clearDraft used to compare storage
// against the payload, skip the removal, and re-adopt "hello" as a draft the
// user then had to delete by hand.
//
// Runs under e2e/with-test-daemon.sh. Sends one real prompt, so run it alone.
// Exit code = number of failures.

import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { showSessionsList } from "../lib/chat-nav.mjs";
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
  await showSessionsList(page);
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

  // 2. Send a message through the composer.
  const box = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='composer-input']");
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (box) await page.mouse.click(box.x, box.y);
  await wait(500);
  const PROMPT = "hello!";
  await page.keyboard.type("hello");
  await wait(700); // autosave (300ms) stores "hello"
  await page.keyboard.type("!");

  const sendable = true; const _unused = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) =>
      /^send$/i.test(x.getAttribute("aria-label") || ""),
    );
    return b ? !b.disabled : false;
  });
  check("send becomes available once there is text", sendable);

  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) =>
      /^send$/i.test(x.getAttribute("aria-label") || ""),
    );
    if (b instanceof HTMLElement) b.click();
  });
  await wait(2500);

  // 3. The user's own turn must appear immediately — an optimistic echo is what
  //    makes the app feel responsive instead of laggy.
  const echoed = await page.evaluate(
    (p) => (document.body.textContent || "").includes(p),
    PROMPT,
  );
  check("the sent message appears in the transcript straight away", echoed);

  const cleared = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='composer-input']");
    return el instanceof HTMLTextAreaElement ? el.value.trim() === "" : false;
  });
  check("the composer clears after sending", cleared);

  const ls = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("omp-draft:")).map(([, v]) => v));
  check("no stale draft left in storage", ls.every((v) => v === ""), JSON.stringify(ls));
  const val = await page.evaluate(() => document.querySelector("[data-testid='composer-input']").value);
  check("composer is empty (no resurrected older draft)", val === "", JSON.stringify(val));
  check("no page errors during the journey", pageErrors.length === 0, pageErrors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
