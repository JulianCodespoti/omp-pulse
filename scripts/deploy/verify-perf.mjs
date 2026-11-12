#!/usr/bin/env node
// Load-performance budget for the deployed app.
//
// This repo has already been bitten once by a single eager import costing
// 540 KB, which is why markdown.tsx carries a standing warning against
// importing streamdown/motion at the top level. A budget catches that class of
// regression the moment it ships, instead of on a phone on mobile data.
//
// Measured on a mid-range-phone profile: 4x CPU throttle, ~4 Mbps, 150ms RTT,
// 390x844. Reported as the MEDIAN of several runs — a single run on a shared
// machine is noise, and a flaky budget gets ignored.
//
// Runs against the DEPLOYED app, because that is what the phone loads:
//   OMP_PULSE_BASE=https://host OMP_PULSE_TOKEN=... node scripts/deploy/verify-perf.mjs
//
// Budgets are deliberately loose enough to absorb machine variance and tight
// enough that a heavy import cannot slip through. Exit code = number of
// failures.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { loadPuppeteer, chromium } from "../../e2e/lib/env.mjs";

const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_BASE;
const TOKEN = process.env.OMP_PULSE_TOKEN;
if (!BASE || !TOKEN) {
  console.error("set OMP_PULSE_BASE and OMP_PULSE_TOKEN");
  process.exit(2);
}

const BUDGET = {
  usableMs: 6000, // session list on screen and interactive
  transferKb: 400, // everything the first load pulls down
  requests: 40,
};
const RUNS = 3;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const results = [];
for (let run = 0; run < RUNS; run++) {
  const b = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-perf-`)}`],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const cdp = await p.createCDPSession();
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (4 * 1024 * 1024) / 8,
    uploadThroughput: (1 * 1024 * 1024) / 8,
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(()=>{try{localStorage.setItem("omp-remote-token",${JSON.stringify(TOKEN)});}catch(e){}})();`,
  });

  // Transfer accounting MUST be CDP-side, not performance-resource-side:
  // resource timing is per-Document, and the service worker reloads the page
  // on first boot — so a getEntriesByType snapshot after session-row sees
  // only the second load, with the hashed critical-path assets at
  // transferSize 0 from the HTTP cache. CDP Network events are per-target
  // and span both loads, and they also catch the idle chat-chunk preload
  // that fires after the snapshot point. Fresh profiles mean a cold disk
  // cache, so this is the true first-load number.
  const seen = new Map();
  cdp.on("Network.responseReceived", (e) => {
    seen.set(e.requestId, e.response.url);
  });
  cdp.on("Network.loadingFinished", (e) => {
    if (seen.has(e.requestId)) {
      netBytes += e.encodedDataLength || 0;
      netReqs += 1;
      lastNetAt = Date.now();
      seen.delete(e.requestId);
    }
  });
  cdp.on("Network.loadingFailed", (e) => {
    seen.delete(e.requestId);
    netFailed += 1;
  });
  let netBytes = 0;
  let netReqs = 0;
  let netFailed = 0;
  let lastNetAt = Date.now();
  const t0 = Date.now();
  await p.goto(`${BASE}/app/`, { waitUntil: "domcontentloaded", timeout: 120000 });
  let usableAt = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    // The service worker reloads once on first boot and destroys the execution
    // context mid-poll. Normal, not a failure.
    let ready = false;
    try {
      ready = await p.evaluate(() => document.querySelector("[data-testid='session-row']") !== null);
    } catch {
      ready = false;
    }
    if (ready) {
      usableAt = Date.now() - t0;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Keep collecting past usable until the network has been quiet for 1 s
  // (catches the idle chat-chunk preload) or 15 s, whichever comes first.
  const quietDeadline = Date.now() + 15000;
  while (Date.now() < quietDeadline && Date.now() - lastNetAt < 1000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  let fcp = null;
  try {
    fcp = await p.evaluate(() => {
      const e = performance.getEntriesByName("first-contentful-paint")[0];
      return e ? Math.round(e.startTime) : null;
    });
  } catch {}
  // FCP belongs to the post-reload document; usableMs spans both loads and
  // stays the honest interactivity number.
  results.push({ usableMs: usableAt, fcp, resources: netReqs, transferBytes: netBytes });
  if (run === 0) {
    // The app is deployed under /app/. A root-only /assets/ SW route left
    // every bundle uncached; the normal HTTP cache hid it until offline.
    // Reload online once under SW control, then remove the HTTP-cache and
    // network safety nets. The actual styled app shell must still mount.
    try {
      await p.setCacheEnabled(false);
      await p.reload({ waitUntil: "networkidle0", timeout: 30000 });
      await cdp.send("Network.emulateNetworkConditions", {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      });
      await p.reload({ waitUntil: "networkidle0", timeout: 30000 });
      await p.waitForSelector("[data-testid='new-session-btn']", { timeout: 15000 });
      const usableOffline = await p.evaluate(async () => {
        const button = document.querySelector("[data-testid='new-session-btn']");
        if (!button || button.getBoundingClientRect().width < 40) return false;
        try { await fetch("/api/status"); return false; } catch { return true; }
      });
      check("app shell remains usable offline with HTTP cache disabled", usableOffline);
    } catch (error) {
      check("app shell remains usable offline with HTTP cache disabled", false, String(error));
    } finally {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 150,
        downloadThroughput: (4 * 1024 * 1024) / 8,
        uploadThroughput: (1 * 1024 * 1024) / 8,
      });
    }
  }
  await b.close();
}

const median = (key) => {
  const v = results.map((r) => r[key]).filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

console.log("profile: 4x CPU, 4 Mbps, 150ms RTT, 390x844\n");
for (const [i, r] of results.entries()) {
  console.log(
    `      run ${i + 1}: usable ${r.usableMs}ms | FCP ${r.fcp}ms | ${r.resources} reqs | ${(r.transferBytes / 1024).toFixed(0)} KB`,
  );
}
const usable = median("usableMs");
const kb = median("transferBytes") / 1024;
const reqs = median("resources");
console.log("");

check(
  `app is usable within ${BUDGET.usableMs}ms`,
  usable !== null && usable < BUDGET.usableMs,
  `median ${usable}ms`,
);
check(
  `first load transfers under ${BUDGET.transferKb} KB`,
  kb < BUDGET.transferKb,
  `median ${kb.toFixed(0)} KB — check for a newly eager import (streamdown, motion, shiki)`,
);
check(`first load makes under ${BUDGET.requests} requests`, reqs < BUDGET.requests, `median ${reqs}`);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
