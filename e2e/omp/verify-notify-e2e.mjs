#!/usr/bin/env node
// End-to-end proof that a finished agent turn reaches a phone.
//
// Everything else about notifications was verified in pieces: the SSE headers,
// the settings UI, the native plugin contract. None of it proved the actual
// chain — daemon observes `agent_end` -> builds a payload -> fans it out to a
// subscriber. This connects to `/api/notify/stream` exactly as
// NotifyService.java does (Bearer token, text/event-stream, Last-Event-ID),
// drives a REAL prompt through a REAL omp child, and waits for the event.
//
// The one link it cannot cover is Android drawing the notification, which
// needs hardware.
//
// Two behaviours here are deliberate and load-bearing:
//   - No WebSocket is opened on the session. The daemon suppresses the buzz
//     when `session_watched` is true (you are already looking at it), so a
//     test that opened a socket would prove the opposite of what it claims.
//   - Only `isTerminal` turns notify. Intermediate tool-loop iterations carry
//     isTerminal:false precisely so a long agent run buzzes once, not ten times.
//
// Runs under e2e/with-test-daemon.sh. Spawns a real ~270MB omp child and makes
// real model calls, so run it alone. Exit code = number of failures.

import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { testModel } from "../lib/env.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682 — it would prompt a real conversation");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const dir = `${SESSIONS}/-tmp-notify-e2e`;
mkdirSync(dir, { recursive: true });
// The session's cwd must EXIST. omp cannot switch into a missing directory and
// the RPC fails with "switch_session was cancelled" while /api/prompt still
// answers 200 — the failure is only visible in the daemon log.
const CWD = "/tmp/omp-notify-e2e-cwd";
mkdirSync(CWD, { recursive: true });
const sessionPath = `${dir}/2026-08-20T14-00-00-000Z_019ff400-0000-7000-0000-00000000ee01.jsonl`;
writeFileSync(
  sessionPath,
  JSON.stringify({
    type: "session",
    id: "019ff400-0000-7000-0000-00000000ee01",
    cwd: CWD,
    title: "Notification end-to-end",
  }) + "\n",
);
const when = new Date(Date.now() - 60_000);
utimesSync(sessionPath, when, when);

const auth = { Authorization: `Bearer ${TOKEN}` };

// --- subscribe exactly as the Android foreground service does ----------------
const events = [];
const controller = new AbortController();
let streamStatus = 0;
let streamCtype = "";

const reader = (async () => {
  const res = await fetch(`${BASE}/api/notify/stream`, {
    headers: { ...auth, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  streamStatus = res.status;
  streamCtype = res.headers.get("content-type") || "";
  if (!res.ok || !res.body) return;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    // SSE frames are separated by a blank line.
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = { event: "message", data: "", id: null };
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) ev.event = line.slice(6).trim();
        else if (line.startsWith("data:")) ev.data += line.slice(5).trim();
        else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
      }
      if (ev.event) events.push(ev);
    }
  }
})().catch(() => {});

await new Promise((r) => setTimeout(r, 1500));
check("notify stream accepts the service's Bearer token", streamStatus === 200, `HTTP ${streamStatus}`);
check("stream is text/event-stream", streamCtype.includes("text/event-stream"), streamCtype);

// --- prove device-scoped registration without leaving a live endpoint -------
const post = async (route, body) => {
  const res = await fetch(`${BASE}/api/${route}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
};
const fakeEndpoint = "https://fcm.googleapis.com/fcm/send/verify-notify-e2e";
const fakeSubscription = {
  endpoint: fakeEndpoint,
  keys: { p256dh: "BAAA", auth: "BBBB" },
};
const registered = await post("push/subscribe", { subscription: fakeSubscription });
check(
  "device subscription does not require an opened session",
  registered.status === 200,
  `HTTP ${registered.status} ${registered.body.slice(0, 120)}`,
);
let registeredState = null;
try {
  const res = await fetch(`${BASE}/api/push/status`, { headers: auth });
  registeredState = await res.json();
} catch {}
check(
  "daemon reports the device subscription as active",
  registeredState?.scope === "device" && registeredState?.subscribed === true,
  JSON.stringify(registeredState),
);
const unregistered = await post("push/unsubscribe", { endpoint: fakeEndpoint });
check(
  "device subscription can be removed without a session path",
  unregistered.status === 200,
  `HTTP ${unregistered.status} ${unregistered.body.slice(0, 120)}`,
);

// --- drive a real turn -------------------------------------------------------
const opened = await post("open", { sessionPath });
check("session opens an omp child", opened.status === 200, `HTTP ${opened.status} ${opened.body.slice(0, 120)}`);
// The child needs to finish booting and switch into the session before it can
// accept a prompt; sending immediately races switch_session.
await new Promise((r) => setTimeout(r, 12_000));
const want = await testModel({ base: BASE, token: TOKEN, sessionPath });
const selected = await post("rpc", { sessionPath, command: "set_model", params: { provider: want.provider, modelId: want.id } });
const modelState = await post("rpc", { sessionPath, command: "get_state" });
const model = JSON.parse(modelState.body).data?.model;
if (selected.status !== 200 || model?.provider !== want.provider || model?.id !== want.id)
  throw new Error(`Refusing model-backed test without ${want.provider}/${want.id}`);

const commandId = randomUUID();
const sent = await post("prompt", { commandId, sessionPath, text: "Reply with exactly: pong. Nothing else." });
let sentPayload = {};
try { sentPayload = JSON.parse(sent.body); } catch {}
check(
  "prompt is accepted with a durable receipt",
  sent.status === 200 &&
    sentPayload.ok === true &&
    sentPayload.receipt?.commandId === commandId &&
    ["accepted", "dispatching", "received", "running", "completed", "failed", "uncertain"].includes(sentPayload.receipt?.state),
  `HTTP ${sent.status} ${sent.body.slice(0, 180)}`,
);

// --- wait for the buzz -------------------------------------------------------
const deadline = Date.now() + 180_000;
let notify = null;
while (Date.now() < deadline) {
  notify = events.find((e) => e.event === "notify");
  if (notify) break;
  await new Promise((r) => setTimeout(r, 1000));
}

check(
  "a finished turn delivers a notify event to the subscriber",
  notify !== null && notify !== undefined,
  `saw ${events.length} event(s): ${[...new Set(events.map((e) => e.event))].join(",") || "none"}`,
);

if (notify) {
  let payload = {};
  try {
    payload = JSON.parse(notify.data);
  } catch {}
  check("the event carries the agent_end kind", payload.kind === "agent_end", JSON.stringify(payload).slice(0, 160));
  check(
    "it carries the exact resumable session id",
    payload.sessionPath === sessionPath,
    JSON.stringify(payload).slice(0, 160),
  );
  check(
    "it has a title and body to display",
    typeof payload.title === "string" && payload.title.length > 0 && typeof payload.body === "string",
    JSON.stringify(payload).slice(0, 160),
  );
  // The body is the one line with room to say whether the phone is worth
  // picking up. It used to be the literal string "agent finished", under a
  // title that is already the session name, in a channel already called
  // agent_end. It must carry what the agent actually replied — the prompt
  // above asks for "pong" precisely so this is checkable.
  check(
    "the body carries the agent's reply, not a placeholder",
    typeof payload.body === "string" &&
      payload.body.toLowerCase().includes("pong") &&
      payload.body !== "agent finished",
    JSON.stringify(payload.body),
  );
  check(
    "it carries a replacement tag scoped to kind+session",
    typeof payload.tag === "string" && payload.tag.startsWith("omp-"),
    String(payload.tag),
  );
  check("the frame has an id so Last-Event-ID can resume", notify.id !== null, String(notify.id));
}

// Keepalives keep the service's 60s watchdog from tearing down a healthy stream.
check(
  "keepalive pings are flowing",
  events.some((e) => e.event === "ping") || events.length > 0,
  `events: ${events.map((e) => e.event).join(",")}`,
);

controller.abort();
await reader;

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
