#!/usr/bin/env node
// Photograph every UI state of the web client, compare it with the saved
// baseline, audit it, and write one self-contained HTML gallery plus a JSON
// report. `captureAllStates()` is the single call.
//
//   node scripts/ui/states/capture.mjs                  # whole catalogue
//   node scripts/ui/states/capture.mjs --only chat-     # ids containing "chat-"
//   node scripts/ui/states/capture.mjs --save-baseline  # this run becomes the reference
//   node scripts/ui/states/capture.mjs --vite           # live web/src, not the embedded build
//   node scripts/ui/states/capture.mjs --serve --vite   # stay up; one run per stdin line
//   node scripts/ui/states/capture.mjs --review audit/ui-review.json
//                                    # annotated review of the states it names (review.mjs)
//
// Outputs: audit/ui-states.html (look at it) and audit/ui-states.json (read
// it: per state, the pixel diff against the baseline and the audit findings
// it introduced or resolved, so a change can be judged without opening 125
// screenshots). The baseline lives in audit/ui-states-baseline/.
//
// Run bare, it re-executes itself under e2e/with-test-daemon.sh, so the ONLY
// daemon it can reach is a throwaway one that run started (live-session-safety:
// a suite once delivered test prompts into a real conversation on 7682).
//
// Why it is fast:
//   * every state is an independent recipe in its own incognito context, run
//     `concurrency` at a time in ONE browser, so nothing serialises on shared
//     page state and one broken recipe cannot poison the next;
//   * the pairing token, localStorage, native bridge, network stubs, clock and
//     WebSocket frame tap are installed by a document-start script, so a
//     recipe boots straight into the state it needs: no pairing flow, no
//     reload, and chats open by deep link (`#s=`) rather than by clicking rows;
//   * animations and transitions are clamped to 1ms and waits are condition
//     based (selector, text, in-flight fetch count, scroll quiet) rather than
//     fixed delays; the only timed waits are held touches and a recording's length;
//   * screenshots stay in memory; each worker diffs and encodes its own shot
//     on a canvas in the page it just photographed;
//   * `--serve` keeps the daemon, corpus, vite and browser up between runs, so
//     re-shooting one state after an edit costs about a second.
//
// Why it is comparable run to run: the page clock is pinned to a fixed date
// (page-shim.mjs, fixtures.mjs CLOCK), the timezone is UTC, motion is frozen,
// every write path is stubbed, and stabilize.mjs removes the last run-to-run
// variance (sub-pixel scroll, elapsed seconds) before each shot.
//
// Why write paths are stubbed IN THE PAGE: every non-GET /api call answers
// from the recipe's stub table (default `{ok:true}`) instead of reaching the
// daemon. That keeps the daemon read-only, which is what makes the recipes
// parallel-safe, and it means no recipe can spawn a ~270 MB omp child or cost
// a model call. States that need a live agent (streaming, running tools,
// collab questions) are produced by injecting protocol frames into the real
// conversation socket instead.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { UI_PROBE } from "../../../e2e/lib/ui-probe.mjs";
import { chromium, loadPuppeteer, startWebApp } from "../../../e2e/lib/env.mjs";
import { recipeApi } from "./api.mjs";
import { Baseline, findingKeys, processShot } from "./compare.mjs";
import { makeEnv } from "./env.mjs";
import { CLOCK, seedFixtures } from "./fixtures.mjs";
import { renderHtml } from "./gallery.mjs";
import { loadReview, renderReview, resolveMarks } from "./review.mjs";
import { FREEZE_CSS, pageShim } from "./page-shim.mjs";
import { RECIPES } from "./recipes.mjs";
import { stabilize } from "./stabilize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

const RECIPE_TIMEOUT_MS = 25_000;
const WEBP_QUALITY = 0.82;

/**
 * One recipe in a fresh page of the worker's context. The context is reused
 * across that worker's recipes so its HTTP cache stays warm (a cold context
 * re-fetched every module, ~1.3 s of boot under vite); every origin store is
 * wiped before each recipe instead, which is what isolation actually needs.
 */
async function runRecipe(context, recipe, env, opts, baseline, marks = null) {
  const started = performance.now();
  const page = await context.newPage();
  const pageErrors = [];
  let error = null;
  const warnings = [];
  /** Where a recipe's time went (ms): page boot, driving + settle, stabilise + shot + diff. */
  const phases = {};
  try {
    const setup = typeof recipe.setup === "function" ? recipe.setup(env) : (recipe.setup ?? {});
    if (!setup.enforceCsp) await page.setBypassCSP(true);
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: opts.scale, isMobile: true, hasTouch: true });
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: "dark" },
    ]);
    // Absolute times ("Last used 11:37 AM") must not depend on the machine.
    await page.emulateTimezone("UTC");
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 240)));
    // Browser-level requests in flight, for settle(): module loads (lazy
    // chunks, syntax grammars) never pass through the page's fetch. Not
    // tracked for recipes that hold a chunk open: that page is deliberately
    // incomplete, and whatever it would load next (a font, measured) never
    // finishes either.
    const net = { inflight: new Map() };
    if (!setup.hold?.length) {
      page.on("request", (req) => net.inflight.set(req, req.url().replace(/^https?:\/\/[^/]+/, "")));
      page.on("requestfinished", (req) => net.inflight.delete(req));
      page.on("requestfailed", (req) => net.inflight.delete(req));
    }
    const cfg = {
      token: setup.unpaired ? null : env.token,
      storage: setup.storage ?? {},
      css: FREEZE_CSS,
      clock: CLOCK,
      notificationPermission: setup.notificationPermission ?? null,
      native: setup.native ?? null,
      ompLocal: setup.ompLocal ?? null,
      stubs: [...(setup.stubs ?? []), ...env.defaultStubs],
      ws: setup.ws ?? {},
    };
    const cdp = await page.createCDPSession();
    // localStorage, IndexedDB (the outbox), service workers and their caches:
    // everything a previous recipe on this context could have left behind.
    await cdp.send("Storage.clearDataForOrigin", { origin: new URL(env.appUrl).origin, storageTypes: "all" });
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${pageShim})(${JSON.stringify(cfg)});` });
    if (setup.hold?.length) {
      // Only for states that exist while a lazy chunk is in flight: request
      // interception turns off the HTTP cache, so it is opt-in per recipe.
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        if (setup.hold.some((re) => re.test(req.url()))) return; // never answered
        void req.continue();
      });
    }
    await page.goto(env.appUrl + (setup.hash ?? ""), { waitUntil: "domcontentloaded" });
    const installed = await page.evaluate(() => document.documentElement.getAttribute("data-capture-shim"));
    if (installed !== "ok") throw new Error("page shim did not install; refusing to drive an unstubbed app");
    phases.boot = Math.round(performance.now() - started);
    const api = recipeApi(page, env, net);
    api.warnings = warnings;
    let timer;
    await Promise.race([
      recipe.run(api),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${RECIPE_TIMEOUT_MS}ms`)), RECIPE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const pending = await api.settle();
    if (pending) warnings.push(`network not quiet at capture: ${pending}`);
    phases.run = Math.round(performance.now() - started) - phases.boot;
  } catch (e) {
    error = String(e?.message ?? e).split("\n")[0].slice(0, 300);
  }

  const result = {
    id: recipe.id, group: recipe.group, title: recipe.title, note: recipe.note ?? "",
    error, warning: warnings.join("; ") || null, pageErrors, ms: 0, phases,
    png: null, webp: null, baseWebp: null, diffWebp: null,
    diff: { status: baseline.exists ? "new" : "none" },
    findings: [], findingsDelta: null, marks: null,
  };
  try {
    await stabilize(page, recipe.mask);
    // PNG, not WebP: the baseline comparison needs lossless pixels.
    result.png = await page.screenshot({ type: "png", encoding: "base64" });
    // Review marks resolve against the exact frame just photographed.
    if (marks?.length) result.marks = await page.evaluate(resolveMarks, marks);
    result.findings = findingKeys(await page.evaluate(UI_PROBE));
    result.findingsDelta = baseline.delta(recipe.id, result.findings);
    const basePng = baseline.png(recipe.id);
    const shot = await processShot(page, result.png, basePng, WEBP_QUALITY);
    phases.capture = Math.round(performance.now() - started) - (phases.boot ?? 0) - (phases.run ?? 0);
    result.webp = shot.webp;
    if (basePng) {
      result.baseWebp = shot.baseWebp ?? null;
      result.diffWebp = shot.diffWebp ?? null;
      result.diff = shot.changed
        ? { status: "changed", changed: shot.changed, total: shot.total, bbox: shot.bbox ?? null, sizeChanged: !!shot.sizeChanged }
        : { status: "same", ...(shot.noise ? { noise: shot.noise } : {}) };
    }
  } catch (e) {
    result.error ??= `capture failed: ${String(e?.message ?? e).split("\n")[0]}`;
  }
  await page.close().catch(() => {});
  result.ms = Math.round(performance.now() - started);
  return result;
}

function assertIsolated(base) {
  const url = new URL(base);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`refusing non-loopback base ${base}: run through e2e/with-test-daemon.sh`);
  }
  if (url.port === "7682") throw new Error("7682 is the live daemon serving real conversations; refusing");
}

/**
 * Start everything a run needs once: seeded corpus, optional vite, browser.
 * `run()` may then be called any number of times; `close()` tears it down.
 *
 * @param {object} options
 * @param {string} options.base          isolated daemon origin (loopback, never 7682)
 * @param {string} options.token         that daemon's token
 * @param {string} options.sessionsRoot  that daemon's sessions root (fixtures are seeded here)
 * @param {boolean} [options.vite]       serve web/src through vite instead of the embedded /app/
 * @param {string} [options.baselineDir] default audit/ui-states-baseline
 * @param {number} [options.concurrency]
 * @param {{width:number,height:number,scale:number}} [options.viewport]
 */
export async function openCaptureSession(options) {
  const { base, token, sessionsRoot } = options;
  if (!base || !token || !sessionsRoot) throw new Error("base, token and sessionsRoot are required");
  assertIsolated(base);
  const view = { width: 390, height: 844, scale: 2, ...options.viewport };
  const concurrency = options.concurrency ?? Math.min(10, Math.max(2, Math.floor(cpus().length / 2)));
  const baselineDir = options.baselineDir ?? resolve(ROOT, "audit/ui-states-baseline");
  const app = options.vite ? "vite (web/src)" : "embedded /app/";
  const viewport = `${view.width}×${view.height}@${view.scale}x`;

  const listing = await seedFixtures({ base, token, sessionsRoot });
  const vite = options.vite ? await startWebApp({ base, port: 5290, vite: true }) : null;
  const env = makeEnv({ base, token, appUrl: vite ? vite.url : `${base}/app/`, listing });
  const puppeteer = await loadPuppeteer();
  const profile = mkdtempSync(`${tmpdir()}/omp-ui-states-`);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profile}`,
      // Dictation states: a fake microphone that is granted without a prompt.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      // Pages run side by side, so all but one are "background" tabs. Left
      // throttled, their requestAnimationFrame stalls: stability checks and
      // the settle step then wait out their full timeouts.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });

  return {
    /**
     * @param {object} [runOptions]
     * @param {string[]} [runOptions.only]      substrings; keep recipes whose id contains any
     * @param {boolean} [runOptions.saveBaseline] record this run as the reference
     * @param {string} [runOptions.out]         HTML path (default audit/ui-states.html; JSON beside it)
     * @param {string} [runOptions.review]      review file: capture only the states it names and
     *                                          write the annotated review instead of the gallery
     * @param {(r: object) => void} [runOptions.onResult]
     */
    async run(runOptions = {}) {
      const t0 = performance.now();
      // Re-read per run, so in --serve an edited review file re-renders in seconds.
      const review = runOptions.review ? loadReview(resolve(runOptions.review)) : null;
      if (review) {
        const unknown = review.states.filter((s) => !RECIPES.some((r) => r.id === s));
        if (unknown.length) throw new Error(`review names states that are not recipes: ${unknown.join(", ")}`);
      }
      const only = review ? review.states : (runOptions.only?.filter(Boolean) ?? []);
      // An exact id selects just that state ("settings" is one state, not all
      // eleven settings-*); anything else is a substring of ids.
      const matches = (r, o) => (RECIPES.some((x) => x.id === o) ? r.id === o : r.id.includes(o));
      const selected = only.length ? RECIPES.filter((r) => only.some((o) => matches(r, o))) : RECIPES;
      // A dev build is never "stale" (SettingsSheet treats releaseId "dev" as
      // current), so a state that needs a real release id cannot exist under
      // vite. Skipped and named, not reported as a failure.
      const skipped = options.vite ? selected.filter((r) => r.embeddedOnly).map((r) => r.id) : [];
      const recipes = selected.filter((r) => !skipped.includes(r.id));
      if (recipes.length === 0) throw new Error(`no runnable recipe id contains any of: ${only.join(", ")}`);
      // Re-read per run: in --serve, a --save-baseline must be visible to the next run.
      const baseline = new Baseline(baselineDir);
      const results = new Array(recipes.length);
      let next = 0;
      const worker = async () => {
        const context = await browser.createBrowserContext();
        try {
          while (next < recipes.length) {
            const i = next++;
            results[i] = await runRecipe(context, recipes[i], env, view, baseline, review?.marks[recipes[i].id]);
            runOptions.onResult?.(results[i]);
          }
        } finally {
          await context.close().catch(() => {});
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, recipes.length) }, worker));

      // What this run was compared WITH, read before a --save-baseline replaces it.
      const comparedWith = baseline.exists ? baseline.meta : null;
      // A review run captures a subset for annotation; it never becomes the reference.
      const saved = runOptions.saveBaseline && !review ? baseline.save(results, { app, viewport }) : 0;
      const summary = {
        states: results.length,
        skipped: skipped.length,
        failed: results.filter((r) => r.error).length,
        changed: results.filter((r) => r.diff.status === "changed").length,
        new: results.filter((r) => r.diff.status === "new").length,
        introduced: results.reduce((n, r) => n + (r.findingsDelta?.introduced.length ?? 0), 0),
        resolved: results.reduce((n, r) => n + (r.findingsDelta?.resolved.length ?? 0), 0),
      };
      const ms = Math.round(performance.now() - t0);
      const mismatch = comparedWith && (comparedWith.app !== app || comparedWith.viewport !== viewport)
        ? `baseline was captured with ${comparedWith.app} at ${comparedWith.viewport}; this run is ${app} at ${viewport}, so pixel differences may be the build, not your change`
        : null;
      const meta = {
        viewport, app, ms, summary, mismatch, savedBaseline: saved,
        baseline: comparedWith?.savedAt ?? null,
        capturedAt: new Date().toISOString(),
      };
      const out = resolve(runOptions.out ?? resolve(ROOT, review ? "audit/ui-review.html" : "audit/ui-states.html"));
      const json = out.replace(/\.html?$/, "") + ".json";
      mkdirSync(dirname(out), { recursive: true });
      const lean = results.map(({ png, webp, baseWebp, diffWebp, ...r }) => r);
      if (review) {
        const { html, problems } = renderReview(review, results, meta);
        meta.review = { findings: review.findings.length, unresolved: problems };
        writeFileSync(out, html);
        writeFileSync(json, JSON.stringify({ ...meta, states: lean.map(({ id, error, marks }) => ({ id, error, marks })) }, null, 1));
      } else {
        writeFileSync(out, renderHtml(results, meta));
        writeFileSync(json, JSON.stringify({ ...meta, states: lean }, null, 1));
      }
      return { file: out, json, meta, results: lean };
    },
    async close() {
      await browser.close().catch(() => {});
      vite?.stop();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** One call: open a session, capture everything (or `only`), close. */
export async function captureAllStates(options) {
  const session = await openCaptureSession(options);
  try {
    return await session.run(options);
  } finally {
    await session.close();
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const [w, h, s] = (value("viewport") ?? "390x844x2").split("x").map(Number);
  return {
    out: value("out"),
    review: value("review"),
    vite: flag("vite"),
    serve: flag("serve"),
    saveBaseline: flag("save-baseline"),
    baselineDir: value("baseline"),
    only: value("only")?.split(",").filter(Boolean),
    concurrency: value("concurrency") ? Number(value("concurrency")) : undefined,
    viewport: { width: w, height: h, scale: s || 2 },
  };
}

/** One line per state that needs attention; silence means ok and unchanged. */
function report(r) {
  const bits = [];
  if (r.error) bits.push(`FAIL ${r.error}`);
  if (r.diff.status === "changed") bits.push(r.diff.sizeChanged ? "size changed" : `changed ${r.diff.changed}px${r.diff.bbox ? ` in ${r.diff.bbox.w}x${r.diff.bbox.h}@${r.diff.bbox.x},${r.diff.bbox.y}` : ""}`);
  if (r.diff.status === "new") bits.push("new (no baseline)");
  for (const f of r.findingsDelta?.introduced ?? []) bits.push(`+ ${f}`);
  for (const f of r.findingsDelta?.resolved ?? []) bits.push(`- ${f}`);
  if (r.warning) bits.push(`warn ${r.warning}`);
  if (bits.length) process.stdout.write(`${r.id} (${r.ms}ms): ${bits.join(" | ")}\n`);
}

function summarise({ file, json, meta }) {
  const s = meta.summary;
  console.log(
    `${s.states} states · ${s.failed} failed` + (s.skipped ? ` · ${s.skipped} skipped (embedded-only)` : "") +
      (meta.baseline ? ` · ${s.changed} changed · ${s.new} new · findings +${s.introduced} -${s.resolved}` : " · no baseline yet (--save-baseline)") +
      (meta.savedBaseline ? ` · baseline saved (${meta.savedBaseline})` : "") +
      ` · ${(meta.ms / 1000).toFixed(1)} s\n  ${file}\n  ${json}`,
  );
  if (meta.mismatch) console.log(`  note: ${meta.mismatch}`);
  if (meta.review) {
    console.log(`  review: ${meta.review.findings} findings, ${meta.review.unresolved.length} unresolved marks`);
    for (const p of meta.review.unresolved) console.log(`    ${p}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (!process.env.OMP_PULSE_TEST_BASE) {
    // Bare invocation: become the harness's child so the daemon is ours.
    try {
      execFileSync(resolve(ROOT, "e2e/with-test-daemon.sh"), [process.execPath, fileURLToPath(import.meta.url), ...argv], { stdio: "inherit" });
      process.exit(0);
    } catch (e) {
      process.exit(typeof e.status === "number" ? e.status : 1);
    }
  }
  const args = parseArgs(argv);
  const session = await openCaptureSession({
    ...args,
    base: process.env.OMP_PULSE_TEST_BASE,
    token: process.env.OMP_PULSE_TEST_TOKEN,
    sessionsRoot: process.env.OMP_PULSE_TEST_SESSIONS,
  });

  if (!args.serve) {
    let result;
    try {
      result = await session.run({ ...args, onResult: report });
    } finally {
      await session.close();
    }
    summarise(result);
    process.exit(result.meta.summary.failed === 0 ? 0 : 1);
  }

  // --serve: each stdin line is one run, taking the per-run flags
  // (`--only chat-,composer-`, `--save-baseline`, `--out`); a blank line runs
  // everything. With --vite every page loads the current web/src, so an edit
  // is on screen at the next run with nothing restarted.
  const prompt = () => console.log("READY (a line of --only/--save-baseline flags, blank = all, 'exit' to stop)");
  prompt();
  for await (const line of createInterface({ input: process.stdin })) {
    const text = line.trim();
    if (text === "exit" || text === "quit") break;
    try {
      const words = text.split(/\s+/).filter(Boolean);
      // Bare words are shorthand for --only: `chat-diff composer-` == `--only chat-diff,composer-`.
      const runArgs = parseArgs(words[0] && !words[0].startsWith("--") ? ["--only", words.join(",")] : words);
      summarise(await session.run({ ...runArgs, out: runArgs.out ?? args.out, onResult: report }));
    } catch (e) {
      console.log(`error: ${e?.message ?? e}`);
    }
    prompt();
  }
  await session.close();
  process.exit(0);
}
