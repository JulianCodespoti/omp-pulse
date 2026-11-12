#!/usr/bin/env node
// Notification-tap deep link carries the push kind into the WebView.
//
// A needs_input tap must land in the chat WITH the answer sheet openable:
// the daemon puts `kind` in the intent extras, MainActivity appends it as
// `&k=` to the hash, and ChatScreen auto-opens the sheet for needs_input.
// Without the `&k=` leg the tap lands in chat and the sheet never opens —
// and nothing else can see it, because the bridge only exists in the shell.
//
//   e2e/with-test-daemon.sh e2e/with-emulator.sh node e2e/android/verify-answer-intent.mjs
//
// Asserts the native half (URL hash carries k=needs_input after an intent
// carrying kind). The sheet itself is web UI, covered by browser suites.
// Exit code = number of failures.

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";

const SERIAL = process.env.OMP_PULSE_EMU_SERIAL;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!SERIAL || !TOKEN || !SESSIONS) {
  console.error("run through: e2e/with-test-daemon.sh e2e/with-emulator.sh node e2e/android/verify-answer-intent.mjs");
  process.exit(2);
}
const ADB = `${process.env.HOME}/Android/Sdk/platform-tools/adb`;
const adb = (...args) => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8" });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixture session to land in. Content is irrelevant — only the hash matters.
const CWD = "/tmp/omp-answer-intent-cwd";
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-answer-intent`;
mkdirSync(dir, { recursive: true });
const fixture = `${dir}/2026-08-22T10-00-00-000Z_019ff402-0000-7000-0000-00000019a0bc.jsonl`;
writeFileSync(
  fixture,
  [
    { type: "session", id: "019ff402-0000-7000-0000-00000019a0bc", cwd: CWD, title: "Answer intent fixture" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);

// Pair + open the app first so the intent lands in a warm WebView.
const unix0 = adb("shell", "cat", "/proc/net/unix");
const sock0 = [...unix0.matchAll(/@?(webview_devtools_remote_\d+)/g)].map((m) => m[1])[0];
if (!sock0) {
  console.log("FAIL  no WebView socket — is the app installed and opened?");
  process.exit(1);
}

// Replicate the notification tap: sessionPath + kind extras, like
// NotificationHelper.buildContentPendingIntent assembles them.
try {
  adb(
    "shell", "am", "start", "-n", "com.omppulse.app/.MainActivity",
    "--es", "sessionPath", fixture,
    "--es", "kind", "needs_input",
  );
} catch (e) {
  check("tap intent accepted", false, String(e).slice(0, 120));
}

// Attach CDP to the WebView (same pattern as verify-native.mjs: fresh
// socket pick per attempt, every call individually timed out).
const listTargets = async () => {
  try {
    const res = await fetch("http://127.0.0.1:9223/json/list", { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return [];
  }
};
let target = null;
for (let i = 0; i < 8 && target === null; i++) {
  const unix = adb("shell", "cat", "/proc/net/unix");
  const found = [...unix.matchAll(/@?(webview_devtools_remote_\d+)/g)].map((m) => m[1]);
  for (const candidate of found) {
    try { adb("forward", "--remove", "tcp:9223"); } catch {}
    adb("forward", "tcp:9223", `localabstract:${candidate}`);
    const list = await listTargets();
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
    if (target) break;
  }
  if (!target) await wait(2000);
}
check("the WebView exposes an inspectable page", target !== null);
if (target === null) {
  console.log(`\n${failures} failed`);
  process.exit(failures);
}
// The forward can race the socket: retry the handshake on fresh picks.
let ws = null;
for (let i = 0; i < 5 && ws === null; i++) {
  try {
    const w = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("devtools websocket did not open")), 10000);
      w.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      w.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error(String(e?.message ?? e))); }, { once: true });
    });
    ws = w;
  } catch (e) {
    if (i === 4) {
      check("devtools websocket opens", false, String(e).slice(0, 120));
      console.log(`\n${failures} failed`);
      process.exit(failures);
    }
    await wait(2000);
  }
}
let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    const timer = setTimeout(() => { pending.delete(id); resolve(undefined); }, 10000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return reply?.result?.result?.value;
};
await evaluate(`localStorage.setItem("omp-remote-token", ${JSON.stringify(TOKEN)})`);

// Re-send the tap now that pairing exists, then read the URL hash.
try {
  adb(
    "shell", "am", "start", "-n", "com.omppulse.app/.MainActivity",
    "--es", "sessionPath", fixture,
    "--es", "kind", "needs_input",
  );
} catch (e) {
  check("tap intent accepted", false, String(e).slice(0, 120));
}
await wait(4000);
const hash = await evaluate("location.hash");
check("tap hash carries the session", typeof hash === "string" && hash.includes("s="), String(hash).slice(-80));
check("tap hash carries k=needs_input", typeof hash === "string" && hash.includes("k=needs_input"), String(hash).slice(-80));

ws.close();
console.log(failures === 0 ? "all checks passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
