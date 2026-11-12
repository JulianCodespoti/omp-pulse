// The helpers a recipe drives the app with. Every one of them waits on a
// condition (selector, text, in-flight fetch count, scroll quiet) and rethrows
// Puppeteer's anonymous timeouts with what it was waiting for.

import { scrollQuiet } from "./stabilize.mjs";
import { CLOCK } from "./fixtures.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param page  the recipe's page
 * @param env   the corpus (env.mjs makeEnv)
 * @param net   `{ inflight: Map<request, url> }`, maintained by the engine
 *              from the page's request events
 */
export function recipeApi(page, env, net) {
  const TIMEOUT = 10_000;
  // Puppeteer's own timeout messages name neither the selector nor the text,
  // so every helper rethrows with what it was waiting for.
  const step = async (label, run) => {
    try { return await run(); } catch (e) { throw new Error(`${label}: ${String(e?.message ?? e).split("\n")[0]}`); }
  };
  // Wait until the target has not moved for two frames, then click. The chat
  // re-anchors its scroll as parts expand and history lands; a click aimed
  // mid-shift hits whatever slid under the pointer instead.
  const press = async (handle) => {
    await handle.scrollIntoView();
    await handle.evaluate((el) => new Promise((resolve) => {
      let last = "";
      let same = 0;
      const t0 = performance.now();
      const tick = () => {
        const r = el.getBoundingClientRect();
        const key = `${r.x},${r.y},${r.width},${r.height}`;
        same = key === last ? same + 1 : 0;
        last = key;
        if (same >= 2 || performance.now() - t0 > 1500) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    await handle.click();
  };
  const api = {
    page,
    env,
    sleep,
    /** App behaviour worth reporting that did not stop the state being captured. */
    warnings: [],
    el: (selector, { timeout = TIMEOUT } = {}) =>
      step(`waiting for ${selector}`, async () => (await page.waitForSelector(selector, { visible: true, timeout })) ?? Promise.reject(new Error("gone"))),
    // Re-queried on each attempt: a list that re-renders under the pointer
    // detaches the handle between the wait and the click. (Puppeteer Locators
    // would do this, but their stability check never resolves in this setup.)
    click: (selector) =>
      step(`clicking ${selector}`, async () => {
        for (let attempt = 0; ; attempt++) {
          const handle = await page.waitForSelector(selector, { visible: true, timeout: TIMEOUT });
          try { await press(handle); return; } catch (e) { if (attempt >= 3) throw e; await sleep(100); }
        }
      }),
    /** Click the last element matching `selector` whose text contains `text`. */
    clickMatching: (selector, text) =>
      step(`clicking ${selector} containing "${text}"`, async () => {
        const handle = await page.waitForFunction(
          (selector, text) => [...document.querySelectorAll(selector)].filter((el) => el.textContent.includes(text)).at(-1) ?? null,
          { timeout: TIMEOUT },
          selector,
          text,
        );
        await press(handle.asElement());
      }),
    /**
     * Click by visible text under the last `within` match. Exact matches win
     * over prefix matches (a "Pair this device" button must beat the paragraph
     * "Pair this device to follow…"), then the innermost candidate, mapped up
     * to its nearest clickable ancestor.
     */
    clickText: (text, { within = "body", exact = false } = {}) =>
      step(`clicking text "${text}"`, async () => {
        for (let attempt = 0; ; attempt++) {
          const handle = await page.waitForFunction(
            (text, within, exact) => {
              const scope = [...document.querySelectorAll(within)].at(-1);
              if (!scope) return null;
              const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
              const shown = [...scope.querySelectorAll("button,a,[role=menuitem],[role=button],[role=option],[role=tab],label,li,span,div,p,h2,h3")].filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              const same = shown.filter((el) => norm(el.textContent) === text);
              const pool = same.length || exact ? same : shown.filter((el) => norm(el.textContent).startsWith(text));
              const inner = pool.find((el) => !pool.some((o) => o !== el && el.contains(o)));
              return inner?.closest("button,a,[role=menuitem],[role=button],[role=option],[role=tab]") ?? inner ?? null;
            },
            { timeout: TIMEOUT },
            text,
            within,
            exact,
          );
          try { await press(handle.asElement()); return; } catch (e) { if (attempt >= 2) throw e; }
        }
      }),
    async type(selector, text) {
      await api.click(selector);
      await page.keyboard.type(text);
    },
    /**
     * A held touch past the long-press threshold (rows 500ms, message text
     * 700ms), ended with touchcancel rather than touchend. A touchend
     * synthesises a click, and once the sheet is up that click lands on its
     * backdrop and dismisses it: whether the sheet survived depended on
     * releasing before its outside-press handler attached, i.e. on load.
     */
    longPress: (selector, { holdMs = 1000, at = "start" } = {}) =>
      step(`long-pressing ${selector}`, async () => {
        await api.quiet();
        let el = await page.waitForSelector(selector, { visible: true, timeout: TIMEOUT });
        if (at === "blank") {
          // Message rows ignore presses on text (native selection owns those)
          // and on controls. Pick the first match that has a point which is
          // neither, by the same caretRangeFromPoint test that
          // MessageActions.pressIsOnText applies.
          // On-screen matches first: scrolling to one fights the transcript's
          // own scroll anchoring, and a held touch on a moving target cancels.
          const found = await page.evaluateHandle((selector) => {
            const blankPoint = (node) => {
              const r = node.getBoundingClientRect();
              for (let py = Math.min(r.bottom, innerHeight) - 2; py > Math.max(r.top, 0); py -= 4) {
                // Left to right: the floating jump pill appears on the right
                // edge on touchstart and would sit over a right-edge point.
                for (let px = r.left + 2; px < r.right; px += 6) {
                  const hit = document.elementFromPoint(px, py);
                  if (!hit || !node.contains(hit) || hit.closest("button,a,[role=button],input,textarea,select")) continue;
                  const caret = document.caretRangeFromPoint(px, py)?.startContainer;
                  if (caret && caret.nodeType === Node.TEXT_NODE && caret.textContent.trim()) continue;
                  return `${px},${py}`;
                }
              }
              return null;
            };
            const nodes = [...document.querySelectorAll(selector)];
            for (const scroll of [false, true]) {
              for (const node of nodes) {
                if (scroll) node.scrollIntoView({ block: "center" });
                const point = blankPoint(node);
                if (point) { node.dataset.captureBlank = point; return node; }
              }
            }
            return null;
          }, selector);
          el = found.asElement();
          if (!el) throw new Error("no match has a text-free point to press");
        } else {
          await el.scrollIntoView();
        }
        const box = await el.boundingBox();
        let x = box.x + Math.min(box.width - 8, 16);
        let y = box.y + box.height / 2;
        if (at === "blank") [x, y] = (await el.evaluate((n) => n.dataset.captureBlank)).split(",").map(Number);
        const cdp = await page.createCDPSession();
        try {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await sleep(holdMs);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        } finally {
          await cdp.detach();
        }
      }),
    text: (needle, timeout = TIMEOUT) =>
      step(`waiting for text "${needle}"`, () => page.waitForFunction((n) => document.body.textContent.includes(n), { timeout }, needle)),
    async frames(kind, frames) {
      const path = await page.evaluate(() => decodeURIComponent(location.hash.slice(3)));
      const row = env.listing.find((row) => row.path === path);
      const prepared = frames.map((frame) => {
        if (frame.type === "event" && frame.event.type === "collab_ui_request") {
          return { type: "event", event: {
            type: "collab_ui_snapshot", complete: true,
            lifecycle: { sessionPath: path, generation: "capture", revision: 100 },
            requests: [{ ...frame.event.request, pulseQuestionToken: "capture:question-7" }],
          } };
        }
        if (frame.type === "event" && frame.event.type === "agent_start") {
          return { ...frame, sessionState: env.runningState(row, CLOCK, {}) };
        }
        return frame;
      });
      await page.evaluate((detail) => window.dispatchEvent(new CustomEvent("capture:frames", { detail })), JSON.stringify({ kind, frames: prepared }));
    },
    /** Call the real notice module in either Vite or the embedded build; never pin a generated export alias. */
    async toast({ message, tone = "info", title, open }) {
      await page.evaluate(async ({ message, tone, title, open }) => {
        const embedded = performance.getEntriesByType("resource").find((r) => /\/Notices-[^/]+\.js$/.test(r.name))?.name;
        const module = await import(embedded ?? "/src/app/Notices.tsx");
        const showToast = module.showToast ?? Object.values(module).find((value) =>
          typeof value === "function" && /performance\.now\(\)/.test(String(value)) && /durationMs/.test(String(value)));
        if (!showToast) throw new Error("notice module does not export showToast");
        showToast(message, tone, open ? { label: "Open", onClick: () => { location.hash = open; } } : undefined, { title, durationMs: 60_000 });
      }, { message, tone, title, open });
      await api.el("[data-slot='toast'] [data-slot='notice-pill']");
    },
    /** Ask the real shared link probe after the recipe's held traffic has settled. */
    async probeLink() {
      return page.evaluate(async () => {
        const embedded = performance.getEntriesByType("resource").find((r) => /\/request-[^/]+\.js$/.test(r.name))?.name;
        const module = await import(embedded ?? "/src/runtime/link-state.ts");
        const probeLink = module.probeLink ?? Object.values(module).find((value) =>
          typeof value === "function" && /\/api\/version/.test(String(value)) && /no-store/.test(String(value)));
        if (!probeLink) throw new Error("request module does not export the shared link probe");
        return probeLink(true);
      });
    },
    /** Wait until the socket of `kind` is open, so injected frames land. */
    socket: (kind) =>
      step(`waiting for the ${kind} socket`, () => page.waitForFunction((k) => document.documentElement.getAttribute(`data-capture-ws-${k}`) === "open", { timeout: TIMEOUT }, kind)),
    /**
     * Scroll a container once the page has stopped moving on its own: set
     * while the transcript is still smooth-scrolling to its live edge, the
     * value is overwritten and the shot lands at the bottom anyway.
     */
    scroll: (selector, to) =>
      step(`scrolling ${selector}`, async () => {
        await page.waitForSelector(selector, { timeout: TIMEOUT });
        await api.quiet();
        await page.$eval(selector, (el, to) => {
          el.scrollTop = to === "bottom" ? el.scrollHeight : to === "middle" ? (el.scrollHeight - el.clientHeight) / 2 : to;
          el.dispatchEvent(new Event("scroll"));
        }, to);
        await api.quiet();
      }),
    /**
     * Bring the innermost element containing `text` to the middle of its
     * scroller, once the network is quiet: content that lands above it after
     * the scroll (a device list, a version row) would shift it by a few
     * pixels, differently on every run.
     */
    revealText: (text) =>
      step(`revealing text "${text}"`, async () => {
        await api.quiet();
        const handle = await page.waitForFunction(
          (text) => {
            const hits = [...document.querySelectorAll("body *")].filter((el) => el.textContent.includes(text));
            return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) ?? null;
          },
          { timeout: TIMEOUT },
          text,
        );
        await handle.asElement().evaluate((el) => el.scrollIntoView({ block: "center" }));
        await api.quiet();
      }),
    /** Network idle, then no scrolling for 200ms (see stabilize.mjs scrollQuiet). */
    quiet: async () => {
      await api.settle();
      await scrollQuiet(page);
    },
    /**
     * Open chat, loaded AND settled at its live edge. Waiting for scrolling to
     * stop was not enough: content that grows after the stick-to-bottom
     * animation ends left the transcript 37px short on some runs (measured),
     * and a sheet opened then locked it there, so the same recipe shot a
     * different background each time. A conversation opens at its newest
     * message; one that never gets there is a finding, not a shot.
     */
    async chat() {
      await api.el("[data-testid='chat-message']", { timeout: 15_000 });
      await api.quiet();
      const atEdge = await page
        .waitForFunction(() => {
          const el = document.querySelector(".chat-scroll");
          return el && el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
        }, { timeout: 3_000, polling: 50 })
        .then(() => true, () => false);
      if (!atEdge) {
        // A real, intermittent app behaviour, not harness noise: the long
        // fixture conversation sometimes opens a couple of turns above its
        // newest message and stick-to-bottom never recovers. Reported on the
        // state, then corrected the way the owner would (jump to latest), so
        // the state being photographed is still the intended one.
        const gap = await page.$eval(".chat-scroll", (el) => {
          const gap = Math.round(el.scrollHeight - el.clientHeight - el.scrollTop);
          el.scrollTop = el.scrollHeight;
          return gap;
        });
        api.warnings.push(`transcript opened ${gap}px short of its newest message and stayed there; scrolled to it`);
        await api.quiet();
      }
    },
    /**
     * The session switcher drawer (`data-testid='session-switcher'`). The app
     * opens on a recent chat or the new-chat home, so reach the drawer via the
     * leading header button (`session-back` or `new-session-menu`).
     */
    async allChats() {
      const openDrawerSel = "[data-testid='session-switcher'][data-open]";
      await api.el(`${openDrawerSel}, [data-testid='session-back'], [data-testid='new-session-menu']`, { timeout: 15_000 });
      if (await page.$(openDrawerSel)) return;
      await api.click("[data-testid='session-back'], [data-testid='new-session-menu']");
      await api.el(openDrawerSel, { timeout: 15_000 });
    },
    /** The new-chat screen: already there when the app lands on it, else ☰ then "New chat" from the drawer. */
    async newSession() {
      await api.el("[data-testid='new-session-screen'], [data-testid='session-back'], [data-testid='session-switcher'][data-open]", { timeout: 15_000 });
      if (await page.$("[data-testid='new-session-screen']")) return;
      if (!(await page.$("[data-testid='session-switcher'][data-open]"))) {
        await api.click("[data-testid='session-back']");
      }
      await api.click("[data-testid='switcher-new-chat']");
      await api.el("[data-testid='new-session-screen']");
    },
    async sessions() {
      await api.allChats();
      await api.el("[data-testid='session-switcher'][data-open] [data-testid='session-row']", { timeout: 15_000 });
    },
    /**
     * Wait until nothing is loading for 120ms (max 3s), then for fonts,
     * images and two frames. "Loading" is the page's own fetches (tracked by
     * the shim) AND the browser's requests (`net`): lazy chunks and syntax
     * grammars arrive as module loads, not fetches, and a code block shot
     * before its grammar landed was plain on one run and highlighted on the
     * next. Resolves to null when quiet, else what was still in flight.
     */
    async settle() {
      const deadline = Date.now() + 3_000;
      let quietSince = null;
      let quiet = false;
      while (Date.now() < deadline) {
        const pageBusy = (await page.evaluate(() => document.documentElement.dataset.captureInflight)) !== "0";
        if (pageBusy || net.inflight.size > 0) quietSince = null;
        else if (quietSince === null) quietSince = Date.now();
        else if (Date.now() - quietSince > 120) { quiet = true; break; }
        await sleep(40);
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      if (quiet) return null;
      const inPage = await page.evaluate(() => document.documentElement.dataset.capturePending || "");
      return [inPage, ...net.inflight.values()].filter(Boolean).join(" ") || "unknown";
    },
  };
  return api;
}
