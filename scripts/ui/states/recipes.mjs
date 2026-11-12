// The catalogue of UI states. One entry per distinct thing the owner can see.
//
// A recipe is { id, group, title, note?, embeddedOnly?, setup?, mask?, run }:
//   embeddedOnly: the state needs a real release id, so `--vite` (a "dev"
//     build) skips it rather than failing it.
//   mask: selectors hidden just before the shot because their pixels are
//     random by nature (a live microphone level). Use sparingly: a masked
//     region is invisible to the baseline diff.
//   setup (object, or fn(env) → object), applied before the app boots:
//     hash      appended to the app URL (`env.chatHash(title)` deep-links a chat)
//     unpaired  boot without a token (pairing screen)
//     storage   extra localStorage entries
//     stubs     [{ method?, path ('/api/x', '/api/x*', any same-origin path), query?, rpc?, skip?,
//                  status?, body?, delay?, hang?, fail? (reject like an unreachable host) }] — first match wins
//     ws        { chat?, sessions? }: 'real' (default) | 'hang' | 'fail'
//     native    { status, permission }: stub the Android bridge
//     notificationPermission  override Notification.permission
//     hold      [RegExp] requests left unanswered (lazy chunks)
//     enforceCsp  keep the browser's Content-Security-Policy enforcement ON for this page. Every other
//               recipe runs with it bypassed; set it where the state is the sandbox frame's own CSP
//               (the plugin sandbox probes: fetch / importScripts / eval read "blocked" only under it).
//   run(ui): drive to the state; the engine settles and shoots when it returns.
//
// Adding a state: append a recipe. Keep it independent (it gets a fresh page
// with every origin store wiped) and end on a condition — a selector or
// text — never a sleep.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { CLOCK, gradientPng } from "./fixtures.mjs";

const MAIN = "Fix double retries";
const PARTS = "Capture: part variants";
/** Stub and frame timestamps: the page clock is pinned to CLOCK (fixtures.mjs). */
const now = CLOCK;
const PROTOCOL = JSON.parse(readFileSync(new URL("../../../protocol-version.json", import.meta.url), "utf8"));

// Protocol frames for synthetic live turns (web/src/domain/protocol.ts).
const ev = (event) => ({ type: "event", event });
const streamingFrames = (content) => [
  ev({ type: "agent_start" }),
  ev({ type: "message_start", message: { role: "assistant", responseId: "cap-r1", content } }),
];
const ASK = (extra) => ev({ type: "collab_ui_request", request: { reqId: 7, prompt: "Which retry budget should the webhook client use?", ...extra } });

const DEVICE_ADMIN = { device: { id: "owner", name: "Desktop owner", role: "admin", lastSeenAt: now - 60_000 } };
const DEVICES = {
  devices: [
    DEVICE_ADMIN.device,
    { id: "phone-1", name: "Pixel 9", role: "control", lastSeenAt: now - 5 * 60_000 },
    { id: "phone-2", name: "Work iPad", role: "read", lastSeenAt: now - 3 * 86_400_000 },
    { id: "phone-3", name: "Old phone", role: "control", lastSeenAt: now - 40 * 86_400_000, revokedAt: now - 30 * 86_400_000 },
  ],
};
const DIRS = (n) => ({
  ok: true,
  path: "/tmp/omp-ux-cwd",
  parent: "/tmp",
  dirs: ["payments", "scratch", "observability", "flaky", "reports", "physics", "omp", "infra", "docs", "notes"].slice(0, n).map((name) => ({ name, path: `/tmp/omp-ux-cwd/${name}` })),
});
/** Pick a command from the slash palette. Enter is not used: it runs whatever row is highlighted, which ran /compact for "/usage". */
async function runSlash(ui, name) {
  await focusComposer(ui);
  await ui.page.keyboard.type(`/${name.slice(0, 3)}`);
  await ui.clickText(`/${name}`, { within: "[data-testid='slash-palette']" });
}

/** ⋯ in the chat header opens the session actions sheet; `row` is a row's testid (`session-settings`, `session-rename`, …). */
async function openSessionMenu(ui, row) {
  await ui.click("[data-testid='session-actions']");
  await ui.click(`[data-testid='session-actions-sheet'] [data-testid='${row}']`);
}
/** One of the workspace drawer's pages (SessionPager), opened from its tab. */
async function openWorkspaceTab(ui, tab) {
  // Programmatic: selecting the tab opens the closed drawer; no pointer path is needed.
  await ui.page.evaluate((t) => document.querySelector(`[data-testid='workspace-tabs'] [data-value='${t}']`)?.click(), tab);
  await ui.el(`[data-testid='workspace-tabs'] [data-value='${tab}'][aria-selected='true']`);
}
/** Settings hangs off the drawer: the ☰ on the home screen (new chat, or the most recent chat it opens to), then the drawer's Settings row. */
async function openDrawer(ui) {
  await ui.click("[data-testid='new-session-menu'], [data-testid='session-back']");
  await ui.el("[data-testid='switcher-settings']");
}
async function openSettings(ui) {
  await openDrawer(ui);
  await ui.click("[data-testid='switcher-settings']");
  await ui.el("[data-testid='settings-screen']");
}
async function openComputer(ui) {
  await openSettings(ui);
  await ui.click("[data-testid='settings-computer']");
  await ui.el("[data-settings-page='computer']");
}
/** A Settings root row that has no testid, by its title; waits for the pushed page. */
async function openSettingsRow(ui, title, page) {
  await openSettings(ui);
  await ui.clickText(title, { within: "[data-settings-page='root']", exact: true });
  await ui.el(`[data-settings-page='${page}']`);
}
/** Android run-mode state (platform/local-mode.ts LocalState): a phone that can run omp itself. */
const PHONE = (extra) => ({ mode: "phone", phase: "ready", supported: true, installed: true, laptopUrl: null, downloadBytes: 0, progress: -1, message: "", error: null, ompVersion: "capture", phoneTools: true, ...extra });
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude Pro/Max)", signedIn: true },
  { id: "openai-codex", label: "ChatGPT Plus/Pro (Codex Subscription)", signedIn: false },
  { id: "github-copilot", label: "GitHub Copilot", signedIn: false },
  { id: "openrouter", label: "OpenRouter", signedIn: false },
  { id: "google-gemini-cli", label: "Google Cloud Code Assist (Gemini CLI)", signedIn: false },
  { id: "deepseek", label: "DeepSeek", signedIn: false },
];
/** The shim's OmpLocal answers `[]`/`{}` to everything; give the call a recipe cares about a real answer (JSON-encoded, like the native side). */
const patchBridge = (ui, answers) =>
  ui.page.evaluate((a) => {
    for (const [k, v] of Object.entries(a)) { const json = JSON.stringify(v); window.OmpLocal[k] = () => json; }
    window.OmpLocal.setPhoneTools = () => {};
  }, answers);
/** omp's `/usage` text (slash-commands/builtin-session.ts), three providers, one near its cap. */
const USAGE_TEXT = [
  "Usage", "",
  "Anthropic", "  Models with usage data", "    anthropic/claude-opus-4-1",
  "- Claude 5 Hour", "  me@example.com (Acme): 62.00% used (38.0% left)  ← in use by this session", "  [███████████████░░░░░░░░░] 62%", "  resets in 2h 10m",
  "- Claude 7 Day", "  me@example.com (Acme): 41.00% used (59.0% left)  ← in use by this session", "  [██████████░░░░░░░░░░░░░░] 41%", "  resets in 3d 4h",
  "- Claude 7 Day (Opus)", "  me@example.com (Acme): 93.00% used (7.0% left)  ← in use by this session", "  [███████████████████████░] 93%", "  resets in 3d 4h",
  "OpenAI Codex", "  Models with usage data", "    openai-codex/gpt-5",
  "- Codex 5 Hour", "  me@example.com: 12.00% used (88.0% left)", "  [███░░░░░░░░░░░░░░░░░░░░░] 12%", "  resets in 4h 31m",
  "- Codex Weekly", "  me@example.com: 27.00% used (73.0% left)", "  [██████░░░░░░░░░░░░░░░░░░] 27%", "  resets in 5d",
  "GitHub Copilot", "  Models with usage data", "    github-copilot/gpt-5",
  "- Premium Requests — Monthly", "  me: 314.00 requests used (of 1500)", "  [█████░░░░░░░░░░░░░░░░░░░] 21%", "  resets in 18d",
].join("\n");
const USAGE_STUB = { method: "POST", path: "/api/command", body: { ok: true, output: USAGE_TEXT, agentInvoked: false } };
/** get_state with every field the Session settings sheet can show (the default stub omits auto-retry and slow mode). */
const FULL_STATE = { ok: true, data: { model: { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" }, thinkingLevel: "medium", isStreaming: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", interruptMode: "immediate", autoCompactionEnabled: true, autoRetryEnabled: true, fastModeEnabled: false, slowModeSupported: true, slowModeEnabled: false, contextUsage: { percent: 34, tokens: 68_000, contextWindow: 200_000 }, messageCount: 84, queuedMessageCount: 0 } };
const stateStub = (extra) => ({ method: "POST", path: "/api/rpc", rpc: "get_state", ...extra });
const modelsStub = (extra) => ({ method: "POST", path: "/api/rpc", rpc: "get_available_models", ...extra });
async function focusComposer(ui) {
  await ui.chat();
  await ui.click("[data-testid='composer-input']");
}

/** Real deletion owns the Undo deadline; keep its drain transition from the camera's global 1ms clamp. */
async function deleteWithUndo(ui) {
  await ui.sessions();
  await ui.page.addStyleTag({ content: "[data-slot='notice-progress']{transition-duration:5s!important}" });
  await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']");
  await ui.click("[data-testid='drawer-action-delete']");
  await ui.el("[data-slot='toast'] [data-slot='notice-progress']");
}

const cachedLinkFailure = {
  ws: { sessions: "fail" },
  stubs: [
    { method: "GET", path: "/api/sessions", skip: 1, fail: true },
    { method: "GET", path: "/api/version", fail: true },
  ],
};

/** Plugin catalogue entries (web/src/domain/plugins.ts PluginInfo, camelCase on the wire). */
const HASH = (c) => c.repeat(64);
const HOST_USAGE = {
  id: "host-usage", name: "Host usage", version: "0.1.0", description: "Load and memory of the computer running the daemon",
  status: "enabled", hash: HASH("a"), slots: ["drawer", "composer.status", "page"], linked: true,
  sources: [
    { id: "load", command: ["cat", "/proc/loadavg"], intervalS: 10, timeoutS: 5 },
    { id: "mem", command: ["cat", "/proc/meminfo"], intervalS: 10, timeoutS: 5 },
    { id: "host", command: ["uname", "-sn"], intervalS: 3600, timeoutS: 5 },
  ],
};
const PLUGIN_CATALOGUE = [
  HOST_USAGE,
  { id: "ci-status", name: "CI status", version: "1.2.0", description: "Latest pipeline result for the current branch", status: "needs_review", hash: HASH("b"), slots: ["drawer"], linked: false,
    sources: [{ id: "pipelines", command: ["gh", "run", "list", "--branch", "main", "--limit", "5", "--json", "status,conclusion,displayTitle,headBranch,updatedAt"], intervalS: 60, timeoutS: 15 }] },
  // Approved once, then edited: the row must say it changed, not that it is new.
  { id: "deploy-notes", name: "Deploy notes", version: "0.3.1", description: "Recent deploys of this project", status: "needs_review", changed: true, hash: HASH("c"), slots: ["page"], linked: true,
    sources: [{ id: "log", command: ["git", "log", "--oneline", "-5"], intervalS: 300, timeoutS: 5 }] },
  { id: "weather", name: "Weather", version: "2.0.0", description: "", status: "disabled", hash: HASH("d"), slots: ["composer.status"], linked: false, sources: [] },
  { id: "broken-plugin", name: "broken-plugin", version: "", description: "", status: "invalid", hash: "", slots: [], linked: true, sources: [], error: "pulse-plugin.toml: unknown key `slot` at line 7" },
];
const pluginsStub = (plugins) => ({ method: "GET", path: "/api/plugins", body: { ok: true, plugins } });
/** Fixed readings for host-usage's three sources, taken at the pinned page clock. */
const HOST_READINGS = {
  load: "0.52 0.58 0.59 1/467 12345\n",
  mem: ["MemTotal:       16318412 kB", "MemFree:         2145120 kB", "MemAvailable:    9876540 kB", "Buffers:          412344 kB", "Cached:          6123456 kB", "SwapTotal:       4194300 kB", "SwapFree:        4194300 kB", ""].join("\n"),
  host: "Linux workstation\n",
};
/**
 * Stubs are JSON-only (page-shim.mjs wraps every body in JSON.stringify with a JSON content type), so a plugin's
 * script cannot be served as text by a stub. Instead, once the app has booted, wrap window.fetch for the plugin
 * routes: the catalogue, each plugin's script as text/javascript, and its sources. The capture daemon has no
 * plugins, so the boot-time catalogue is empty and nothing has tried to start a plugin yet. Recipes that run a
 * plugin set `enforceCsp`: the sandbox frame's own Content-Security-Policy must stay on.
 *
 *   plugins   the catalogue (PluginInfo[]) to answer with
 *   scripts   { [pluginId]: script text }
 *   readings  { ["pluginId/sourceId"]: text } or a function of the real clock `(realNowMs) => that`
 *             (the worker's Date is not pinned, so relative times in a reading must be built from the real clock)
 */
async function servePlugins(ui, { plugins, scripts = {}, readings = {} }) {
  await ui.quiet();
  const table = typeof readings === "function" ? readings(Date.now()) : readings;
  await ui.page.evaluate(({ scripts, plugins, readings, at }) => {
    const previous = window.fetch;
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "GET") {
        if (url.pathname === "/api/plugins") return Promise.resolve(json({ ok: true, plugins }));
        const script = url.pathname.match(/^\/api\/plugins\/([^/]+)\/client\.js$/)?.[1];
        if (script && script in scripts)
          return Promise.resolve(new Response(scripts[script], { status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } }));
        const source = url.pathname.match(/^\/api\/plugins\/([^/]+)\/sources\/([^/]+)$/);
        if (source && `${source[1]}/${source[2]}` in readings)
          return Promise.resolve(json({ ok: true, reading: { ok: true, text: readings[`${source[1]}/${source[2]}`], exitCode: 0, fetchedAtMs: at, truncated: false } }));
      }
      return previous(input, init);
    };
  }, { scripts, plugins, readings: table, at: now });
}
/** A shipped example's client.js, read from the repository so the shot always shows what ships. */
const exampleScript = (name) => readFileSync(new URL(`../../../examples/plugins/${name}/client.js`, import.meta.url), "utf8");
const serveHostUsagePlugin = (ui, plugins) =>
  servePlugins(ui, {
    plugins,
    scripts: { "host-usage": exampleScript("host-usage") },
    readings: Object.fromEntries(Object.entries(HOST_READINGS).map(([source, text]) => [`host-usage/${source}`, text])),
  });
/** visibilitychange makes the app reload the plugin catalogue; repeat until `selector` shows (a reload already in flight coalesces). */
const nudgeUntil = (ui, selector) =>
  ui.page.waitForFunction((sel) => {
    document.dispatchEvent(new Event("visibilitychange"));
    return !!document.querySelector(sel);
  }, { polling: 500, timeout: 20_000 }, selector);
const DRAWER_CHIP = "[data-testid='plugin-slot-drawer'] [data-testid='plugin-chip']";
/** host-usage alone, running: serve it, open the drawer and wait for its chips. */
async function runHostUsagePlugin(ui) {
  await serveHostUsagePlugin(ui, [HOST_USAGE]);
  await openDrawer(ui);
  await nudgeUntil(ui, DRAWER_CHIP);
}
/** The plugin's own page, reached the way a user does: a tap on its first drawer chip (served beforehand). */
async function openPluginPageFromDrawer(ui) {
  await openDrawer(ui);
  await nudgeUntil(ui, DRAWER_CHIP);
  await ui.click(DRAWER_CHIP);
  await ui.el("[data-testid='plugin-page']");
}

/** The Chats list, reached the way a person does: the drawer, then "See all…". */
async function openChatsList(ui) {
  await ui.sessions();
}
// Slice 2 stand-ins and shipped examples. Slice 2 PluginInfo fields (permissions, tools, messages, options, optionValues, actions).
const info = (extra) => ({ description: "", status: "enabled", slots: [], sources: [], linked: true, permissions: [], tools: [], messages: [], options: [], optionValues: {}, actions: [], ...extra });
const OPS_HELPER = info({
  id: "ops-helper", name: "Ops helper", version: "0.3.0", description: "Row chips, quick prompts and a card for scheduled jobs", status: "needs_review", hash: HASH("e"),
  slots: ["session.row", "session.menu", "composer.actions", "transcript.tool", "transcript.message", "page"],
  permissions: ["session.compose", "session.prompt"], tools: ["schedule_*", "mcp__cron__list"], messages: ["ops:card"],
  actions: [
    { id: "restart", label: "Restart a user service", command: ["systemctl", "--user", "restart", "{arg}"], argPattern: "[A-Za-z0-9@._:-]+\\.service", timeoutS: 30 },
    { id: "timers", label: "List timers", command: ["systemctl", "--user", "list-timers", "--no-pager"], timeoutS: 10 },
  ],
  options: [
    { id: "verbose", label: "Show details on cards", type: "bool", choices: [], default: false },
    { id: "threshold", label: "Warn above", type: "choice", choices: ["70", "80", "90"], default: "80" },
    { id: "prefix", label: "Prompt prefix", type: "text", choices: [], default: "" },
  ],
  optionValues: { verbose: false, threshold: "80", prefix: "Please " },
});
const ROW_CHIPS = info({ id: "row-chips", name: "Row chips", version: "0.1.0", description: "The model family on every conversation row", hash: HASH("f"), slots: ["session.row"] });
// ctx.session.model is "provider/model-id" (or empty).
const ROW_CHIPS_SCRIPT = `
pulse.slot("session.row", async (ctx) => {
  const session = ctx && ctx.session;
  if (!session) return null;
  const name = String(session.model || "").split("/").pop();
  return pulse.ui.chip(name ? name.replace(/-\\d.*$/, "") : "no model", { tone: session.status === "working" ? "accent" : "muted" });
});
`;
const QUICK_PROMPTS = info({
  id: "quick-prompts", name: "Quick prompts", version: "0.2.0", description: "Canned prompts in the menus", hash: HASH("1"),
  slots: ["session.menu", "composer.actions"], permissions: ["session.compose"],
});
const QUICK_PROMPTS_SCRIPT = `
const TEXT = {
  summarise: "Summarise this conversation in five bullet points.",
  title: "Suggest a shorter title for this conversation.",
  review: "Review my last change for bugs.",
  tests: "Run the tests and report only the failures.",
  explain: "Explain the last error in plain words.",
};
pulse.slot("session.menu", async () =>
  pulse.ui.list([
    { id: "summarise", label: "Summarise this chat", detail: "Puts a prompt in the message box" },
    { id: "title", label: "Suggest a title", detail: "Puts a prompt in the message box" },
  ], { actions: { click: "pick" } }));
pulse.slot("composer.actions", async () =>
  pulse.ui.list([
    { id: "review", label: "Review my last change", detail: "Puts a prompt in the message box" },
    { id: "tests", label: "Run the tests", detail: "Puts a prompt in the message box" },
    { id: "explain", label: "Explain the last error" },
  ], { actions: { click: "pick" } }));
pulse.on("action", (event) => {
  if (event.act === "pick" && event.item && TEXT[event.item]) pulse.composer.insert(TEXT[event.item]);
});
`;
const BASH_CARD = info({ id: "bash-card", name: "Bash card", version: "0.1.0", description: "Draws bash calls as a summary card", hash: HASH("2"), slots: ["transcript.tool"], tools: ["bash"] });
const BASH_CARD_SCRIPT = `
pulse.slot("transcript.tool", async (ctx) => {
  const call = ctx && ctx.call;
  if (!call) return null;
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const lines = String(call.output || "").split("\\n").filter(Boolean).length;
  const tone = call.state === "error" ? "error" : "success";
  return pulse.ui.col([
    pulse.ui.kv([
      { key: "command", value: String(args.command || "") },
      { key: "result", value: call.state, tone },
      { key: "output", value: lines + (lines === 1 ? " line" : " lines") },
    ]),
    pulse.ui.progress(Math.min(1, lines / 20), "Output: " + lines + " of 20 lines", { tone }),
  ]);
});
`;
const PROVIDER_USAGE = info({
  id: "provider-usage", name: "Provider usage", version: "0.1.0", description: "How much of each model provider's usage limits you have used, from omp usage", hash: HASH("3"),
  slots: ["composer.status", "drawer", "page"],
  sources: [{ id: "usage", command: ["omp", "usage", "--json", "--redact"], intervalS: 300, timeoutS: 30 }],
  options: [
    { id: "warn_at", label: "Warn from this used percentage", type: "choice", choices: ["70", "80", "90"], default: "80" },
    { id: "composer_chip", label: "Show a chip beside the composer", type: "bool", choices: [], default: true },
  ],
  optionValues: { warn_at: "80", composer_chip: true },
});
/** `omp usage --json --redact`: { reports: [{ provider, fetchedAt, limits: [{ label, window: { id, resetsAt }, amount: { usedFraction } }] }] }. Times are relative to the real clock, offset 15 s so minute rounding is stable. */
const providerUsageReadings = (t) => {
  const min = 60_000;
  const ahead = (m) => t + m * min + 15_000;
  const limit = (label, id, used, resetsInMin) => ({ label, window: { id, resetsAt: ahead(resetsInMin) }, amount: { usedFraction: used } });
  return {
    "provider-usage/usage": JSON.stringify({
      reports: [
        { provider: "anthropic", fetchedAt: t - 2 * min, limits: [limit("5 hour window", "5h", 0.96, 95), limit("Weekly", "7d", 0.42, 3 * 24 * 60 + 5 * 60)] },
        { provider: "openai", fetchedAt: t - 2 * min, limits: [limit("Daily requests", "1d", 0.31, 9 * 60 + 40), limit("Monthly tokens", "30d", 0.12, 18 * 24 * 60)] },
      ],
    }),
  };
};
const SYSTEMD_TIMERS = info({
  id: "systemd-timers", name: "Systemd timers", version: "0.1.0", description: "Your systemd user timers and the services they run, with a tap to run one now", hash: HASH("4"),
  slots: ["drawer", "page"],
  sources: [
    { id: "timers", command: ["systemctl", "--user", "list-timers", "--all", "--output=json", "--no-pager"], intervalS: 30, timeoutS: 5 },
    { id: "units", command: ["systemctl", "--user", "list-units", "--type=service", "--all", "--output=json", "--no-pager"], intervalS: 30, timeoutS: 5 },
  ],
  options: [{ id: "show_inactive", label: "Show timers with no next run", type: "bool", choices: [], default: false }],
  optionValues: { show_inactive: false },
  actions: [{ id: "start", label: "Start the service a timer runs", command: ["systemctl", "--user", "start", "{arg}"], argPattern: "[A-Za-z0-9@._:-]+\\.service", timeoutS: 60 }],
});
/** systemctl's JSON: timers carry microseconds since the epoch (0 = never) and the unit they activate; units carry active/sub state. */
const systemdTimersReadings = (t) => {
  const min = 60_000;
  const us = (ms) => Math.round(ms * 1000);
  const timer = (name, nextInMin, lastAgoMin) => ({
    unit: `${name}.timer`, activates: `${name}.service`,
    next: nextInMin === null ? 0 : us(t + nextInMin * min + 15_000), last: lastAgoMin === null ? 0 : us(t - lastAgoMin * min + 15_000),
  });
  const unit = (name, active, sub, description) => ({ unit: `${name}.service`, load: "loaded", active, sub, description });
  return {
    "systemd-timers/timers": JSON.stringify([
      timer("backup", 130, 21 * 60 + 50),
      timer("omp-pulse-update", 47, 13 * 60 + 13),
      timer("photo-sync", 12, 48),
      timer("logrotate", 6 * 60 + 5, 17 * 60 + 55),
      timer("one-shot-cleanup", null, null),
    ]),
    "systemd-timers/units": JSON.stringify([
      unit("backup", "inactive", "dead", "Nightly backup"),
      unit("omp-pulse-update", "inactive", "dead", "Update omp-pulse"),
      unit("photo-sync", "failed", "failed", "Photo library sync"),
      unit("logrotate", "inactive", "dead", "Rotate logs"),
      unit("one-shot-cleanup", "inactive", "dead", "One-off cleanup"),
    ]),
  };
};
export const RECIPES = [
  // ── Pairing ───────────────────────────────────────────────────────────────
  { id: "pair-default", group: "Pairing", title: "Pairing screen", setup: { unpaired: true },
    run: (ui) => ui.text("Connect to your computer") },
  { id: "pair-enter-code", group: "Pairing", title: "Enter code", setup: { unpaired: true },
    run: async (ui) => { await ui.clickText("Enter code", { exact: true }); await ui.el("#pairing-code"); } },
  { id: "pair-code-prefilled", group: "Pairing", title: "Pairing from a link", note: "#pair= fills the code",
    setup: { unpaired: true, hash: "#pair=483920" },
    run: (ui) => ui.el("#pairing-code") },
  { id: "pair-busy", group: "Pairing", title: "Pairing in progress",
    setup: { unpaired: true, stubs: [{ method: "POST", path: "/api/pair", hang: true }] },
    run: async (ui) => {
      await ui.clickText("Enter code", { exact: true });
      await ui.type("#pairing-code", "483920");
      await ui.clickText("Connect", { exact: true });
      await ui.text("Connecting…");
    } },
  { id: "pair-error", group: "Pairing", title: "Pairing rejected",
    setup: { unpaired: true, stubs: [{ method: "POST", path: "/api/pair", status: 401, body: { ok: false, error: "That pairing code has expired. Generate a new one on the desktop." } }] },
    run: async (ui) => {
      await ui.clickText("Enter code", { exact: true });
      await ui.type("#pairing-code", "000000");
      await ui.clickText("Connect", { exact: true });
      await ui.el("#pairing-code-error [role='alert']");
    } },
  { id: "pair-lazy-splash", group: "Pairing", title: "Pairing chunk loading", note: "Suspense fallback while the PairScreen chunk is in flight",
    setup: { unpaired: true, hold: [/PairScreen/] },
    run: (ui) => ui.el("main svg") },

  // ── Sessions list ─────────────────────────────────────────────────────────
  { id: "sessions-loading", group: "Sessions", title: "Loading skeletons",
    setup: { stubs: [{ method: "GET", path: "/api/sessions", hang: true }] },
    run: async (ui) => { await ui.allChats(); await ui.el("[aria-label='Loading sessions']"); } },
  { id: "sessions-populated", group: "Sessions", title: "Session drawer", run: (ui) => ui.sessions() },
  { id: "sessions-empty", group: "Sessions", title: "No chats yet",
    setup: { stubs: [{ method: "GET", path: "/api/sessions", body: { sessions: [], projects: [] } }] },
    run: async (ui) => { await ui.allChats(); await ui.el("[data-testid='switcher-empty']"); } },
  { id: "drawer-no-chats", group: "Sessions", title: "Phone drawer: no chats yet",
    setup: { ompLocal: PHONE(), stubs: [{ method: "GET", path: "/api/sessions", body: { sessions: [], projects: [] } }] },
    run: async (ui) => { await openDrawer(ui); await ui.el("[data-testid='switcher-empty']"); await ui.el("[data-testid='switcher-new-chat']"); } },
  { id: "sessions-offline", group: "Sessions", title: "Couldn't load chats", note: "listing transport failure, nothing cached",
    setup: { stubs: [{ method: "GET", path: "/api/sessions", fail: true }] },
    run: async (ui) => { await ui.allChats(); await ui.el("[data-testid='switcher-error'], [data-testid='switcher-slow']"); } },
  { id: "sessions-reconnecting", group: "Sessions", title: "Reconnecting with rows", note: "the first listing lands, the next poll cannot reach the computer",
    setup: { ws: { sessions: "fail" }, stubs: [{ method: "GET", path: "/api/sessions", skip: 2, fail: true }, { method: "GET", path: "/api/version", fail: true }] },
    run: async (ui) => { await ui.sessions(); await ui.el("[data-testid='link-banner']"); } },
  { id: "sessions-running", group: "Sessions", title: "Working row and computer row", note: "running ring on the working row; the part-variants row is open on the computer",
    setup: (env) => ({ stubs: [env.listingStub((r) => r.title?.includes(MAIN) ? { sessionState: undefined, status: "streaming", streaming: true, running: true } : r.title?.includes(PARTS) ? { live: true, ownerPid: 4242 } : null)] }),
    run: async (ui) => {
      await ui.allChats();
      await ui.el("[data-slot='session-status'][data-state='working']");
      await ui.el("[data-slot='session-status'][data-state='on-computer']");
    } },
  { id: "sessions-project-sheet", group: "Sessions", title: "All projects page",
    run: async (ui) => { await openDrawer(ui); await ui.click("[data-testid='switcher-projects']"); await ui.el("[data-testid='projects-list'] [data-testid='project-row']"); } },
  { id: "sessions-project-filter", group: "Sessions", title: "Filtered to one project",
    run: async (ui) => { await openDrawer(ui); await ui.click("[data-testid='switcher-project']"); await ui.el("[data-testid='project-new-chat']"); await ui.sessions(); } },
  { id: "sessions-needs-reply", group: "Sessions", title: "Needs you row", note: "awaiting + pendingAsk: glyph and question preview",
    setup: (env) => ({ stubs: [
      { method: "GET", path: "/api/awaiting", body: { ok: true, sessions: [env.path(MAIN)] } },
      env.listingStub((r) => r.title?.includes(MAIN) ? { pendingAsk: { question: "Mirror the pool fix into the webhook client?", options: ["Yes, same change", "No, leave webhooks", "Show me the diff first"] } } : null),
    ] }),
    run: async (ui) => { await ui.allChats(); await ui.el("[data-testid='session-row'][data-state='needs-you']"); } },
  { id: "sessions-answer-sheet", group: "Sessions", title: "Answer sheet", note: "a tap on a Needs you row answers in place",
    setup: (env) => ({ stubs: [
      { method: "GET", path: "/api/awaiting", body: { ok: true, sessions: [env.path(MAIN)] } },
      env.listingStub((r) => r.title?.includes(MAIN) ? { pendingAsk: { question: "Mirror the pool fix into the webhook client?", options: ["Yes, same change", "No, leave webhooks", "Show me the diff first"] } } : null),
    ] }),
    run: async (ui) => { await ui.allChats(); await ui.click("[data-testid='session-row'][data-state='needs-you']"); await ui.el("[data-testid='answer-sheet']"); } },
  { id: "sessions-live-desktop", group: "Sessions", title: "On computer",
    setup: (env) => ({ stubs: [env.listingStub((r) => r.title?.includes("tsconfig") ? { live: true, ownerPid: 4242 } : null)] }),
    run: async (ui) => { await ui.allChats(); await ui.el("[data-slot='session-status'][data-state='on-computer']"); } },
  { id: "sessions-unread", group: "Sessions", title: "Unread replies", note: "seen revision older than the listing's: rows get the unread dot, not Needs you",
    setup: (env) => ({ stubs: [env.listingStub(() => ({ revision: "2" }))], storage: Object.fromEntries(env.listing.map((r) => [`omp-seen:${r.path}`, "r:1"])) }),
    run: async (ui) => { await ui.allChats(); await ui.el("[data-slot='session-status'][data-state='unread']"); } },
  { id: "sessions-pinned", group: "Sessions", title: "Pinned sessions",
    setup: (env) => ({ storage: { "omp-pins": JSON.stringify([env.path("tsconfig"), env.path("CI is red")]) } }),
    run: async (ui) => { await openDrawer(ui); await ui.el("[data-testid='switcher-sessions'] section[aria-label='Pinned'] [data-testid='session-row']"); } },
  { id: "sessions-grouped", group: "Sessions", title: "Drawer: Pinned and Recent groups",
    setup: (env) => ({ storage: { "omp-pins": JSON.stringify([env.path("CI is red")]) } }),
    run: async (ui) => { await openDrawer(ui); await ui.text("Pinned"); await ui.text("Recent"); } },
  { id: "sessions-search", group: "Sessions", title: "Search: titles and messages",
    // Title (`?q=`) and message (/api/search) results land independently; wait
    // for both so the shot never catches one group alone.
    run: async (ui) => {
      await ui.sessions();
      await ui.click("[data-testid='switcher-search-toggle']");
      const messages = ui.page.waitForResponse((r) => r.url().includes("/api/search?"));
      await ui.type("[data-testid='session-search']", "undici");
      await messages;
      await ui.el("[data-testid='message-results']");
    } },
  { id: "sessions-search-empty", group: "Sessions", title: "Search matches nothing",
    run: async (ui) => { await ui.sessions(); await ui.click("[data-testid='switcher-search-toggle']"); await ui.type("[data-testid='session-search']", "zzqx-nothing"); await ui.el("[data-testid='empty-no-search']"); } },
  { id: "sessions-search-error", group: "Sessions", title: "Search failed",
    setup: { stubs: [{ method: "GET", path: "/api/sessions", query: "q=", status: 500, body: { ok: false, error: "index unavailable" } }] },
    run: async (ui) => { await ui.sessions(); await ui.click("[data-testid='switcher-search-toggle']"); await ui.type("[data-testid='session-search']", "alpha"); await ui.el("[data-testid='search-error']"); } },
  { id: "sessions-messages-searching", group: "Sessions", title: "Message search in flight",
    setup: { stubs: [{ method: "GET", path: "/api/search", hang: true }] },
    run: async (ui) => { await ui.sessions(); await ui.click("[data-testid='switcher-search-toggle']"); await ui.type("[data-testid='session-search']", "undici"); await ui.el("[data-testid='message-search-loading']"); } },
  { id: "sessions-actions-sheet", group: "Sessions", title: "Session actions",
    run: async (ui) => { await ui.sessions(); await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']"); await ui.click("[data-testid='drawer-action-more']"); await ui.el("[data-testid='action-sheet']"); } },
  { id: "sessions-actions-working", group: "Sessions", title: "Session actions: working (Stop)",
    setup: (env) => ({ stubs: [env.listingStub((r) => r.title?.includes(MAIN) ? { sessionState: undefined, status: "streaming", streaming: true, running: true } : null)] }),
    run: async (ui) => { await ui.allChats(); await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row'][data-state='working']"); await ui.click("[data-testid='drawer-action-more']"); await ui.el("[data-testid='action-stop']"); } },
  { id: "sessions-rename", group: "Sessions", title: "Rename session",
    run: async (ui) => { await ui.sessions(); await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']"); await ui.click("[data-testid='drawer-action-rename']"); await ui.el("[data-testid='rename-input']"); } },
  { id: "sessions-rename-error", group: "Sessions", title: "Rename refused",
    setup: { stubs: [{ method: "POST", path: "/api/rpc", rpc: "set_session_name", body: { ok: false, error: "This session is open in a desktop terminal.", code: "session_owned_by_terminal" } }] },
    run: async (ui) => {
      await ui.sessions(); await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']"); await ui.click("[data-testid='drawer-action-rename']");
      await ui.click("[data-testid='rename-input']");
      await ui.page.keyboard.down("Control"); await ui.page.keyboard.press("KeyA"); await ui.page.keyboard.up("Control");
      await ui.page.keyboard.type("Payments retry fix"); await ui.click("[data-testid='rename-save']");
      await ui.el("[role='alert'], [data-slot='app-banner']");
    } },
  { id: "sessions-rename-empty", group: "Sessions", title: "Rename: empty name", note: "Save is disabled rather than raising an error after the tap",
    run: async (ui) => {
      await ui.sessions(); await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']"); await ui.click("[data-testid='drawer-action-rename']");
      await ui.click("[data-testid='rename-input']");
      await ui.page.keyboard.down("Control"); await ui.page.keyboard.press("KeyA"); await ui.page.keyboard.up("Control");
      await ui.page.keyboard.press("Backspace");
      await ui.el("[data-testid='rename-save']:disabled");
    } },
  { id: "sessions-change-model", group: "Sessions", title: "Change model from the list",
    run: async (ui) => { await ui.sessions(); await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']"); await ui.click("[data-testid='drawer-action-more']"); await ui.click("[data-testid='action-change-model']"); await ui.el("[data-testid='model-item']"); } },
  { id: "sessions-delete-undo", group: "Sessions", title: "Deleted, with Undo",
    run: async (ui) => { await ui.sessions(); await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']"); await ui.click("[data-testid='drawer-action-delete']"); await ui.el("[role='status']"); } },
  { id: "update-banner", group: "Sessions", title: "Update available banner", note: "heartbeat names a different release",
    run: async (ui) => {
      await ui.sessions(); await ui.socket("sessions");
      await ui.frames("sessions", [{ type: "hb", v: "capture-newer-release", ...PROTOCOL }]);
      await ui.text("A new version is ready.");
    } },
  { id: "protocol-banner", group: "Sessions", title: "Server protocol too old", note: "heartbeat protocolVersion below the client's",
    run: async (ui) => {
      await ui.sessions(); await ui.socket("sessions");
      await ui.frames("sessions", [{ type: "hb", v: "capture-old-release", protocolVersion: 1, minClientProtocolVersion: 1 }]);
      await ui.text("Update omp-pulse on your computer to keep sending safely.");
    } },

  // ── New session ───────────────────────────────────────────────────────────
  { id: "new-session", group: "New session", title: "New session (defaults)",
    run: async (ui) => { await ui.newSession(); await ui.el("[data-testid='new-session-screen']"); } },
  { id: "new-session-projects", group: "New session", title: "Project sheet",
    run: async (ui) => { await ui.newSession(); await ui.click("[data-testid='new-session-project']"); await ui.el("[data-testid='project-row']"); } },
  { id: "new-session-folders", group: "New session", title: "Folder browser",
    setup: { stubs: [{ method: "GET", path: "/api/browse", body: DIRS(5) }] },
    run: async (ui) => { await ui.newSession(); await ui.click("[data-testid='new-session-project']"); await ui.click("[data-testid='project-other-folder']"); await ui.el("[data-testid='dir-row']"); } },
  { id: "new-session-folders-loading", group: "New session", title: "Folder browser loading",
    setup: { stubs: [{ method: "GET", path: "/api/browse", hang: true }] },
    run: async (ui) => { await ui.newSession(); await ui.click("[data-testid='new-session-project']"); await ui.click("[data-testid='project-other-folder']"); await ui.el("[data-testid='project-sheet']"); } },
  { id: "new-session-filter-empty", group: "New session", title: "Folder filter: no match",
    setup: { stubs: [{ method: "GET", path: "/api/browse", body: DIRS(10) }] },
    run: async (ui) => { await ui.newSession(); await ui.click("[data-testid='new-session-project']"); await ui.click("[data-testid='project-other-folder']"); await ui.type("[data-testid='folder-filter']", "zzqx"); await ui.text("No folders match"); } },
  { id: "new-session-no-subdirs", group: "New session", title: "No folders here",
    setup: { stubs: [{ method: "GET", path: "/api/browse", body: { ok: true, path: "/tmp/omp-ux-cwd/empty", parent: "/tmp/omp-ux-cwd", dirs: [] } }] },
    run: async (ui) => { await ui.newSession(); await ui.click("[data-testid='new-session-project']"); await ui.click("[data-testid='project-other-folder']"); await ui.text("No folders here"); } },
  { id: "new-session-folder-error", group: "New session", title: "Folder browser failed",
    setup: { stubs: [{ method: "GET", path: "/api/browse", status: 500, body: { ok: false, error: "permission denied reading /tmp/omp-ux-cwd" } }] },
    run: async (ui) => { await ui.newSession(); await ui.click("[data-testid='new-session-project']"); await ui.click("[data-testid='project-other-folder']"); await ui.el("[role='alert']"); } },
  { id: "new-session-model", group: "New session", title: "Model picker (unsaved choice)",
    run: async (ui) => { await ui.newSession(); await ui.click("[data-testid='new-session-model']"); await ui.el("[data-testid='model-item']"); } },
  { id: "new-session-creating", group: "New session", title: "Starting session",
    setup: { stubs: [{ method: "POST", path: "/api/new", hang: true }] },
    run: async (ui) => { await ui.newSession(); await ui.type("[data-testid='new-session-input']", "Fix the flaky test"); await ui.click("[data-testid='new-session-send']"); } },
  { id: "new-session-error", group: "New session", title: "Start failed",
    setup: { stubs: [{ method: "POST", path: "/api/new", status: 400, body: { ok: false, error: "invalid cwd" } }] },
    run: async (ui) => { await ui.newSession(); await ui.type("[data-testid='new-session-input']", "Fix the flaky test"); await ui.click("[data-testid='new-session-send']"); await ui.el("[data-testid='new-session-error']"); } },

  // ── Settings ──────────────────────────────────────────────────────────────
  { id: "settings", group: "Settings", title: "Settings (browser)", run: openSettings },
  { id: "settings-bottom", group: "Settings", title: "Settings scrolled to the end",
    run: async (ui) => { await openSettings(ui); await ui.revealText("Clear cached conversations"); } },
  { id: "settings-push-denied", group: "Settings", title: "Push blocked by the browser", setup: { notificationPermission: "denied" },
    run: async (ui) => { await openSettingsRow(ui, "Notifications", "notifications"); await ui.text("Allow notifications for this site"); } },
  { id: "settings-appearance", group: "Settings", title: "Appearance",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-appearance']"); await ui.el("[data-settings-page='appearance'] [data-testid='appearance-preview']"); } },
  { id: "settings-appearance-colour", group: "Settings", title: "Appearance: Coloured markdown on",
    setup: { storage: { "omp-appearance": JSON.stringify({ colourMarkdown: true }) } },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-appearance']"); await ui.el("[data-testid='appearance-colour-markdown']"); } },
  { id: "chat-markdown-coloured", group: "Conversation", title: "Coloured markdown: heading, bold, inline code, table",
    setup: (env) => ({ hash: env.chatHash(MAIN), storage: { "omp-appearance": JSON.stringify({ colourMarkdown: true }) } }),
    run: async (ui) => { await ui.chat(); await ui.scroll(".chat-scroll", 0); await ui.text("What I found"); await ui.revealText("What I found"); } },
  { id: "settings-appearance-larger", group: "Settings", title: "Appearance: Larger, compact",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-appearance']"); await ui.clickText("Text", { within: "[data-testid='appearance-tabs']", exact: true }); await ui.clickText("Larger", { within: "[data-testid='appearance-text-size']", exact: true }); await ui.clickText("Compact", { within: "[data-testid='appearance-density']", exact: true }); await ui.text("Reset everything to defaults"); } },
  { id: "settings-computer", group: "Settings", title: "Computer",
    setup: { stubs: [{ method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/devices", body: DEVICES }] },
    run: openComputer },
  { id: "settings-about", group: "Settings", title: "About",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-about']"); await ui.text("App build"); } },
  { id: "settings-update", group: "Settings", title: "Update available", embeddedOnly: true,
    setup: { stubs: [{ method: "GET", path: "/api/version", body: { ok: true, version: "capture-newer", releaseId: "capture-newer", ...PROTOCOL } }] },
    run: async (ui) => {
      await openSettings(ui); await ui.click("[data-testid='settings-about']"); await ui.text("App build");
      const developmentBuild = await ui.page.$eval("[data-settings-page='about']", (el) => /App build\s*dev/.test(el.textContent));
      if (developmentBuild) throw new Error("Embedded app build is dev; Settings deliberately suppresses Update available for development builds");
      await ui.text("Update available"); await ui.text("Reloads the app with the version your computer is running.");
    } },
  { id: "settings-diagnostics", group: "Settings", title: "Diagnostics",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-diagnostics']"); await ui.el("[data-testid='connection-health']"); } },
  { id: "settings-diagnostics-technical", group: "Settings", title: "Diagnostics: technical details",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-diagnostics']"); await ui.click("[data-testid='diagnostics-technical']"); await ui.el("[data-testid='diagnostics-details']"); } },
  { id: "settings-diagnostics-loading", group: "Settings", title: "Diagnostics loading",
    setup: { stubs: [{ method: "GET", path: "/api/health", hang: true }] },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-diagnostics']"); await ui.text("Checking"); await ui.revealText("Checking"); } },
  { id: "settings-diagnostics-error", group: "Settings", title: "Diagnostics failed",
    setup: { stubs: [{ method: "GET", path: "/api/health", status: 503, body: { ok: false, error: "health probe timed out" } }] },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-diagnostics']"); await ui.el("[data-testid='connection-health'] [role='alert'], [role='alert']"); } },
  { id: "settings-diagnostics-credentials", group: "Settings", title: "Diagnostics: credential override",
    setup: { stubs: [{ method: "GET", path: "/api/health", body: { ok: true, observedAt: now, releaseId: "build", protocolVersion: 1, minClientProtocolVersion: 1, credentials: { environmentKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], brokerEnvironmentConfigured: true, effectiveSource: "environment" }, session: null } }] },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-diagnostics']"); await ui.click("[data-testid='diagnostics-technical']"); await ui.revealText("ANTHROPIC_API_KEY"); } },
  { id: "settings-clear-cache", group: "Settings", title: "Confirm: clear cached conversations",
    run: async (ui) => { await openSettings(ui); await ui.clickText("Clear cached conversations"); await ui.text("Clear cached conversations?"); } },
  { id: "settings-forget", group: "Settings", title: "Confirm: forget pairing",
    run: async (ui) => { await openSettings(ui); await ui.clickText("Unpair this phone"); await ui.text("Unpair this phone?"); } },
  // Android phone mode: the controls are grouped under "Run on this phone", with no PC pairing and an obvious Stop.
  { id: "settings-phone", group: "Settings", title: "Settings (Android, running on this phone)", setup: { ompLocal: PHONE() },
    run: async (ui) => { await openSettings(ui); await ui.el("[data-testid='settings-stop-phone']"); } },
  { id: "settings-phone-stop", group: "Settings", title: "Confirm: stop phone mode", setup: { ompLocal: PHONE() },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-stop-phone']"); await ui.text("Stop phone mode?"); } },
  { id: "settings-phone-device-access", group: "Settings", title: "Device access (Android, running on this phone)", setup: { ompLocal: PHONE(),
    stubs: [{ method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/devices", body: DEVICES }] },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-device-access']"); await ui.el("[data-settings-page='computer']"); } },
  // The chooser after Stop phone mode: the runtime is installed, so it offers to resume instead of setting up again.
  { id: "onboarding-phone-stopped", group: "Settings", title: "Welcome after stopping phone mode",
    setup: { ompLocal: PHONE({ mode: "unset", installed: true }) },
    run: async (ui) => { await ui.text("Phone mode is off"); await ui.el("[data-testid='onboarding-phone']"); } },
  { id: "onboarding-phone-saved-computers", group: "Settings", title: "Phone mode off: continue on a saved computer",
    setup: { ompLocal: PHONE({ mode: "unset", computers: ["https://studio.example-tailnet.ts.net/app/", "https://desk.example-tailnet.ts.net/app/"], computerStatus: { "https://studio.example-tailnet.ts.net/app/": "online", "https://desk.example-tailnet.ts.net/app/": "offline" } }) },
    run: async (ui) => { await ui.el("[data-testid='onboarding-computer-list']"); await ui.text("Online"); await ui.text("Offline"); } },
  { id: "onboarding-phone-computers-checking", group: "Settings", title: "Phone mode off: checking saved computers",
    setup: { ompLocal: PHONE({ mode: "unset", computers: ["https://studio.example-tailnet.ts.net/app/", "https://desk.example-tailnet.ts.net/app/"], computerStatus: { "https://studio.example-tailnet.ts.net/app/": "checking", "https://desk.example-tailnet.ts.net/app/": "checking" } }) },
    run: async (ui) => { await ui.el("[data-testid='onboarding-computer-list']"); await ui.text("Checking"); } },
  // Android run mode: a phone running omp itself, no computer connected yet.
  { id: "settings-run-on-connect", group: "Settings", title: "Run on › Computer: connect by scanning",
    setup: { ompLocal: { mode: "phone", phase: "ready", supported: true, laptopUrl: null, downloadBytes: 0, progress: -1, message: "", error: null, ompVersion: "capture" } },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-run-on']"); await ui.clickText("Computer", { within: "[data-testid='run-on']", exact: true }); await ui.el("[data-testid='connect-computer']"); } },
  { id: "sessions-run-on-switcher", group: "Settings", title: "Drawer: switch between phone and computers",
    setup: { ompLocal: { mode: "laptop", phase: "ready", supported: true, installed: true, laptopUrl: "https://studio.example-tailnet.ts.net/app/", computers: ["https://studio.example-tailnet.ts.net/app/", "https://desk.example-tailnet.ts.net/app/"], downloadBytes: 0, progress: -1, message: "", error: null, ompVersion: "capture" } },
    run: async (ui) => { await openDrawer(ui); await ui.click("[data-testid='switcher-computer']"); await ui.el("[data-testid='run-on-switcher-sheet'] [data-testid='run-on-switcher-option']"); } },

  // ── Device access (Settings › Computer) ───────────────────────────────────
  { id: "devices-loading", group: "Device access", title: "Paired devices loading",
    setup: { stubs: [{ method: "GET", path: "/api/device", hang: true }] },
    run: async (ui) => { await openComputer(ui); await ui.el("[data-testid='device-access'] [aria-busy='true']"); } },
  { id: "devices-error", group: "Device access", title: "Paired devices failed",
    setup: { stubs: [{ method: "GET", path: "/api/device", status: 500, body: { ok: false, error: "device registry unavailable" } }] },
    run: async (ui) => { await openComputer(ui); await ui.el("[data-testid='device-access-error']"); } },
  { id: "devices-admin", group: "Device access", title: "Admin: all devices",
    setup: { stubs: [{ method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/devices", body: DEVICES }] },
    run: async (ui) => { await openComputer(ui); const el = await ui.el("[data-testid='paired-device'][data-device-id='phone-3']"); await el.scrollIntoView(); } },
  { id: "devices-read-only", group: "Device access", title: "Read-only device",
    setup: { stubs: [{ method: "GET", path: "/api/device", body: { device: { id: "phone-2", name: "Work iPad", role: "read", lastSeenAt: now } } }] },
    run: async (ui) => { await openComputer(ui); const el = await ui.el("[data-testid='device-access']"); await el.scrollIntoView(); } },
  { id: "devices-pair-dialog", group: "Device access", title: "Pair another device",
    setup: { stubs: [{ method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/devices", body: DEVICES }] },
    run: async (ui) => { await openComputer(ui); await ui.click("[data-testid='pair-another-device']"); await ui.el("#new-device-name"); } },
  { id: "devices-pairing-code", group: "Device access", title: "Pairing code issued (QR)",
    setup: { stubs: [
      { method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/devices", body: DEVICES },
      { method: "POST", path: "/api/devices/pairing-codes", body: { ok: true, code: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", expiresAt: now + 5 * 60_000 } },
    ] },
    run: async (ui) => { await openComputer(ui); await ui.click("[data-testid='pair-another-device']"); await ui.type("#new-device-name", "Tablet"); await ui.clickText("Create pairing code", { exact: true }); await ui.el("[data-testid='pairing-qr']"); } },
  { id: "devices-pairing-code-typed", group: "Device access", title: "Pairing code: typed fallback expanded",
    setup: { stubs: [
      { method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/devices", body: DEVICES },
      { method: "POST", path: "/api/devices/pairing-codes", body: { ok: true, code: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", expiresAt: now + 5 * 60_000 } },
    ] },
    run: async (ui) => { await openComputer(ui); await ui.click("[data-testid='pair-another-device']"); await ui.clickText("Create pairing code", { exact: true }); await ui.clickText("Enter code instead"); await ui.el("[data-testid='pairing-code']"); } },
  { id: "devices-revoke", group: "Device access", title: "Confirm: remove device",
    setup: { stubs: [{ method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/devices", body: DEVICES }] },
    run: async (ui) => { await openComputer(ui); await ui.click("[data-testid='paired-device'][data-device-id='phone-2']"); await ui.text("Remove Work iPad?"); } },

  // ── Conversation ──────────────────────────────────────────────────────────
  { id: "chat-lazy-splash", group: "Conversation", title: "Chat chunk loading",
    setup: (env) => ({ hash: env.chatHash(MAIN), hold: [/ChatScreen/] }),
    run: (ui) => ui.el("main[aria-label='Loading conversation']") },
  { id: "chat-opening", group: "Conversation", title: "Opening a session",
    setup: (env) => ({ hash: env.chatHash(MAIN), ws: { chat: "hang" }, stubs: [{ method: "GET", path: "/api/history", hang: true }] }),
    run: (ui) => ui.text("Opening") },
  { id: "chat", group: "Conversation", title: "Transcript (latest)", setup: (env) => ({ hash: env.chatHash(MAIN) }), run: (ui) => ui.chat() },
  { id: "chat-top", group: "Conversation", title: "Transcript scrolled to the top", note: "reaching the top pages the previous turns in and re-anchors",
    setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await ui.scroll(".chat-scroll", 0); } },
  { id: "chat-load-earlier-loading", group: "Conversation", title: "Loading earlier turns",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [{ method: "GET", path: "/api/history", query: "before=", hang: true }] }),
    // Reaching the top arms the next page by itself; the stub holds it in flight.
    run: async (ui) => { await ui.chat(); await ui.scroll(".chat-scroll", 0); await ui.text("Loading earlier messages"); } },
  { id: "chat-empty", group: "Conversation", title: "Empty conversation", setup: (env) => ({ hash: env.chatHash("Capture: empty conversation") }),
    run: async (ui) => { await ui.el("[data-testid='chat-empty']"); await ui.text("What should we work on?"); } },
  { id: "chat-short", group: "Conversation", title: "Short exchange", setup: (env) => ({ hash: env.chatHash("tsconfig") }), run: (ui) => ui.chat() },
  { id: "chat-header-long-title", group: "Conversation", title: "Header: long title", note: "one 56px row: the title truncates over its project; the full name is in the ⋯ sheet",
    setup: (env) => ({ hash: env.chatHash("p99 latency") }),
    run: async (ui) => { await ui.chat(); await ui.el("[data-testid='session-actions'][title*='p99']"); } },
  { id: "chat-thinking-expanded", group: "Conversation", title: "Reasoning expanded",
    setup: (env) => ({ hash: env.chatHash("p99 latency") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='turn-work-title']"); await ui.text("excludes queueing"); } },
  { id: "chat-tool-error", group: "Conversation", title: "Failed tool call", setup: (env) => ({ hash: env.chatHash("CI is red") }),
    run: async (ui) => { await ui.chat(); await ui.text("· failed"); } },
  { id: "chat-tool-error-expanded", group: "Conversation", title: "Failed tool call expanded", setup: (env) => ({ hash: env.chatHash("CI is red") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='turn-work-title']"); await ui.click("[data-testid='rail-chip'][data-state='error']"); await ui.el("[data-testid='tool-sheet']"); } },
  { id: "chat-parts", group: "Conversation", title: "Error turn and unfinished tool", note: "provider error message and an unresolved historical bash call",
    setup: (env) => ({ hash: env.chatHash(PARTS) }), run: async (ui) => { await ui.chat(); await ui.revealText("Half an answer"); await ui.el("[data-testid='turn-footer'][data-state='error']"); } },
  { id: "chat-markers", group: "Conversation", title: "Markers and day separator",
    setup: (env) => ({ hash: env.chatHash(PARTS) }),
    run: async (ui) => { await ui.chat(); await ui.scroll(".chat-scroll", 0); await ui.text("compacted"); } },
  { id: "chat-diff-expanded", group: "Conversation", title: "Diff expanded",
    setup: (env) => ({ hash: env.chatHash(PARTS) }),
    run: async (ui) => {
      await ui.chat();
      await ui.page.$$eval("[data-testid='turn-work-title'][aria-expanded='false']", (buttons) => buttons.forEach((button) => button.click()));
      await ui.click("[data-testid='rail-act'][data-category='edit'] [data-testid='rail-chip']");
      await ui.el("[data-testid='tool-sheet']"); await ui.click("[data-testid='show-all']");
      await ui.page.waitForFunction(() => document.querySelectorAll("[data-testid='tool-sheet'] [data-testid='diff-line']").length > 200);
    } },
  { id: "chat-long-reply", group: "Conversation", title: "Very long reply (collapsed)", setup: (env) => ({ hash: env.chatHash("Capture: very long reply") }),
    run: async (ui) => { await ui.chat(); await ui.text("Read more"); } },
  { id: "chat-image-viewer", group: "Conversation", title: "Image viewer",
    setup: (env) => ({ hash: env.chatHash("Capture: image reply") }),
    run: async (ui) => { await ui.chat(); await ui.click("button[aria-label^='Open image']"); await ui.el("[data-testid='image-viewer-stage']"); } },
  { id: "chat-image", group: "Conversation", title: "Images: placeholder and inline", note: "base64 source blocks are not shipped to the phone; top-level data is",
    setup: (env) => ({ hash: env.chatHash("Capture: image reply") }),
    run: async (ui) => { await ui.el("button[aria-label^='Open image'] img"); await ui.text("Image not on this device"); } },
  { id: "chat-user-actions", group: "Conversation", title: "User message actions",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='chat-message'].is-user"); await ui.text("Edit"); } },
  { id: "chat-edit-message", group: "Conversation", title: "Edit the newest message (composer chip)",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='chat-message'].is-user"); await ui.clickText("Edit", { exact: true }); await ui.el("[data-testid='edit-chip']"); } },
  { id: "chat-assistant-actions", group: "Conversation", title: "Assistant message actions (long press)",
    // Assistant prose is all selectable text, so long-press has no blank point
    // to land on once tool cards collapse into runs: the visible More actions
    // button on the newest reply is the way in.
    setup: (env) => ({ hash: env.chatHash(PARTS) }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='message-more']"); await ui.text("Copy as markdown"); } },
  { id: "chat-jump-latest", group: "Conversation", title: "Jump to latest (scrolled up)",
    setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await ui.scroll(".chat-scroll", "middle"); await ui.el("[data-testid='jump-nav'][aria-hidden='false']"); } },

  // ── Connection ────────────────────────────────────────────────────────────
  { id: "chat-connecting", group: "Connection", title: "Connecting", note: "the header stays quiet: no indicator until the socket actually fails",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), ws: { chat: "hang" } }),
    run: async (ui) => { await ui.chat(); await ui.el("[data-testid='session-actions']"); } },
  { id: "chat-reconnecting", group: "Connection", title: "Reconnecting",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), ws: { chat: "fail" } }),
    run: async (ui) => { await ui.chat(); await ui.el("[data-testid='chat-offline-hint']"); await ui.text("Connecting"); } },
  { id: "chat-offline", group: "Connection", title: "Offline pill", note: "the ONE offline indicator, under the header",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.page.setOfflineMode(true); await ui.el("[data-testid='chat-offline-hint']"); await ui.text("You’re offline"); } },
  { id: "chat-offline-queued", group: "Connection", title: "Offline: message not sent yet",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.page.setOfflineMode(true); await ui.el("[data-testid='chat-offline-hint']");
      await ui.type("[data-testid='composer-input']", "Queue this until I am back online");
      await ui.click("[data-testid='composer-send-btn']");
      // The outbox preserves the bubble and names the connection it is waiting for.
      await ui.text("Waiting for connection", 15_000);
    } },
  { id: "chat-link-unreachable", group: "Connection", title: "Can’t reach your computer",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), ws: { chat: "hang", sessions: "hang" }, stubs: [{ method: "GET", path: "/api/version", fail: true }] }),
    run: async (ui) => { await ui.chat(); await ui.probeLink(); await ui.el("[data-testid='chat-offline-hint'][data-link='unreachable']"); await ui.text("Can’t reach"); } },
  { id: "chat-link-back-online", group: "Connection", title: "Back online after an outage",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.page.setOfflineMode(true); await ui.el("[data-testid='chat-offline-hint'][data-link='offline']");
      await ui.page.waitForFunction(() => {
        const root = document.documentElement;
        if (document.querySelector("[data-testid='chat-offline-hint']")?.getAttribute("data-link") !== "offline") {
          delete root.dataset.captureOutageAt; return false;
        }
        root.dataset.captureOutageAt ??= String(Date.now());
        return Date.now() - Number(root.dataset.captureOutageAt) >= 3100;
      }, { timeout: 10_000 });
      await ui.page.setOfflineMode(false);
      await ui.probeLink();
      await ui.text("Back online");
    } },
  { id: "chat-send-waiting", group: "Connection", title: "Message waiting for connection",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.page.setOfflineMode(true); await ui.el("[data-testid='chat-offline-hint'][data-link='offline']");
      await ui.type("[data-testid='composer-input']", "Send the retry notes when the connection returns.");
      await ui.click("[data-testid='composer-send-btn']");
      await ui.el("[data-testid='send-status']");
      await ui.text("Waiting for connection", 15_000);
    } },
  { id: "chat-context-warning", group: "Connection", title: "Context nearly full",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/rpc", rpc: "get_state", body: { ok: true, data: { model: { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" }, contextUsage: { percent: 91, tokens: 182_000, contextWindow: 200_000 } } } }] }),
    run: async (ui) => { await ui.chat(); await ui.page.waitForFunction(() => document.querySelector("[data-testid='composer-context']")?.textContent?.includes("91%")); } },
  { id: "chat-compact-offer", group: "Connection", title: "Compaction offered", note: "past 40% on an idle turn the row above the composer offers to compact",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/rpc", rpc: "get_state", body: { ok: true, data: { model: { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" }, contextUsage: { percent: 52, tokens: 104_000, contextWindow: 200_000 } } } }] }),
    run: async (ui) => { await ui.chat(); await ui.el("[data-testid='compact-pill'][data-state='offer']"); } },
  { id: "chat-compacting", group: "Connection", title: "Compacting", note: "omp answers the compact request only when it is done; the pill holds the running state for the whole wait",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [
      { method: "POST", path: "/api/rpc", rpc: "compact", hang: true },
      { method: "POST", path: "/api/rpc", rpc: "get_state", body: { ok: true, data: { model: { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" }, contextUsage: { percent: 52, tokens: 104_000, contextWindow: 200_000 } } } },
    ] }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='compact-pill-run']"); await ui.el("[data-testid='compact-pill'][data-state='compacting']"); } },
  { id: "chat-error-banner", group: "Connection", title: "Error banner",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.socket("chat"); await ui.frames("chat", [{ type: "error", message: "The session file moved on disk; showing the last copy." }]); await ui.el("[data-testid='chat-error'] [aria-label='Dismiss']"); } },
  { id: "chat-child-died", group: "Connection", title: "Agent stopped unexpectedly", note: "a dead child: the danger notice offers Retry, and no footer claims the turn is running",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.socket("chat"); await ui.frames("chat", [{ type: "error", message: "agent process exited (code 137)" }]); await ui.el("[data-testid='chat-error']"); await ui.text("The agent stopped unexpectedly."); } },
  // ── Live turn (synthetic frames, no model) ────────────────────────────────
  { id: "live-thinking", group: "Live turn", title: "Agent working, thinking",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.socket("chat"); await ui.frames("chat", streamingFrames([{ type: "thinking", thinking: "The emitted import specifiers depend on the bundler, not on tsc's resolver…" }])); await ui.el("[data-testid='composer-stop-btn']"); } },
  { id: "live-streaming", group: "Live turn", title: "Streaming reply",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.socket("chat");
      await ui.frames("chat", [...streamingFrames([{ type: "text", text: "Right: `paths` never rewrites output. If you want the emitted JS to resolve, you have three options:\n\n1. Let the bundler resolve it" }]), { type: "md", id: "cap-r1", a: "\n2. Run `tsc-alias` after `tsc`\n3. Use Node subpath imports", g: 1 }]);
      // The daemon's own activity frame on the conversation socket: the live
      // turn footer follows it and runs its clock from turnStartedAt.
      await ui.frames("chat", [{ type: "activity", path: ui.env.path("tsconfig"), now: { state: "writing", since: now - 3_000, turnStartedAt: now - 42_000, tools: 0 } }]);
      await ui.text("subpath imports");
      await ui.el("[data-testid='composer-stop-btn']"); await ui.el("[data-testid='turn-footer'][data-state='running']");
    } },
  { id: "chat-laptop-ask", group: "Live turn", title: "Laptop question (desktop ask)",
    note: "the desktop omp is blocked on `ask`: no daemon/collab dialog exists, so the answer sheet must open by itself",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [
      { method: "GET", path: "/api/awaiting", body: { ok: true, sessions: [env.path(MAIN)] } },
      env.listingStub((r) => r.title?.includes(MAIN) ? { status: "waiting", live: true, bridge: true, pendingAsk: { id: "toolu_capture", index: 0, total: 2, question: "Where should the new herdr binary go?", options: ["~/.local/bin/herdr", "Wait for the next release"], recommended: 0 } } : null),
    ] }),
    run: async (ui) => { await ui.chat(); await ui.el("[data-testid='answer-sheet']"); await ui.text("Recommended"); await ui.text("Question 1 of 2"); } },
  { id: "live-tool-running", group: "Live turn", title: "Tool running with live output",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.socket("chat");
      await ui.frames("chat", [
        ...streamingFrames([{ type: "text", text: "Running the build to confirm." }]),
        ev({ type: "tool_execution_start", toolCallId: "cap-live-1", toolName: "bash", intent: "Building with tsc", args: { command: "npx tsc -p . && node dist/index.js" } }),
        ev({ type: "tool_execution_update", toolCallId: "cap-live-1", toolName: "bash", partialResult: "src/index.ts → dist/index.js\nsrc/util/paths.ts → dist/util/paths.js\nError [ERR_MODULE_NOT_FOUND]: Cannot find package '@app/util'" }),
      ]);
      await ui.click("[data-testid='rail-chip'][data-state='running']"); await ui.text("ERR_MODULE_NOT_FOUND");
    } },
  { id: "live-partial", group: "Live turn", title: "Desktop partial line",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.socket("chat");
      await ui.frames("chat", [ev({ type: "agent_start" }), { type: "partial", offset: 999_999, text: '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Checking the tsconfig on the desktop side' }]);
      await ui.el("[data-testid='partial-line']");
    } },
  // The question is the shared BottomSheet: it opens on arrival, and closing
  // it leaves a "Question" chip in the track strip to reopen it.
  { id: "live-collab-choice", group: "Live turn", title: "Desktop question: choice",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.socket("chat"); await ui.frames("chat", [ASK({ kind: "choice", options: ["3 attempts", "5 attempts (Recommended)", "No retries"].map((label) => ({ label, value: label })) })]); await ui.el("[data-testid='collab-dialog'] [data-testid='collab-option'] [data-testid='collab-recommended']"); } },
  { id: "live-collab-text", group: "Live turn", title: "Desktop question: free text",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.socket("chat"); await ui.frames("chat", [ASK({ kind: "text", placeholder: "e.g. 3" })]); await ui.el("[data-testid='collab-dialog'] #collab-text-input"); } },
  { id: "live-collab-banner", group: "Live turn", title: "Desktop question: closed, waiting in the strip",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.socket("chat");
      await ui.frames("chat", [ASK({ kind: "choice", options: ["3 attempts", "5 attempts (Recommended)", "No retries"].map((label) => ({ label, value: label })) })]);
      await ui.click("[data-testid='collab-dialog'] [data-testid='sheet-close']");
      await ui.el("[data-testid='track-strip'] [data-testid='collab-banner']");
      await ui.text("Question");
    } },
  { id: "chat-track-strip", group: "Live turn", title: "Tab badges and the question chip", note: "question chip, tasks 2 left, two running agents, 2 changed files",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "GET", path: "/api/changes", body: { ok: true, cwd: "/tmp/omp-ux-cwd", repoRoot: "/tmp/omp-ux-cwd", branch: "main", notRepo: false, truncated: false, totals: { files: 2, additions: 120, deletions: 34 }, files: [
      { path: "src/webhook/client.ts", status: "modified", additions: 96, deletions: 30, binary: false, patch: "", patchTruncated: false },
      { path: "src/webhook/retry.ts", status: "added", additions: 24, deletions: 4, binary: false, patch: "", patchTruncated: false },
    ] } }] }),
    run: async (ui) => {
      await ui.chat(); await ui.socket("chat");
      const ts = new Date(now).toISOString();
      await ui.frames("chat", [{ type: "entries", entries: [
        { type: "message", id: "cap-track-1", timestamp: ts, message: { role: "assistant", content: [
          { type: "toolCall", id: "cap-todo", name: "todo", arguments: {} },
          { type: "toolCall", id: "cap-task", name: "task", intent: "Auditing retry callers", arguments: { tasks: [{ name: "CallerAudit", agent: "scout", task: "Find every retry caller" }, { name: "BudgetCheck", agent: "scout", task: "Check the retry budget" }] } },
        ] } },
        { type: "message", id: "cap-track-2", timestamp: ts, message: { role: "toolResult", toolCallId: "cap-todo", toolName: "todo", isError: false, content: [{ type: "text", text: "Updated" }], details: { phases: [{ name: "Fix retries", tasks: [
          { content: "Reproduce the double retry", status: "completed" },
          { content: "Cap the retry budget", status: "in_progress" },
          { content: "Add a regression test", status: "pending" },
        ] }] } } },
        // omp's task returns at spawn time; both agents are still pending.
        { type: "message", id: "cap-track-3", timestamp: ts, message: { role: "toolResult", toolCallId: "cap-task", toolName: "task", isError: false, content: [{ type: "text", text: "Spawned 2 background agents using task." }], details: { results: [], progress: [
          { index: 0, id: "CallerAudit", agent: "scout", status: "pending" },
          { index: 1, id: "BudgetCheck", agent: "scout", status: "pending" },
        ] } } },
      ] }]);
      await ui.frames("chat", [ASK({ kind: "choice", options: ["3 attempts", "5 attempts (Recommended)", "No retries"].map((label) => ({ label, value: label })) })]);
      await ui.click("[data-testid='collab-dialog'] [data-testid='sheet-close']");
      await ui.el("[data-testid='track-strip'] [data-testid='collab-banner']");
      await ui.click("[data-testid='open-workspace']");
      await ui.el("[data-testid='tab-badge-tasks']");
      await ui.el("[data-testid='tab-badge-agents'][data-tone='running']");
      await ui.el("[data-testid='tab-badge-changes']");
    } },
  { id: "live-new-below", group: "Live turn", title: "New messages below (scrolled up)",
    setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => {
      // Middle, not top: reaching the top pages history in, and a prepend
      // changes the first row, which ThumbNav rightly does not count as news.
      await ui.chat(); await ui.socket("chat"); await ui.settle(); await ui.scroll(".chat-scroll", "middle"); await ui.el("[data-testid='jump-nav'][aria-hidden='false']");
      await ui.frames("chat", [{ type: "entries", entries: [{ type: "message", id: "cap-new-1", timestamp: new Date(now).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Webhook client patched as well." }] } }] }]);
      await ui.el("[data-testid='jump-nav'] [data-testid='latest-messages-count']"); await ui.text("1 new");
    } },

  // ── Composer ──────────────────────────────────────────────────────────────
  { id: "composer-focused", group: "Composer", title: "Composer focused", setup: (env) => ({ hash: env.chatHash("tsconfig") }), run: focusComposer },
  { id: "composer-filled", group: "Composer", title: "Composer with a draft",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await focusComposer(ui); await ui.page.keyboard.type("Can you add tsc-alias to the build and show me the diff?"); } },
  { id: "composer-attachment", group: "Composer", title: "Image attached",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat();
      const input = await ui.page.$("input[type='file'][multiple]");
      await input.uploadFile(await tmpPng());
      await ui.el("[aria-label^='Remove']");
    } },
  { id: "composer-plus-menu", group: "Composer", title: "Plus sheet", note: "attachments, history, skills, commands, model and context", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='composer-plus-btn']"); await ui.el("[data-testid='composer-plus-sheet'] [data-testid='composer-commands']"); await ui.text("Commands"); } },
  { id: "composer-slash", group: "Composer", title: "Slash palette", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await focusComposer(ui); await ui.page.keyboard.type("/"); await ui.el("[data-testid='slash-palette']"); } },
  { id: "composer-slash-filtered", group: "Composer", title: "Slash palette filtered", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await focusComposer(ui); await ui.page.keyboard.type("/mo"); await ui.el("[data-testid='slash-palette']"); } },
  { id: "composer-slash-unknown", group: "Composer", title: "Unknown command", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await focusComposer(ui); await ui.page.keyboard.type("/no-such-command"); await ui.el("[data-testid='uncatalogued-command']"); } },
  { id: "composer-commands-sheet", group: "Composer", title: "Command palette sheet", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='composer-plus-btn']"); await ui.click("[data-testid='composer-plus-sheet'] [data-testid='composer-commands']"); await ui.el("[data-testid='command-palette']"); } },
  { id: "composer-sending", group: "Composer", title: "Sent, awaiting receipt", note: "optimistic echo with its delivery state",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/prompt", hang: true }, { method: "GET", path: "/api/receipts*", hang: true }] }),
    run: async (ui) => { await focusComposer(ui); await ui.page.keyboard.type("Ship it."); await ui.click("[data-testid='composer-send-btn']"); await ui.text("Ship it."); } },
  { id: "composer-voice-recording", group: "Composer", title: "Dictation recording", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    // The meter follows the live (fake) microphone level: random by nature.
    mask: ["[data-testid='dictation-status'] > span[aria-hidden]"],
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='voice-button']"); await ui.el("[data-testid='dictation-bar'] [role='timer']"); } },
  { id: "composer-voice-transcribing", group: "Composer", title: "Dictation transcribing",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/transcribe", hang: true }] }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='voice-button']"); await ui.el("[role='timer']"); await ui.sleep(600); await ui.click("[data-testid='dictation-insert']"); await ui.text("Transcribing"); } },
  { id: "composer-multiline", group: "Composer", title: "Typing several lines", note: "two tiers at all times: the toolbar never moves",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await focusComposer(ui); await ui.page.keyboard.type("First line of a longer message that wraps past the width of the card"); await ui.page.keyboard.down("Shift"); await ui.page.keyboard.press("Enter"); await ui.page.keyboard.up("Shift"); await ui.page.keyboard.type("Second line"); } },

  { id: "composer-stop-with-draft", group: "Composer", title: "Draft with Send and compact Stop",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat(); await ui.socket("chat");
      await ui.frames("chat", streamingFrames([{ type: "text", text: "Checking the retry policy now." }]));
      await ui.type("[data-testid='composer-input']", "Also check the webhook client.");
      await ui.el("[data-testid='composer-stop-btn']"); await ui.el("[data-testid='composer-send-btn']:not(:disabled)");
    } },
  // ── Model picker ──────────────────────────────────────────────────────────
  { id: "model-picker", group: "Model picker", title: "Model picker", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-model"); await ui.el("[data-testid='model-item']"); } },
  { id: "model-picker-search-empty", group: "Model picker", title: "Model search: no match", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-model"); await ui.type("[data-testid='model-search']", "zzqx"); } },
  { id: "model-picker-thinking", group: "Model picker", title: "Model and thinking", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-model"); await ui.el("[data-testid='model-thinking']"); } },

  // ── Commands ──────────────────────────────────────────────────────────────
  { id: "command-usage", group: "Commands", title: "/usage result", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await runSlash(ui, "usage"); await ui.el("[data-testid='command-result-sheet']"); await ui.el("[data-testid='usage-summary'], [data-testid='usage-details']"); } },
  { id: "command-context", group: "Commands", title: "/context result",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/command", body: { ok: true, output: "Context usage\nSystem prompt: 12,000 tokens\nTools: 6,000 tokens\nMessages: 50,000 tokens\nFree: 132,000 tokens", agentInvoked: false } }] }),
    run: async (ui) => { await runSlash(ui, "context"); await ui.el("[data-testid='command-result-sheet']"); await ui.text("132,000"); } },
  { id: "command-rename-input", group: "Commands", title: "/rename argument sheet", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await runSlash(ui, "rename"); await ui.el("[data-testid='command-input-sheet']"); } },
  { id: "command-compact-refused", group: "Commands", title: "/compact refused",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/rpc", rpc: "compact", body: { ok: false, error: "Nothing to compact (session too small)" } }] }),
    // The shared compaction pill owns refusals, including slash-command requests.
    run: async (ui) => { await runSlash(ui, "compact"); await ui.el("[data-testid='compact-pill']"); await ui.text("Nothing to compact"); } },

  // ── Session sheets ────────────────────────────────────────────────────────
  { id: "session-menu", group: "Session sheets", title: "Session actions (⋯) sheet", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='session-actions']"); await ui.el("[data-testid='session-actions-sheet'] [data-testid='session-reload']"); } },
  { id: "files-sheet", group: "Session sheets", title: "Files tab: listing", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "files"); await ui.el("[data-testid='files-tab']"); await ui.text("README.md"); } },
  { id: "file-viewer", group: "Session sheets", title: "File viewer", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "files"); await ui.clickText("README.md", { within: "[data-testid='files-tab']", exact: true }); await ui.el("[data-testid='file-edit']"); } },
  { id: "file-editor", group: "Session sheets", title: "File editor", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "files"); await ui.clickText("README.md", { within: "[data-testid='files-tab']", exact: true }); await ui.click("[data-testid='file-edit']"); await ui.el("[data-testid='file-editor']"); } },
  { id: "agents-sheet", group: "Session sheets", title: "Agents tab", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "agents"); await ui.el("[data-testid='agents-tab']"); } },
  { id: "timeline-sheet", group: "Session sheets", title: "Tasks tab: timeline", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "tasks"); await ui.el("[data-testid='tasks-tab'] [data-timeline-row-id]"); await ui.text("Follow-up"); } },
  { id: "session-switcher", group: "Panels", title: "Session switcher", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='session-back']"); await ui.el("[data-testid='session-switcher'] [data-testid='session-row']"); } },
  { id: "global-palette", group: "Panels", title: "Global palette: panels", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => {
      await ui.chat(); await ui.click("[data-testid='composer-plus-btn']"); await ui.click("[data-testid='composer-commands']");
      await ui.click("[data-testid='command-palette'] input");
      await ui.page.keyboard.down("Control"); await ui.page.keyboard.press("KeyA"); await ui.page.keyboard.up("Control"); await ui.page.keyboard.press("Backspace");
      await ui.el("[data-testid='palette-panels']");
    } },
  ...["changes", "files", "agents", "tasks", "terminal"].map((tab) => ({
    id: `workspace-${tab}`, group: "Panels", title: `Workspace: ${tab}`, setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, tab); await ui.el(`[data-testid='workspace-tab-${tab}']`); },
  })),
  { id: "terminal-sheet", group: "Session sheets", title: "Terminal tab", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "terminal"); await ui.el("[data-testid='terminal-tab'] [data-testid='bash-run']"); } },
  { id: "terminal-result", group: "Session sheets", title: "Terminal result",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [{ method: "POST", path: "/api/bash", body: { ok: true, result: { output: "README.md\npackage.json\nsrc\n", exitCode: 0, cancelled: false, truncated: false } } }] }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "terminal"); await ui.type("[data-testid='terminal-tab'] input, [data-testid='terminal-tab'] textarea", "ls"); await ui.click("[data-testid='bash-run']"); await ui.el("[data-testid='bash-output']"); await ui.text("package.json"); } },
  { id: "session-settings-sheet", group: "Session sheets", title: "Session settings", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.el("[data-testid='session-settings-sheet']"); } },

  // ── Settings pages (the sub-pages the UI inventory found without a state) ─
  // Notifications is a pushed page in both the browser and the Android shell.
  { id: "settings-notifications-help", group: "Settings pages", title: "Notifications: blocked, recovery guidance",
    setup: { notificationPermission: "denied" },
    run: async (ui) => { await openSettingsRow(ui, "Notifications", "notifications"); await ui.text("Allow notifications for this site"); } },
  { id: "settings-notifications-native", group: "Settings pages", title: "Notifications in the Android app",
    setup: { native: { status: {}, permission: { display: "granted" } } },
    run: async (ui) => { await openSettingsRow(ui, "Notifications", "notifications"); await ui.text("Quiet hours"); } },
  { id: "settings-providers", group: "Settings pages", title: "Model providers (computer)", note: "administrator device can add providers",
    setup: { stubs: [{ method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/providers", body: { providers: PROVIDERS } }, { method: "GET", path: "/api/providers/login", body: { running: false, exitCode: null, output: "" } }] },
    run: async (ui) => { await openSettingsRow(ui, "Model providers", "providers"); await ui.el("[data-testid='provider-signed-in-row']"); await ui.el("[data-testid='provider-add']"); } },
  { id: "settings-providers-none", group: "Settings pages", title: "Model providers (computer): nothing signed in",
    setup: { stubs: [modelsStub({ body: { ok: true, data: { models: [] } } }), { method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/providers", body: { providers: PROVIDERS.map((p) => ({ ...p, signedIn: false })) } }, { method: "GET", path: "/api/providers/login", body: { running: false, exitCode: null, output: "" } }] },
    run: async (ui) => { await openSettingsRow(ui, "Model providers", "providers"); await ui.el("[data-testid='provider-empty']"); } },
  { id: "settings-providers-auth-failed", group: "Settings pages", title: "Model providers (computer): provider access failed",
    setup: { stubs: [{ method: "GET", path: "/api/device", body: DEVICE_ADMIN }, { method: "GET", path: "/api/providers", status: 500, body: { ok: false, error: "No API key for provider anthropic" } }] },
    run: async (ui) => { await openSettingsRow(ui, "Model providers", "providers"); await ui.el("[data-settings-page='providers'] [role='alert']"); } },
  { id: "settings-providers-phone", group: "Settings pages", title: "Model providers (phone): sign-in", note: "Android phone mode signs in through the local bridge",
    setup: { ompLocal: PHONE() },
    run: async (ui) => { await patchBridge(ui, { providers: PROVIDERS }); await openSettingsRow(ui, "Model providers", "providers"); await ui.text("Anthropic (Claude Pro/Max)"); } },
  { id: "settings-providers-phone-picker", group: "Settings pages", title: "Model providers (phone): provider menu",
    setup: { ompLocal: PHONE() },
    run: async (ui) => { await patchBridge(ui, { providers: PROVIDERS }); await openSettingsRow(ui, "Model providers", "providers"); await ui.click("[data-testid='provider-add']:not(:disabled)"); await ui.el("[data-testid='provider-add-sheet']"); } },
  { id: "settings-providers-phone-signing-in", group: "Settings pages", title: "Model providers (phone): signing in", note: "omp login is waiting for a pasted code or API key",
    setup: { ompLocal: PHONE() },
    run: async (ui) => {
      await patchBridge(ui, { providers: PROVIDERS, loginState: { provider: "anthropic", running: true, exitCode: null, output: "Open this link to sign in:\nhttps://claude.ai/oauth/authorize?code=true&client_id=9d1c250a\n\nPaste the code here if the browser doesn't return." } });
      await openSettingsRow(ui, "Model providers", "providers");
      await ui.el("[data-testid='provider-auth-link']");
      await ui.el("input[aria-label='Code, redirect link or API key']");
    } },
  { id: "settings-providers-phone-failed", group: "Settings pages", title: "Model providers (phone): sign-in failed",
    setup: { ompLocal: PHONE() },
    run: async (ui) => {
      await patchBridge(ui, { providers: PROVIDERS, loginState: { running: false, exitCode: 1, output: "Error: access_denied: the user cancelled the request" } });
      await openSettingsRow(ui, "Model providers", "providers");
      await ui.text("Anthropic (Claude Pro/Max)");
      await ui.click("[data-testid='provider-add']"); await ui.click("[data-testid='provider-openrouter']");
      await ui.el("[data-testid='provider-failed']");
    } },
  { id: "settings-run-on-phone", group: "Settings pages", title: "Run on (phone)", setup: { ompLocal: PHONE() },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-run-on']"); await ui.el("[data-testid='run-on']"); await ui.text("Running on this phone"); } },
  { id: "settings-run-on-preparing", group: "Settings pages", title: "Run on: preparing the phone runtime",
    setup: { ompLocal: PHONE({ mode: "laptop", laptopUrl: "https://studio.example-tailnet.ts.net/app/", computers: ["https://studio.example-tailnet.ts.net/app/"], phase: "installing", progress: 42, message: "Installing omp", downloadBytes: 180_000_000 }) },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-run-on']"); await ui.clickText("This phone", { within: "[data-testid='run-on']", exact: true }); await ui.text("Installing omp"); } },
  { id: "settings-run-on-error", group: "Settings pages", title: "Run on: phone setup failed",
    setup: { ompLocal: PHONE({ phase: "error", error: "Couldn't unpack the runtime: no space left on device" }) },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-run-on']"); await ui.text("Phone setup couldn"); } },
  { id: "settings-run-on-computers", group: "Settings pages", title: "Run on (computer): saved computers",
    setup: { ompLocal: PHONE({ mode: "laptop", laptopUrl: "https://studio.example-tailnet.ts.net/app/", computers: ["https://studio.example-tailnet.ts.net/app/", "https://desk.example-tailnet.ts.net/app/"] }) },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-run-on']"); await ui.el("[data-testid='computer-row']"); } },
  { id: "settings-run-on-forget", group: "Settings pages", title: "Confirm: forget a computer", note: "the trailing Forget button opens the confirmation",
    setup: { ompLocal: PHONE({ mode: "laptop", laptopUrl: "https://studio.example-tailnet.ts.net/app/", computers: ["https://studio.example-tailnet.ts.net/app/", "https://desk.example-tailnet.ts.net/app/"] }) },
    run: async (ui) => {
      await openSettings(ui); await ui.click("[data-testid='settings-run-on']"); await ui.el("[data-testid='computer-row']");
      await ui.click("[data-testid='forget-computer-button']");
      await ui.el("[data-testid='forget-computer']");
    } },
  { id: "settings-phone-access", group: "Settings pages", title: "Phone access", setup: { ompLocal: PHONE() },
    run: async (ui) => { await patchBridge(ui, { access: { storage: true, battery: true } }); await openSettingsRow(ui, "Phone access", "phone-access"); await ui.el("[data-testid='phone-tools']"); } },
  { id: "settings-phone-access-bottom", group: "Settings pages", title: "Phone access: explanations", setup: { ompLocal: PHONE() },
    run: async (ui) => { await patchBridge(ui, { access: { storage: true, battery: true } }); await openSettingsRow(ui, "Phone access", "phone-access"); await ui.revealText("Android requires your approval"); } },
  { id: "settings-repair-pairing", group: "Settings pages", title: "Repair a rejected computer pairing",
    setup: { ompLocal: PHONE({ mode: "laptop", laptopUrl: "https://studio.example-tailnet.ts.net/app/" }), stubs: [{ method: "GET", path: "/api/version", status: 401, body: { ok: false, error: "Invalid token" } }] },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-repair-pairing']"); await ui.el("[data-testid='pair-screen']"); await ui.text("Your saved work is kept."); } },
  { id: "settings-repair-pairing-enter", group: "Settings pages", title: "Repair pairing: enter code",
    setup: { ompLocal: PHONE({ mode: "laptop", laptopUrl: "https://studio.example-tailnet.ts.net/app/" }), stubs: [{ method: "GET", path: "/api/version", status: 401, body: { ok: false, error: "Invalid token" } }] },
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-repair-pairing']"); await ui.clickText("Enter code", { exact: true }); await ui.el("#pairing-code"); } },
  { id: "settings-appearance-text", group: "Settings pages", title: "Appearance: Text tab",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-appearance']"); await ui.clickText("Text", { within: "[data-testid='appearance-tabs']", exact: true }); await ui.el("[data-testid='appearance-text-size']"); } },
  { id: "settings-appearance-chat", group: "Settings pages", title: "Appearance: Chat tab",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-appearance']"); await ui.clickText("Chat", { within: "[data-testid='appearance-tabs']", exact: true }); await ui.el("[data-settings-page='appearance'] [data-testid='appearance-wrap'], [data-settings-page='appearance'] [data-slot='row']"); } },
  { id: "settings-appearance-controls", group: "Settings pages", title: "Appearance: Controls tab",
    run: async (ui) => { await openSettings(ui); await ui.click("[data-testid='settings-appearance']"); await ui.clickText("Controls", { within: "[data-testid='appearance-tabs']", exact: true }); await ui.el("[data-testid='appearance-haptics']"); } },

  // ── Usage: ⋯ › Usage, /usage and the composer's context meter open one surface ──
  { id: "session-usage", group: "Usage", title: "Usage (⋯ › Usage)", note: "this conversation, then plan limits per provider, then the counts grid",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [USAGE_STUB] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-usage"); await ui.el("[data-testid='usage-limits']"); await ui.el("[data-testid='usage-summary']"); } },
  { id: "session-usage-bottom", group: "Usage", title: "Usage: scrolled to the details grid",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [USAGE_STUB] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-usage"); await ui.el("[data-testid='usage-limits']"); await ui.revealText("Cache write"); } },
  { id: "session-usage-loading", group: "Usage", title: "Usage: provider limits loading",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/command", hang: true }] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-usage"); await ui.el("[data-testid='usage-limits-loading']"); } },
  { id: "session-usage-error", group: "Usage", title: "Usage: provider limits failed (Retry in the limits group)",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [{ method: "POST", path: "/api/command", status: 502, body: { ok: false, error: "Your computer didn’t answer." } }] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-usage"); await ui.el("[data-testid='usage-limits-error']"); } },
  { id: "session-usage-ring", group: "Usage", title: "Composer context meter: opens Usage",
    setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [USAGE_STUB, stateStub({ body: FULL_STATE })] }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='composer-context']"); await ui.el("[data-testid='usage-summary']"); } },

  // ── Session settings, section by section ─────────────────────────────────
  { id: "session-settings-context", group: "Session settings", title: "Session settings: Context + Compact",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ body: FULL_STATE })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.el("[data-testid='settings-context']"); await ui.revealText("Compact now"); } },
  { id: "session-settings-messages", group: "Session settings", title: "Session settings: Messages",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ body: FULL_STATE })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.el("[data-testid='settings-context']"); await ui.revealText("Messages sent while it works"); } },
  { id: "session-settings-behaviour", group: "Session settings", title: "Session settings: Behaviour switches",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ body: FULL_STATE })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.el("[data-testid='settings-context']"); await ui.revealText("Auto-retry"); } },
  { id: "session-settings-choice", group: "Session settings", title: "Session settings: a Messages choice changed inline (no nested sheet)",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ body: FULL_STATE })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.click("[data-testid='setting-steering'] [data-value='all']"); await ui.el("[data-testid='setting-steering']"); } },
  { id: "session-settings-compact-confirm", group: "Session settings", title: "Session settings: confirm compaction (inline)",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ body: FULL_STATE })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.clickText("Compact now"); await ui.text("Compact this chat?"); } },
  { id: "session-settings-loading", group: "Session settings", title: "Session settings: loading",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ hang: true })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.text("Loading settings"); } },
  { id: "session-settings-owned", group: "Session settings", title: "Session settings: open on the computer",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ status: 409, body: { ok: false, error: "This session is open in a desktop terminal.", code: "session_owned_by_terminal" } })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.text("Settings are on your computer"); } },
  { id: "session-settings-error", group: "Session settings", title: "Session settings: failed to load",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ status: 500, body: { ok: false, error: "Your computer didn’t answer. The session may still be starting." } })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.text("Couldn’t load settings"); } },

  // ── Model picker states ───────────────────────────────────────────────────
  { id: "model-picker-loading", group: "Model picker", title: "Model picker: loading", setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [modelsStub({ hang: true })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-model"); await ui.el("[data-testid='model-picker']"); } },
  { id: "model-picker-stalled", group: "Model picker", title: "Model picker: taking longer than usual", setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [modelsStub({ hang: true })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-model"); await ui.text("taking longer than usual"); } },
  { id: "model-picker-empty", group: "Model picker", title: "Model picker: no models (no provider signed in)", setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [modelsStub({ body: { ok: true, data: { models: [] } } })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-model"); await ui.text("No models available"); } },
  { id: "model-picker-auth", group: "Model picker", title: "Model picker: provider sign-in needed", setup: (env) => ({ hash: env.chatHash("tsconfig"), stubs: [modelsStub({ status: 500, body: { ok: false, error: "No API key for provider anthropic" } })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-model"); await ui.el("[data-testid='model-load-failed']"); } },

  // ── ⋯ menu destinations ───────────────────────────────────────────────────
  { id: "session-menu-rename", group: "Session menu", title: "⋯ › Rename", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-rename"); await ui.el("[data-testid='command-input-sheet']"); } },

  // ── Workspace: Changes with content ───────────────────────────────────────
  { id: "workspace-changes-files", group: "Workspace", title: "Workspace › Changes: files", note: "a git repo with two changed files",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [{ method: "GET", path: "/api/changes", body: { ok: true, cwd: "/tmp/omp-ux-cwd", repoRoot: "/tmp/omp-ux-cwd", branch: "main", notRepo: false, truncated: false, totals: { files: 2, additions: 4, deletions: 2 }, files: [
      { path: "src/webhook/client.ts", status: "modified", additions: 3, deletions: 2, binary: false, patch: "@@ -10,5 +10,6 @@ export async function send(req) {\n   const budget = retryBudget(req);\n-  for (let i = 0; i < budget + 1; i++) {\n-    await attempt(req);\n+  for (let i = 0; i < budget; i++) {\n+    const ok = await attempt(req);\n+    if (ok) return;\n   }\n", patchTruncated: false },
      { path: "src/webhook/retry.ts", status: "added", additions: 1, deletions: 0, binary: false, patch: "@@ -0,0 +1,1 @@\n+export const retryBudget = (req) => req.budget ?? 3;\n", patchTruncated: false },
    ] } }] }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "changes"); await ui.el("[data-testid='changes-list']"); } },
  { id: "workspace-changes-expanded", group: "Workspace", title: "Workspace › Changes: a file expanded",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [{ method: "GET", path: "/api/changes", body: { ok: true, cwd: "/tmp/omp-ux-cwd", repoRoot: "/tmp/omp-ux-cwd", branch: "main", notRepo: false, truncated: false, totals: { files: 1, additions: 3, deletions: 2 }, files: [
      { path: "src/webhook/client.ts", status: "modified", additions: 3, deletions: 2, binary: false, patch: "@@ -10,5 +10,6 @@ export async function send(req) {\n   const budget = retryBudget(req);\n-  for (let i = 0; i < budget + 1; i++) {\n-    await attempt(req);\n+  for (let i = 0; i < budget; i++) {\n+    const ok = await attempt(req);\n+    if (ok) return;\n   }\n", patchTruncated: false },
    ] } }] }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "changes"); await ui.click("[data-testid='changes-file'] button"); await ui.text("retryBudget"); } },

  // ── Other secondary sheets that had no state ──────────────────────────────
  { id: "composer-history-sheet", group: "Sheets", title: "Composer + › History", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='composer-plus-btn']"); await ui.click("[data-testid='composer-plus-sheet'] [data-testid='composer-history']"); await ui.el("[data-testid='history-sheet']"); } },
  { id: "composer-skills-sheet", group: "Sheets", title: "Composer + › Insert skill", setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => { await ui.chat(); await ui.click("[data-testid='composer-plus-btn']"); await ui.click("[data-testid='composer-plus-sheet'] [data-testid='composer-insert-skill']"); await ui.el("[data-testid='skill-picker']"); } },
  { id: "pair-help-sheet", group: "Sheets", title: "Pairing help sheet", setup: { unpaired: true,
      stubs: [{ method: "POST", path: "/api/pair", status: 401, body: { ok: false, error: "That pairing code has expired. Generate a new one on the desktop." } }] },
    run: async (ui) => {
      await ui.clickText("Enter code", { exact: true }); await ui.type("#pairing-code", "000000"); await ui.clickText("Connect", { exact: true });
      await ui.el("#pairing-code-error [role='alert']"); await ui.clickText("Pairing help"); await ui.text("Get a new pairing code");
    } },
  { id: "session-settings-sharing-help", group: "Sheets", title: "Sharing recovery sheet (Session settings closes first)",
    setup: (env) => ({ hash: env.chatHash(MAIN), stubs: [stateStub({ status: 409, body: { ok: false, error: "This session is open in a desktop terminal.", code: "session_owned_by_terminal" } })] }),
    run: async (ui) => { await ui.chat(); await openSessionMenu(ui, "session-settings"); await ui.clickText("Sharing help"); await ui.el("[data-testid='sharing-recovery']"); } },
  { id: "workspace-tasks-row-actions", group: "Sheets", title: "Tasks › row actions sheet", setup: (env) => ({ hash: env.chatHash(MAIN) }),
    run: async (ui) => { await ui.chat(); await openWorkspaceTab(ui, "tasks"); await ui.el("[data-testid='tasks-tab'] [data-timeline-row-id]"); await ui.click("[data-testid='timeline-row-menu']"); await ui.el("[data-testid='timeline-row-actions']"); } },

  // ── Notice stack ──────────────────────────────────────────────────────────
  { id: "toast-undo", group: "Notices", title: "Undo with its real deadline", run: deleteWithUndo },
  { id: "toast-two", group: "Notices", title: "Undo protected beside a passive toast",
    run: async (ui) => {
      await deleteWithUndo(ui); await ui.toast({ message: "Link copied", tone: "success" });
      await ui.page.waitForFunction(() => document.querySelectorAll("[data-slot='toast']").length === 2);
      await ui.text("Undo");
    } },
  { id: "toast-error-expanded", group: "Notices", title: "Long error expanded by a tap",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat();
      await ui.toast({ message: "The session could not be renamed because it is open in a desktop terminal. Your draft is kept on this phone. Close the desktop conversation or share it with /collab, then try renaming it again.", tone: "error" });
      await ui.click("[data-slot='toast'] [data-slot='notice-pill']");
      await ui.el("[data-slot='toast'] .break-words:not(.line-clamp-2)");
    } },
  { id: "toast-reply-ready", group: "Notices", title: "Reply ready: conversation title and Open",
    setup: (env) => ({ hash: env.chatHash("tsconfig") }),
    run: async (ui) => {
      await ui.chat();
      await ui.toast({ message: "Reply ready", tone: "success", title: MAIN, open: ui.env.chatHash(MAIN) });
      await ui.text(MAIN); await ui.el("[data-slot='toast'] button");
    } },
  { id: "sessions-link-banner", group: "Sessions", title: "Connection banner above cached rows",
    setup: cachedLinkFailure,
    run: async (ui) => {
      await ui.sessions(); await ui.el("[data-testid='link-banner']"); await ui.el("[data-testid='session-row']");
      // Chat notices are portalled above screen layers; a covered chat must
      // not leave a second Retry floating over this page's connection banner.
      await ui.page.waitForFunction(() => !document.querySelector("[data-testid='chat-offline-hint']"));
    } },

  // ── Plugins ───────────────────────────────────────────────────────────────
  { id: "settings-plugins", group: "Plugins", title: "Settings › Plugins", note: "Three rows: one on (host-usage, with slots and all three source commands, no failure notice), one awaiting review (long argv should wrap, not clip), one invalid with its reason",
    setup: { enforceCsp: true },
    run: async (ui) => { await serveHostUsagePlugin(ui, PLUGIN_CATALOGUE); await openSettingsRow(ui, "Plugins", "plugins"); await ui.el("[data-testid='plugins-settings'] [data-testid='plugin-row']"); } },
  { id: "settings-plugins-empty", group: "Plugins", title: "Settings › Plugins, none installed", note: "Empty state explains where plugins live and the link command",
    setup: { stubs: [pluginsStub([])] },
    run: async (ui) => { await openSettingsRow(ui, "Plugins", "plugins"); await ui.el("[data-testid='plugins-empty']"); } },
  { id: "drawer-plugin-chips", group: "Plugins", title: "Drawer with host-usage chips", note: "The shipped example runs in its sandbox: a load chip and a memory chip under the drawer links",
    setup: { enforceCsp: true },
    run: async (ui) => { await runHostUsagePlugin(ui); await ui.el("[data-testid='plugin-slot-drawer'] [data-testid='plugin-chip']"); } },
  { id: "plugin-page", group: "Plugins", title: "Plugin page: host-usage", note: "Host card and Sandbox check card; every sandbox row must read blocked (none reachable)",
    setup: { enforceCsp: true },
    run: async (ui) => {
      await runHostUsagePlugin(ui);
      await ui.click("[data-testid='plugin-slot-drawer'] [data-testid='plugin-chip']");
      await ui.el("[data-testid='plugin-page']");
      await ui.text("Sandbox check");
      await ui.text("blocked");
    } },

  // ── Plugins: slice 2 surfaces ────────────────────────────────────────────
  { id: "settings-plugins-review", group: "Plugins", title: "Settings › Plugins: review of permissions, actions and options",
    note: "One plugin awaiting review. Look for the Sees lines (titles, folders and models; tool claims; message claims), the Can lines (put text in the message box, send messages), one line per host action with its {arg} pattern, and the three option controls (switch, choice, text field), none clipped at 390 px",
    setup: { stubs: [pluginsStub([OPS_HELPER])] },
    run: async (ui) => {
      await openSettingsRow(ui, "Plugins", "plugins");
      await ui.el("[data-testid='plugin-review-sees']");
      await ui.el("[data-testid='plugin-review-can']");
      await ui.el("[data-testid='plugin-review-actions']");
      await ui.el("[data-testid='plugin-option'][data-option='prefix']");
      await ui.page.evaluate(() => document.querySelector("[data-testid='plugin-review-actions']")?.scrollIntoView({ block: "center" }));
      await ui.quiet();
    } },
  { id: "session-rows-plugin-chips", group: "Plugins", title: "Chats list: a plugin chip on every row",
    note: "Each row should end its meta line with a model-family chip, wrapping cleanly beside the existing meta text; nothing may push the row taller than its neighbours without a reason",
    setup: { enforceCsp: true },
    run: async (ui) => {
      await openChatsList(ui);
      await servePlugins(ui, { plugins: [ROW_CHIPS], scripts: { "row-chips": ROW_CHIPS_SCRIPT } });
      await nudgeUntil(ui, "[data-testid='plugin-row-badges'] [data-testid='plugin-chip']");
    } },
  { id: "session-menu-plugin-items", group: "Plugins", title: "Session actions sheet: plugin items",
    note: "Two plugin rows under the plugin's name (\"Quick prompts\") after the built-in actions, each with a detail line; they must read as the plugin's, not as app actions",
    setup: { enforceCsp: true },
    run: async (ui) => {
      await openChatsList(ui);
      await servePlugins(ui, { plugins: [QUICK_PROMPTS], scripts: { "quick-prompts": QUICK_PROMPTS_SCRIPT } });
      await ui.longPress("[data-testid='session-switcher'] [data-testid='session-row']");
      await ui.click("[data-testid='drawer-action-more']");
      await ui.el("[data-testid='action-sheet']");
      await nudgeUntil(ui, "[data-testid='action-sheet'] [data-testid='plugin-menu-item']");
    } },
  { id: "composer-plus-plugin-items", group: "Plugins", title: "Composer plus sheet: plugin actions", setup: (env) => ({ hash: env.chatHash("tsconfig"), enforceCsp: true }),
    note: "Plugin rows after the built-in items (Commands is the last built-in), under the plugin's name, each with a detail line",
    run: async (ui) => {
      await ui.chat();
      await servePlugins(ui, { plugins: [QUICK_PROMPTS], scripts: { "quick-prompts": QUICK_PROMPTS_SCRIPT } });
      await ui.click("[data-testid='composer-plus-btn']");
      await nudgeUntil(ui, "[data-testid='composer-plus-sheet'] [data-testid='plugin-menu-item']");
    } },
  { id: "transcript-tool-card", group: "Plugins", title: "Transcript: a plugin card for a bash call", setup: (env) => ({ hash: env.chatHash("CI is red"), enforceCsp: true }),
    note: "In the default Summary mode the plugin's card sits in the conversation directly under its stretch's \"Worked for …\" chip: key/value rows, then a progress bar, under the plugin's name, with a Show original button (which opens the stock tool detail sheet). No stock tool row may appear beside it",
    run: async (ui) => {
      await ui.chat();
      await servePlugins(ui, { plugins: [BASH_CARD], scripts: { "bash-card": BASH_CARD_SCRIPT } });
      const card = "[data-testid='plugin-tool-card'][data-plugin='bash-card']";
      await nudgeUntil(ui, card);
      await ui.page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), card);
      await ui.quiet();
      await ui.el(`${card} [data-testid='plugin-show-original']`);
    } },
  { id: "provider-usage-page", group: "Plugins", title: "Plugin page: provider usage", setup: { enforceCsp: true },
    note: "The shipped example from omp usage output: a card per provider with a bar per window. anthropic's 5 hour window is at 96% and must read as an error; the others stay neutral; \"resets in\" and \"Fetched\" lines are present",
    run: async (ui) => {
      await servePlugins(ui, { plugins: [PROVIDER_USAGE], scripts: { "provider-usage": exampleScript("provider-usage") }, readings: providerUsageReadings });
      await openPluginPageFromDrawer(ui);
      await ui.text("5 hour window");
      await ui.text("resets in");
    } },
  { id: "systemd-timers-page", group: "Plugins", title: "Plugin page: systemd timers", setup: { enforceCsp: true },
    note: "The shipped example: a list of user timers with next/last run and the service state. photo-sync's service has failed and must read as an error; a timer with no next run is hidden by default",
    run: async (ui) => {
      await servePlugins(ui, { plugins: [SYSTEMD_TIMERS], scripts: { "systemd-timers": exampleScript("systemd-timers") }, readings: systemdTimersReadings });
      await openPluginPageFromDrawer(ui);
      await ui.text("photo-sync");
      await ui.text("Tap a timer to run its service now.");
    } },
];

let pngPath = null;
function tmpPng() {
  if (!pngPath) {
    pngPath = `${tmpdir()}/omp-ui-states-attachment.png`;
    writeFileSync(pngPath, Buffer.from(gradientPng(240, 160), "base64"));
  }
  return pngPath;
}
