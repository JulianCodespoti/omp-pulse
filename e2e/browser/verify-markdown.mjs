#!/usr/bin/env node
// Regression proof for the markdown gateway after it was split into a plain
// fallback plus a lazily-loaded heavy layer (streamdown + shiki), and after the
// shiki grammar set was restricted to the languages this workflow actually uses.
//
// Two ways that split can fail silently:
//   1. Suspense never resolves, so every assistant turn renders empty. A
//      transcript of blank rows is the worst possible failure and produces no
//      console error.
//   2. A restricted (stubbed) grammar throws instead of degrading, taking the
//      whole message down with it.
//
// Both are asserted here against a controlled fixture. Runs under
// e2e/with-test-daemon.sh against a throwaway vite dev server.

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
  console.error("  e2e/with-test-daemon.sh node e2e/browser/verify-markdown.mjs");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against live daemon on 7682 — use e2e/with-test-daemon.sh");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Fixture timestamps are shifted to be recent: the Sessions screen hides conversations whose
// newest message is older than 7 days (RECENT_WINDOW_MS), so fixed dates age out of the list.
// Offsets relative to 2026-08-20T12:10:03.000Z are preserved exactly.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const SHIFT_MS = BASE_MS - Date.parse("2026-08-20T12:10:03.000Z");
const ts = (iso) => new Date(Date.parse(iso) + SHIFT_MS).toISOString();

const DIR = "-tmp-verify-markdown";
const FILE = "2026-08-20T12-10-00-000Z_019ff400-0000-7000-0000-0000000000c1.jsonl";

const RUST = ["fn main() {", '    let total: u64 = (1..=10).map(|n| n * n).sum();', '    println!("{total}");', "}"].join("\n");
const COBOL = ["IDENTIFICATION DIVISION.", "PROGRAM-ID. LEGACY.", "PROCEDURE DIVISION.", "    STOP RUN."].join("\n");

const MARKDOWN = [
  "Here is **bold prose** with `inline code` and a [link](https://example.com).",
  "",
  "```rust",
  RUST,
  "```",
  "",
  "A restricted grammar must degrade to plain text, never throw:",
  "",
  "```cobol",
  COBOL,
  "```",
  "",
  "| column | value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "",
  "- first bullet",
  "- second bullet",
].join("\n");

const entries = [
  { type: "title", title: "Markdown regression fixture" },
  { type: "session", id: "019ff400-0000-7000-0000-0000000000c1", cwd: "/tmp/verify-markdown", title: "Markdown regression fixture" },
  {
    id: "e-u-01",
    type: "message",
    timestamp: ts("2026-08-20T12:10:02.000Z"),
    message: { id: "m-u-01", role: "user", content: [{ type: "text", text: "MARKDOWN FIXTURE REQUEST" }] },
  },
  {
    id: "e-a-01",
    type: "message",
    timestamp: ts("2026-08-20T12:10:03.000Z"),
    message: { id: "m-a-01", role: "assistant", content: [{ type: "text", text: MARKDOWN }] },
  },
];

const dir = `${SESSIONS}/${DIR}`;
mkdirSync(dir, { recursive: true });
const fixturePath = `${dir}/${FILE}`;
writeFileSync(fixturePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 2 * 60 * 1000);
utimesSync(fixturePath, when, when);

const webApp = await startWebApp({ base: BASE, port: 5196 });

try {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${mkdtempSync(`${tmpdir()}/omp-verify-md-`)}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

  const pageErrors = [];
  const consoleErrors = [];
  const NOISE = /favicon\.ico|Failed to load resource|status of 404|ERR_|net::|WebSocket|Failed to fetch/i;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !NOISE.test(m.text())) consoleErrors.push(m.text());
  });

  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: "networkidle0" });
  await page.reload({ waitUntil: "networkidle0" });
  await showSessionsList(page);
  await page.waitForSelector("[data-testid='session-row']", { timeout: 20000 });
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid='session-row']"));
    const t = rows.find((r) => (r.textContent || "").includes("Markdown regression")) || rows[0];
    if (t instanceof HTMLElement) t.click();
  });
  await page.waitForSelector("[data-testid='chat-message']", { timeout: 20000 });

  // The heavy layer is lazy by design, so give it a bounded window to arrive.
  await page
    .waitForFunction(() => document.querySelectorAll("pre").length > 0, { timeout: 15000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const r = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("[data-testid='chat-message']")).find((e) =>
      (e.textContent || "").includes("bold prose"),
    );
    if (!row) return { missing: true };
    row.scrollIntoView({ block: "center" });
    const text = row.textContent || "";
    const pres = Array.from(row.querySelectorAll("pre"));
    return {
      missing: false,
      // textContent, not innerText: content-visibility:auto skips offscreen
      // rendering and innerText would report a rendered row as empty.
      chars: text.length,
      hasProse: text.includes("bold prose"),
      // The renderer emits its own styled markup rather than raw tags:
      // bold becomes `[data-streamdown="strong"]`, and links become buttons so
      // navigation stays under app control. Assert the contract, not the tag.
      strong: row.querySelectorAll('strong, [data-streamdown="strong"]').length,
      inlineCode: row.querySelectorAll("code").length,
      link: Array.from(row.querySelectorAll('a, button')).filter((e) =>
        (e.textContent || "").includes("link"),
      ).length,
      table: row.querySelectorAll("table").length,
      listItems: row.querySelectorAll("li").length,
      pre: pres.length,
      nodeAttrLeak: row.querySelectorAll("[node]").length,
      rustVisible: text.includes("let total") || text.includes("println!"),
      cobolVisible: text.includes("PROGRAM-ID") || text.includes("STOP RUN"),
      // shiki wraps tokens in styled spans once a grammar is applied
      highlightedTokens: pres.reduce((n, p) => n + p.querySelectorAll("span[style]").length, 0),
    };
  });

  check("the assistant turn is not blank", !r.missing && r.chars > 100, r.missing ? "row not found" : `${r.chars} chars`);
  check("prose renders", !!r.hasProse && r.strong > 0, `strong=${r.strong}`);
  check("inline code renders", (r.inlineCode ?? 0) > 0, `code=${r.inlineCode}`);
  check("links render", (r.link ?? 0) > 0, `a=${r.link}`);
  check("tables render", (r.table ?? 0) > 0, `table=${r.table}`);
  check("lists render", (r.listItems ?? 0) >= 2, `li=${r.listItems}`);
  check("fenced code blocks render as <pre>", (r.pre ?? 0) >= 2, `pre=${r.pre}`);
  check("an allowed grammar keeps its content", !!r.rustVisible, `rustVisible=${r.rustVisible}`);
  check(
    "a restricted grammar degrades to plain text instead of throwing",
    !!r.cobolVisible && pageErrors.length === 0,
    `cobolVisible=${r.cobolVisible}, pageErrors=${pageErrors.length}`,
  );
  check("syntax highlighting is applied after the lazy layer loads", (r.highlightedTokens ?? 0) > 0, `styled spans=${r.highlightedTokens}`);
  check("no mdast `node` attribute leaks into the DOM", (r.nodeAttrLeak ?? 0) === 0, `elements with node=: ${r.nodeAttrLeak}`);
  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join("; ") || "none");
  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join("; ") || "none");

  await browser.close();
} finally {
  webApp.stop();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
