#!/usr/bin/env node
// Proof that Stop actually stops, promptly.
//
// On the laptop you fire a command and interrupt it the moment you change your
// mind; the whole point of a command like /compact firing without a confirm is
// that stopping is cheap and immediate. The phone has to honour the same
// contract, and a Stop button that merely *looks* pressed while the agent keeps
// burning tokens is worse than no button at all.
//
// `/api/abort` was wired and unit-covered but never proven against a live turn.
// This drives a real prompt through a real omp child, aborts mid-flight, and
// asserts the run actually ends — and ends fast.
//
// Runs under e2e/with-test-daemon.sh. Costs a model call, so run it alone.
// Exit code = number of failures.
import { randomUUID } from "crypto";
import { mkdirSync, utimesSync, writeFileSync } from "fs";
import { testModel } from "../lib/env.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682 — it would abort a real turn");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The session's cwd must exist or omp cannot switch into it; the RPC fails with
// "switch_session was cancelled" while the HTTP call still answers 200.
const CWD = "/tmp/omp-stop-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-stop`;
mkdirSync(dir, { recursive: true });
const sessionPath = `${dir}/2026-08-20T18-00-00-000Z_019ff400-0000-7000-0000-00000000dd05.jsonl`;
writeFileSync(
  sessionPath,
  JSON.stringify({
    type: "session",
    id: "019ff400-0000-7000-0000-00000000dd05",
    cwd: CWD,
    title: "Stop responsiveness",
  }) + "\n",
);
const when = new Date(Date.now() - 60_000);
utimesSync(sessionPath, when, when);

const H = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const post = async (route, body) => {
  const res = await fetch(`${BASE}/api/${route}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  // Full body: the receipt carries the absolute session path, and slicing to
  // 200 chars before JSON.parse made every receipt check fail on a long tmp
  // path while the prompt itself had been accepted. Details truncate instead.
  return { status: res.status, text: await res.text() };
};
const rpc = async (command, args = {}) => {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ sessionPath, command, args }),
  });
  try {
    return JSON.parse(await res.text());
  } catch {
    return {};
  }
};

await post("open", { sessionPath });
await new Promise((r) => setTimeout(r, 12_000));
const want = await testModel({ base: BASE, token: TOKEN, sessionPath });
await post("rpc", { sessionPath, command: "set_model", params: { provider: want.provider, modelId: want.id } });
const modelState = await rpc("get_state");
if (modelState.data?.model?.provider !== want.provider || modelState.data?.model?.id !== want.id) throw new Error(`Refusing model-backed test without ${want.provider}/${want.id}`);

// Watch the notify stream: a turn that is genuinely finished emits agent_end,
// which is the same signal the phone's notification path keys on.
const seen = [];
const ac = new AbortController();
let streamStatus = 0;
const reader = (async () => {
  const res = await fetch(`${BASE}/api/notify/stream`, {
    headers: { ...H, Accept: "text/event-stream" },
    signal: ac.signal,
  });
  streamStatus = res.status;
  if (!res.ok || !res.body) return;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = { event: "message", data: "" };
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) ev.event = line.slice(6).trim();
        else if (line.startsWith("data:")) ev.data += line.slice(5).trim();
      }
      seen.push({ ...ev, at: Date.now() });
    }
  }
})().catch(() => {});
const streamReadyBy = Date.now() + 10_000;
while (streamStatus === 0 && Date.now() < streamReadyBy) await new Promise((r) => setTimeout(r, 50));
check("notification listener is connected before stopping", streamStatus === 200);
const completions = () => seen.filter((e) => {
  if (e.event !== "notify") return false;
  try { const p = JSON.parse(e.data); return p.kind === "agent_end" && p.sessionPath === sessionPath; } catch { return false; }
});
const commandId = randomUUID();
const sent = await post("prompt", {
  commandId,
  sessionPath,
  text: "Count slowly from 1 to 400, writing each number on its own line, with a short sentence about each.",
});
let sentPayload = {};
try { sentPayload = JSON.parse(sent.text); } catch {}
check(
  "a long prompt starts with a durable receipt",
  sent.status === 200 &&
    sentPayload.ok === true &&
    sentPayload.receipt?.commandId === commandId &&
    ["accepted", "dispatching", "received", "running", "completed", "failed", "uncertain"].includes(sentPayload.receipt?.state),
  `HTTP ${sent.status} ${sent.text.slice(0, 300)}`,
);

// Confirm the agent is genuinely working before aborting, otherwise the test
// proves nothing: aborting an idle session trivially "succeeds".
let working = false;
const startedBy = Date.now() + 60_000;
while (Date.now() < startedBy) {
  // `isStreaming` is the live signal. get_state exposes no isRunning/busy/
  // agentWorking field, so probing for those reported "not working" the whole
  // time and made the stop timing meaningless: aborting an idle session
  // trivially succeeds in 68ms.
  const st = await rpc("get_state");
  if ((st.data ?? {}).isStreaming === true) {
    working = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
check("the agent is actually running before we stop it", working);

const t0 = Date.now();
const aborted = await post("abort", { sessionPath });
check("abort is accepted", aborted.status === 200, `HTTP ${aborted.status} ${aborted.text}`);

// "Responsiveness at demand": the run must end quickly, not eventually.
let stoppedMs = null;
const deadline = Date.now() + 45_000;
while (Date.now() < deadline) {
  const st = await rpc("get_state");
  if ((st.data ?? {}).isStreaming !== true) {
    stoppedMs = Date.now() - t0;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
check("the run actually stops after abort", stoppedMs !== null, "still running 45s after abort");
if (stoppedMs !== null) {
  check(
    "it stops promptly, not eventually",
    stoppedMs < 15_000,
    `took ${stoppedMs}ms`,
  );
  console.log(`      stopped in ${stoppedMs}ms`);
}
// No chat socket: otherwise watched-session suppression would hide this bug.
await new Promise((r) => setTimeout(r, 3000));
check("manual stop does not emit a completion alert", completions().length === 0);
const afterCommandId = randomUUID();
const after = await post("prompt", { commandId: afterCommandId, sessionPath, text: "Reply with exactly: ok" });
let afterPayload = {};
try { afterPayload = JSON.parse(after.text); } catch {}
check(
  "the session still accepts a prompt afterwards",
  after.status === 200 && afterPayload.ok === true && afterPayload.receipt?.commandId === afterCommandId,
  `HTTP ${after.status} ${after.text.slice(0, 300)}`,
);
const notifyBy = Date.now() + 90_000;
while (completions().length === 0 && Date.now() < notifyBy) await new Promise((r) => setTimeout(r, 250));
const completion = completions();
check("the next successful turn still notifies", completion.length === 1,
  JSON.stringify(completion.map((e) => JSON.parse(e.data))));

ac.abort();
await reader;

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
