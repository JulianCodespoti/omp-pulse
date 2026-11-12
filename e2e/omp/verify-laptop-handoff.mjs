#!/usr/bin/env node
// "Open on laptop": POST /api/desktop/open moves a conversation into a Herdr
// tab, starting a stopped Herdr server when safe to do so (src/terminal/handoff.rs).
//
// Everything real except the omp executable wrapper, which adds this checkout's
// control extension and test model flags. Herdr itself is a throwaway named
// session, and both it and the daemon use a temporary config and daemon state.
// Real model turns prove busy handoff and busy-close refusals without aborting work.
//
// What it proves:
//   - phone conversations move to Herdr and stop their RPC child;
//   - workspace reuse/rollover, one-writer checks, and busy-close behavior;
//   - a busy phone conversation is refused before cold-starting Herdr;
//   - a stopped Herdr is automatically started, preserving layout without
//     bulk-resuming saved omp sessions, then the selected conversation moves;
//   - startup failure leaves the phone child untouched and healthy config is
//     not rewritten;
//   - the automatic Herdr server survives shutdown of this isolated daemon.
//
// Cost: several real omp TUIs, RPC children, and model turns (~270 MB each).
// Run alone: e2e/with-test-daemon.sh node e2e/omp/verify-laptop-handoff.mjs

import { execFileSync, spawn } from "child_process";
import { mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "fs";
import { testModel } from "../lib/env.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const STATE = process.env.OMP_PULSE_TEST_STATE_DIR;
const TMP = process.env.OMP_PULSE_TEST_TMP;
const HS = process.env.OMP_PULSE_TEST_HERDR_SESSION;
const HERDR_CONFIG = process.env.HERDR_CONFIG_PATH;
const DAEMON_PID = Number(process.env.OMP_PULSE_TEST_DAEMON_PID);
if (!BASE || !TOKEN || !SESSIONS || !STATE || !TMP || !HS || !HERDR_CONFIG || !DAEMON_PID) {
  console.error("run under e2e/with-test-daemon.sh (harness variables missing)");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682");
  process.exit(2);
}
if (!HS.startsWith("omp-pulse-test-") || process.env.HERDR_SESSION !== HS) {
  console.error(`refusing: HERDR_SESSION must be this run's throwaway session (got ${process.env.HERDR_SESSION})`);
  process.exit(2);
}
if (!HERDR_CONFIG.startsWith(`${TMP}/`)) {
  console.error("refusing: HERDR_CONFIG_PATH must be inside this run's temporary directory");
  process.exit(2);
}
// Every herdr call below, and the daemon's, must reach only this run's server.

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 200) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() >= deadline) return v;
    await sleep(step);
  }
}

// herdr identity: the named session only. A leftover HERDR_SOCKET_PATH would
// win over it and reach the developer's server.
const herdrEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_") || k === "HERDR_SESSION" || k === "HERDR_CONFIG_PATH"),
);
const herdr = (...args) =>
  JSON.parse(execFileSync("herdr", args, { env: herdrEnv, encoding: "utf8", timeout: 15_000 }));

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, json: null };
  }
};
const listing = async () => {
  const r = await fetch(`${BASE}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return (await r.json()).sessions ?? [];
};
const row = async (path) => (await listing()).find((s) => s.path === path);

// Daemon RPC children for a fixture, found the way the one-writer rule cares
// about: a live process marked OMP_PULSE_CHILD=1 running in that fixture's
// (unique) cwd. The daemon exposes no per-session child pid, and must not.
function childPids(cwd) {
  const out = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) !== cwd) continue;
      const env = readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
      if (env.includes("OMP_PULSE_CHILD=1")) out.push(Number(pid));
    } catch {
      // exited mid-scan or not ours
    }
  }
  return out;
}
function sessionArgPids(sessionPath) {
  const out = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "latin1").includes(sessionPath)) out.push(Number(pid));
    } catch {
      // exited mid-scan or not ours
    }
  }
  return out;
}

const dir = `${SESSIONS}/-tmp-verify-handoff`;
mkdirSync(dir, { recursive: true });
function fixture(key, n) {
  const cwd = `${TMP}/handoff-${key}`;
  mkdirSync(cwd, { recursive: true });
  const id = `019ff400-0000-7000-0000-0000000b000${n}`;
  const title = `Handoff fixture ${key.toUpperCase()}`;
  const path = `${dir}/2026-09-25T00-00-0${n}-000Z_${id}.jsonl`;
  // The TUI RENDERS this on resume, so the assistant turn carries the fields
  // omp's own entries do: a bare {role, content} crashed omp in
  // renderInitialMessages, and the launch timed out behind a stack trace.
  const entries = [
    { type: "session", version: 3, id, timestamp: "2026-09-25T00:00:00.000Z", cwd, title },
    {
      type: "message", id: `${key}-u`, parentId: null, timestamp: "2026-09-25T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: `hello from the phone (${key})` }], timestamp: 1790294401000 },
    },
    {
      type: "message", id: `${key}-a`, parentId: `${key}-u`, timestamp: "2026-09-25T00:00:02.000Z",
      message: {
        role: "assistant", content: [{ type: "text", text: "Hi. What should we work on?" }],
        api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5",
        usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 1790294402000,
      },
    },
  ];
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { cwd, title, path };
}
const A = fixture("a", 1);
const B = fixture("b", 2);
const C = fixture("c", 3);
const D = fixture("d", 4);
const E = fixture("e", 5);

// Both the manually started server and later auto-start inherit this isolated
// config, state directory, and omp wrapper PATH from the harness.
const extension = `${TMP}/handoff-control.ts`;
writeFileSync(extension, readFileSync(new URL("../../extensions/omp-pulse-control.ts", import.meta.url), "utf8").replace("__OMP_PULSE_STATE_DIR_JSON__", JSON.stringify(STATE)));
// The control extension imports its queue helper as a sibling file.
writeFileSync(`${TMP}/pulse-queue.ts`, readFileSync(new URL("../../extensions/pulse-queue.ts", import.meta.url), "utf8"));
const binDir = `${TMP}/handoff-bin`;
mkdirSync(binDir, { recursive: true });
const ompBin = execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
// herdr's omp agent-state extension; defaults to the per-user omp extensions dir.
const herdrExtension = process.env.OMP_PULSE_HERDR_EXTENSION || `${process.env.HOME}/.omp/agent/extensions/herdr-omp-agent-state.ts`;
const want = await testModel();
writeFileSync(`${binDir}/omp`, `#!/bin/sh
exec ${quote(ompBin)} --model ${want.provider}/${want.id} --no-extensions -e ${quote(herdrExtension)} -e ${quote(extension)} "$@"
`, { mode: 0o755 });
const originalConfig = `# test-only config; format must survive automatic startup
[session]
# keep this comment while disabling agent restore
resume_agents_on_restore = true

[terminal]
default_shell = "/bin/sh"
`;
writeFileSync(HERDR_CONFIG, originalConfig);
const autoStartedConfig = originalConfig.replace("resume_agents_on_restore = true", "resume_agents_on_restore = false");
const serverEnv = { ...herdrEnv, PATH: `${binDir}:${process.env.PATH}`, OMP_PULSE_STATE_DIR: STATE };
delete serverEnv.OMP_PULSE_CHILD;
delete serverEnv.HERDR_SESSION;
const server = spawn("herdr", ["--session", HS, "server"], { env: serverEnv, stdio: "ignore" });
const stopHerdr = () => {
  try {
    execFileSync("herdr", ["session", "stop", HS], { env: herdrEnv, stdio: "ignore", timeout: 15_000 });
  } catch {
    // already stopped
  }
};

try {
  const up = await waitFor(() => {
    try {
      return Array.isArray(herdr("workspace", "list").result.workspaces);
    } catch {
      return false;
    }
  }, 10_000);
  check("isolated herdr server is up", up);
  if (!up) throw new Error("no herdr server");
  check("initial healthy Herdr config is unchanged", readFileSync(HERDR_CONFIG, "utf8") === originalConfig);

  // --- input validation -----------------------------------------------------
  let r = await post("/api/desktop/open", {});
  check("missing sessionPath -> 400", r.status === 400);
  r = await post("/api/desktop/open", { sessionPath: `${dir}/missing.jsonl` });
  check("missing session file -> 404", r.status === 404);

  // --- A: a phone-driven conversation moves --------------------------------
  await post("/api/prewarm", { sessionPath: A.path });
  const warm = await waitFor(() => childPids(A.cwd).length > 0, 30_000);
  check("phone child for A is running before the move", warm);

  r = await post("/api/desktop/open", { sessionPath: A.path });
  const first = r.json ?? {};
  check("A opens on the laptop", first.ok === true, JSON.stringify(r.json));
  check("first handoff creates 'Pulse mobile'", first.workspace?.label === "Pulse mobile" && first.workspace?.created === true, JSON.stringify(first.workspace));
  check("tab is named after the conversation", first.tab?.label === A.title, first.tab?.label);
  check("omp reached its prompt in the tab", first.ready === true);
  check("phone child for A has exited (one writer)", childPids(A.cwd).length === 0, String(childPids(A.cwd)));
  check("A's laptop omp process has the selected session argument", sessionArgPids(A.path).length > 0);

  const agents = herdr("agent", "list").result.agents;
  const pane = agents.find((a) => a.agent_session?.value === A.path);
  check("herdr reports omp holding A in the new pane", pane?.pane_id === first.pane && pane?.agent === "omp", JSON.stringify(pane?.pane_id));

  const bridged = await waitFor(async () => {
    const s = await row(A.path);
    return s?.live === true && s?.bridge === true && s?.ownerPid != null;
  }, 15_000);
  check("listing shows A open on the laptop, bridged", bridged, JSON.stringify(await row(A.path)));

  r = await post("/api/desktop/open", { sessionPath: A.path });
  check("a second handoff of A is refused", r.json?.ok === false && r.json?.code === "already_on_laptop", JSON.stringify(r.json));

  await post("/api/prewarm", { sessionPath: A.path });
  await sleep(3_000);
  check("the phone cannot warm a second writer for A", childPids(A.cwd).length === 0);

  // --- B: history conversation joins the same workspace ---------------------
  r = await post("/api/desktop/open", { sessionPath: B.path });
  check("B joins the same workspace as tab 2", r.json?.ok === true && r.json?.workspace?.id === first.workspace?.id && r.json?.workspace?.created === false && r.json?.tab?.number === 2, JSON.stringify(r.json));
  check("healthy server reuse leaves Herdr config unchanged", readFileSync(HERDR_CONFIG, "utf8") === originalConfig);

  // --- C: a full workspace rolls over ---------------------------------------
  // Two plain shell tabs bring "Pulse mobile" to four; herdr's own count is
  // what the daemon reads, so it cannot tell them from handoff tabs.
  herdr("tab", "create", "--workspace", first.workspace.id, "--label", "filler", "--no-focus");
  herdr("tab", "create", "--workspace", first.workspace.id, "--label", "filler", "--no-focus");
  r = await post("/api/desktop/open", { sessionPath: C.path });
  check("fifth conversation opens 'Pulse mobile 2'", r.json?.ok === true && r.json?.workspace?.label === "Pulse mobile 2" && r.json?.workspace?.created === true, JSON.stringify(r.json));
  const ours = herdr("workspace", "list").result.workspaces.filter((w) => w.label.startsWith("Pulse mobile"));
  check("layout is 4 + 1 tabs", ours.length === 2 && ours.find((w) => w.label === "Pulse mobile")?.tab_count === 4 && ours.find((w) => w.label === "Pulse mobile 2")?.tab_count === 1, JSON.stringify(ours));

  // Closing is an owner shutdown, not a destructive pane operation.
  const ownerPid = (await row(A.path)).ownerPid;
  const descriptor = JSON.parse(readFileSync(`${STATE}/desktop-controls/${ownerPid}.json`, "utf8"));
  const ownerCall = async (method, sessionPath = A.path) => (await fetch(`http://127.0.0.1:${descriptor.port}/control`, {
    method: "POST", headers: { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionPath, method, params: {} }), signal: AbortSignal.timeout(10000),
  })).json();
  const wrongOwner = await ownerCall("close_if_idle", B.path);
  check("owner refuses a close naming another conversation", wrongOwner.ok === false);
  await post("/api/prompt", { sessionPath: A.path, commandId: crypto.randomUUID(), text: "Write the integers from 1 through 20000, separated by spaces. Do not use tools." });
  const working = await waitFor(async () => (await ownerCall("get_state")).data?.isStreaming === true, 30000);
  check("real laptop turn is running before the close attempt", working);
  if (!working) throw new Error("No real running turn observed");
  const busyOwner = await ownerCall("close_if_idle");
  check("owner atomically refuses close while streaming", busyOwner.ok === false && busyOwner.code === "turn_running", JSON.stringify(busyOwner));
  r = await post("/api/desktop/close", { sessionPath: A.path });
  check("phone close refuses the busy laptop session", r.json?.ok === false && r.json?.code === "turn_running", JSON.stringify(r.json));
  check("refused close leaves the turn running", (await ownerCall("get_state")).data?.isStreaming === true);
  await post("/api/abort", { sessionPath: A.path });
  if (!await waitFor(async () => (await ownerCall("get_state")).data?.isStreaming === false, 20000)) throw new Error("Test turn did not stop");
  await waitFor(() => ["idle", "done"].includes(herdr("agent", "list").result.agents.find(a => a.pane_id === first.pane)?.agent_status), 10000);
  const messages = () => JSON.stringify(readFileSync(A.path, "utf8").trim().split("\n").map(JSON.parse).filter(entry => entry.type === "message"));
  const historyBefore = messages();
  r = await post("/api/desktop/close", { sessionPath: D.path });
  check("closing an unowned history session is refused", r.json?.ok === false && r.json?.code === "not_on_laptop", JSON.stringify(r.json));
  r = await post("/api/desktop/close", { sessionPath: A.path });
  check("idle laptop owner closes gracefully", r.json?.ok === true, JSON.stringify(r.json));
  const ownerExited = await waitFor(() => {
    try { process.kill(ownerPid, 0); return false; } catch { return true; }
  }, 5000);
  check("success means the original omp process exited", ownerExited);
  check("close preserves every conversation message", messages() === historyBefore);
  const remainingPane = herdr("pane", "get", first.pane).result.pane;
  check("close leaves the Herdr pane open", remainingPane?.pane_id === first.pane, JSON.stringify(remainingPane));

  // --- D: busy preflight, then cold-start and move --------------------------
  const savedLayout = herdr("workspace", "list").result.workspaces;
  const priorSessions = [A.path, B.path, C.path];
  const priorArgPids = new Map(priorSessions.map(path => [path, sessionArgPids(path)]));
  await post("/api/prewarm", { sessionPath: D.path });
  check("phone child for D is running", await waitFor(() => childPids(D.cwd).length > 0, 30_000));
  await post("/api/prompt", { sessionPath: D.path, commandId: crypto.randomUUID(), text: "Write the integers from 1 through 20000, separated by spaces. Do not use tools." });
  const phoneWorking = await waitFor(async () => {
    const s = await row(D.path);
    return s?.status === "streaming" || s?.streaming === true;
  }, 30_000);
  check("D phone child is actively writing before Herdr stops", phoneWorking);
  if (!phoneWorking) throw new Error("No busy phone turn observed for D");

  stopHerdr();
  let herdrDown = false;
  try { herdr("workspace", "list"); } catch { herdrDown = true; }
  check("named Herdr server is stopped before cold-start checks", herdrDown);
  r = await post("/api/desktop/open", { sessionPath: D.path });
  check("busy phone owner is refused before Herdr startup", r.json?.ok === false && r.json?.code === "turn_running", JSON.stringify(r.json));
  check("busy refusal leaves D phone child untouched", childPids(D.cwd).length > 0);
  let stillDown = false;
  try { herdr("workspace", "list"); } catch { stillDown = true; }
  check("busy refusal did not start Herdr", stillDown);
  check("busy refusal leaves config unchanged", readFileSync(HERDR_CONFIG, "utf8") === originalConfig);

  await post("/api/abort", { sessionPath: D.path });
  const phoneIdle = await waitFor(async () => {
    const s = await row(D.path);
    return s && s.status !== "streaming" && s.streaming !== true;
  }, 20_000);
  check("D phone turn stops before handoff", phoneIdle);
  if (!phoneIdle) throw new Error("D phone turn did not stop");
  check("idle D phone child remains available for handoff", childPids(D.cwd).length > 0);

  r = await post("/api/desktop/open", { sessionPath: D.path });
  check("stopped Herdr automatically starts and opens D", r.json?.ok === true, JSON.stringify(r.json));
  check("automatic start retains and reuses the saved workspace layout", r.json?.workspace?.id === savedLayout.find(w => w.label === "Pulse mobile 2")?.workspace_id && r.json?.workspace?.label === "Pulse mobile 2", JSON.stringify(r.json?.workspace));
  check("D is selected as the new tab", r.json?.tab?.label === D.title && r.json?.ready === true, JSON.stringify(r.json?.tab));
  check("automatic start disables resume_agents_on_restore", readFileSync(HERDR_CONFIG, "utf8") === autoStartedConfig, readFileSync(HERDR_CONFIG, "utf8"));
  check("phone child for D exited before laptop omp owns it", childPids(D.cwd).length === 0, String(childPids(D.cwd)));

  const afterStart = herdr("workspace", "list").result.workspaces;
  const layoutRetained = savedLayout.every(old => afterStart.some(now => now.workspace_id === old.workspace_id && now.label === old.label));
  check("restored workspace identities and labels are retained", layoutRetained, JSON.stringify(afterStart));
  check("restored workspace tab counts are retained before D's new tab", afterStart.find(w => w.label === "Pulse mobile")?.tab_count === 4 && afterStart.find(w => w.label === "Pulse mobile 2")?.tab_count === 2, JSON.stringify(afterStart));
  const activeAgents = herdr("agent", "list").result.agents;
  check("saved A/B/C sessions have no active Herdr omp agent", priorSessions.every(path => !activeAgents.some(a => a.agent_session?.value === path && a.agent === "omp")), JSON.stringify(activeAgents.filter(a => priorSessions.includes(a.agent_session?.value))));
  const noBulkWriters = priorSessions.every(path => sessionArgPids(path).every(pid => priorArgPids.get(path).includes(pid)));
  check("restoring the saved layout did not spawn new A/B/C omp processes", noBulkWriters, JSON.stringify(Object.fromEntries(priorSessions.map(path => [path, { before: priorArgPids.get(path), after: sessionArgPids(path) }]))));
  check("D has an actual laptop omp process after its phone child exited", sessionArgPids(D.path).length > 0 && activeAgents.some(a => a.agent_session?.value === D.path && a.agent === "omp"));

  // An invalid config must fail closed without closing a phone child.
  stopHerdr();
  await post("/api/prewarm", { sessionPath: E.path });
  check("phone child for E is running before failed startup", await waitFor(() => childPids(E.cwd).length > 0, 30_000));
  const malformedConfig = "[session\nresume_agents_on_restore = false\n";
  writeFileSync(HERDR_CONFIG, malformedConfig);
  r = await post("/api/desktop/open", { sessionPath: E.path });
  check("malformed TOML returns herdr_start_failed", r.json?.ok === false && r.json?.code === "herdr_start_failed", JSON.stringify(r.json));
  check("malformed config leaves E phone child untouched", childPids(E.cwd).length > 0);
  let failedStartDown = false;
  try { herdr("workspace", "list"); } catch { failedStartDown = true; }
  check("malformed config leaves Herdr stopped", failedStartDown);

  const schemaInvalidConfig = `onboarding = "invalid"\n`;
  writeFileSync(HERDR_CONFIG, schemaInvalidConfig);
  r = await post("/api/desktop/open", { sessionPath: E.path });
  check("schema-invalid config returns herdr_start_failed", r.json?.ok === false && r.json?.code === "herdr_start_failed", JSON.stringify(r.json));
  check("schema-invalid config bytes and E phone child are untouched", readFileSync(HERDR_CONFIG, "utf8") === schemaInvalidConfig && childPids(E.cwd).length > 0);
  failedStartDown = false;
  try { herdr("workspace", "list"); } catch { failedStartDown = true; }
  check("schema-invalid config leaves Herdr stopped", failedStartDown);
  writeFileSync(HERDR_CONFIG, autoStartedConfig);
  r = await post("/api/desktop/open", { sessionPath: E.path });
  check("corrected config allows automatic startup and handoff retry", r.json?.ok === true, JSON.stringify(r.json));
  check("retry preserves the corrected config bytes", readFileSync(HERDR_CONFIG, "utf8") === autoStartedConfig);
  check("successful retry stops E phone child", childPids(E.cwd).length === 0);

  // The auto-started server belongs to its named Herdr scope, not this daemon.
  try { process.kill(DAEMON_PID, "SIGTERM"); } catch { /* already exited */ }
  const daemonStopped = await waitFor(async () => {
    try {
      await fetch(`${BASE}/`, { signal: AbortSignal.timeout(500) });
      return false;
    } catch {
      return true;
    }
  }, 5_000);
  check("isolated Pulse daemon shuts down", daemonStopped);
  let survivesDaemon = false;
  try { survivesDaemon = Array.isArray(herdr("workspace", "list").result.workspaces); } catch { /* server exited with daemon */ }
  check("automatically started Herdr survives Pulse daemon shutdown", survivesDaemon);
} catch (e) {
  check("suite ran to completion", false, String(e?.stack ?? e));
} finally {
  stopHerdr();
  try {
    execFileSync("herdr", ["session", "delete", HS], { env: herdrEnv, stdio: "ignore", timeout: 15_000 });
  } catch {
    // the harness retries on exit
  }
  server.kill();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures);
