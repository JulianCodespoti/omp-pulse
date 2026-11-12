#!/usr/bin/env node
// The primary journey, end to end: create a session from the phone, type a
// message, send it, get a reply.
//
// Everything else in this suite directory tests a feature around the edges of
// that loop — paging, markdown, commands, notifications. None of them actually
// drive the composer and wait for the agent to answer, which is the one thing
// the app exists to do. A regression here would be invisible to every other
// suite and instantly obvious to the owner.
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

  // 1. Create a session the way the owner would. The app opens on the new-chat
  // home when idle, else on the latest chat, whose header has a New chat button.
  await page.waitForSelector("[data-testid='new-session-screen'], [data-testid='session-new-chat']", { timeout: 30000 });
  check("new-session control is reachable", (await page.$("[data-testid='new-session-screen']")) !== null || (await clickLabel("new chat")));
  await wait(1800);
  const sheetOpen = await page.evaluate(() => document.querySelector("[data-testid='new-session-screen']") !== null);
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
  const PROMPT = "Reply with exactly the word: pineapple";
  await page.keyboard.type(PROMPT);
  await wait(600);

  const sendable = await page.evaluate(() => {
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
  await wait(1500);

  // 3. The user's own turn must appear immediately — an optimistic echo is what
  //    makes the app feel responsive instead of laggy.
  const echoed = await page.evaluate(
    (p) => (document.body.textContent || "").includes(p),
    PROMPT,
  );
  check("the sent message appears in the transcript straight away", echoed);

  // ChatGPT's send: the message you sent rests at the top of the view (under the
  // header pills), where the reply will stream beneath it.
  const sentTop = await page.evaluate(() => {
    const sc = document.querySelector(".chat-scroll");
    const turns = document.querySelectorAll("[data-user-turn]");
    const turn = turns[turns.length - 1];
    if (!(sc instanceof HTMLElement) || !turn) return null;
    return Math.round(turn.getBoundingClientRect().top - sc.getBoundingClientRect().top);
  });
  check("the sent message rests at the top of the view", sentTop !== null && sentTop >= 0 && sentTop <= 140, `offset from the scroller top = ${sentTop}px`);

  const cleared = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='composer-input']");
    return el instanceof HTMLTextAreaElement ? el.value.trim() === "" : false;
  });
  check("the composer clears after sending", cleared);

  // 4. The agent answers, and the answer renders.
  let replied = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    replied = await page.evaluate(() => {
      const txt = document.body.textContent || "";
      if (document.querySelector("[data-testid='turn-error']")) return "provider-error";
      return /pineapple/i.test(txt.replace(/Reply with exactly the word: pineapple/gi, "")) ? "found" : null;
    });
    if (replied) break;
    await wait(2000);
  }
  check("the agent's reply arrives and renders", replied === "found",
    replied === "provider-error" ? "provider rejected the turn; inspect the configured model/account" : "no reply within 180s");

  check("no page errors during the journey", pageErrors.length === 0, pageErrors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
