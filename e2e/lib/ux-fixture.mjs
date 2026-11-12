#!/usr/bin/env node
// Seed a rich, deterministic session corpus for UI review.
//
// A real conversation is the wrong stage for a design audit: it is the
// user's private data, it cannot be pointed at safely, and whatever it
// happens to contain is not what you need to look at. This builds a corpus
// that deliberately contains every shape the transcript can render — every
// content block type the parser handles (text, thinking, redactedThinking,
// image, toolCall, anthropicServerTool), tool failures, mode changes, and the
// content that historically breaks mobile layout: unbroken 200-character
// strings, wide tables, deep lists, long titles, emoji and CJK.
//
// Usage: node e2e/lib/ux-fixture.mjs <sessions-root>

import { mkdirSync, writeFileSync, utimesSync } from "fs";

const root = process.argv[2];
if (!root) {
  console.error("usage: node e2e/lib/ux-fixture.mjs <sessions-root>");
  process.exit(2);
}

// A 1x1 transparent PNG — enough to exercise the image part without weight.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const LOREM =
  "The retry budget is per-endpoint, not per-request, so a burst of 500s on one route cannot exhaust the allowance for another. ";

// Working directories live in a sandbox: they must exist, and they must not
// be anyone's real project paths.
const SANDBOX = "/tmp/omp-ux-cwd";
mkdirSync(SANDBOX, { recursive: true });

let clock = Date.UTC(2026, 7, 28, 9, 0, 0);
const tick = (mins = 2) => {
  clock += mins * 60_000;
  return new Date(clock).toISOString();
};

// `read_tree` builds the branch tree from each entry's top-level `id` and
// `parentId` (src/sessions/jsonl.rs:1145-1152). Fixture entries originally carried
// neither, so /api/tree returned 0 rows for every fixture session and the
// Timeline sheet silently fell back to its /api/turns path — meaning the
// harness could not exercise the surface it was built to review. Chain them.
function chain(entries, prefix) {
  let prev = null;
  return entries.map((e, i) => {
    const id = e.id ?? `${prefix}-e${i}`;
    const out = prev ? { ...e, id, parentId: prev } : { ...e, id };
    prev = id;
    return out;
  });
}

function session(slug, title, cwd, entries, ageMinutes) {
  const dir = `${root}/${slug}`;
  mkdirSync(dir, { recursive: true });
  // The cwd must EXIST. omp cannot switch into a missing directory: it fails
  // with an open failure that surfaces as a red banner across the top of the
  // chat, and a reviewer would reasonably report that as an app bug.
  mkdirSync(cwd, { recursive: true });
  const id = `019ff400-0000-7000-0000-${String(Math.abs(hash(slug))).padStart(12, "0").slice(0, 12)}`;
  const stamp = new Date(clock).toISOString().replace(/[:.]/g, "-");
  const file = `${dir}/${stamp}_${id}.jsonl`;
  const all = chain([{ type: "session", id, cwd, title }, ...entries], slug.replace(/[^a-z0-9]/gi, ""));
  writeFileSync(file, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const when = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(file, when, when);
  return file;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const user = (text) => ({
  type: "message",
  timestamp: tick(),
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (content) => ({
  type: "message",
  timestamp: tick(),
  message: { role: "assistant", content },
});
const toolResult = (callId, text, isError = false) => ({
  type: "message",
  timestamp: tick(0),
  message: {
    role: "toolResult",
    content: [{ type: "text", text }],
    toolCallId: callId,
    isError,
  },
});

// ── 1. The main stage: long, rich, every renderable shape ───────────────────
const main = [];
main.push(user("The payment retries are firing twice on 429s. Can you find out why and fix it?"));
main.push(
  assistant([
    { type: "thinking", thinking: "Two retries on a 429 usually means two layers are both retrying — a client-level policy and a transport-level one. Worth checking whether the HTTP client has its own retry enabled underneath our policy." },
    {
      type: "text",
      text:
        "## What I found\n\n" +
        "There are **two** retry layers, and they compose multiplicatively.\n\n" +
        "1. `PaymentClient` applies our own policy\n" +
        "2. The underlying `undici` pool has `retry` left at its default\n" +
        "   - which is 2 for idempotent methods\n" +
        "   - and `POST /charges` is being marked idempotent by the key header\n\n" +
        "| Layer | Retries | Backoff | Honours `Retry-After` |\n" +
        "| --- | ---: | --- | --- |\n" +
        "| `PaymentClient` | 3 | exponential, jittered | yes |\n" +
        "| `undici` pool | 2 | fixed 100ms | no |\n" +
        "| **effective** | **6** | — | partially |\n\n" +
        "> The 429 handler was never wrong. It just never got to run twice in the same place.\n\n" +
        "Here is the offending construction:",
    },
    {
      type: "text",
      text:
        "```ts\n" +
        "const pool = new Pool(origin, {\n" +
        "  connections: 32,\n" +
        "  // no `retry` key -> undici's default kicks in underneath our policy\n" +
        "});\n" +
        "\n" +
        "export const client = new PaymentClient(pool, {\n" +
        "  retries: 3,\n" +
        "  backoff: exponentialJitter({ base: 200, cap: 8_000 }),\n" +
        "});\n" +
        "```",
    },
  ]),
);

main.push(
  assistant([
    { type: "toolCall", id: "call_grep_1", name: "grep", intent: "Finding retry configuration", arguments: { pattern: "retry|retries", path: "src/payments" } },
  ]),
);
main.push(
  toolResult(
    "call_grep_1",
    "src/payments/client.ts:41:  retries: 3,\n" +
      "src/payments/pool.ts:12:  // no retry configured\n" +
      "src/payments/policy.ts:88:  shouldRetry(status) {\n" +
      "src/payments/policy.ts:93:    return status === 429 || status >= 500;\n",
  ),
);

main.push(
  assistant([
    { type: "toolCall", id: "call_bash_1", name: "bash", intent: "Reproducing the double retry", arguments: { command: "npm run test -- payments/retry --reporter=verbose" } },
  ]),
);
main.push(
  toolResult(
    "call_bash_1",
    "FAIL  test/payments/retry.spec.ts\n" +
      "  ● double-charges a 429\n\n" +
      "    expected 3 attempts, received 6\n\n" +
      "      at Object.<anonymous> (test/payments/retry.spec.ts:44:19)\n\n" +
      "Tests: 1 failed, 12 passed, 13 total\n" +
      "Time:  4.118s",
    true,
  ),
);

main.push(
  assistant([
    { type: "text", text: "Reproduced — six attempts where three were configured. Fixing the pool so only one layer retries:" },
    {
      type: "toolCall",
      id: "call_edit_1",
      name: "edit",
      intent: "Disabling the transport retry",
      arguments: { path: "src/payments/pool.ts", old: "connections: 32,", new: "connections: 32,\n  retry: 0, // the policy above owns retries" },
    },
  ]),
);
main.push(toolResult("call_edit_1", "applied 1 hunk to src/payments/pool.ts"));

main.push(
  assistant([
    {
      type: "toolCall",
      id: "call_task_1",
      name: "task",
      intent: "Auditing the other clients in parallel",
      arguments: {
        tasks: [
          { name: "LedgerClientAudit", agent: "scout", task: "Check whether the ledger client has the same double-retry shape." },
          { name: "WebhookClientAudit", agent: "scout", task: "Check the webhook dispatcher for a nested retry policy." },
          { name: "RefundsClientAudit", agent: "scout", task: "Check the refunds client for nested retries." },
        ],
      },
    },
  ]),
);
main.push(toolResult("call_task_1", "3 subagents finished. Ledger: clean. Webhooks: same bug. Refunds: clean."));

main.push(user("Good. Show me the diff and re-run the suite."));
main.push(
  assistant([
    {
      type: "text",
      text:
        "```diff\n" +
        "--- a/src/payments/pool.ts\n" +
        "+++ b/src/payments/pool.ts\n" +
        "@@\n" +
        "   connections: 32,\n" +
        "+  retry: 0, // the policy above owns retries\n" +
        " });\n" +
        "```",
    },
    { type: "toolCall", id: "call_bash_2", name: "bash", intent: "Re-running the suite", arguments: { command: "npm test" } },
  ]),
);
main.push(toolResult("call_bash_2", "Tests: 13 passed, 13 total\nTime:  3.902s"));

// A server-side tool block, an image, and the layout-hostile content.
main.push(
  assistant([
    { type: "anthropicServerTool", block: { type: "web_search_tool_result", id: "srv_1", name: "web_search", content: [{ title: "undici Pool options", url: "https://undici.nodejs.org/#/docs/api/Pool" }] } },
    { type: "text", text: "The upstream default is confirmed in undici's own docs. Screenshot of the failing run before the fix:" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  ]),
);

main.push(user("What happens if the identifier is absurdly long? supercalifragilisticexpialidocious_" + "x".repeat(160)));
main.push(
  assistant([
    { type: "redactedThinking", data: "redacted" },
    {
      type: "text",
      text:
        "It wraps. Here is a URL that cannot break: " +
        "https://example.com/" + "segment".repeat(28) + "\n\n" +
        "And a wide code line:\n\n```bash\n" +
        "curl -X POST https://api.example.com/v1/charges -H 'Idempotency-Key: " + "k".repeat(120) + "' -d '{}'\n" +
        "```\n\n" +
        LOREM.repeat(6) +
        "\n\n絵文字とCJKの混在テスト 🚀 ✅ 🔁 — mixed emoji and CJK to check line-height and clipping.",
    },
  ]),
);
main.push({ type: "mode_change", mode: "plan" });
main.push(user("Switch to plan mode and outline the webhook fix."));
main.push(
  assistant([
    {
      type: "text",
      text:
        "### Plan\n\n" +
        "- [ ] Mirror the pool change in `src/webhooks/pool.ts`\n" +
        "- [ ] Add a regression test asserting attempt COUNT, not just eventual success\n" +
        "  - the existing test only asserted the final state, which is why six attempts passed for months\n" +
        "- [ ] Check the dead-letter queue for duplicates created while this was live\n" +
        "- [ ] Backfill: reconcile duplicate charge intents from the last 30 days\n",
    },
  ]),
);

// The tree has one row per USER turn, and a Timeline that fits its viewport
// cannot exercise where it lands when opened. Thirty extra turns push the
// sheet well past one screen so the landing position is observable.
for (let i = 0; i < 30; i++) {
  main.push(user(`Follow-up ${i + 1}: check the ${i % 2 ? "webhook" : "ledger"} path for the same nested retry.`));
  main.push(
    assistant([
      { type: "text", text: `Checked. ${i % 3 === 0 ? "Clean." : "Same shape, patched."} Attempt count now asserted in the test.` },
    ]),
  );
}

session("-Coding-payments", "Fix double retries on 429 in the payments client", `${SANDBOX}/payments`, main, 3);

// ── 2. A short session: the near-empty state ────────────────────────────────
session(
  "-Coding-scratch",
  "Quick question about tsconfig paths",
  `${SANDBOX}/scratch`,
  [user("Does `paths` in tsconfig affect the emitted JS?"), assistant([{ type: "text", text: "No. `paths` is resolution-only; the emitted import specifiers are unchanged. You need a bundler or `tsc-alias` to rewrite them." }])],
  45,
);

// ── 3. A session whose title is far too long for one line ───────────────────
session(
  "-Coding-observability",
  "Investigate why the p99 latency dashboard disagrees with the client-side RUM numbers for the checkout funnel on mobile Safari",
  `${SANDBOX}/observability`,
  [
    user("The dashboards disagree. Which one is lying?"),
    assistant([
      { type: "thinking", thinking: "Server p99 excludes queueing and TLS; RUM includes both plus the user's network. They are measuring different things." },
      { type: "text", text: "Neither. They measure different intervals — the server histogram starts at first byte in, RUM starts at navigation start. On mobile Safari the gap is dominated by TLS resumption failures." },
    ]),
  ],
  180,
);

// ── 4. A failed run: error surfaces ─────────────────────────────────────────
session(
  "-Coding-flaky",
  "CI is red again",
  `${SANDBOX}/flaky`,
  [
    user("CI failed. Why?"),
    assistant([{ type: "toolCall", id: "call_ci", name: "bash", intent: "Reading the CI log", arguments: { command: "gh run view --log-failed" } }]),
    toolResult(
      "call_ci",
      "Error: connect ETIMEDOUT 140.82.121.6:443\n" +
        "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)\n" +
        "  errno: -110,\n  code: 'ETIMEDOUT',\n  syscall: 'connect'\n\n" +
        "The runner could not reach the registry. This is the fourth occurrence this week.",
      true,
    ),
  ],
  1440,
);

// ── 5..10. Enough rows that the session list itself must be designed ────────
const filler = [
  ["-Coding-reports", "Report generation drops the summary section", `${SANDBOX}/reports`, 12],
  ["-Coding-physics", "Bond-graph solver energy ledger does not close", `${SANDBOX}/physics`, 300],
  ["-Coding-omp", "Slash command palette ordering", `${SANDBOX}/omp`, 2880],
  ["-Coding-infra", "Terraform plan wants to replace the whole VPC", `${SANDBOX}/infra`, 4320],
  ["-Coding-docs", "Rewrite the onboarding guide", `${SANDBOX}/docs`, 10080],
  ["-tmp-notes", "scratch", `${SANDBOX}/notes`, 20160],
];
for (const [slug, title, cwd, age] of filler) {
  session(
    slug,
    title,
    cwd,
    [user(`Opening question for ${title}.`), assistant([{ type: "text", text: `A short reply about ${title.toLowerCase()}.` }])],
    age,
  );
}

console.log(`seeded ${4 + filler.length} sessions into ${root}`);
