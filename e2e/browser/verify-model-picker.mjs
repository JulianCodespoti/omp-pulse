#!/usr/bin/env node
// Proof that `/model` behaves the way it does in the terminal.
//
// On the laptop `/models` opens a dedicated page with a real picker — it does
// not dump text into the transcript and it does not make you type an id. The
// phone has to keep that shape: tap the command, get a searchable list, choose,
// and have the session actually change. A picker that opens but cannot change
// anything is the exact "looks like a novice whipped it up" failure.
//
// verify-commands.mjs proves `/model` CLASSIFIES as a picker. This proves the
// picker WORKS.
//
// Needs a live omp child to enumerate models, so it runs under
// e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
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
  console.error("refusing to run against the live daemon on 7682 — it would change a real session's model");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The session's cwd must exist or omp cannot switch into it: the RPC fails with
// "switch_session was cancelled" while the HTTP call still answers 200.
const CWD = "/tmp/omp-model-picker-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-model-picker`;
mkdirSync(dir, { recursive: true });
const sessionPath = `${dir}/2026-08-20T15-00-00-000Z_019ff400-0000-7000-0000-00000000aa02.jsonl`;
writeFileSync(
  sessionPath,
  [
    { type: "session", id: "019ff400-0000-7000-0000-00000000aa02", cwd: CWD, title: "Model picker fixture" },
    // A real session records the model it runs on. Without this entry nothing
    // is "the model in use" for an idle session (its state is read from the
    // file), so the sheet correctly pins nothing.
    { type: "model_change", id: "fixmodel1", timestamp: new Date(Date.now() - 90_000).toISOString(), model: "anthropic/claude-3-5-sonnet-20241022", role: "default" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);
const when = new Date(Date.now() - 60_000);
utimesSync(sessionPath, when, when);

// Boot the omp child up front; the picker enumerates models over its RPC.
await fetch(`${BASE}/api/open`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ sessionPath }),
});
await new Promise((r) => setTimeout(r, 12_000));

const webApp = await startWebApp({ base: BASE, port: 5226 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-mp-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Model picker")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await wait(3500);

  // The model chip sits in the composer toolbar, always visible, and names the
  // model in use; it opens a lightweight popover with "All models…" for the full
  // picker. The header sheet's Model row is another way in.
  const chipEntry = await page.evaluate(() => document.querySelector("[data-testid='composer-model']")?.textContent ?? null);
  check("the model is always visible on the composer chip", !!chipEntry?.trim(), JSON.stringify(chipEntry));
  await page.click("[data-testid='composer-model']");
  await page.waitForSelector("[data-testid='composer-model-menu'] [data-testid='composer-model-all']", { timeout: 5000 });
  check("the chip opens a popover offering All models…", true);
  await page.keyboard.press("Escape"); await wait(900);
  await page.click("[data-testid='session-actions']");
  await page.waitForSelector("[data-testid='session-actions-sheet'] [data-testid='session-model']", { timeout: 5000 });
  // The sheet slides up as it opens: tap once the row has stopped moving.
  let entryTop = null;
  for (let i = 0; i < 40; i++) {
    const top = await page.evaluate(() => document.querySelector("[data-testid='session-model']")?.getBoundingClientRect().top ?? null);
    if (top !== null && top === entryTop) break;
    entryTop = top;
    await wait(100);
  }
  await page.click("[data-testid='session-model']");
  await wait(3000);
  const openedFromChip = await page.evaluate(() => document.querySelector("[data-testid='model-picker']") !== null);
  check("the header sheet's Model row opens the picker", openedFromChip);
  // The list must OPEN on the model in use. 164 entries arrive oldest-first, so
  // without pinning it opened on a 2024 Sonnet with the live model below the
  // fold and nothing marked at all.
  const pinned = await page.evaluate(() => {
    const first = document.querySelector("[data-testid='model-item']");
    if (!first) return null;
    return { text: (first.textContent || "").trim().slice(0, 40), current: first.getAttribute("data-current") === "true" };
  });
  check(
    "it opens on the model in use, pinned first and marked",
    pinned !== null && pinned.current === true,
    JSON.stringify(pinned),
  );

  // Below Current and Recent, each provider group is NEWEST RELEASE FIRST.
  // The catalogue itself is oldest-first, so an unsorted sheet opens on 2024
  // models. Compare each group's rows with identity.revision from the real
  // catalogue: no row may have an older revision than a row below it.
  const groupIds = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid^='model-group-provider:']"), (group) => Array.from(group.querySelectorAll("[data-testid='model-item']"), (row) => row.getAttribute("data-model"))));
  const catalogue = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionPath, command: "get_available_models", params: {} }),
  }).then((r) => r.json());
  const listed = Array.isArray(catalogue.data) ? catalogue.data : catalogue.data?.models ?? [];
  const revisionOf = new Map(listed.map((m) => [`${m.provider}/${m.id}`, m.identity?.revision]));
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] ?? 0) - (a[i] ?? 0); if (d) return d; } return 0; };
  let compared = 0, descending = true;
  for (const ids of groupIds) {
    const revisions = ids.map((id) => revisionOf.get(id)).filter((rev) => typeof rev === "string").map((rev) => rev.split(".").map(Number));
    compared += Math.max(0, revisions.length - 1);
    for (let i = 1; i < revisions.length; i++) if (cmp(revisions[i - 1], revisions[i]) > 0) descending = false;
  }
  check("each provider group is newest release first", compared > 0 && descending, `${groupIds.length} groups, ${compared} ordered pairs`);
  await page.keyboard.press("Escape");
  await wait(1200);

  // Reach it the way the owner would: type the command, tap the row.
  const box = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='composer-input']");
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (box) await page.mouse.click(box.x, box.y);
  await wait(600);
  await page.keyboard.type("/model");
  await wait(1500);

  const tapped = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll("[data-testid='slash-palette'] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row']), [data-sheet-panel] :is([data-slot='item'], [data-slot='sheet-row'], [data-slot='row'])")).find(
      (el) => (el.textContent || "").trim().startsWith("/model"),
    );
    if (hit instanceof HTMLElement) {
      hit.click();
      return true;
    }
    return false;
  });
  check("/model is reachable from the composer", tapped);
  await wait(2500);

  const opened = await page.evaluate(
    () => document.querySelector("[data-testid='model-picker']") !== null,
  );
  check("tapping /model opens a picker, not transcript text", opened);

  // The list is populated over the child's RPC, so give it room.
  let items = [];
  for (let i = 0; i < 20 && items.length === 0; i++) {
    items = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-testid='model-item']")).map((el) =>
        (el.textContent || "").trim().slice(0, 40),
      ),
    );
    if (items.length === 0) await wait(1000);
  }
  check("the picker lists models", items.length > 0, `${items.length} items`);

  // A picker you cannot search is a wall of text on a 390px screen.
  const searchable = await page.evaluate(
    () => document.querySelector("[data-testid='model-search']") !== null,
  );
  check("the list is searchable", searchable);
  if (searchable && items.length > 1) {
    const term = (items[0].match(/[a-z]{4,}/i) || ["a"])[0].slice(0, 4);
    await page.evaluate((t) => {
      const el = document.querySelector("[data-testid='model-search']");
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.value = "";
      }
      void t;
    }, term);
    await page.keyboard.type(term);
    await wait(1200);
    const filtered = await page.evaluate(
      () => document.querySelectorAll("[data-testid='model-item']").length,
    );
    check(
      "search narrows the list",
      filtered > 0 && filtered <= items.length,
      `${items.length} -> ${filtered} for "${term}"`,
    );
    // Clear so the selection below is not made from a filtered subset.
    for (let i = 0; i < term.length; i++) await page.keyboard.press("Backspace");
    await wait(900);
  }

  // One-tap model selection updates the always-visible model chip without a poll.
  const chosen = await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll("[data-testid='model-item']")).find((row) => row.getAttribute("data-current") !== "true");
    if (!(target instanceof HTMLElement)) return null;
    const result = { id: target.getAttribute("data-model"), label: target.querySelector("[data-testid='model-name']")?.textContent || "" };
    target.click();
    return result;
  });
  check("a different model can be selected", chosen !== null, JSON.stringify(chosen));
  await wait(3000);
  const afterSelection = await page.evaluate(() => {
    const selected = document.querySelector("[data-testid='model-current-check']")?.closest("[data-testid='model-item']");
    // The composer chip is always on screen under the sheet and names the
    // model, from the same label source as the header's menu row.
    const chip = document.querySelector("[data-testid='composer-model']");
    return { selectedId: selected?.getAttribute("data-model"), chip: chip?.textContent };
  });
  if (chosen) {
    const detail = JSON.stringify({ chosen, ...afterSelection });
    check("the check moves to the selected model", afterSelection.selectedId === chosen.id, detail);
    check("the composer model chip immediately names the chosen model", afterSelection.chip?.includes(chosen.label), detail);
  }
  // Reasoning controls are per model: the segments must be EXACTLY the chosen
  // model's catalogue ladder (Off, Auto when reasoning is verified, then
  // thinking.efforts), and a model without a ladder must show no segments at
  // all - never a fixed Off/Low/Medium/High.
  if (chosen) {
    const catalogue = await fetch(`${BASE}/api/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath, command: "get_available_models", params: {} }),
    }).then((r) => r.json());
    const list = Array.isArray(catalogue.data) ? catalogue.data : catalogue.data?.models ?? [];
    const entry = list.find((m) => `${m.provider}/${m.id}` === chosen.id);
    const auto = entry?.reasoning === true && entry?.thinking?.unverified !== true;
    const efforts = entry?.thinking?.efforts ?? [];
    const expected = entry && entry.reasoning !== false && (efforts.length || auto) ? ["off", ...(auto ? ["auto"] : []), ...efforts] : [];
    const shown = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid='model-thinking'] button")).map((b) => b.getAttribute("data-value")));
    check("the thinking segments are exactly the chosen model's own ladder", !!entry && JSON.stringify(shown) === JSON.stringify(expected), JSON.stringify({ model: chosen.id, expected, shown }));
    // Six segments share one phone-width row; a label that does not fit is cut off.
    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid='model-thinking'] button")).filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent));
    check("no thinking segment clips its label", clipped.length === 0, JSON.stringify({ model: chosen.id, clipped }));
  }
  const high = await page.evaluate(() => {
    const button = document.querySelector("[data-testid='model-thinking'] button[data-value='high']");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  if (high) {
    await wait(1500);
    const thinking = await page.evaluate(() => ({
      high: document.querySelector("[data-testid='model-thinking'] button[data-value='high']")?.getAttribute("aria-checked"),
      chip: document.querySelector("[data-testid='composer-model']")?.getAttribute("data-level"),
    }));
    check("thinking updates the segment and the composer model chip", thinking.high === "true" && thinking.chip === "high", JSON.stringify(thinking));
    // The thinking row lives in the chip's popover (once the model's catalogue entry has loaded).
    await page.keyboard.press("Escape");
    await wait(900);
    await page.click("[data-testid='composer-model']");
    const popoverThinking = await page.waitForSelector("[data-testid='composer-model-menu'] [data-testid='composer-thinking']", { timeout: 8000 }).then(() => page.evaluate(() => document.querySelector("[data-testid='composer-thinking']")?.getAttribute("data-level")), () => null);
    check("the chip popover's thinking row shows the chosen level", popoverThinking === "high", JSON.stringify(popoverThinking));
  }
  await page.keyboard.press("Escape");
  await wait(600);
  // The second entry: ⋯ → "Model" in the session actions sheet.
  await page.click("[data-testid='session-actions']");
  await page.waitForSelector("[data-testid='session-actions-sheet'] [data-testid='session-model']", { timeout: 5000 });
  const modelRow = await page.evaluate(() => (document.querySelector("[data-testid='session-model']")?.textContent || "").trim());
  check("the session actions sheet offers Model", modelRow.startsWith("Model"), modelRow);
  // The sheet slides up as it opens: a pointer tap aimed at the row mid-slide
  // lands on the backdrop (closing the sheet) or finds no clickable point.
  // Tap once the row has stopped moving, as a finger would.
  let lastTop = null;
  for (let i = 0; i < 40; i++) {
    const top = await page.evaluate(() => document.querySelector("[data-testid='session-model']")?.getBoundingClientRect().top ?? null);
    if (top !== null && top === lastTop) break;
    lastTop = top;
    await wait(100);
  }
  await page.click("[data-testid='session-model']");
  await wait(3000);
  const reopened = await page.evaluate(() => ({
    picker: document.querySelector("[data-testid='model-picker']") !== null,
    // The row closes the actions sheet before the picker opens: one sheet up.
    actions: document.querySelector("[data-testid='session-actions-sheet']") !== null,
    selected: document.querySelector("[data-testid='model-current-check']")?.closest("[data-testid='model-item']")?.getAttribute("data-model"),
  }));
  check("⋯ → Model opens the picker in place of the actions sheet", reopened.picker && !reopened.actions, JSON.stringify(reopened));
  if (chosen) check("reopening preserves the selected model", reopened.selected === chosen.id, JSON.stringify(reopened));

  check("no page errors", errors.length === 0, errors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
