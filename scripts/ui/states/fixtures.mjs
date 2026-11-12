// Corpus for the UI-state capture: e2e/lib/ux-fixture.mjs (the review corpus,
// every content shape the transcript renders) plus a handful of sessions that
// exist only to put one specific state on screen.
//
// Working directories live under /tmp/omp-ux-cwd, the scratch sandbox the
// review corpus already uses: they must exist (omp refuses a missing cwd) and
// they must never be a real project path.

import { execFileSync } from "node:child_process";
import { crc32, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SANDBOX = "/tmp/omp-ux-cwd";

const DIFF = [
  "--- a/src/payments/pool.ts",
  "+++ b/src/payments/pool.ts",
  "@@ -9,7 +9,8 @@ import { Pool } from \"undici\";",
  " ",
  " export const pool = new Pool(origin, {",
  "   connections: 32,",
  "-  keepAliveTimeout: 4_000,",
  "+  keepAliveTimeout: 10_000,",
  "+  retry: 0, // the policy above owns retries",
  " });",
  " ",
  ...Array.from({ length: 230 }, (_, i) => (i % 3 === 0 ? `+// generated line ${i}` : ` const unchanged${i} = ${i};`)),
].join("\n");

/** A 480×300 gradient PNG: a 1×1 pixel (the review corpus) makes the image viewer look broken. */
export function gradientPng(w = 480, h = 300) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      raw[o] = 60 + Math.round((x / w) * 120);
      raw[o + 1] = 40 + Math.round((y / h) * 90);
      raw[o + 2] = 200 - Math.round((x / w) * 80);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

/**
 * The instant every capture renders at: the page clock is pinned here
 * (page-shim.mjs), and every fixture time and stub timestamp is relative to
 * it, so relative times read the same on every run and screenshots can be
 * compared pixel for pixel. After the review corpus (2026-08-28), so its
 * sessions read as weeks old rather than in the future.
 */
export const CLOCK = Date.UTC(2026, 8, 20, 9, 0, 0);

let clock = CLOCK - 2 * 86_400_000;
const at = (mins) => new Date((clock += mins * 60_000)).toISOString();

function write(sessionsRoot, slug, title, cwd, entries, ageMinutes) {
  const dir = `${sessionsRoot}/${slug}`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const id = `019ff500-0000-7000-0000-${String(slug.length * 7919 + title.length).padStart(12, "0")}`;
  const file = `${dir}/2026-09-01T00-00-00-000Z_${id}.jsonl`;
  // Chained id/parentId: /api/tree and the timeline need them (ux-fixture.mjs).
  let prev = null;
  const all = [{ type: "session", id, cwd, title }, ...entries].map((e, i) => {
    const eid = e.id ?? `${slug}-e${i}`;
    const out = prev ? { ...e, id: eid, parentId: prev } : { ...e, id: eid };
    prev = eid;
    return out;
  });
  writeFileSync(file, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const when = new Date(CLOCK - ageMinutes * 60_000);
  utimesSync(file, when, when);
}

const user = (text, mins = 2) => ({ type: "message", timestamp: at(mins), message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (content, extra = {}, mins = 1) => ({ type: "message", timestamp: at(mins), message: { role: "assistant", content, ...extra } });
const result = (callId, text, isError = false) => ({ type: "message", timestamp: at(0), message: { role: "toolResult", toolCallId: callId, isError, content: [{ type: "text", text }] } });

function seedExtras(sessionsRoot) {
  // Files for the Files sheet / viewer / editor, in the main fixture's cwd.
  const payments = `${SANDBOX}/payments`;
  mkdirSync(`${payments}/src/payments`, { recursive: true });
  // Dated from CLOCK like everything else: the Files sheet shows each entry's
  // age, and a file written "now" reads differently on every run.
  const files = {
    "README.md": "# payments\n\nRetry policy lives in `src/payments/policy.ts`.\n",
    "package.json": '{\n  "name": "payments",\n  "private": true\n}\n',
    "src/payments/pool.ts": 'import { Pool } from "undici";\n\nexport const pool = new Pool(origin, {\n  connections: 32,\n  retry: 0,\n});\n',
    "src/payments/policy.ts": "export function shouldRetry(status: number): boolean {\n  return status === 429 || status >= 500;\n}\n",
  };
  const when = new Date(CLOCK - 30 * 60_000);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(`${payments}/${name}`, content);
    utimesSync(`${payments}/${name}`, when, when);
  }
  for (const dir of ["src/payments", "src", "."]) utimesSync(`${payments}/${dir}`, when, when);

  write(sessionsRoot, "-Capture-empty", "Capture: empty conversation", `${SANDBOX}/empty`, [], 20);

  // Two calendar days, every marker kind, a provider error, a file tool, a
  // diff long enough to collapse, and a tool call with no result (running).
  clock = CLOCK - 2 * 86_400_000;
  write(sessionsRoot, "-Capture-parts", "Capture: part variants", `${SANDBOX}/payments`, [
    user("Walk me through the retry change."),
    assistant([{ type: "text", text: "Starting with the current pool configuration." }]),
    { type: "model_change", timestamp: at(1), model: "anthropic/claude-opus-4-1" },
    { type: "thinking_level_change", timestamp: at(0), thinkingLevel: "high" },
    { type: "service_tier_change", timestamp: at(0), serviceTier: "priority" },
    { type: "compaction", timestamp: at(1), tokensBefore: 182_000, tokensAfter: 31_000, summary: "Earlier turns compacted." },
    (() => { clock += 86_400_000; return user("Continue from yesterday."); })(),
    assistant([{ type: "toolCall", id: "cap_read", name: "read", intent: "Reading the pool", arguments: { path: "src/payments/pool.ts" } }]),
    result("cap_read", 'import { Pool } from "undici";\n\nexport const pool = new Pool(origin, {\n  connections: 32,\n});'),
    assistant([{ type: "toolCall", id: "cap_edit", name: "edit", intent: "Raising keep-alive and disabling transport retry", arguments: { path: "src/payments/pool.ts" } }]),
    result("cap_edit", DIFF),
    { type: "title_change", timestamp: at(0), title: "Capture: part variants" },
    assistant([{ type: "text", text: "Half an answer before the provider fell over" }], { stopReason: "error", errorMessage: "provider error: 529 overloaded_error — the upstream model is at capacity" }),
    user("Run the suite again."),
    assistant([{ type: "toolCall", id: "cap_running", name: "bash", intent: "Running the payments suite", arguments: { command: "npm test -- payments" } }]),
  ], 8);

  write(sessionsRoot, "-Capture-long", "Capture: very long reply", `${SANDBOX}/payments`, [
    user("Paste the whole incident log."),
    assistant([{ type: "text", text: "## Incident log\n\n" + Array.from({ length: 260 }, (_, i) => `${i + 1}. 09:${String(i % 60).padStart(2, "0")} retry attempt observed on \`POST /charges\` — status 429, Retry-After 2s.`).join("\n") }]),
    // The long reply must be an EARLIER turn: only the newest reply is always
    // shown in full, so the collapsed form is captured on an older one.
    user("Thanks. Is that the whole log?"),
    assistant([{ type: "text", text: "Yes, that is everything from the incident window." }]),
  ], 30);

  write(sessionsRoot, "-Capture-image", "Capture: image reply", `${SANDBOX}/payments`, [
    user("Show me the latency chart."),
    assistant([
      { type: "text", text: "Here is the p99 over the incident window:" },
      // Anthropic-style `source` blocks render as the "not transferred" placeholder…
      { type: "image", source: { type: "base64", media_type: "image/png", data: gradientPng(8, 8) } },
      { type: "text", text: "…and the same chart in omp's own image form:" },
      // …omp's top-level data/mimeType form renders inline (web/src/domain/messages.ts).
      { type: "image", data: gradientPng(), mimeType: "image/png" },
    ]),
  ], 35);
}

async function listing(base, token) {
  const r = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET /api/sessions → ${r.status}`);
  return (await r.json()).sessions ?? [];
}

/** Seed the corpus into the ISOLATED sessions root; resolve once the daemon lists all of it. */
export async function seedFixtures({ base, token, sessionsRoot }) {
  execFileSync(process.execPath, [resolve(ROOT, "e2e/lib/ux-fixture.mjs"), sessionsRoot], { stdio: "ignore" });
  seedExtras(sessionsRoot);
  const expected = ["Fix double retries", "Capture: empty conversation", "Capture: part variants", "Capture: very long reply", "Capture: image reply", "scratch"];
  for (let i = 0; i < 100; i++) {
    const rows = await listing(base, token);
    if (expected.every((t) => rows.some((r) => (r.title ?? "").includes(t)))) return rows;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("daemon never listed the seeded fixtures");
}
