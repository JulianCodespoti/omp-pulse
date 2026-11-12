#!/usr/bin/env node
// Regression proof for the ways app CHROME can bury or crowd the content.
//
// 1. Markers announce a transition worth reading in the transcript. omp writes
//    a `mode_change` entry on every turn while a mode is active, so a real
//    session once showed twelve identical "Mode → goal" dividers on one
//    screen. Mode (like the thinking level) is state the composer chip shows:
//    the transcript draws no marker for it at all.
//
// 2. The floating navigation is pinned inside the scroll area. The old
//    expanded nav was 171px tall and sat on top of the newest content — a
//    measured 53x171px overlap that covered a running tool card's Cancel
//    control. Its successor, the "Jump to latest" button, must at the live
//    edge be faded out, hidden from assistive tech and transparent to taps, so
//    it can never swallow a press meant for the content under it; scrolled
//    away from the edge it must come back as a real, tappable control.
//
// Both were found by using the app, not by a failing test, which is why they
// get one. Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync, utimesSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium, startWebApp } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { backToSessions, showSessionsList } from "../lib/chat-nav.mjs";
import { JUMP_TO_LATEST } from "../lib/jump-latest.mjs";


const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS) {
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

// Fixture: enough turns to scroll, each preceded by an identical mode_change,
// plus one genuine change to a different mode that MUST still be shown.
const entries = [
  { type: "session", id: "019ff400-0000-7000-0000-0000000000d1", cwd: "/tmp/verify-chrome", title: "Transcript chrome fixture" },
];
for (let i = 0; i < 12; i++) {
  entries.push({ type: "mode_change", mode: "goal" });
  entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: `Turn ${i} question` }] } });
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Answer ${i}.\n\n${"Filler line that wraps at 390px to build height. ".repeat(8)}` }],
    },
  });
}
// A real transition, after a run of identical ones: must NOT be collapsed away.
entries.push({ type: "mode_change", mode: "plan" });
entries.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "Final question" }] } });
entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Final answer." }] } });

const dir = `${SESSIONS}/-tmp-verify-chrome`;
mkdirSync(dir, { recursive: true });
const file = `${dir}/2026-08-20T12-40-00-000Z_019ff400-0000-7000-0000-0000000000d1.jsonl`;
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(file, when, when);

const webApp = await startWebApp({ base: BASE, port: 5206 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-chrome-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 140)));

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Transcript chrome")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  // Opening a session scrolls to the live edge; pin to the bottom and let the
  // fade settle, or the assertion races the state it is measuring.
  await page.evaluate(() => {
    const sc = document.querySelector(".chat-scroll");
    if (sc instanceof HTMLElement) sc.scrollTop = sc.scrollHeight;
  });
  await new Promise((r) => setTimeout(r, 3200));

  const markers = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-testid='transcript-marker']"))
      .map((el) => (el.textContent || "").trim())
      .filter((t) => /\b(?:mode|goal|plan)\b/i.test(t) || t.includes("→")),
  );
  check(
    "mode changes draw no transcript marker",
    markers.length === 0,
    `rendered ${markers.length}: ${markers.slice(0, 3).join(", ")}`,
  );

  // At the live edge the jump button stays mounted (so it can fade) but must be
  // inert: hidden from assistive tech, out of the tab order, transparent to
  // pointer events, and not the hit-test target at its own centre.
  const latestState = () =>
    page.evaluate(() => {
      const btn = document.querySelector("[data-testid='jump-next']");
      if (!(btn instanceof HTMLElement)) return { missing: true };
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // The fade is on the whole control (prev/next pill and count), not the button's own parent.
      const wrap = btn.closest("[data-testid='jump-nav']");
      return {
        ariaHidden: btn.getAttribute("aria-hidden"),
        tabIndex: btn.tabIndex,
        pointerEvents: getComputedStyle(btn).pointerEvents,
        opacity: wrap ? Number(getComputedStyle(wrap).opacity) : -1,
        hitsButton: hit instanceof Element && btn.contains(hit),
        label: btn.getAttribute("aria-label"),
      };
    });
  const atRest = await latestState();
  check(
    "at the live edge the jump-to-latest button is mounted but hidden",
    atRest.missing !== true && atRest.ariaHidden === "true" && atRest.tabIndex === -1 && atRest.opacity < 0.05,
    JSON.stringify(atRest),
  );
  check(
    "at rest the jump-to-latest button does not intercept taps on the transcript",
    atRest.missing !== true && atRest.pointerEvents === "none" && atRest.hitsButton === false,
    `pointer-events=${atRest.pointerEvents} hit=${atRest.hitsButton}`,
  );

  // Away from the live edge it must come back as a real control.
  await page.evaluate(() => {
    const sc = document.querySelector(".chat-scroll");
    if (sc instanceof HTMLElement) {
      sc.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
      sc.scrollTop = 0;
    }
  });
  await new Promise((r) => setTimeout(r, 1200));
  const away = await latestState();
  check(
    "scrolled away from the live edge the jump-to-latest button is shown and tappable",
    away.missing !== true && away.ariaHidden === "false" && away.tabIndex === 0 && away.pointerEvents !== "none"
      && away.opacity > 0.95 && away.hitsButton === true && /^Jump to latest/.test(away.label || ""),
    JSON.stringify(away),
  );
  await page.evaluate(JUMP_TO_LATEST);
  await new Promise((r) => setTimeout(r, 2500));
  const back = await page.evaluate(() => {
    const sc = document.querySelector(".chat-scroll");
    const btn = document.querySelector("[data-testid='jump-next']");
    return {
      gap: sc instanceof HTMLElement ? Math.round(sc.scrollHeight - sc.clientHeight - sc.scrollTop) : -1,
      ariaHidden: btn ? btn.getAttribute("aria-hidden") : null,
    };
  });
  check(
    "tapping jump-to-latest returns to the live edge and hides the button again",
    back.gap >= 0 && back.gap <= 70 && back.ariaHidden === "true",
    JSON.stringify(back),
  );

  // A short sheet must hug its content. Every BottomSheet was pinned to a
  // fixed h-[68dvh] regardless of what was in it, which left ~160px of empty
  // panel under the six-row session-actions sheet — and contradicted the
  // component's own documented shape ("max-h-[85dvh]").
  await backToSessions(page);
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(() => {
    const row = document.querySelector("[data-testid='session-row']");
    if (!(row instanceof HTMLElement)) return;
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: box.x + 40,
        clientY: box.y + 20,
        pointerType: "touch",
      }),
    );
  });
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => {
    const row = document.querySelector("[data-testid='session-row']");
    if (row instanceof HTMLElement) {
      row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 1500));

  const sheet = await page.evaluate(() => {
    // The drawers stay mounted (hidden) while closed: only a shown dialog is the sheet.
    const panel = [...document.querySelectorAll("[role='dialog']")].find((d) => !d.closest("[hidden]") && d.getClientRects().length > 0);
    if (!panel) return { noSheet: true };
    const pr = panel.getBoundingClientRect();
    let lowest = pr.top;
    for (const el of Array.from(panel.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      // Leaves only. A stretched flex container still reports a bottom at the
      // panel edge, so counting containers measures 0 dead space even with the
      // bug present — calibrated: leaf-only reads 23px fixed vs 183px broken,
      // container-inclusive reads 0px for both and proves nothing.
      if (el.children.length === 0 && r.height > 0 && r.width > 0 && (el.textContent || "").trim()) {
        lowest = Math.max(lowest, r.bottom);
      }
    }
    return { deadSpace: Math.round(pr.bottom - lowest), panelH: Math.round(pr.height) };
  });
  check(
    "a short sheet hugs its content instead of reserving a fixed height",
    sheet.noSheet === true || sheet.deadSpace < 80,
    `${sheet.deadSpace}px of empty panel below the last row (panel ${sheet.panelH}px)`,
  );

  // Reported from the phone: "I can't copy text in the output because it
  // prompts me to copy the whole thing." Long-press is BOTH the platform's
  // text-selection gesture and this app's message-actions trigger, and the
  // sheet was winning — so selecting a path or a command out of a reply was
  // impossible. Actions must still be reachable, so both directions are
  // asserted: plain press opens the sheet, press-with-selection does not.
  //
  // Driven with synthetic PointerEvents rather than CDP touch: headless touch
  // never reaches these React handlers, which is exactly why the original bug
  // could not be reproduced from the desktop.
  await backToSessions(page);
  await new Promise((r) => setTimeout(r, 1800));
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Transcript chrome")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await new Promise((r) => setTimeout(r, 3000));

  const press = await page.evaluate(async () => {
    const el = Array.from(document.querySelectorAll(".chat-scroll p")).find(
      (x) =>
        (x.textContent || "").trim().length > 30 &&
        !x.closest("button, a, [role='button']") &&
        x.closest("[class*='is-assistant'], [class*='is-user']") !== null,
    );
    if (!el) return { missing: true };
    // The chat lands at its newest message, so the first long paragraph can be a screen or more above the
    // viewport; a press measured there (y=-1490) hit nothing and could never count as a press on text.
    el.scrollIntoView({ block: "center" });
    await new Promise((x) => setTimeout(x, 400));
    // Aim at an actual glyph, measured from a Range over the first word — not
    // at the element box. `top + 8` lands in the line box ABOVE the text, so a
    // press there misses the caret hit-test entirely and the assertion passes
    // without ever exercising the case it claims to.
    // The first text node that actually draws glyphs: the paragraph's own first child can be a bare
    // whitespace node beside Streamdown's word spans, whose box is not where any text is.
    // Looked up afresh at every press: opening and closing the actions menu re-renders the paragraph, so a
    // node found once goes stale (detached, zero-size) and a press measured from it lands at 0,0.
    const findNode = () => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const rg = document.createRange();
        rg.selectNodeContents(t);
        if (t.textContent.trim() && rg.getClientRects().length) return t;
      }
      return null;
    };
    if (!findNode()) return { missing: true };
    // Measured at each press, not once: the chat can still move after the scroll (it re-pins to the
    // bottom), and a stale point sat 29px off the text it was meant to hit.
    const onText = () => {
      const node = findNode();
      const first = Math.max(0, node.textContent.search(/\S/));
      const wordRange = document.createRange();
      wordRange.setStart(node, first);
      wordRange.setEnd(node, Math.min(first + 1, node.textContent.length));
      const wr = wordRange.getClientRects()[0] ?? wordRange.getBoundingClientRect();
      return { x: Math.round(wr.left + wr.width / 2), y: Math.round(wr.top + wr.height / 2) };
    };
    const mk = (pt) => ({
      bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y,
      button: 0, pointerType: "touch", isPrimary: true,
    });
    const sleep = (m) => new Promise((x) => setTimeout(x, m));
    // The message menu closes on an Escape that reaches it (it takes focus when a real press opens it), so
    // aim the key at the open menu; a sheet still hears it on the document.
    const esc = () => (document.querySelector("[data-testid='message-menu']") ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // What a press can open: a shown dialog (the drawers stay mounted, hidden, while closed) or the message
    // actions, which are a floating menu now, not a dialog. Counting every [role=dialog] let the hidden
    // drawers stand in for a menu that never opened.
    const dialogs = () => [...document.querySelectorAll("[role='dialog']")].filter((d) => !d.closest("[hidden]") && d.getClientRects().length > 0).length
      + (document.querySelector("[data-testid='message-menu']") ? 1 : 0);
    // The short-sheet check above leaves its sheet open; start clean.
    esc();
    await sleep(700);

    // 1. Press directly on a glyph: the platform owns this gesture, so the
    //    app's sheet must stay shut and let selection happen.
    window.getSelection()?.removeAllRanges();
    let opts = mk(onText());
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    await sleep(1200);
    const onGlyph = dialogs();
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    await sleep(300);
    esc();
    await sleep(700);

    // 2. Press on the row's own padding, clear of any glyph: the sheet is the
    //    only sensible interpretation there, so it must still open.
    const r = el.getBoundingClientRect();
    const padOpts = mk({ x: Math.round(r.right - 4), y: Math.round(r.bottom - 2) });
    window.getSelection()?.removeAllRanges();
    el.dispatchEvent(new PointerEvent("pointerdown", padOpts));
    await sleep(1200);
    const plain = dialogs();
    el.dispatchEvent(new PointerEvent("pointerup", padOpts));
    await sleep(300);
    esc();
    await sleep(700);

    window.getSelection()?.removeAllRanges();
    opts = mk(onText());
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    await sleep(300);
    const selNode = findNode();
    if (selNode && selNode.nodeType === 3) {
      const rg = document.createRange();
      rg.setStart(selNode, 0);
      rg.setEnd(selNode, Math.min(10, selNode.textContent.length));
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(rg);
    }
    await sleep(1200);
    const selecting = dialogs();
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    return { plain, selecting, onGlyph };
  });
  check(
    "pressing directly on text never opens the sheet",
    press.missing === true || press.onGlyph === 0,
    `dialogs=${press.onGlyph} while pressing a glyph`,
  );
  check(
    "long-press on non-text still reaches the message actions",
    press.missing === true || press.plain >= 1,
    `dialogs=${press.plain}`,
  );
  check(
    "selecting text does not trigger the copy-whole-message sheet",
    press.missing === true || press.selecting === 0,
    `dialogs=${press.selecting} while text was selected`,
  );

  check("no page errors", pageErrors.length === 0, pageErrors[0] || "");

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
  await browser.close();
} finally {
  webApp.stop();
}

process.exit(failures === 0 ? 0 : 1);
