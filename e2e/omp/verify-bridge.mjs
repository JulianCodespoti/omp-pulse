#!/usr/bin/env node
// Proof that the desktop bridge makes a desktop conversation fully live on the
// phone, with the desktop omp as the only writer.
//
// A real `omp` stands in for the laptop: it loads the repo's extension, owns its
// session, and is prompted over its own stdin exactly as if someone typed at
// the terminal. The phone side is this script talking to the test daemon. It
// asserts the whole loop the bridge exists for:
//
//   laptop turn  -> phone sees it token by token, tools included, and once;
//   listing      -> the row says "bridged", and `activity` names the running tool;
//   phone prompt -> the LAPTOP process runs it (receipt forwarded, its own stdout
//                   shows the turn), and the reply streams back to the phone;
//   phone Stop   -> the laptop's running turn ends within seconds;
//   laptop dies  -> the row stops claiming a bridge and the stale descriptor goes.
//
// Runs under e2e/with-test-daemon.sh. Costs real model calls: run it alone.
// Exit code = number of failures.
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { testModel } from "../lib/env.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const WS = process.env.OMP_PULSE_TEST_WS;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const STATE = process.env.OMP_PULSE_TEST_STATE_DIR;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const TMP = process.env.OMP_PULSE_TEST_TMP;
if (!BASE || !WS || !TOKEN || !STATE || !SESSIONS || !TMP) {
  console.error("run under e2e/with-test-daemon.sh (harness variables missing)");
  process.exit(2);
}
if (!/^http:\/\/127\.0\.0\.1:/.test(BASE) || BASE.includes(":7682")) {
  console.error(`refusing non-harness base ${BASE}`);
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms, step = 200) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = async (route, body) => {
  const r = await fetch(`${BASE}/api/${route}`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, text, json };
};
const listing = async () => {
  const r = await fetch(`${BASE}/api/sessions`, { headers: H, signal: AbortSignal.timeout(10_000) });
  return (await r.json()).sessions ?? [];
};

// ── The stand-in laptop ────────────────────────────────────────────────────
// Its cwd and sessions live in the harness scratch dir; nothing real is touched.
const cwd = `${TMP}/bridge-desktop`;
const sessionDir = `${SESSIONS}/-bridge-desktop`;
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
const extension = `${TMP}/omp-pulse-control.ts`;
writeFileSync(
  extension,
  readFileSync(new URL("../../extensions/omp-pulse-control.ts", import.meta.url), "utf8").replace(
    "__OMP_PULSE_STATE_DIR_JSON__",
    JSON.stringify(STATE),
  ),
);
// The control extension imports its queue helper as a sibling file.
writeFileSync(`${TMP}/pulse-queue.ts`, readFileSync(new URL("../../extensions/pulse-queue.ts", import.meta.url), "utf8"));
const desktopEnv = { ...process.env, OMP_PULSE_STATE_DIR: STATE };
delete desktopEnv.OMP_PULSE_CHILD;
const want = await testModel();
const desktop = spawn(
  "omp",
  ["--mode", "rpc", "--model", `${want.provider}/${want.id}`, "--no-extensions", "-e", extension, "--cwd", cwd, "--session-dir", sessionDir, "--no-title"],
  { env: desktopEnv, stdio: ["pipe", "pipe", "pipe"] },
);
const desktopEvents = [];
createInterface({ input: desktop.stdout }).on("line", (line) => {
  try {
    desktopEvents.push(JSON.parse(line));
  } catch {}
});
desktop.stderr.on("data", () => {});
const typeAtDesktop = (message) =>
  desktop.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
const desktopEnds = () => desktopEvents.filter((e) => e.type === "agent_end").length;
const text = (m) =>
  (Array.isArray(m?.content) ? m.content : [])
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("");

let exitCode = 1;
try {
  const descriptor = await until(() => {
    const dir = `${STATE}/desktop-controls`;
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find((f) => f === `${desktop.pid}.json`);
    return file ? JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) : null;
  }, 30_000);
  check("the desktop omp publishes a live-capable descriptor", descriptor?.capabilities?.includes("events"));
  if (!descriptor) throw new Error("no descriptor");
  const sessionPath = descriptor.sessionPath;
  desktop.stdin.write(JSON.stringify({ type: "get_state", id: "verify-test-model" }) + "\n");
  const modelState = await until(() => desktopEvents.find(e => e.id === "verify-test-model"), 10000);
  if (modelState?.data?.model?.provider !== want.provider || modelState?.data?.model?.id !== want.id) throw new Error(`Refusing model-backed test without ${want.provider}/${want.id}`);

  // First laptop turn materialises the session file.
  typeAtDesktop("Reply with exactly: desk-one");
  await until(() => desktopEnds() >= 1, 120_000);

  const row = await until(async () => (await listing()).find((s) => s.path === sessionPath && s.bridge), 20_000);
  check("the listing marks the laptop conversation as bridged", Boolean(row), sessionPath);
  check("a bridged row advertises stream and control", row?.capabilities?.stream && row?.capabilities?.control);

  // ── Phone sockets ────────────────────────────────────────────────────────
  const frames = [];
  const sock = new WebSocket(`${WS}/ws?session=${encodeURIComponent(sessionPath)}&token=${TOKEN}`);
  sock.onmessage = (m) => {
    try {
      frames.push(JSON.parse(m.data));
    } catch {}
  };
  const activity = [];
  const list = new WebSocket(`${WS}/ws/sessions?token=${TOKEN}`);
  list.onmessage = (m) => {
    try {
      const f = JSON.parse(m.data);
      if (f.type === "activity" && f.path === sessionPath) activity.push(f.now);
    } catch {}
  };
  // The native Android listener receives completion alerts; live activity is on WS.
  const sse = { notify: [] };
  const sseAbort = new AbortController();
  const sseReader = (async () => {
    const r = await fetch(`${BASE}/api/notify/stream`, { headers: H, signal: sseAbort.signal });
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue;
        try {
          const payload = JSON.parse(data);
          if (payload.sessionPath !== sessionPath) continue;
          if (event === "notify") sse.notify.push(payload);
        } catch {}
      }
    }
  })().catch(() => {});
  await until(() => sock.readyState === 1 && list.readyState === 1, 10_000);
  await sleep(500);
  const eventsOf = (type) => frames.filter((f) => f.type === "event" && f.event?.type === type);

  // ── Laptop turn with a tool, observed from the phone ─────────────────────
  frames.length = 0;
  typeAtDesktop("Use the bash tool to run `sleep 2; echo desk-two-ok`. Then reply with exactly: desk-two");
  await until(() => desktopEnds() >= 2, 150_000);
  await sleep(800);
  const lifecycle = () =>
    frames
      .filter((f) => f.type === "event" && /^agent_/.test(f.event?.type))
      .map((f) => `${f.event.type}${f.event.bridgeResumed ? "(resumed)" : ""}${f.event.bridgeLost ? "(lost)" : ""}`)
      .join(",");
  check("a laptop turn streams to the phone (agent_start)", eventsOf("agent_start").length === 1, lifecycle());
  check("tool calls stream live (tool_execution_start: bash)", eventsOf("tool_execution_start").some((f) => f.event.toolName === "bash"));
  check(
    "tool output streams while it runs",
    eventsOf("tool_execution_update").some((f) => JSON.stringify(f.event.partialResult ?? "").includes("desk-two-ok")),
  );
  check("assistant tokens stream (message_update)", eventsOf("message_update").length > 0);
  check("the turn end reaches the phone exactly once", eventsOf("agent_end").length === 1, lifecycle());
  check(
    "the listing socket names the running tool",
    activity.some((n) => n?.state === "tool" && n?.tool === "bash"),
    JSON.stringify(activity.slice(0, 6)),
  );
  check(
    "a finished laptop turn buzzes with its reply",
    sse.notify.some((n) => n.kind === "agent_end" && /desk-two/.test(n.body ?? "")),
    JSON.stringify(sse.notify),
  );
  check("activity clears when the turn ends", activity.at(-1) === null, JSON.stringify(activity.at(-1)));

  // ── Phone prompt, executed by the laptop process ─────────────────────────
  frames.length = 0;
  const before = desktopEnds();
  const commandId = randomUUID();
  const sent = await post("prompt", { commandId, sessionPath, text: "Reply with exactly: phone-three" });
  check(
    "a phone prompt is handed to the laptop (receipt forwarded)",
    sent.json?.receipt?.state === "forwarded",
    sent.text.slice(0, 300),
  );
  await until(() => desktopEnds() > before, 120_000);
  const ranOnDesktop = desktopEvents.some(
    (e) => e.type === "message_start" && e.message?.role === "user" && text(e.message).includes("phone-three"),
  );
  check("the laptop's own omp ran the phone's prompt", ranOnDesktop);
  await sleep(800);
  const replied = eventsOf("message_end").some(
    (f) => f.event.message?.role === "assistant" && text(f.event.message).includes("phone-three"),
  );
  check("the reply streams back to the phone", replied);

  // ── Phone Stop ────────────────────────────────────────────────────────────
  frames.length = 0;
  const beforeStop = desktopEnds();
  typeAtDesktop("Use the bash tool to run `sleep 90`, then reply with exactly: too-late");
  const toolRunning = await until(() => eventsOf("tool_execution_start").length > 0, 90_000);
  check("a long laptop tool run is visible before stopping", Boolean(toolRunning));
  const t0 = Date.now();
  const stopped = await post("abort", { sessionPath });
  check("Stop is accepted", stopped.json?.ok === true, stopped.text);
  const ended = await until(() => desktopEnds() > beforeStop, 20_000, 100);
  check("the laptop turn actually stops", Boolean(ended), "still running 20s after Stop");
  if (ended) console.log(`      stopped in ${Date.now() - t0} ms`);
  // The laptop stopping is only half of it: the PHONE must hear the end, or
  // it keeps showing Running and a Stop button that seems to do nothing.
  const phoneEnded = await until(() => eventsOf("agent_end").length > 0, 10_000, 100);
  check("the phone is told the stopped turn ended", Boolean(phoneEnded), lifecycle());
  const idleRow = await until(async () => {
    const r = (await listing()).find((s) => s.path === sessionPath);
    return r && r.status !== "streaming" && r.streaming !== true ? r : null;
  }, 10_000);
  check("the listing stops calling the stopped turn running", Boolean(idleRow));

  // ── A turn that ends while the phone is disconnected ─────────────────────
  // The phone misses agent_end (a daemon restart drops every socket); its
  // reconnect bundle must say the turn is over, or it shows Running forever.
  const afterMissed = desktopEnds();
  typeAtDesktop("Reply with exactly: while-away");
  await until(() => eventsOf("agent_start").length > 1 || frames.some((f) => f.type === "event" && f.event?.type === "message_update"), 60_000);
  sock.close();
  await until(() => desktopEnds() > afterMissed, 120_000);
  const rejoin = new WebSocket(`${WS}/ws?session=${encodeURIComponent(sessionPath)}&token=${TOKEN}&caps=bundle`);
  const bundle = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    rejoin.onmessage = (m) => {
      try {
        const f = JSON.parse(m.data);
        if (f.type === "bundle") { clearTimeout(timer); resolve(f); }
      } catch {}
    };
  });
  rejoin.close();
  check("a reconnect after a missed turn end says it is not running", bundle?.running === false, JSON.stringify({ running: bundle?.running }));

  // ── A quiet bridge stays up; rename runs on the laptop ───────────────────
  // Bun.serve idle-closes a connection after 10 s of silence, and the old
  // 15 s ping lost that race: every quiet bridge dropped every ~12 s (the
  // owner, 2026-09-24). Each drop ended and restarted the phone's turn and
  // left a window where writes found no bridge and were refused as "open on
  // the desktop". Sit idle well past 10 s and require silence.
  await sleep(1000);
  frames.length = 0;
  await sleep(14_000);
  check(
    "an idle bridge stays connected past Bun's 10 s idle window",
    frames.every((f) => !(f.type === "event" && (f.event?.bridgeLost || f.event?.bridgeResumed))),
    lifecycle(),
  );
  const renamed = await post("rpc", { sessionPath, command: "set_session_name", params: { name: "Renamed from phone" } });
  check("a phone rename of a laptop conversation is accepted", renamed.json?.ok === true, renamed.text.slice(0, 300));
  const titled = await until(() => readFileSync(sessionPath, "utf8").includes("Renamed from phone"), 10_000);
  check("the laptop's omp wrote the new title", Boolean(titled));

  // ── Laptop disappears ─────────────────────────────────────────────────────
  sock.close();
  sseAbort.abort();
  await sseReader;
  desktop.kill("SIGKILL");
  const gone = await until(async () => {
    const r = (await listing()).find((s) => s.path === sessionPath);
    return r && !r.bridge ? r : null;
  }, 20_000);
  check("a killed laptop stops being reported as bridged", Boolean(gone));
  const released = await until(async () => {
    const row = (await listing()).find((s) => s.path === sessionPath);
    const authority = row?.sessionState;
    return authority?.owner.kind === "none" && authority.turn === "idle"
      && authority.connection === "connected" ? row : null;
  }, 20_000);
  check("an exited laptop releases canonical ownership instead of reconnecting forever", Boolean(released));
  const pruned = await until(() => !existsSync(`${STATE}/desktop-controls/${desktop.pid}.json`), 15_000);
  check("its leftover descriptor is pruned", Boolean(pruned));
  // Keep the listing audience connected through delayed bridge cleanup. An
  // OS-thread cleanup once panicked here and froze every future list refresh.
  await sleep(4000);
  const laterPath = `${sessionDir}/${new Date().toISOString().replaceAll(":", "-")}_${randomUUID()}.jsonl`;
  writeFileSync(laterPath, JSON.stringify({type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd, title: "After desktop disconnect"}) + "\n");
  const laterVisible = await until(async () => (await listing()).some(row => row.path === laterPath), 15_000);
  check("listing keeps refreshing after delayed desktop disconnect cleanup", Boolean(laterVisible));
  list.close();
  exitCode = failures;
} catch (error) {
  console.error(error);
  failures += 1;
  exitCode = failures;
} finally {
  if (desktop.exitCode === null) desktop.kill("SIGKILL");
}
console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(exitCode === 0 ? 0 : 1);
