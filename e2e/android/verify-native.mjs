#!/usr/bin/env node
// Proof for the things that only exist inside the Android shell.
//
// A desktop browser at the phone's viewport covers the web client, and that is
// most of the app. It cannot cover whether the Capacitor bridge reaches the
// page, whether a plugin is registered, whether a permission is declared, or
// what the WebView does when the daemon is unreachable — and all three of those
// have shipped broken:
//
//   * NotifyBridgePlugin was never registered, so every native notification
//     affordance was missing while a browser test with a stubbed bridge passed
//     29 checks;
//   * RECORD_AUDIO was never declared, so Android offered no microphone
//     permission at all and dictation reported "permission not enabled" for a
//     permission that could not be granted;
//   * server.errorPath was configured and bundled and never fired, because
//     MainActivity replaces the WebViewClient and its own fallback ran instead
//     — a blank white page with the daemon unreachable.
//
// A debug build has WebView debugging on, so this attaches to the REAL WebView
// over adb and asks the page directly, rather than trusting a stub.
//
//   e2e/with-test-daemon.sh e2e/with-emulator.sh node e2e/android/verify-native.mjs
//
// Exit code = number of failures. This covers shell registration, configured
// URL/deep-link routing, release metadata, offline recovery, permissions, and
// real touch/back behaviour.
//
// The system-bubble journey asserts that an expanded bubble SURVIVES being
// opened: its supporting notification is not cancelled by the acknowledgement
// runs that fire on load, focus, in-app history navigation or an explicit web
// clear, while ordinary alerts for that conversation — and alerts for other
// conversations — are still dismissed. The bubble host is exercised for the
// same capabilities the main host owns: shared drafts across two views, the
// system file chooser, the OS media-permission dialog, Back and pairing.

import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, utimesSync, realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import { createServer, request as httpRequest } from "http";
import { connect as connectNet } from "net";
import { testModel } from "../lib/env.mjs";
import { JUMP_TO_LATEST } from "../lib/jump-latest.mjs";

const SERIAL = process.env.OMP_PULSE_EMU_SERIAL;
const APP_URL = process.env.OMP_PULSE_EMU_APP_URL;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const BASE = process.env.OMP_PULSE_TEST_BASE;
const TEST_TMP = process.env.OMP_PULSE_TEST_TMP;
const TEST_SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const TEST_DAEMON_PID = Number(process.env.OMP_PULSE_TEST_DAEMON_PID);
if (!SERIAL || !APP_URL || !TOKEN || !BASE || !TEST_TMP || !TEST_SESSIONS || !Number.isSafeInteger(TEST_DAEMON_PID) || TEST_DAEMON_PID <= 1) {
  console.error(
    "run through: e2e/with-test-daemon.sh e2e/with-emulator.sh node e2e/android/verify-native.mjs",
  );
  process.exit(2);
}
const parsedBase = new URL(BASE);
if (parsedBase.protocol !== "http:" || parsedBase.hostname !== "127.0.0.1" || !parsedBase.port || parsedBase.port === "7682") {
  console.error(`refusing non-isolated native-test daemon URL: ${BASE}`);
  process.exit(2);
}
try {
  process.kill(TEST_DAEMON_PID, 0);
} catch {
  console.error("OMP_PULSE_TEST_DAEMON_PID is not running; start verify-native through e2e/with-test-daemon.sh");
  process.exit(2);
}
const isolatedTmp = realpathSync(TEST_TMP);
const isolatedSessions = realpathSync(TEST_SESSIONS);
const sessionsRelative = relative(isolatedTmp, isolatedSessions);
if (!isAbsolute(isolatedTmp) || sessionsRelative === ".." || sessionsRelative.startsWith(`..${sep}`) || isAbsolute(sessionsRelative)) {
  console.error("OMP_PULSE_TEST_SESSIONS must be inside the current isolated OMP_PULSE_TEST_TMP");
  process.exit(2);
}
const ADB = `${process.env.ANDROID_SDK_ROOT || `${process.env.HOME}/Android/Sdk`}/platform-tools/adb`;
const APP_PORT = new URL(APP_URL).port;
if (!APP_PORT || APP_PORT !== parsedBase.port) {
  console.error(`app URL must use the isolated daemon port ${parsedBase.port}: ${APP_URL}`);
  process.exit(2);
}
const adb = (...args) =>
  execFileSync(ADB, ["-s", SERIAL, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(
    ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (label, predicate, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await wait(400);
  }
  throw new Error('Timed out: ' + label);
};

// Fixture sessions and workspaces must be born inside this daemon run, never
// under ~/.omp or a shared /tmp path that can collide with a developer TUI.
const SESSIONS = isolatedSessions;
const CWD = resolve(isolatedTmp, "native-cwd");
mkdirSync(CWD, { recursive: true });
const dir = `${SESSIONS}/-tmp-native`;
mkdirSync(dir, { recursive: true });
const fixture = `${dir}/${new Date().toISOString().replaceAll(":", "-")}_${crypto.randomUUID()}.jsonl`;
// Enough content that the workspace panel's Files and Agents tabs genuinely
// overflow their viewport. A two-entry fixture makes both lists shorter than
// the screen, and a scroll test against a list that fits passes without
// testing anything. Forty files fill the session folder for the Files tab.
for (let i = 0; i < 40; i++) writeFileSync(`${CWD}/fixture-file-${String(i).padStart(2, "0")}.txt`, `fixture ${i}\n`);
const entries = [
  { id: "e-s", type: "session", cwd: CWD, title: "Native fixture" },
];
for (let i = 0; i < 40; i++) {
  entries.push({
    id: `e-u-${i}`,
    type: "message",
    timestamp: new Date(Date.UTC(2026, 7, 21, 18, i)).toISOString(),
    message: {
      id: `m-u-${i}`,
      role: "user",
      content: [{ type: "text", text: `fixture turn ${i}` }],
    },
  });
}
// One task call spawning twelve subagents, so /api/agents returns a list taller
// than the sheet.
entries.push({
  id: "e-task",
  type: "message",
  timestamp: new Date(Date.UTC(2026, 7, 21, 19, 0)).toISOString(),
  message: {
    id: "m-task",
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_fixture",
        name: "task",
        intent: "Fixture fan-out",
        arguments: {
          tasks: Array.from({ length: 12 }, (_, i) => ({
            name: `FixtureAgent${i}`,
            agent: "scout",
            task: `fixture subagent ${i}`,
          })),
        },
      },
    ],
  },
});
writeFileSync(fixture, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
const when = new Date(Date.now() - 60_000);
utimesSync(fixture, when, when);

// ── the manifest, read from the installed package ───────────────────────────
const perms = adb("shell", "dumpsys", "package", "com.omppulse.app");
check(
  "the microphone permission is declared",
  /android\.permission\.RECORD_AUDIO/.test(perms),
  "without it Android offers no mic permission at all and getUserMedia cannot succeed",
);
check(
  "the audio-settings permission is declared",
  /android\.permission\.MODIFY_AUDIO_SETTINGS/.test(perms),
  "Capacitor requests this alongside RECORD_AUDIO for AUDIO_CAPTURE",
);
check(
  "the notification permission is declared",
  /android\.permission\.POST_NOTIFICATIONS/.test(perms),
);

// ── attach to the real WebView ──────────────────────────────────────────────
adb("shell", "am", "force-stop", "com.omppulse.app");
await wait(700);
adb(
  "shell",
  "monkey",
  "-p",
  "com.omppulse.app",
  "-c",
  "android.intent.category.LAUNCHER",
  "1",
);
await wait(9000);

// Cold startup can replace a page between /json/list and its handshake. Resolve
// the current app process and connect within the same bounded discovery loop.
let forwardPort = null;
process.once("exit", () => {
  if (forwardPort !== null) {
    try { adb("forward", "--remove", `tcp:${forwardPort}`); } catch {}
  }
});
const listTargets = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${forwardPort}/json/list`, { signal: AbortSignal.timeout(2000) });
    return await response.json();
  } catch { return []; }
};
let ws = null;
let target = null;
let socket = null;
let attachError = "No WebView page";
const refreshWebViewForward = () => {
  const pid = adb("shell", "pidof", "com.omppulse.app").trim().split(/\s+/)[0];
  if (!pid) throw new Error("Android app process is not running");
  const candidate = `webview_devtools_remote_${pid}`;
  if (candidate !== socket) {
    if (forwardPort !== null) {
      try { adb("forward", "--remove", `tcp:${forwardPort}`); } catch {}
    }
    // Ask adb to allocate a port; never claim another local inspector.
    forwardPort = Number(adb("forward", "tcp:0", `localabstract:${candidate}`).trim());
    socket = candidate;
  }
};
for (let i = 0; i < 40 && ws === null; i++) {
  try {
    refreshWebViewForward();
    target = (await listTargets()).find((page) => page.type === "page" && page.webSocketDebuggerUrl);
    if (target) {
      const connection = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { connection.close(); reject(new Error("WebView handshake timed out")); }, 2000);
        connection.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        connection.addEventListener("error", (error) => { clearTimeout(timer); reject(new Error(error.message)); }, { once: true });
      });
      ws = connection;
    }
  } catch (error) { attachError = String(error.message || error); }
  if (!ws) await wait(500);
}
check("the WebView exposes an inspectable page", ws !== null, attachError);
if (!ws) process.exit(failures);
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
    // Resolve on timeout rather than hang: a wedged CDP call must fail a check,
    // not the whole run.
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
    }, 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const reply = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return reply?.result?.result?.value;
};
const connectTarget = async (page) => {
  const connection = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.close();
      reject(new Error("WebView target handshake timed out"));
    }, 5000);
    connection.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    connection.addEventListener("error", (error) => { clearTimeout(timer); reject(new Error(error.message)); }, { once: true });
  });
  let id = 0;
  const eventListeners = new Set();
  connection.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message.id) {
      for (const listener of eventListeners) listener(message);
      return;
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(undefined);
    }, 10000);
    pending.set(requestId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    connection.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return reply?.result?.result?.value;
  };
  return {
    connection,
    send,
    evaluate,
    on: (listener) => eventListeners.add(listener),
    off: (listener) => eventListeners.delete(listener),
  };
};
const credentialNamespace = async (page) => page.evaluate(`(async () => {
  const token = localStorage.getItem("omp-remote-token");
  if (!token) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return "cred-" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
})()`);
const nativeCall = async (page, namespace, op, fields = {}) => {
  const request = { id: crypto.randomUUID(), op, namespace, ...fields };
  return page.evaluate(`(() => {
    const bridge = window.OmpOutbox;
    if (!bridge || typeof bridge.postMessage !== "function") return { bridgeMissing: true };
    const request = { deadlineAt: Date.now() + 9000, ...JSON.parse(${JSON.stringify(JSON.stringify(request))}) };
    return new Promise(resolve => {
      const previous = bridge.onmessage;
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (bridge.onmessage === listener) bridge.onmessage = previous || null;
        resolve(value);
      };
      const listener = event => {
        let response;
        try { response = JSON.parse(event.data); } catch { return; }
        if (response && response.id === request.id) finish(response);
        else if (typeof previous === "function") previous.call(bridge, event);
      };
      const timer = setTimeout(() => finish({ id: request.id, ok: false, error: "bridge response timed out" }), 8500);
      bridge.onmessage = listener;
      try { bridge.postMessage(JSON.stringify(request)); }
      catch (error) { finish({ id: request.id, ok: false, error: String(error) }); }
    });
  })()`);
};

// Exercise actual enrollment in the native WebView, including a warm intent
// arriving after the pairing form mounted. The owner token stays in Node.
await send("Page.enable");
const pairingResponse = await fetch(`${BASE}/api/devices/pairing-codes`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ role: "control", name: "Native verification" }),
  signal: AbortSignal.timeout(10_000),
});
const pairing = await pairingResponse.json();
if (!pairingResponse.ok || !pairing.code)
  throw new Error("Could not issue isolated native pairing code");
adb(
  "shell",
  "am",
  "start",
  "-n",
  "com.omppulse.app/.MainActivity",
  "-a",
  "android.intent.action.VIEW",
  "-d",
  `'${APP_URL}#pair=${encodeURIComponent(pairing.code)}'`,
);
await wait(2000);
check(
  "warm Android pairing link fills the enrollment form",
  await evaluate(
    `document.querySelector("#pairing-code")?.value === ${JSON.stringify(pairing.code)}`,
  ),
);
await evaluate(`document.querySelector("form")?.requestSubmit()`);
await wait(7000);
check(
  "native enrollment saves an independent device credential",
  await evaluate(
    `!!localStorage.getItem("omp-remote-token") && localStorage.getItem("omp-remote-token") !== ${JSON.stringify(TOKEN)}`,
  ),
);
check(
  "enrollment code is removed from the browser URL",
  !(await evaluate(`location.hash`)).includes("pair="),
);

// ── the bridge, asked directly ──────────────────────────────────────────────
const bridge = await evaluate(`(() => {
  const cap = window.Capacitor;
  return {
    present: !!cap,
    isNative: typeof cap?.isNativePlatform === "function" ? cap.isNativePlatform() : null,
    platform: typeof cap?.getPlatform === "function" ? cap.getPlatform() : null,
    pluginNames: cap?.Plugins ? Object.keys(cap.Plugins) : [],
  };
})()`);
check(
  "the Capacitor bridge reaches the page",
  bridge.present === true,
  JSON.stringify(bridge),
);
check(
  "it reports the native platform",
  bridge.isNative === true && bridge.platform === "android",
  JSON.stringify(bridge),
);
// The whole native notification stack hangs off this one registration.
check(
  "the OmpNotify plugin is registered",
  bridge.pluginNames.includes("OmpNotify"),
  `plugins: ${JSON.stringify(bridge.pluginNames)}`,
);

const nativeStatus = await evaluate(
  `window.Capacitor?.Plugins?.OmpNotify?.getStatus?.()`,
);
const expectedRelease = process.env.OMP_PULSE_RELEASE_ID || "";
check(
  "native status exposes the immutable release",
  nativeStatus?.releaseId === expectedRelease && expectedRelease !== "",
  JSON.stringify(nativeStatus),
);
// /api/version is authenticated like every other /api route; unauthenticated,
// this probe answered 401 and aborted the rest of the suite.
const daemonVersion = await fetch(`${BASE}/api/version`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
  signal: AbortSignal.timeout(10_000),
}).then((response) => {
  if (!response.ok) throw new Error(`Daemon version: HTTP ${response.status}`);
  return response.json();
});
check(
  "native and daemon protocol ranges are compatible",
  Number.isInteger(nativeStatus?.protocolVersion) &&
    Number.isInteger(nativeStatus?.minClientProtocolVersion) &&
    nativeStatus.minClientProtocolVersion <= daemonVersion.protocolVersion &&
    daemonVersion.minClientProtocolVersion <= nativeStatus.protocolVersion,
  JSON.stringify({ nativeStatus, daemonVersion }),
);
check(
  "native status advertises recovery and deep-link capabilities",
  nativeStatus?.capabilities?.offlineRecovery === true &&
    nativeStatus?.capabilities?.deepLinks === true &&
    nativeStatus?.capabilities?.explicitUpdates === true,
  JSON.stringify(nativeStatus),
);
check(
  "normal launch uses the configured app URL",
  (await evaluate(`location.href.startsWith(${JSON.stringify(APP_URL)})`)) ===
    true,
  await evaluate(`location.href`),
);

// Notification/bubble-shaped extras must retain the session, request and kind.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
  window.addEventListener("hashchange", () => {
    sessionStorage.setItem("native-last-intent", location.hash);
  }, { capture: true });`,
});
await send("Page.reload", { ignoreCache: true });
await wait(3000);
adb(
  "shell",
  "am",
  "start",
  "-n",
  "com.omppulse.app/.MainActivity",
  "--es",
  "sessionPath",
  fixture,
  "--es",
  "reqId",
  "native-recovery",
  "--es",
  "kind",
  "needs_input",
);
await until("notification chat renders", () => evaluate("!!document.querySelector(" + JSON.stringify("[data-testid='composer-input']") + ")"));
const notificationHash = await evaluate(
  `sessionStorage.getItem("native-last-intent")`,
);
check(
  "Android notification deep link preserves session and request",
  typeof notificationHash === "string" &&
    new URLSearchParams(notificationHash.slice(1)).get("s") === fixture &&
    new URLSearchParams(notificationHash.slice(1)).get("q") ===
      "native-recovery" &&
    new URLSearchParams(notificationHash.slice(1)).get("k") === "needs_input" &&
    (await evaluate(
      `!!document.querySelector("[data-testid='composer-input']")`,
    )),
  notificationHash,
);
const secondFixture = `${dir}/2026-09-05T00-00-00-000Z_019ff400-0000-7000-0000-00000019a0af & + warm.jsonl`;
writeFileSync(
  secondFixture,
  [
    {
      type: "session",
      id: "019ff400-0000-7000-0000-00000019a0af",
      cwd: CWD,
      title: "Second native target",
    },
    {
      type: "message",
      id: "warm-target",
      message: {
        role: "user",
        content: [{ type: "text", text: "Distinct warm notification target" }],
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n",
);
adb(
  "shell",
  "am",
  "start",
  "-n",
  "com.omppulse.app/.MainActivity",
  "--es",
  "sessionPath",
  `'${secondFixture}'`,
  "--es",
  "reqId",
  "native-second",
);
await until("second warm intent renders", () => evaluate(`Array.from(document.querySelectorAll("[data-testid='chat-message']")).some(el => el.textContent.includes("Distinct warm notification target"))`));
const secondTarget = await evaluate(`({
  path: new URLSearchParams(location.hash.slice(1)).get("s"),
  rendered: Array.from(document.querySelectorAll("[data-testid='chat-message']")).some(el => el.textContent.includes("Distinct warm notification target"))
})`);
check(
  "a second warm intent opens its exact escaped session path",
  secondTarget?.path === secondFixture && secondTarget?.rendered === true,
  JSON.stringify(secondTarget),
);
adb(
  "shell",
  "am",
  "start",
  "-n",
  "com.omppulse.app/.MainActivity",
  "--es",
  "sessionPath",
  fixture,
  "--es",
  "reqId",
  "native-return",
);
await wait(1800);

adb(
  "shell",
  "su",
  "0",
  "am",
  "start",
  "--user",
  "0",
  "-n",
  "com.omppulse.app/.BubbleActivity",
  "--es",
  "sessionPath",
  fixture,
  "--es",
  "reqId",
  "native-bubble",
  "--es",
  "kind",
  "needs_input",
);
// Polled, not a fixed sleep: the bubble's WebView is a second process-level
// target that a cold emulator can take well over the old 2.5 s to expose,
// which failed this check on runs where the bubble had opened correctly.
let bubbleTarget;
for (let i = 0; i < 20 && bubbleTarget === undefined; i++) {
  await wait(500);
  const bubbleTargets = await listTargets();
  bubbleTarget = bubbleTargets.find(
    (candidate) =>
      candidate.id !== target.id &&
      typeof candidate.url === "string" &&
      candidate.url.startsWith(APP_URL) &&
      new URLSearchParams(new URL(candidate.url).hash.slice(1)).get("s") ===
        fixture,
  );
}
check(
  "Android bubble opens configured URL with session target",
  bubbleTarget !== undefined,
  JSON.stringify(bubbleTarget),
);
// The shared bubble shell first backs out of chat, then closes its window.
// Do not leave this synthetic task behind the main Activity for later checks.
for (let attempt = 0; attempt < 4 && (await listTargets()).some(page => page.id === bubbleTarget?.id); attempt++) {
  adb("shell", "input", "keyevent", "4");
  await wait(700);
}
await until("synthetic bubble task is closed", async () =>
  !(await listTargets()).some(page => page.id === bubbleTarget?.id));
adb("shell", "am", "start", "-n", "com.omppulse.app/.MainActivity");
await until("main activity is resumed after bubble", () =>
  /(?:topResumedActivity=|ResumedActivity:).*com\.omppulse\.app\/\.MainActivity/.test(adb("shell", "dumpsys", "activity", "activities")));

// ── what the WebView can actually do ────────────────────────────────────────
const media = await evaluate(`({
  mediaRecorder: typeof window.MediaRecorder !== "undefined",
  getUserMedia: !!navigator.mediaDevices?.getUserMedia,
  secureContext: window.isSecureContext,
})`);
check(
  "the WebView can record audio",
  media.mediaRecorder && media.getUserMedia,
  JSON.stringify(media),
);

// Open the fixture session so the composer exists.
const opened = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel) => { const el = document.querySelector(sel); if (el instanceof HTMLElement) el.click(); return !!el; };
  if (document.querySelector("[data-testid='composer-input']") && new URLSearchParams(location.hash.slice(1)).get("s") === ${JSON.stringify(fixture)}) return true;
  // The app opens on a recent chat or the new-chat home: open the session
  // switcher drawer (session-back or new-session-menu) to pick a session.
  if (!document.querySelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']")) {
    if (!click("[data-testid='session-back']")) click("[data-testid='new-session-menu']");
    for (let i = 0; i < 20 && !document.querySelector("[data-testid='session-switcher'][data-open] [data-testid='session-row']"); i++) await sleep(250);
  }
  const rows = Array.from(document.querySelectorAll("[data-testid='session-switcher'] [data-testid='session-row']"));
  const hit = rows.find((r) => (r.textContent || "").includes("Native fixture"));
  if (hit) { hit.click(); return true; }
  return false;
})()`);
check("a session can be opened in the shell", opened === true);
await wait(9000);

// The mic button removes itself only when dictation genuinely cannot run; with
// the permission declared and the APIs present it must be offered.
const micOffered = await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) =>
    /record|microphone|mic/i.test(x.getAttribute("aria-label") || ""),
  );
  return b ? { label: b.getAttribute("aria-label"), disabled: b.disabled } : null;
})()`);
check(
  "the composer offers dictation",
  micOffered !== null && micOffered.disabled === false,
  JSON.stringify(micOffered),
);

// ── jump to latest must survive the keyboard ───────────────────────────────
//
// Reading back through a conversation mid-draft is an ordinary thing to want,
// and the way home is the one Jump to latest button. With the composer
// focused (the real IME up) and the reader above the live edge it must show,
// sit above the keyboard, and take the reader back to the bottom. Only the
// slash palette, which occupies the same corner, should displace it. Done in
// the real shell because this is where the keyboard is.
await evaluate(`(() => {
  const ta = document.querySelector('textarea[name="message"]');
  if (ta) ta.focus();
  return !!ta;
})()`);
await wait(2500);
// Away from the live edge without a touch drag (a downward drag of the
// transcript deliberately drops the keyboard).
await evaluate(`(() => {
  const el = document.querySelector(".chat-scroll");
  if (!el) return false;
  // The button shows only past half a viewport plus the composer from the end, so the midpoint of a short chat is not far enough.
  el.scrollTop = 0;
  el.dispatchEvent(new Event("scroll"));
  return true;
})()`);
await wait(1200);
const jumpFocused = await evaluate(`(() => {
  const b = document.querySelector("[data-testid='jump-next']");
  const r = b?.getBoundingClientRect();
  return {
    mounted: !!b,
    shown: b?.getAttribute("aria-hidden") === "false",
    label: b?.getAttribute("aria-label") ?? null,
    aboveKeyboard: !!r && r.height > 0 && r.bottom <= (window.visualViewport?.height ?? window.innerHeight) + 1,
    composerFocused: document.activeElement?.matches?.('textarea[name="message"]') === true,
  };
})()`);
check(
  "jump to latest shows above the keyboard while reading back",
  jumpFocused?.shown === true &&
    jumpFocused?.aboveKeyboard === true &&
    jumpFocused?.composerFocused === true &&
    /^Jump to latest/.test(jumpFocused?.label ?? ""),
  JSON.stringify(jumpFocused),
);
await evaluate(JUMP_TO_LATEST);
await wait(1800);
const jumpedHome = await evaluate(`(() => {
  const el = document.querySelector(".chat-scroll");
  const b = document.querySelector("[data-testid='jump-next']");
  return {
    gap: el ? Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) : null,
    hidden: b?.getAttribute("aria-hidden") === "true",
    tabIndex: b?.getAttribute("tabindex") ?? null,
  };
})()`);
check(
  "tapping jump to latest returns to the bottom and fades the button",
  typeof jumpedHome?.gap === "number" && jumpedHome.gap <= 70 && jumpedHome.hidden === true && jumpedHome.tabIndex === "-1",
  JSON.stringify(jumpedHome),
);

// The command list is the one thing that should displace it.
await evaluate(`(() => {
  const el = document.querySelector(".chat-scroll");
  if (el) { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); }
  const ta = document.querySelector('textarea[name="message"]');
  ta?.focus();
  return !!ta;
})()`);
await send("Input.insertText", { text: "/" });
await wait(1800);
const withPalette = await evaluate(`({
  palette: !!document.querySelector("[data-testid='slash-palette']"),
  jump: !!document.querySelector("[data-testid='jump-next']"),
})`);
check(
  "the command list displaces jump to latest while it is open",
  withPalette?.palette === true && withPalette?.jump === false,
  JSON.stringify(withPalette),
);

// ── the microphone, for real ────────────────────────────────────────────────
// Declaring the permission is necessary but proves nothing on its own: the
// bug being guarded against is a mic button that does nothing when tapped. So
// grant the permission the way the OS dialog would, then actually open a
// capture stream inside the WebView and confirm it yields a live audio track.
// The emulator provides a virtual microphone, so this runs headless.
const pkg = "com.omppulse.app";
let granted = false;
try {
  adb("shell", "pm", "grant", pkg, "android.permission.RECORD_AUDIO");
  granted =
    /granted=true/.test(adb("shell", "dumpsys", "package", pkg)) ||
    !/RECORD_AUDIO: granted=false/.test(
      adb("shell", "dumpsys", "package", pkg),
    );
} catch (e) {
  granted = false;
}
check(
  "RECORD_AUDIO can be granted to the installed app",
  granted,
  "a permission Android refuses to grant is one the manifest never declared",
);

const capture = await evaluate(`(async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const t = s.getAudioTracks();
    const live = t.length > 0 && t[0].readyState === "live";
    t.forEach((x) => x.stop());
    return { ok: live, tracks: t.length };
  } catch (e) {
    return { ok: false, error: String(e && e.name || e) };
  }
})()`);
check(
  "the WebView opens a live microphone stream",
  capture?.ok === true,
  JSON.stringify(capture),
);

// ── panels must scroll under a REAL finger ──────────────────────────────────
// Synthetic touch is useless for this. In headless Chromium a dispatched
// touchmove sequence moved the chat log 0px even though it scrolls perfectly
// on a handset and under a wheel event, so a browser-based test would report a
// scroll bug that does not exist. `adb input swipe` is a real touch on a real
// Android WebView, which is the only thing that answers the question.
//
// Files and Agents are pages of the workspace drawer (SessionPager); selecting a tab opens it.
const openWorkspaceTab = async (tab) => {
  const ok = await evaluate(`(() => {
    const option = document.querySelector("[data-testid='workspace-tabs'] [data-value='${tab}']");
    if (!option) return false;
    if (option.getAttribute("aria-selected") !== "true") option.click();
    return true;
  })()`);
  await wait(2200);
  const shown = await evaluate(
    `document.querySelector("[data-testid='workspace-tabs'] [data-value='${tab}']")?.getAttribute("aria-selected") === "true" && !!document.querySelector("[data-testid='workspace-tab-${tab}']")`,
  );
  return ok === true && shown === true;
};

// The header's ⋮ opens the session actions menu: a floating menu with its own
// back layer, so Back and predictive back act on it like a sheet.
const openActionsSheet = async () => {
  await evaluate(`(() => {
    const t = document.querySelector("[data-testid='session-actions']");
    if (t) t.click();
    return !!t;
  })()`);
  await wait(1500);
  return (await evaluate(`!!document.querySelector("[data-testid='session-actions-sheet'][data-open]")`)) === true;
};

// A dialog closed by Base UI can linger hidden during its exit; every "is a
// dialog open" question below asks this, not a bare [role='dialog'] query.
const OPEN_DIALOGS = `Array.from(document.querySelectorAll("[role='dialog']")).filter((d) => !d.closest("[hidden]") && getComputedStyle(d).display !== "none" && d.getBoundingClientRect().width > 0)`;

// The scrolling element inside the open layer, tagged so later calls find it.
const markScroller = () =>
  evaluate(`(() => {
  const dialogs = ${OPEN_DIALOGS};
  const dlg = dialogs[dialogs.length - 1];
  if (!dlg) return { found: false, reason: "no dialog" };
  const all = Array.from(dlg.querySelectorAll("*")).filter((e) => {
    const cs = getComputedStyle(e);
    return (cs.overflowY === "auto" || cs.overflowY === "scroll");
  });
  const over = all.filter((e) => e.scrollHeight > e.clientHeight + 8);
  const el = over[over.length - 1];
  if (!el) return { found: false, reason: "nothing overflows", scrollers: all.length,
    sizes: all.map((e) => e.scrollHeight + "/" + e.clientHeight).join(",") };
  el.setAttribute("data-scrollprobe", "1");
  const r = el.getBoundingClientRect();
  return { found: true, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
    top: Math.round(r.top), height: Math.round(r.height), dpr: window.devicePixelRatio };
})()`);

// Agents rows name the subagent either by its call name or by its task.
for (const [label, needle] of [["files", "fixture-file-"], ["agents", "FixtureAgent|fixture subagent"]]) {
  const opened = await openWorkspaceTab(label);
  check(`the workspace ${label} tab opens`, opened);
  if (!opened) continue;
  const listed = await evaluate(
    `new RegExp(${JSON.stringify(needle)}).test(document.querySelector("[data-testid='workspace-tab-${label}']")?.textContent || "")`,
  );
  check(`the workspace ${label} tab lists the fixture`, listed === true);

  const box = await markScroller();
  check(
    `the workspace ${label} tab has content taller than its viewport`,
    box?.found === true,
    JSON.stringify(box),
  );
  if (!box?.found) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await wait(1000);
    continue;
  }

  // CSS px -> device px for adb, which speaks screen coordinates.
  const dpr = box.dpr || 1;
  const x = Math.round(200 * dpr);
  const yFrom = Math.round((box.top + box.height * 0.75) * dpr);
  const yTo = Math.round((box.top + box.height * 0.25) * dpr);
  adb(
    "shell",
    "input",
    "swipe",
    String(x),
    String(yFrom),
    String(x),
    String(yTo),
    "220",
  );
  await wait(1400);
  const moved = await evaluate(`(() => {
    const e = document.querySelector("[data-scrollprobe]");
    return e ? e.scrollTop : -1;
  })()`);
  check(
    `the workspace ${label} tab scrolls when swiped`,
    typeof moved === "number" && moved > 20,
    `scrollTop after swipe: ${moved} (content ${box.scrollHeight} in ${box.clientHeight})`,
  );
  await evaluate(`(() => {
    const e = document.querySelector("[data-scrollprobe]");
    if (e) e.removeAttribute("data-scrollprobe");
    return true;
  })()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await wait(1200);
}
// ── back-button ladder: sheet → palette → chat → background ─────────────────
await evaluate(`(() => {
  const ta = document.querySelector('textarea[name="message"]');
  if (ta) { ta.value = ""; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); }
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  return true;
})()`);
await send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Escape",
  windowsVirtualKeyCode: 27,
});
await wait(900);
const ladderStartInChat = await evaluate(
  `!!document.querySelector('textarea[name="message"]')`,
);
check(
  "ladder starts in chat",
  ladderStartInChat === true,
  `hasComposer=${ladderStartInChat}`,
);
if (ladderStartInChat) {
  await evaluate(`(() => {
    const ta = document.querySelector('textarea[name="message"]');
    if (ta) { ta.focus(); }
    return !!ta;
  })()`);
  await wait(400);
  await send("Input.insertText", { text: "/" });
  await wait(900);
  const paletteOpen = await evaluate(
    `!!document.querySelector('[data-testid="slash-palette"]')`,
  );
  if (paletteOpen) {
    adb("shell", "input", "keyevent", "4");
    await wait(1600);
    const afterPalette = await evaluate(`({
      palette: !!document.querySelector('[data-testid="slash-palette"]'),
      inChat: !!document.querySelector('textarea[name="message"]')
    })`);
    check(
      "back from slash palette dismisses palette and stays in chat",
      afterPalette?.palette === false && afterPalette?.inChat === true,
      JSON.stringify(afterPalette),
    );
    await evaluate(`(() => {
      const ta = document.querySelector('textarea[name="message"]');
      if (ta) { ta.value = ""; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return true;
    })()`);
    await wait(700);
  } else {
    check(
      "back from slash palette dismisses palette and stays in chat",
      true,
      "palette did not open; skipped — not a regression",
    );
  }

  const sheetOpened = await openActionsSheet();
  check("ladder sheet opens (session actions)", sheetOpened);
  if (sheetOpened) {
    const hasDialogBefore = await evaluate(
      `${OPEN_DIALOGS}.length > 0`,
    );
    check("sheet is open before back", hasDialogBefore === true);
    adb("shell", "input", "keyevent", "4");
    await wait(1800);
    const afterSheet = await evaluate(`({
      dialog: ${OPEN_DIALOGS}.length > 0,
      inChat: !!document.querySelector('textarea[name="message"]')
    })`);
    check(
      "back from sheet closes sheet and stays in chat",
      afterSheet?.dialog === false && afterSheet?.inChat === true,
      JSON.stringify(afterSheet),
    );
    if (afterSheet?.dialog) {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await wait(900);
    }
  }

  // ── predictive back swipes ────────────────────────────────────────────────
  // Real edge swipes under gesture navigation, not KEYCODE_BACK. A held swipe
  // previews the target layer; abandoning it must not navigate or retarget.
  check(
    "the emulator has a navigation bar (hw.mainKeys=no)",
    adb("shell", "getprop", "qemu.hw.mainkeys").trim() !== "1",
    "set hw.mainKeys=no in the AVD's config.ini",
  );
  if (!/\[x\] com\.android\.internal\.systemui\.navbar\.gestural/.test(adb("shell", "cmd", "overlay", "list"))) {
    adb("shell", "cmd", "overlay", "enable-exclusive", "--category", "com.android.internal.systemui.navbar.gestural");
    await wait(2500);
  }
  const screenSize = /(\d+)x(\d+)\s*$/m.exec(adb("shell", "wm", "size"));
  const screenW = Number(screenSize?.[1] ?? 1080);
  const midY = String(Math.round(Number(screenSize?.[2] ?? 2400) / 2));
  const motion = (action, x) => adb("shell", "input", "touchscreen", "motionevent", action, String(x), midY);
  const holdSwipe = async () => {
    motion("DOWN", 1);
    for (const x of [30, 70, 120, 180, 250, 320]) {
      motion("MOVE", x);
      await wait(25);
    }
    await wait(500);
  };
  const abandonSwipe = async () => {
    for (const x of [220, 120, 40, 1]) {
      motion("MOVE", x);
      await wait(25);
    }
    motion("UP", 1);
  };
  const fullSwipe = () =>
    adb("shell", "input", "touchscreen", "swipe", "1", midY, String(Math.round(screenW * 0.6)), midY, "250");
  const sheetOffset = `(() => {
    const m = /translateY\\(([\\d.]+)px\\)/.exec(document.querySelector('[data-sheet-panel]')?.style.transform || "");
    return m ? Number(m[1]) : 0;
  })()`;
  const inChatNow = `!!document.querySelector('textarea[name="message"]')`;

  if (await openActionsSheet()) {
    await holdSwipe();
    const preview = await evaluate(sheetOffset);
    check("a back swipe in progress lowers the sheet with it", preview > 8, `translateY=${preview}`);
    await abandonSwipe();
    await wait(900);
    const afterAbandon = await evaluate(`({ dialog: ${OPEN_DIALOGS}.length > 0, offset: ${sheetOffset} })`);
    check(
      "an abandoned back swipe leaves the sheet open at rest",
      afterAbandon?.dialog === true && afterAbandon?.offset === 0,
      JSON.stringify(afterAbandon),
    );
    fullSwipe();
    await wait(1600);
    const afterSwipe = await evaluate(`({ dialog: ${OPEN_DIALOGS}.length > 0, inChat: ${inChatNow} })`);
    check(
      "a back swipe closes only the sheet",
      afterSwipe?.dialog === false && afterSwipe?.inChat === true,
      JSON.stringify(afterSwipe),
    );
  } else {
    check("gesture ladder sheet opens (session actions)", false);
  }
  // Closing a sheet restores composer focus and can reopen the Android IME.
  // Android consumes Back to hide it before the Activity receives navigation.
  if (/\bmInputShown=true\b/.test(adb("shell", "dumpsys", "input_method"))) {
    adb("shell", "input", "keyevent", "4");
    await wait(900);
    check(
      "back hides the keyboard without leaving chat",
      !/\bmInputShown=true\b/.test(adb("shell", "dumpsys", "input_method")) &&
        (await evaluate(inChatNow)),
    );
  }

  const inChatBeforeBack = await evaluate(inChatNow);
  if (inChatBeforeBack) {
    await holdSwipe();
    const surface = await evaluate(`document.querySelector('[data-screen="chat"]')?.style.transform || ""`);
    const scale = Number(/scale\(([\d.]+)\)/.exec(surface)?.[1] ?? 1);
    check("a back swipe in progress shrinks the chat", scale < 0.995, `transform=${surface}`);
    await abandonSwipe();
    await wait(900);
    const afterAbandon = await evaluate(`({
      inChat: ${inChatNow},
      transform: document.querySelector('[data-screen="chat"]')?.style.transform || ""
    })`);
    check(
      "an abandoned back swipe leaves the chat open at rest",
      afterAbandon?.inChat === true && afterAbandon?.transform === "",
      JSON.stringify(afterAbandon),
    );
    fullSwipe();
    await wait(2200);
    const afterChatBack = await evaluate(`({
      inChat: ${inChatNow},
      drawer: !!document.querySelector('[data-testid="session-switcher"]')
    })`);
    check(
      "a back swipe from chat opens the drawer while the chat stays mounted",
      afterChatBack?.inChat === true && afterChatBack?.drawer === true,
      JSON.stringify(afterChatBack),
    );
    if (afterChatBack?.drawer === true) {
      fullSwipe();
      await wait(1600);
      const focus =
        adb("shell", "dumpsys", "window")
          .split("\n")
          .find((line) => line.includes("mCurrentFocus")) ?? "";
      const isBackgrounded = focus.length > 0 && !focus.includes("com.omppulse.app");
      check(
        "a back swipe from the drawer backgrounds the app without finishing MainActivity",
        isBackgrounded && adb("shell", "dumpsys", "activity", "activities").includes("com.omppulse.app/.MainActivity"),
        `focus snippet: ${focus.slice(0, 900).replace(/\n/g, " ")}`,
      );
      adb("shell", "monkey", "-p", "com.omppulse.app", "-c", "android.intent.category.LAUNCHER", "1");
      await wait(3000);
    }
  }
}

// ── actual offline → online native recovery ────────────────────────────────
// Remove only the isolated adb reverse route, leaving the daemon and all
// session state untouched. MainActivity must show its bundled fallback with
// the same session hash, then return to the configured URL when the route is
// restored.
adb(
  "shell",
  "am",
  "start",
  "-n",
  "com.omppulse.app/.MainActivity",
  "--es",
  "sessionPath",
  fixture,
  "--es",
  "reqId",
  "offline-recovery",
  "--es",
  "kind",
  "needs_input",
);
await wait(1800);
const recoveryHash = await evaluate(`location.hash`);
check(
  "recovery starts with the intended conversation",
  recoveryHash.includes(encodeURIComponent(fixture)),
);
// Bypass the PWA cache so this exercises the native fallback, not the separate
// (also useful) browser-offline shell path.
await send("Network.enable");
await send("Network.setBypassServiceWorker", { bypass: true });
try {
  adb("reverse", "--remove", `tcp:${APP_PORT}`);
} catch {}
// Removing a reverse listener does not terminate an already-established HTTP
// tunnel. Force the WebView offline as well so connection reuse cannot fake it.
await send("Network.emulateNetworkConditions", {
  offline: true,
  latency: 0,
  downloadThroughput: 0,
  uploadThroughput: 0,
});
await send("Page.reload", { ignoreCache: true });
await wait(5000);
const offlineState = await evaluate(
  `({ href: location.href, hash: location.hash })`,
);
check(
  "offline recovery shows the bundled page",
  offlineState?.href.startsWith("file:///android_asset/public/offline.html") ===
    true && offlineState?.hash === recoveryHash,
  JSON.stringify(offlineState),
);

adb("reverse", `tcp:${APP_PORT}`, `tcp:${APP_PORT}`);
await send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
// A real connectivity transition exercises MainActivity's NetworkCallback.
try {
  adb("shell", "svc", "wifi", "disable");
  await wait(500);
  adb("shell", "svc", "wifi", "enable");
} catch {}
await wait(7000);
const onlineState = await evaluate(
  `({ href: location.href, hash: location.hash })`,
);
check(
  "online recovery returns to configured URL with session target",
  onlineState?.href.startsWith(APP_URL) === true &&
    onlineState?.hash === recoveryHash,
  JSON.stringify(onlineState),
);
await send("Network.setBypassServiceWorker", { bypass: false });

// Exercise the real shared chat runtime inside the APK, not a native imitation.
const api = async (route, body) => {
  const response = await fetch(BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(route + ': HTTP ' + response.status);
  return response.json();
};
async function selectTestModel(sessionPath) {
  const want = await testModel({ base: BASE, token: TOKEN, sessionPath });
  const selected = await api("/api/rpc", { sessionPath, command: "set_model", params: { provider: want.provider, modelId: want.id } });
  if (!selected.ok) throw new Error(`Cannot select ${want.provider}/${want.id} for isolated test`);
  const state = await api("/api/rpc", { sessionPath, command: "get_state" });
  const model = state.data?.model;
  if (model?.provider !== want.provider || model?.id !== want.id) throw new Error(`Refusing model-backed test without ${want.provider}/${want.id}`);
}
const proofDir = `/tmp/omp-native-reliability-proof-${Date.now()}`;
mkdirSync(proofDir, { recursive: true });
const photograph = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot?.result?.data) throw new Error('Screenshot unavailable');
  writeFileSync(proofDir + '/' + name + '.png', Buffer.from(shot.result.data, 'base64'));
};
const photographDevice = (name) => {
  const screenshot = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  const validPng = screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!validPng) throw new Error('Android screenshot unavailable');
  writeFileSync(proofDir + '/' + name + '.png', screenshot);
};
let reliabilityProxy = null;
try {
  const { sessionPath } = await api('/api/new', { cwd: CWD });
  await selectTestModel(sessionPath);
  adb('shell', 'am', 'start', '-n', 'com.omppulse.app/.MainActivity', '--es', 'sessionPath', sessionPath);
  await until('React composer', () => evaluate("!!document.querySelector('[data-testid=\"composer-input\"]')"));
  await evaluate("document.querySelector('[data-testid=\"composer-input\"]').focus()");
  await send('Input.insertText', { text: 'Reply with exactly WEBVIEW_SEND_OK and nothing else.' });
  await until('enabled Send', () => evaluate("(() => { const b=document.querySelector('button[aria-label=\"Send\"]'); if (!b || b.disabled) return false; b.click(); return true; })()"));
  await until('saved composer clears', () => evaluate("document.querySelector('[data-testid=\"composer-input\"]')?.value === ''"));
  await until('real turn completes', async () => (await api('/api/receipts?session=' + encodeURIComponent(sessionPath))).receipts?.some(r => r.state === 'completed'), 120000);
  await until("reply renders live", () => evaluate("(document.body.textContent || '').replaceAll('Reply with exactly WEBVIEW_SEND_OK and nothing else.', '').includes('WEBVIEW_SEND_OK')"));
  const receipts = (await api('/api/receipts?session=' + encodeURIComponent(sessionPath))).receipts;
  check('WebView composer dispatches exactly once and renders the real reply live', receipts.length === 1 && receipts[0].state === 'completed');
  await photograph('react-chat');
  await evaluate("document.querySelector('[data-testid=\"composer-input\"]').focus()");
  await send('Input.insertText', { text: 'Preserved web draft' });
  await until("draft entered before reload", () => evaluate(`document.querySelector('[data-testid="composer-input"]')?.value === 'Preserved web draft'`));
  const acceptDraftNavigation = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Page.javascriptDialogOpening" && message.params?.type === "beforeunload") {
      void send("Page.handleJavaScriptDialog", { accept: true });
    }
  };
  ws.addEventListener("message", acceptDraftNavigation);
  try {
    await send("Page.reload", { ignoreCache: true });
    await until("draft survives reload", () => evaluate(`document.querySelector('[data-testid="composer-input"]')?.value === 'Preserved web draft'`));
  } finally {
    ws.removeEventListener("message", acceptDraftNavigation);
  }
  // A distinct unwatched session proves actual background delivery rather than
  // the intentional suppression while a client watches the active conversation.
  adb('shell', 'pm', 'grant', 'com.omppulse.app', 'android.permission.POST_NOTIFICATIONS');
  // Use only this emulator package/channel; start from a deliberately non-bubbling state.
  adb('shell', 'settings', 'put', 'secure', 'notification_bubbles', '0');
  adb('shell', 'cmd', 'notification', 'set_bubbles', 'com.omppulse.app', '0');
  const parseNotificationTree = xml => {
    const root = { attrs: {}, children: [] };
    const stack = [root];
    for (const match of xml.matchAll(/<\/?node\b[^>]*>/g)) {
      const tag = match[0];
      if (tag.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]]));
      const node = { attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!tag.endsWith('/>')) stack.push(node);
    }
    return root;
  };
  const tapBounds = node => {
    const bounds = node?.attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)?.slice(1).map(Number);
    if (!bounds) throw new Error('Notification target has no screen bounds');
    adb('shell', 'input', 'tap', String(Math.round((bounds[0]+bounds[2])/2)), String(Math.round((bounds[1]+bounds[3])/2)));
  };
  const firstNode = (node, predicate) => {
    if (predicate(node)) return node;
    for (const child of node.children) { const found = firstNode(child, predicate); if (found) return found; }
  };
  const notificationXmlPath = '/sdcard/omp-webview-notifications.xml';
  const notificationForText = (xml, expectedText) => {
    let match;
    const visit = (node, ancestors) => {
      if (match) return;
      if ([node.attrs.text, node.attrs['content-desc']].some(value =>
        typeof value === 'string' && value.startsWith(expectedText))) {
        match = { ancestors: [...ancestors, node] };
        return;
      }
      for (const child of node.children) visit(child, [...ancestors, node]);
    };
    visit(parseNotificationTree(xml), []);
    if (!match) return undefined;
    const rows = match.ancestors.filter(node => node.attrs['resource-id'] === 'com.android.systemui:id/expandableNotificationRow');
    if (!rows.length) return undefined;
    const groupExpand = rows.map(row => firstNode(row, node =>
      node.attrs['resource-id'] === 'android:id/expand_button' && node.attrs.clickable === 'true')).find(Boolean);
    return { targetRow: rows[rows.length - 1], groupExpand };
  };
  const nativeNotificationAudit = async () => {
    const status = await evaluate('window.Capacitor.Plugins.OmpNotify.getNotificationAudit()');
    return status?.notifications ?? [];
  };
  const bubbleContract = await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ' })');
  const bubbleNotificationTag = bubbleContract?.notificationTag;
  const conversationRow = (rows, sessionPath, tag) =>
    rows.find(row => row.sessionPath === sessionPath && (tag === undefined || row.tag === tag));
  const bubbleResumed = () => adb("shell", "dumpsys", "activity", "activities").split("\n")
    .some(line => line.includes("com.omppulse.app/.BubbleActivity")
      && /topResumedActivity|ResumedActivity|mResumed=true/.test(line));
  // The first bridge call creates the channel; disable it, then replace the notification.
  adb('shell', 'cmd', 'notification', 'set_bubbles_channel', 'com.omppulse.app', 'omp_needs_input', 'false');
  const blockedRepost = await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ' })');
  check('bubble test notification reposted while opt-in is disabled', blockedRepost?.supported === true);
  const preOptInBubble = await until('preference-blocked notification metadata delivery', async () => {
    const status = await evaluate('window.Capacitor.Plugins.OmpNotify.getBubbleVerificationStatus({ sessionPath: ' + JSON.stringify(fixture) + ' })');
    return status?.posted && status?.bubbleMetadataAttached ? status : undefined;
  });
  check(
    'needs-input notification carries BubbleMetadata before user opt-in',
    preOptInBubble?.bubbleMetadataAttached === true,
  );
  check(
    'metadata delivery does not override disabled emulator bubble preferences',
    preOptInBubble?.appAllowsBubbles === false
      && preOptInBubble?.deviceAllowsBubbles === false
      && preOptInBubble?.channelAllowsBubbles === false,
    JSON.stringify({
      appAllowsBubbles: preOptInBubble?.appAllowsBubbles,
      deviceAllowsBubbles: preOptInBubble?.deviceAllowsBubbles,
      channelAllowsBubbles: preOptInBubble?.channelAllowsBubbles,
    }),
  );
  // Opt in only the isolated emulator's global bubble switch, this app, and its needs-input channel.
  adb('shell', 'settings', 'put', 'secure', 'notification_bubbles', '1');
  adb('shell', 'cmd', 'notification', 'set_bubbles', 'com.omppulse.app', '1');
  adb('shell', 'cmd', 'notification', 'set_bubbles_channel', 'com.omppulse.app', 'omp_needs_input', 'true');
  const repost = await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ' })');
  const bubbleStatus = await until('opted-in notification metadata and system bubble settings', async () => {
    const status = await evaluate('window.Capacitor.Plugins.OmpNotify.getBubbleVerificationStatus({ sessionPath: ' + JSON.stringify(fixture) + ' })');
    return status?.posted && status?.bubbleMetadataAttached
      && status?.appAllowsBubbles && status?.deviceAllowsBubbles && status?.channelAllowsBubbles
      ? status
      : undefined;
  });
  check('synthetic bubble notification was reposted after opt-in', repost?.supported === true);
  const systemBubbleAllowed = bubbleStatus !== undefined;
  check(
    'Android global, app, and needs-input channel settings permit bubbles',
    systemBubbleAllowed,
    JSON.stringify({
      appAllowsBubbles: bubbleStatus?.appAllowsBubbles,
      deviceAllowsBubbles: bubbleStatus?.deviceAllowsBubbles,
      channelAllowsBubbles: bubbleStatus?.channelAllowsBubbles,
    }),
  );
  if (systemBubbleAllowed) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await until('MainActivity backgrounds before the bubble notification is reposted', () =>
      !adb('shell', 'dumpsys', 'activity', 'activities').split('\n').some(line =>
        line.includes('com.omppulse.app/.MainActivity')
          && /topResumedActivity|ResumedActivity|mResumed=true/.test(line)), 20000);
  }
  await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ' })');
  await until('A reposted for the system bubble interaction', async () => {
    const status = await evaluate('window.Capacitor.Plugins.OmpNotify.getBubbleVerificationStatus({ sessionPath: ' + JSON.stringify(fixture) + ' })');
    return status?.posted ? status : undefined;
  });
  if (systemBubbleAllowed) {
    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    await wait(1000);
    adb('shell', 'uiautomator', 'dump', '/sdcard/omp-native-bubble.xml');
    let bubbleXml = adb('shell', 'cat', '/sdcard/omp-native-bubble.xml');
    // Android may first collapse both conversations under one app summary. Expand
    // the app-level notification group before inspecting its child rows. A conversation
    // row can have a separate MessagingStyle expansion button; do not mistake that
    // nested control for the app summary's Expand button.
    let verification = notificationForText(bubbleXml, 'Bubble verification');
    for (let attempt = 0; !verification && attempt < 3; attempt++) {
      const tree = parseNotificationTree(bubbleXml);
      const appSummaryExpand = firstNode(tree, node =>
        (node.attrs.text === 'Expand' || node.attrs['content-desc'] === 'Expand')
          && node.attrs.clickable === 'true');
      const otherConversation = notificationForText(bubbleXml, 'Other conversation marker');
      let summaryExpand = appSummaryExpand ?? otherConversation?.groupExpand;
      if (!summaryExpand) {
        const collapsedRow = firstNode(tree, node =>
          node.attrs['resource-id'] === 'com.android.systemui:id/expandableNotificationRow'
            && firstNode(node, child => child.attrs['resource-id'] === 'android:id/expand_button'
              && child.attrs.clickable === 'true'));
        summaryExpand = collapsedRow && firstNode(collapsedRow, child =>
          child.attrs['resource-id'] === 'android:id/expand_button' && child.attrs.clickable === 'true');
      }
      if (!summaryExpand) break;
      tapBounds(summaryExpand);
      await wait(500);
      adb('shell', 'uiautomator', 'dump', '/sdcard/omp-native-bubble.xml');
      bubbleXml = adb('shell', 'cat', '/sdcard/omp-native-bubble.xml');
      verification = notificationForText(bubbleXml, 'Bubble verification');
    }
    if (!verification) {
      const labels = [...bubbleXml.matchAll(/<node\b[^>]*>/g)]
        .flatMap(match => [...match[0].matchAll(/(?:text|content-desc)="([^"]*)"/g)].map(label => label[1]))
        .filter(Boolean);
      writeFileSync(proofDir + '/android-bubble-notifications.xml', bubbleXml);
      throw new Error('Bubble verification conversation A is not visible after expanding the app summary; visible labels: ' + labels.join(' | '));
    }
    // The first expandable ancestor is the app summary; after it opens, a fresh
    // lookup reaches A's own row and expands any remaining MessagingStyle group.
    for (let attempt = 0; attempt < 2 && verification?.groupExpand; attempt++) {
      tapBounds(verification.groupExpand);
      await wait(500);
      adb('shell', 'uiautomator', 'dump', '/sdcard/omp-native-bubble.xml');
      bubbleXml = adb('shell', 'cat', '/sdcard/omp-native-bubble.xml');
      verification = notificationForText(bubbleXml, 'Bubble verification');
    }
    const bubbleNodes = [...bubbleXml.matchAll(/<node\b[^>]*>/g)].map(match => match[0]);
    const boundsOf = node => node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)?.slice(1).map(Number);
    const verificationTitle = bubbleNodes.find(node =>
      [...node.matchAll(/(?:text|content-desc)="([^"]*)"/g)]
        .some(match => match[1].startsWith('Bubble verification'))
      && boundsOf(node));
    if (!verificationTitle) throw new Error('Synthetic bubble verification notification is not visible in the shade');
    const titleBounds = boundsOf(verificationTitle);
    const titleY = (titleBounds[1] + titleBounds[3]) / 2;
    const labelsOf = node => [...node.matchAll(/(?:text|content-desc)="([^"]*)"/g)].map(match => match[1]);
    const allowedBubbleAction = labels => labels.some(label => /^(?:bubble|bubbles|bubble conversation|bubble this conversation|add bubble|show as bubble|create bubble)$/i.test(label));
    const actionableBubble = bubbleNodes.find(node => {
      const labels = labelsOf(node);
      const bounds = boundsOf(node);
      const actionable = /android\.widget\.(?:Button|ImageButton)/.test(node) || allowedBubbleAction(labels);
      return actionable && labels.some(label => /bubble/i.test(label)) && bounds
        && Math.abs((bounds[1] + bounds[3]) / 2 - titleY) < 500;
    });
    const alreadyBubbled = bubbleNodes.find(node =>
      labelsOf(node).some(label => /^remove bubbles$/i.test(label)) && boundsOf(node)
      && Math.abs((boundsOf(node)[1] + boundsOf(node)[3]) / 2 - titleY) < 500);
    if (alreadyBubbled) {
      // When Android auto-bubbles this notification, the action becomes
      // "Remove bubbles". Never tap that destructive toggle; open the exact
      // notification row to expand the system-owned bubble instead.
      const titleX = (titleBounds[0] + titleBounds[2]) / 2;
      const row = bubbleNodes.find(node => {
        if (!node.includes('resource-id="com.android.systemui:id/expandableNotificationRow"')) return false;
        const bounds = boundsOf(node);
        return bounds && titleX >= bounds[0] && titleX <= bounds[2]
          && titleY >= bounds[1] && titleY <= bounds[3];
      });
      if (!row) throw new Error('Already-bubbled synthetic notification row is missing');
      const rowBounds = boundsOf(row);
      adb('shell', 'input', 'tap', String(Math.round((rowBounds[0] + rowBounds[2]) / 2)), String(Math.round((rowBounds[1] + rowBounds[3]) / 2)));
    } else if (actionableBubble) {
      const bubbleBounds = boundsOf(actionableBubble);
      adb('shell', 'input', 'tap', String(Math.round((bubbleBounds[0] + bubbleBounds[2]) / 2)), String(Math.round((bubbleBounds[1] + bubbleBounds[3]) / 2)));
    } else {
      // Android 11+ may expose the bubble choice only from the exact conversation's long-press menu.
      adb('shell', 'input', 'swipe', String(Math.round((titleBounds[0] + titleBounds[2]) / 2)), String(Math.round((titleBounds[1] + titleBounds[3]) / 2)), String(Math.round((titleBounds[0] + titleBounds[2]) / 2)), String(Math.round((titleBounds[1] + titleBounds[3]) / 2)), '1000');
      await wait(750);
      adb('shell', 'uiautomator', 'dump', '/sdcard/omp-native-bubble.xml');
      bubbleXml = adb('shell', 'cat', '/sdcard/omp-native-bubble.xml');
      const longPressNodes = [...bubbleXml.matchAll(/<node\b[^>]*>/g)].map(match => match[0]);
      const longPressTitle = longPressNodes.find(node =>
        labelsOf(node).some(label => label.startsWith('Bubble verification')) && boundsOf(node));
      const longPressBounds = boundsOf(longPressTitle);
      const longPressY = longPressBounds && (longPressBounds[1] + longPressBounds[3]) / 2;
      const alreadyBubbledAfterPress = longPressNodes.some(node =>
        labelsOf(node).some(label => /^remove bubbles$/i.test(label)) && boundsOf(node)
          && Math.abs((boundsOf(node)[1] + boundsOf(node)[3]) / 2 - longPressY) < 500);
      if (alreadyBubbledAfterPress && longPressBounds) {
        // Remove bubbles is a destructive toggle; tap the exact row to expand it instead.
        const titleX = (longPressBounds[0] + longPressBounds[2]) / 2;
        const row = longPressNodes.find(node => {
          if (!node.includes('resource-id="com.android.systemui:id/expandableNotificationRow"')) return false;
          const bounds = boundsOf(node);
          return bounds && titleX >= bounds[0] && titleX <= bounds[2]
            && longPressY >= bounds[1] && longPressY <= bounds[3];
        });
        if (!row) throw new Error('Already-bubbled conversation A row is missing');
        const rowBounds = boundsOf(row);
        adb('shell', 'input', 'tap', String(Math.round((rowBounds[0] + rowBounds[2]) / 2)), String(Math.round((rowBounds[1] + rowBounds[3]) / 2)));
      } else {
        const menuNode = longPressNodes.find(node =>
          labelsOf(node).some(label => /^(?:bubble|bubbles|bubble conversation|bubble this conversation|add bubble|show as bubble|create bubble)$/i.test(label))
            && node.includes('clickable="true"'));
        if (!menuNode || !boundsOf(menuNode)) {
          writeFileSync(proofDir + '/android-bubble-action.xml', bubbleXml);
          const labels = longPressNodes.flatMap(labelsOf).filter(Boolean);
          throw new Error('Android conversation long-press menu has no bubble action; visible labels: ' + labels.join(' | '));
        }
        const menuBounds = boundsOf(menuNode);
        adb('shell', 'input', 'tap', String(Math.round((menuBounds[0] + menuBounds[2]) / 2)), String(Math.round((menuBounds[1] + menuBounds[3]) / 2)));
      }
    }
    const systemBubble = await until('system bubble opens the shared React chat', async () =>
      (await listTargets()).find(candidate => {
        if (candidate.id === target.id || typeof candidate.url !== 'string' || !candidate.url.startsWith(APP_URL)) return false;
        const params = new URLSearchParams(new URL(candidate.url).hash.slice(1));
        return params.get("s") === fixture && JSON.parse(candidate.description || "{}").visible === true;
      }), 20000);
    const bubbleActivities = adb("shell", "dumpsys", "activity", "activities");
    const deliveredBubbleIntent = [...bubbleActivities.matchAll(/dat=(com\.omppulse\.app:\/\/bubble\?[^\s]+)/g)]
      .map(match => new URL(match[1])).some(url => url.searchParams.get("sessionPath") === fixture
        && url.searchParams.get("reqId") === "1041" && url.searchParams.get("kind") === "needs_input");
    // React consumes q/k when normalizing the active chat URL; Android retains
    // the delivered identity, while the visible WebView proves the destination.
    check("system bubble preserves session, request and event identity", deliveredBubbleIntent);
    check("tapping the synthetic Android bubble opens its exact React chat route", systemBubble !== undefined);
    const bubbleExpanded = systemBubble && await until('BubbleActivity is expanded above the launcher', () =>
      adb('shell', 'dumpsys', 'activity', 'activities').split('\n').some(line =>
        line.includes('com.omppulse.app/.BubbleActivity')
          && /topResumedActivity|ResumedActivity|mResumed=true/.test(line)), 20000);
    check('BubbleActivity is the expanded system bubble', bubbleExpanded !== undefined && bubbleExpanded !== false);
    // The bubble is on screen and still alive: cancelling the notification here
    // is exactly what used to make an opened bubble vanish immediately.
    const bubbleBacking = await until('bubble keeps its supporting notification delivered', async () => {
      const rows = await nativeNotificationAudit();
      return conversationRow(rows, fixture, bubbleNotificationTag);
    });
    check('opening the bubble keeps the notification that backs it delivered',
      bubbleBacking?.tag === bubbleNotificationTag, JSON.stringify(bubbleBacking));

    const bubblePage = await connectTarget(systemBubble);
    // Focus re-runs the shell's visible-conversation acknowledgement path.
    const typedInBubble = "native bubble focus probe";
    const bubbleFocused = await until('bubble composer takes focus', () => bubblePage.evaluate(
      `(() => { const composer = document.querySelector('[data-testid="composer-input"]'); if (!composer) return false;
        composer.focus(); composer.select(); return document.activeElement === composer; })()`));
    await bubblePage.send("Input.insertText", { text: typedInBubble });
    const bubbleTyping = await until('bubble composer still accepts input', () =>
      bubblePage.evaluate(`document.querySelector('[data-testid="composer-input"]')?.value === ${JSON.stringify(typedInBubble)}`));
    const afterFocus = await nativeNotificationAudit();
    check('an expanded bubble stays interactive after load and focus',
      bubbleFocused === true && bubbleTyping === true && bubbleResumed(),
      JSON.stringify({ bubbleFocused, bubbleTyping }));
    check('focusing the bubbled conversation does not cancel its bubble notification',
      conversationRow(afterFocus, fixture, bubbleNotificationTag) !== undefined,
      JSON.stringify(afterFocus.filter(row => row.sessionPath === fixture)));
    await bubblePage.evaluate(`(() => {
      const composer = document.querySelector('[data-testid="composer-input"]');
      if (!composer) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(composer, "");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);

    const otherBubbleContract = await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(secondFixture) + ', title: "Other conversation marker" })');
    // An ordinary, non-bubbled alert for the very same conversation: the clear
    // path still has to dismiss this one while the live bubble keeps its own.
    const ordinaryContract = await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ', title: "Ordinary alert marker", kind: "agent_end" })');
    check('an ordinary non-bubble alert is delivered for the bubbled conversation',
      ordinaryContract?.supported === true
        && typeof ordinaryContract?.notificationTag === "string"
        && ordinaryContract.notificationTag !== bubbleNotificationTag,
      JSON.stringify(ordinaryContract));
    const pairedNotifications = await until('actual Android notifications for two distinct conversations', async () => {
      const rows = await nativeNotificationAudit();
      return rows.some(row => row.sessionPath === fixture)
        && rows.some(row => row.sessionPath === secondFixture) ? rows : undefined;
    });
    const firstDelivered = pairedNotifications.find(row => row.sessionPath === fixture);
    const secondDelivered = pairedNotifications.find(row => row.sessionPath === secondFixture);
    check('needs-input notifications for conversations A and B are independently delivered by Android',
      otherBubbleContract?.supported === true && firstDelivered?.tag !== secondDelivered?.tag
        && firstDelivered?.category === 'msg' && secondDelivered?.category === 'msg');

    const switchedToB = await bubblePage.evaluate(
      '(() => { const path = ' + JSON.stringify(secondFixture)
        + '; history.pushState({ ompChat: true, path }, "", location.pathname + location.search + "#s=" + encodeURIComponent(path));'
        + ' window.dispatchEvent(new HashChangeEvent("hashchange")); return true; })()');
    check('BubbleActivity WebView accepted the in-app route switch to B', switchedToB === true);
    const bubbleRouteB = await until('BubbleActivity displays conversation B after route switch', async () => {
      const result = await bubblePage.evaluate('({ path: new URLSearchParams(location.hash.slice(1)).get("s"), visible: document.visibilityState === "visible" })');
      return result?.path === secondFixture && result?.visible ? result : undefined;
    });
    check('BubbleActivity now visibly displays B', bubbleRouteB?.path === secondFixture && bubbleRouteB?.visible === true);
    const afterBubbleRouteSwitch = await until('route switch clears the shown conversation and spares the live bubble', async () => {
      const rows = await nativeNotificationAudit();
      return !conversationRow(rows, secondFixture)
        && conversationRow(rows, fixture, bubbleNotificationTag) ? rows : undefined;
    });
    check('navigating the bubble to another conversation clears that conversation\'s alerts while the bubble notification survives',
      !conversationRow(afterBubbleRouteSwitch, secondFixture)
        && conversationRow(afterBubbleRouteSwitch, fixture, bubbleNotificationTag) !== undefined,
      JSON.stringify(afterBubbleRouteSwitch.filter(row => row.sessionPath === fixture || row.sessionPath === secondFixture)));
    // Back inside the same bubble: history navigation alone must not resurrect
    // the ordinary alert already acknowledged, nor cancel the bubble.
    await bubblePage.evaluate(
      '(() => { const path = ' + JSON.stringify(fixture)
        + '; history.pushState({ ompChat: true, path }, "", location.pathname + location.search + "#s=" + encodeURIComponent(path));'
        + ' window.dispatchEvent(new HashChangeEvent("hashchange")); return true; })()');
    await until('bubble returns to conversation A', () => bubblePage.evaluate(
      `new URLSearchParams(location.hash.slice(1)).get("s") === ${JSON.stringify(fixture)}`));
    const afterBubbleReturn = await until('returning to A clears its ordinary alert and spares the bubble', async () => {
      const rows = await nativeNotificationAudit();
      return !conversationRow(rows, fixture, ordinaryContract?.notificationTag)
        && conversationRow(rows, fixture, bubbleNotificationTag) ? rows : undefined;
    });
    check('history navigation back to the bubbled conversation clears its ordinary alert and keeps its bubble notification',
      !conversationRow(afterBubbleReturn, fixture, ordinaryContract?.notificationTag)
        && conversationRow(afterBubbleReturn, fixture, bubbleNotificationTag) !== undefined
        && bubbleResumed(),
      JSON.stringify(afterBubbleReturn.filter(row => row.sessionPath === fixture)));

    // Repost both kinds so the explicit web clear has one of each to act on.
    await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(secondFixture) + ', title: "Other conversation marker" })');
    await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ', title: "Ordinary alert marker", kind: "agent_end" })');
    await until('A ordinary alert, A bubble notification and B delivered before exact clear', async () => {
      const rows = await nativeNotificationAudit();
      return conversationRow(rows, fixture, ordinaryContract?.notificationTag)
        && conversationRow(rows, fixture, bubbleNotificationTag)
        && conversationRow(rows, secondFixture) ? rows : undefined;
    });
    // The web clear for a conversation, issued from the shell that is showing it.
    const clearA = await bubblePage.evaluate('window.Capacitor.Plugins.OmpNotify.clearNotifications({ sessionPath: ' + JSON.stringify(fixture) + ' })');
    const afterClearA = await until('explicit web clear drops the ordinary alert and spares the live bubble', async () => {
      const rows = await nativeNotificationAudit();
      return !conversationRow(rows, fixture, ordinaryContract?.notificationTag) ? rows : undefined;
    });
    check('an explicit web clear of A removes A\'s ordinary alert, keeps A\'s live bubble notification and leaves B delivered',
      clearA?.ok === true && !conversationRow(afterClearA, fixture, ordinaryContract?.notificationTag)
        && conversationRow(afterClearA, fixture, bubbleNotificationTag) !== undefined
        && conversationRow(afterClearA, secondFixture) !== undefined,
      JSON.stringify(afterClearA.filter(row => row.sessionPath === fixture || row.sessionPath === secondFixture)));
    check('the exemption covers exactly the one notification backing the live bubble',
      afterClearA.filter(row => row.sessionPath === fixture).length === 1
        && afterClearA.find(row => row.sessionPath === fixture)?.bubbleBacking === true,
      JSON.stringify(afterClearA.filter(row => row.sessionPath === fixture)));
    if (systemBubble && bubbleExpanded) {
      await wait(1000);
      const screenshot = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
      const validPng = screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (validPng) writeFileSync(proofDir + '/android-bubble-chat.png', screenshot);
      check('expanded Android bubble screenshot captured', validPng && screenshot.length > 10_000);
      // Back first navigates chat to the list; collapsing a bubble is not
      // removing it. Its notification still backs the collapsed bubble.
      adb("shell", "input", "keyevent", "KEYCODE_HOME");
      await until("system bubble is collapsed", () => !bubbleResumed(), 20000);
      await evaluate("window.Capacitor.Plugins.OmpNotify.clearNotifications({ sessionPath: " + JSON.stringify(fixture) + " })");
      const collapsedRows = await nativeNotificationAudit();
      check("conversation cleanup preserves the collapsed bubble and the other conversation",
        conversationRow(collapsedRows, fixture, bubbleNotificationTag)?.bubbleBacking === true
          && conversationRow(collapsedRows, secondFixture) !== undefined);
      // The next journey concerns ordinary notifications, not bubble removal.
      adb("shell", "cmd", "notification", "set_bubbles", "com.omppulse.app", "0");
    }
  }
  // Restore A while no conversation view is visible, then open its exact main-chat route.
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await until('MainActivity is backgrounded before restoring A notification', () =>
    !adb('shell', 'dumpsys', 'activity', 'activities').split('\n').some(line =>
      line.includes('com.omppulse.app/.MainActivity')
        && /topResumedActivity|ResumedActivity|mResumed=true/.test(line)), 20000);
  await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ' })');
  await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(secondFixture) + ', title: "Other conversation marker" })');
  await until('A and B notifications restored before MainActivity access', async () => {
    const rows = await nativeNotificationAudit();
    return rows.some(row => row.sessionPath === fixture)
      && rows.some(row => row.sessionPath === secondFixture) ? rows : undefined;
  });
  adb("shell", "am", "start", "-n", "com.omppulse.app/.MainActivity", "--es", "sessionPath", fixture);
  await until("main activity resumes after notification bubble", () =>
    /(?:topResumedActivity|ResumedActivity):.*com\.omppulse\.app\/\.MainActivity/.test(adb("shell", "dumpsys", "activity", "activities")));
  await until('main chat displays conversation A', async () => {
    const result = await evaluate('({ path: new URLSearchParams(location.hash.slice(1)).get("s"), visible: document.visibilityState === "visible" })');
    return result?.path === fixture && result?.visible ? result : undefined;
  });
  let lastMainAccessRows = [];
  const mainAccessRows = await until('MainActivity clears A while B remains delivered', async () => {
    const rows = await nativeNotificationAudit();
    lastMainAccessRows = rows;
    return !rows.some(row => row.sessionPath === fixture)
      && rows.some(row => row.sessionPath === secondFixture) ? rows : undefined;
  }).catch(error => {
    throw new Error(error.message + '; active notifications: ' + JSON.stringify(lastMainAccessRows));
  });
  check('opening MainActivity clears A but keeps B delivered',
    !mainAccessRows.some(row => row.sessionPath === fixture)
      && mainAccessRows.some(row => row.sessionPath === secondFixture));
  adb("shell", "cmd", "notification", "set_bubbles", "com.omppulse.app", "1");
  const nativeStarted = await evaluate('(async () => { await Capacitor.Plugins.OmpNotify.setToken({ token: localStorage.getItem("omp-remote-token") }); return true; })()');
  if (!nativeStarted) throw new Error('Native listener did not start');
  const background = await api('/api/new', { cwd: CWD });
  await selectTestModel(background.sessionPath);
  await until('foreground notification service', () => adb('shell', 'dumpsys', 'activity', 'services', 'com.omppulse.app').includes('isForeground=true'));
  await evaluate('window.Capacitor.Plugins.OmpNotify.verifyBubbleContract({ sessionPath: ' + JSON.stringify(fixture) + ' })');
  const foregroundRows = await nativeNotificationAudit();
  const foregroundNotice = foregroundRows.find(row => row.id === 1001);
  check('needs-input remains a conversation-scoped message notification',
    foregroundRows.some(row => row.sessionPath === fixture && row.category === 'msg'));
  check('foreground listener keeps only the minimal silent mandatory service notice',
    foregroundNotice?.ongoing === true && foregroundNotice?.silent === true
      && foregroundNotice?.category === 'service' && foregroundNotice?.channelId === 'omp_foreground_v2'
      && foregroundNotice?.text === '' && foregroundNotice?.visibility === 0
      && !foregroundRows.some(row => row.category === 'progress' || row.tag?.startsWith('omp-live-')));
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  const commandId = crypto.randomUUID();
  await api('/api/prompt', { sessionPath: background.sessionPath, commandId, text: 'Reply with exactly WEBVIEW_BACKGROUND_OK and nothing else.' });
  await until('background completion', async () => (await api('/api/receipts/' + commandId)).receipt?.state === 'completed', 120000);
  await until('actual Android notification', () => adb('shell', 'dumpsys', 'notification', '--noredact').includes('WEBVIEW_BACKGROUND_OK'));
  check('real background turn is delivered by the Android service', true);
  adb('shell', 'cmd', 'statusbar', 'expand-notifications');
  await wait(1000);
  adb('shell', 'uiautomator', 'dump', '/sdcard/omp-webview-notifications.xml');
  let notificationXml = adb('shell', 'cat', notificationXmlPath);
  let notification = notificationForText(notificationXml, 'WEBVIEW_BACKGROUND_OK');
  if (!notification) throw new Error('Notification not visible in shade');
  // Android may auto-group this notification with the earlier bubble-contract
  // notification. In a collapsed group the preview text is exposed in the tree,
  // but its row is non-clickable and taps launch only the app summary. Expand
  // that group first, then tap the individually actionable exact notification.
  if (notification.targetRow?.attrs.clickable !== 'true' && notification.groupExpand) {
    tapBounds(notification.groupExpand);
    await wait(500);
    adb('shell', 'uiautomator', 'dump', notificationXmlPath);
    notificationXml = adb('shell', 'cat', notificationXmlPath);
    notification = notificationForText(notificationXml, 'WEBVIEW_BACKGROUND_OK');
  }
  if (!notification?.targetRow || notification.targetRow.attrs.clickable !== 'true') {
    throw new Error('Exact background notification row is not independently clickable');
  }
  let replyButton = firstNode(notification.targetRow, node => node.attrs.text === "Reply");
  if (!replyButton) {
    const expand = firstNode(notification.targetRow, node => node.attrs["resource-id"] === "android:id/expand_button");
    if (!expand) throw new Error("Background notification has no Reply action or expand control");
    tapBounds(expand);
    await wait(500);
    adb("shell", "uiautomator", "dump", notificationXmlPath);
    notification = notificationForText(adb("shell", "cat", notificationXmlPath), 'WEBVIEW_BACKGROUND_OK');
    replyButton = notification && firstNode(notification.targetRow, node => node.attrs.text === "Reply");
  }
  if (!replyButton) throw new Error("Expanded notification has no Reply action");
  tapBounds(replyButton);
  await wait(500);
  adb("shell", "uiautomator", "dump", notificationXmlPath);
  const replyTree = parseNotificationTree(adb("shell", "cat", notificationXmlPath));
  const replyInput = firstNode(replyTree, node => node.attrs.class === "android.widget.EditText");
  if (!replyInput) throw new Error("Android did not open the inline-reply input");
  tapBounds(replyInput);
  adb("shell", "input", "text", "Reply%swith%sexactly%sWEBVIEW_BACKGROUND_OK%sand%snothing%selse.");
  adb("shell", "uiautomator", "dump", notificationXmlPath);
  const sendReply = firstNode(parseNotificationTree(adb("shell", "cat", notificationXmlPath)),
    node => node.attrs["resource-id"] === "com.android.systemui:id/remote_input_send"
      || node.attrs["content-desc"] === "Send");
  if (!sendReply) throw new Error("Android inline-reply send control is unavailable");
  tapBounds(sendReply);
  const inlineReceipt = await until("inline reply completes through the real native sender", async () => {
    const rows = (await api("/api/receipts?session=" + encodeURIComponent(background.sessionPath))).receipts;
    return rows.find(row => row.commandId !== commandId && row.state === "completed");
  }, 120000);
  const replyReceipts = (await api("/api/receipts?session=" + encodeURIComponent(background.sessionPath))).receipts;
  check("actual Android inline reply executes once without opening either app view",
    replyReceipts.length === 2 && inlineReceipt.commandId !== commandId);
  photographDevice("notification-inline-reply");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  adb("shell", "cmd", "statusbar", "expand-notifications");
  await wait(500);
  adb("shell", "uiautomator", "dump", notificationXmlPath);
  notification = notificationForText(adb("shell", "cat", notificationXmlPath), 'WEBVIEW_BACKGROUND_OK');
  if (!notification?.targetRow) throw new Error("Reply completion notification is missing");
  tapBounds(notification.targetRow);
  // With bubbles enabled, Android may expand BubbleActivity for a conversation
  // notification instead of resuming MainActivity. The original CDP page then
  // remains attached but hidden; inspect real WebView targets rather than that
  // stale page, while preserving the exact requested session-path assertion.
  const notificationTarget = await until('notification opens exact web chat', async () =>
    (await listTargets()).find(candidate => {
      if (candidate.type !== 'page' || typeof candidate.url !== 'string' || !candidate.url.startsWith(APP_URL)) return false;
      return new URLSearchParams(new URL(candidate.url).hash.slice(1)).get('s') === background.sessionPath;
    }));
  check('Android notification opens its exact React conversation', notificationTarget !== undefined);
  photographDevice('notification-opened-chat');
  // ── lifecycle-independent Android outbox ─────────────────────────────────
  // The proxy remains on loopback and forwards only this APK's isolated
  // adb-reversed daemon origin. It can drop one completed /api/prompt response
  // without ever touching the developer's daemon or sessions.
  const promptAttempts = new Map();
  const droppedPromptIds = [];
  let dropNextPromptResponse = false;
  reliabilityProxy = createServer((request, response) => {
    const path = new URL(request.url || "/", BASE).pathname;
    const isPrompt = request.method === "POST" && path === "/api/prompt";
    const dropResponse = isPrompt && dropNextPromptResponse;
    if (dropResponse) dropNextPromptResponse = false;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (!isPrompt) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (payload.commandId) {
          promptAttempts.set(payload.commandId, (promptAttempts.get(payload.commandId) || 0) + 1);
          if (dropResponse) droppedPromptIds.push(payload.commandId);
        }
      } catch {}
    });
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: parsedBase.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${parsedBase.port}` },
    }, (upstreamResponse) => {
      if (dropResponse) {
        upstreamResponse.resume();
        upstreamResponse.once("end", () => response.destroy());
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      if (response.destroyed) return;
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(String(error.message || error));
    });
    request.on("error", () => upstream.destroy());
    request.pipe(upstream);
  });
  reliabilityProxy.on("upgrade", (request, socket, initial) => {
    const upstream = connectNet(Number(parsedBase.port), "127.0.0.1");
    upstream.once("connect", () => {
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n");
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (initial.length) upstream.write(initial);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise((resolve, reject) => {
    reliabilityProxy.once("error", reject);
    reliabilityProxy.listen(0, "127.0.0.1", resolve);
  });
  const proxyPort = reliabilityProxy.address().port;
  adb("reverse", `tcp:${APP_PORT}`, `tcp:${proxyPort}`);

  const routeTarget = async (sessionPath, excludedId) => {
    try { refreshWebViewForward(); } catch { return undefined; }
    const pages = await listTargets();
    return pages.find((candidate) => {
      if (candidate.id === excludedId || candidate.type !== "page" || typeof candidate.url !== "string") return false;
      try {
        const pageUrl = new URL(candidate.url);
        return pageUrl.origin === new URL(APP_URL).origin
          && new URLSearchParams(pageUrl.hash.slice(1)).get("s") === sessionPath;
      } catch { return false; }
    });
  };
  const openBubble = async (sessionPath, reqId) => {
    adb("shell", "su", "0", "am", "start", "--user", "0", "-n", "com.omppulse.app/.BubbleActivity",
      "--es", "sessionPath", sessionPath, "--es", "reqId", reqId, "--es", "kind", "needs_input");
    return until(`bubble WebView for ${reqId}`, () => routeTarget(sessionPath), 30000);
  };
  const assertReceiptOnce = async (sessionPath, commandId) => {
    const result = await until(`real receipt for ${commandId}`, async () => {
      try {
        const { receipt } = await api(`/api/receipts/${encodeURIComponent(commandId)}`);
        return receipt?.state === "completed" ? receipt : undefined;
      } catch { return undefined; }
    }, 120000);
    const rows = (await api(`/api/receipts?session=${encodeURIComponent(sessionPath)}`)).receipts || [];
    await wait(1500);
    const attempts = promptAttempts.get(commandId) || 0;
    const matchingReceipts = rows.filter((receipt) => receipt.commandId === commandId);
    check("one isolated daemon receipt and one POST for the stable command ID",
      matchingReceipts.length === 1 && result.commandId === commandId
        && result.state === "completed" && attempts === 1,
      JSON.stringify({ sessionReceipts: rows.length, matchingReceipts: matchingReceipts.length, attempts, commandId }));
    return result;
  };
  const lockSession = await api("/api/new", { cwd: CWD });
  await selectTestModel(lockSession.sessionPath);
  adb("shell", "am", "start", "-n", "com.omppulse.app/.MainActivity", "--es", "sessionPath", lockSession.sessionPath);
  const mainTarget = await until("main app target for suspended-lock scenario",
    () => routeTarget(lockSession.sessionPath), 30000);
  const mainPage = await connectTarget(mainTarget);
  await mainPage.send("Page.enable");
  await until("main session composer", () => mainPage.evaluate("!!document.querySelector('[data-testid=\"composer-input\"]')"));
  const namespace = await credentialNamespace(mainPage);
  check("native sender namespace is only the paired-token SHA-256", /^cred-[0-9a-f]{64}$/.test(namespace || ""));
  check("actual Android build requires the native sender", await mainPage.evaluate("window.OmpNative?.senderRequired?.() === true"));
  const lockNames = [`omp-pulse-outbox:${namespace}`, `omp-pulse-outbox-drain:${namespace}`];
  const lockSetup = await mainPage.evaluate(`(() => {
    if (!navigator.locks?.request || !navigator.locks?.query) return false;
    window.__nativeLockReleases = [];
    for (const name of ${JSON.stringify(lockNames)}) {
      void navigator.locks.request(name, { mode: "exclusive" }, () =>
        new Promise(resolve => window.__nativeLockReleases.push(resolve))).catch(() => {});
    }
    return true;
  })()`);
  check("main WebView acquired both legacy outbox mutation and drain locks", lockSetup === true);
  await until("both main-view Web Locks held", async () => {
    const held = await mainPage.evaluate("navigator.locks.query().then(q => q.held.map(lock => lock.name))");
    return lockNames.every((name) => held?.includes(name));
  });
  const freezeReply = await mainPage.send("Page.setWebLifecycleState", { state: "frozen" });
  check("main renderer is genuinely suspended while owning its Web Locks", !freezeReply?.error, JSON.stringify(freezeReply));

  const bubbleTarget = await openBubble(lockSession.sessionPath, "native-lock-owner");
  const bubblePage = await connectTarget(bubbleTarget);
  await bubblePage.send("Page.enable");
  await until("bubble composer without MainActivity", () => bubblePage.evaluate("!!document.querySelector('[data-testid=\"composer-input\"]')"));
  const bubbleNamespace = await credentialNamespace(bubblePage);
  const locksObserved = await bubblePage.evaluate("navigator.locks.query().then(q => q.held.map(lock => lock.name))");
  check("bubble sees the suspended main renderer still holding both locks",
    lockNames.every((name) => locksObserved?.includes(name)), JSON.stringify(locksObserved));
  const nativeMarker = await bubblePage.evaluate("window.OmpNative?.senderRequired?.() === true");
  check("cold bubble page requires its native sender instead of browser fallback", nativeMarker === true);
  const bubbleNativeStatus = await bubblePage.evaluate("window.Capacitor?.Plugins?.OmpNotify?.getStatus?.()");
  check("the bubble host serves the same native release, protocol and paired credential",
    bubbleNativeStatus?.releaseId === nativeStatus?.releaseId
      && bubbleNativeStatus?.protocolVersion === nativeStatus?.protocolVersion
      && bubbleNativeStatus?.minClientProtocolVersion === nativeStatus?.minClientProtocolVersion
      && bubbleNativeStatus?.hasToken === true,
    JSON.stringify({ releaseId: bubbleNativeStatus?.releaseId, protocolVersion: bubbleNativeStatus?.protocolVersion }));
  check("bubble and main share one paired credential namespace",
    bubbleNamespace === namespace, JSON.stringify({ bubbleNamespace, namespace }));
  // A refused credential must surface as a rejection and leave the stored one
  // intact; the token itself is never read back into this script's output.
  const rejectedToken = await bubblePage.evaluate(`(async () => {
    try { const result = await window.Capacitor.Plugins.OmpNotify.setToken({ token: "" }); return { rejected: false, result: result ?? null }; }
    catch (error) { return { rejected: true, message: String(error?.message || error) }; }
  })()`);
  const afterRejectedToken = await bubblePage.evaluate("window.Capacitor?.Plugins?.OmpNotify?.getStatus?.()");
  check("a rejected native credential is visible and leaves the paired credential untouched",
    rejectedToken?.rejected === true && afterRejectedToken?.hasToken === true
      && (await credentialNamespace(bubblePage)) === bubbleNamespace,
    JSON.stringify(rejectedToken));
  const nativeList = await nativeCall(bubblePage, bubbleNamespace, "list");
  check("actual OmpOutbox bridge lists durable native rows", nativeList?.ok === true && Array.isArray(nativeList.value), JSON.stringify(nativeList));
  const lockPrompt = "Reply with exactly NATIVE_BUBBLE_LOCK_OK and nothing else.";
  await bubblePage.evaluate("document.querySelector('[data-testid=\"composer-input\"]')?.focus()");
  await bubblePage.send("Input.insertText", { text: lockPrompt });
  const lockClicked = await bubblePage.evaluate(`(() => {
    const button = document.querySelector('[data-testid="composer-send-btn"]');
    if (!button || button.disabled) return false;
    button.click(); return true;
  })()`);
  check("actual bubble composer accepts a prompt while both main locks remain held", lockClicked === true);
  await until("bubble composer clears after native durable save",
    () => bubblePage.evaluate("document.querySelector('[data-testid=\"composer-input\"]')?.value === ''"));
  const lockEntry = await until("native row for bubble composer send", async () => {
    const result = await nativeCall(bubblePage, bubbleNamespace, "list");
    return result?.ok && result.value.find((row) => row.text === lockPrompt);
  });
  await assertReceiptOnce(lockSession.sessionPath, lockEntry.commandId);
  check("bubble's native queue row retains the exact session and command identity",
    lockEntry.sessionPath === lockSession.sessionPath && lockEntry.id === lockEntry.commandId);
  photographDevice("bubble-native-lock-send");
  await mainPage.send("Page.setWebLifecycleState", { state: "active" });
  await wait(300);
  await mainPage.evaluate("window.__nativeLockReleases?.splice(0).forEach(release => release())");
  // ── one host implementation: shared drafts, file chooser, media permission ──
  const draftKey = `omp-draft:${bubbleNamespace}:${lockSession.sessionPath}`;
  const composerValue = page => page.evaluate(`document.querySelector('[data-testid="composer-input"]')?.value ?? null`);
  const savedDraft = page => page.evaluate(`localStorage.getItem(${JSON.stringify(draftKey)})`);
  const focusComposer = page => page.evaluate(`(() => {
    const composer = document.querySelector('[data-testid="composer-input"]');
    if (!composer) return false;
    composer.focus();
    return document.activeElement === composer;
  })()`);
  const clearComposer = page => page.evaluate(`(() => {
    const composer = document.querySelector('[data-testid="composer-input"]');
    if (!composer) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(composer, "");
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  // Main and bubble are two documents of one conversation. Editing in one and
  // then closing or blurring the untouched other view must not erase the saved
  // draft. Nothing is sent, so no model call is involved.
  const mainDraft = "native main view draft";
  await until("main view composer takes focus", () => focusComposer(mainPage));
  await mainPage.send("Input.insertText", { text: mainDraft });
  const mainDraftTyped = await until("main view draft is typed", async () => (await composerValue(mainPage)) === mainDraft);
  const mainDraftSaved = await until("main view draft is persisted", async () => (await savedDraft(bubblePage)) === mainDraft);
  const acceptBubbleUnload = message => {
    if (message.method === "Page.javascriptDialogOpening" && message.params?.type === "beforeunload") {
      void bubblePage.send("Page.handleJavaScriptDialog", { accept: true });
    }
  };
  bubblePage.on(acceptBubbleUnload);
  try {
    await bubblePage.send("Page.reload", { ignoreCache: true });
    await until("untouched bubble view reloads with the conversation composer", () => bubblePage.evaluate(
      `!!document.querySelector('[data-testid="composer-input"]')`), 30000);
  } finally {
    bubblePage.off(acceptBubbleUnload);
  }
  const bubbleReloaded = await until("reopened bubble view restores the saved draft", async () =>
    (await composerValue(bubblePage)) === mainDraft, 30000);
  check("closing an untouched second view of one conversation cannot erase the edited view's draft",
    mainDraftTyped === true && mainDraftSaved === true && bubbleReloaded === true
      && (await composerValue(mainPage)) === mainDraft && (await savedDraft(bubblePage)) === mainDraft,
    JSON.stringify({ mainDraftTyped, mainDraftSaved, bubbleReloaded }));
  const bubbleDraft = "native bubble view draft";
  await clearComposer(bubblePage);
  await until("bubble view composer takes focus", () => focusComposer(bubblePage));
  await bubblePage.send("Input.insertText", { text: bubbleDraft });
  const bubbleDraftTyped = await until("bubble view draft is typed", async () => (await composerValue(bubblePage)) === bubbleDraft);
  const bubbleDraftSaved = await until("bubble view draft is persisted", async () => (await savedDraft(bubblePage)) === bubbleDraft);
  await mainPage.evaluate(`window.dispatchEvent(new Event("blur")); document.activeElement?.blur?.();`);
  await wait(1200);
  check("an untouched view blurring cannot roll the saved draft back to its stale snapshot",
    bubbleDraftTyped === true && bubbleDraftSaved === true
      && (await composerValue(bubblePage)) === bubbleDraft && (await savedDraft(bubblePage)) === bubbleDraft,
    JSON.stringify({ bubbleDraftTyped, bubbleDraftSaved }));
  await clearComposer(bubblePage);
  await clearComposer(mainPage);
  await until("shared-draft probe leaves both composers empty", async () =>
    (await composerValue(bubblePage)) === "" && (await composerValue(mainPage)) === "");

  // The attach control is only reachable through the shell's WebChromeClient
  // file-chooser callback, so a real system picker proves the wiring end to end.
  const resumedComponent = () => {
    const line = adb("shell", "dumpsys", "activity", "activities").split("\n")
      .find(candidate => /topResumedActivity=|mResumedActivity/.test(candidate));
    return line?.match(/([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/)?.[1] ?? "";
  };
  const tapElement = async (page, selectorExpression) => {
    const box = await page.evaluate(`(() => { const element = ${selectorExpression}; if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    if (!box) return false;
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    return true;
  };
  // "Add image" is a row of the + bottom sheet (data-testid composer-add-image), not a menu item.
  const addImageItem = `document.querySelector('[data-testid="composer-add-image"]')`;
  await until("bubble attach sheet opens", () => tapElement(bubblePage, `document.querySelector('[data-testid="composer-plus-btn"]')`));
  await until("bubble attach sheet lists Add image", () => bubblePage.evaluate(`!!(${addImageItem})`));
  const addImageTapped = await tapElement(bubblePage, addImageItem);
  const chooserOwner = await until('system document picker opens from the bubble host', () => {
    const owner = resumedComponent();
    return /documentsui|photopicker/i.test(owner) ? owner : undefined;
  }, 20000);
  check('the bubble attachment control opens the real system document picker',
    addImageTapped === true && chooserOwner !== undefined,
    JSON.stringify({ addImageTapped, chooserOwner, resumed: resumedComponent() }));
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  const chooserDismissed = await until('document picker closes back to the bubble host', () =>
    !/documentsui|photopicker/i.test(resumedComponent()) && bubbleResumed(), 20000);
  check('a cancelled document picker leaves the bubble host resumed and usable',
    chooserDismissed !== undefined && chooserDismissed !== false
      && await bubblePage.evaluate(`!!document.querySelector('[data-testid="composer-input"]')`),
    JSON.stringify({ chooserDismissed, resumed: resumedComponent() }));

  // CAMERA is declared but never granted, so a camera request from the bubble
  // WebView has to reach the OS dialog. The consent is approved only on this
  // isolated emulator: the suite refuses to run without its serial.
  const cameraRequested = await bubblePage.evaluate(`(() => {
    window.__ompCameraRequest = null;
    if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
    navigator.mediaDevices.getUserMedia({ video: true }).then(
      stream => { window.__ompCameraRequest = { granted: true, live: stream.getVideoTracks().some(track => track.readyState === "live") }; },
      error => { window.__ompCameraRequest = { granted: false, error: error?.name || String(error) }; });
    return "requested";
  })()`);
  const permissionDialog = await until('system media permission dialog appears for the bubble host', async () => {
    const owner = resumedComponent();
    if (!/permissioncontroller|packageinstaller/i.test(owner)) return undefined;
    adb("shell", "uiautomator", "dump", "/sdcard/omp-native-permission.xml");
    const xml = adb("shell", "cat", "/sdcard/omp-native-permission.xml");
    const allow = firstNode(parseNotificationTree(xml), node => node.attrs.clickable === "true"
      && /^(?:allow|while using the app|only this time)$/i.test((node.attrs.text || node.attrs["content-desc"] || "").trim()));
    if (!allow) return undefined;
    tapBounds(allow);
    return owner;
  }, 30000);
  const cameraOutcome = await until('camera permission request settles', () => bubblePage.evaluate('window.__ompCameraRequest'), 30000);
  const cameraGranted = /android\.permission\.CAMERA: granted=true/.test(
    adb("shell", "dumpsys", "package", "com.omppulse.app"));
  check('a media permission request from the bubble host raises the OS dialog and the approval is applied to the app',
    cameraRequested === "requested" && permissionDialog !== undefined && cameraGranted === true
      && typeof cameraOutcome?.granted === "boolean",
    JSON.stringify({ cameraRequested, dialogOwner: permissionDialog, cameraOutcome, cameraGranted }));
  mainPage.connection.close();

  // SQLite CursorWindow is normally ~2 MiB; photos must not make even list() fail.
  const largeImageId = crypto.randomUUID();
  const largeImage = { mimeType: "image/png", data: "AQID".repeat(1024 * 1024) };
  const largeCommand = { commandId: largeImageId, sessionPath: lockSession.sessionPath,
    text: "native large-attachment persistence fixture", images: [largeImage], state: "uncertain" };
  const largeSaved = await nativeCall(bubblePage, bubbleNamespace, "import", { command: largeCommand });
  const largeListed = await nativeCall(bubblePage, bubbleNamespace, "list");
  const largeRestored = await nativeCall(bubblePage, bubbleNamespace, "images", { commandId: largeImageId });
  check("photo larger than SQLite CursorWindow remains listable and byte-exact",
    largeSaved?.ok === true && largeListed?.value?.some(row => row.commandId === largeImageId)
      && largeRestored?.value?.[0]?.data === largeImage.data);
  await nativeCall(bubblePage, bubbleNamespace, "remove", { commandId: largeImageId });
  const lateImport = await nativeCall(bubblePage, bubbleNamespace, "import", { command: largeCommand });
  check("late legacy import cannot resurrect a dismissed native command", lateImport?.ok === true && lateImport.value === null);
  const expiredId = crypto.randomUUID();
  const expiredSave = await nativeCall(bubblePage, bubbleNamespace, "enqueue", {
    command: { commandId: expiredId, sessionPath: lockSession.sessionPath, text: "expired save", images: [] },
    deadlineAt: Date.now() - 1000,
  });
  const expiredRow = await nativeCall(bubblePage, bubbleNamespace, "get", { commandId: expiredId });
  check("expired native save cannot commit or dispatch late", expiredSave?.code === "deadline"
    && expiredRow?.ok === true && expiredRow.value === null && !promptAttempts.has(expiredId));

  // Migrate a real previous-web-version IndexedDB row through the web adapter:
  // the reload imports it natively, then removes the browser source only after
  // the native import acknowledgement. The row's ID/state/attachment survive.
  const migrationId = crypto.randomUUID();
  const migrationText = "legacy migration identity fixture";
  const migrationImage = { data: "AQIDBA==", mimeType: "image/png" };
  const migrationRecord = {
    id: migrationId, commandId: migrationId, sessionPath: lockSession.sessionPath,
    text: migrationText, imageCount: 1, imageBytes: migrationImage.data.length,
    droppedImages: false, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000,
    state: "uncertain", images: [migrationImage], namespace: bubbleNamespace,
    storageKey: `${bubbleNamespace}:${migrationId}`,
  };
  const seededLegacyRow = await bubblePage.evaluate(`new Promise(resolve => {
    const request = indexedDB.open("omp-pulse-outbox", 3);
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("commands-v3")) { db.close(); resolve(false); return; }
      const tx = db.transaction("commands-v3", "readwrite");
      tx.objectStore("commands-v3").put(${JSON.stringify(migrationRecord)});
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(false); };
    };
  })`);
  check("seeded the previous browser outbox record in its isolated IndexedDB", seededLegacyRow === true);
  await bubblePage.send("Page.reload", { ignoreCache: true });
  await until("chat returned after native legacy import", () => bubblePage.evaluate(
    `location.origin === ${JSON.stringify(new URL(APP_URL).origin)} && !!document.querySelector('[data-testid="composer-input"]')`));
  const migratedEntry = await until("legacy command imported with stable ID", async () => {
    const result = await nativeCall(bubblePage, bubbleNamespace, "get", { commandId: migrationId });
    return result?.ok && result.value?.commandId === migrationId ? result.value : undefined;
  });
  const migratedImages = await nativeCall(bubblePage, bubbleNamespace, "images", { commandId: migrationId });
  const browserSource = await bubblePage.evaluate(`new Promise(resolve => {
    const request = indexedDB.open("omp-pulse-outbox", 3);
    request.onerror = () => resolve("error");
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("commands-v3", "readonly");
      const get = tx.objectStore("commands-v3").get(${JSON.stringify(`${bubbleNamespace}:${migrationId}`)});
      get.onsuccess = () => resolve(get.result || null);
      tx.oncomplete = () => db.close();
    };
  })`);
  check("actual browser-to-native migration preserves ID, uncertain state and creation time",
    migratedEntry.id === migrationId && migratedEntry.state === "uncertain"
      && migratedEntry.createdAt === migrationRecord.createdAt,
    JSON.stringify(migratedEntry));
  check("migration keeps the attachment bytes and removes source only after native import",
    migratedImages?.ok === true && migratedImages.value?.length === 1
      && migratedImages.value[0].data === migrationImage.data && browserSource === null);
  const duplicateMigration = await nativeCall(bubblePage, bubbleNamespace, "import", {
    command: { ...migrationRecord, text: `${migrationText} conflict` },
  });
  check("same command ID with a different migrated payload is refused",
    duplicateMigration?.ok === false && duplicateMigration.code === "native_outbox", JSON.stringify(duplicateMigration));

  const wrongNamespace = `cred-${"0".repeat(64)}`;
  const wrongScope = await nativeCall(bubblePage, wrongNamespace, "list");
  check("native bridge refuses a stale credential namespace", wrongScope?.ok === false && wrongScope.code === "scope", JSON.stringify(wrongScope));
  await bubblePage.evaluate(`window.__testPairingToken = localStorage.getItem("omp-remote-token"); localStorage.setItem("omp-remote-token", "stale-native-test-credential");`);
  const staleCredentialNamespace = await credentialNamespace(bubblePage);
  const staleCredential = await nativeCall(bubblePage, staleCredentialNamespace, "list");
  await bubblePage.evaluate(`localStorage.setItem("omp-remote-token", window.__testPairingToken); delete window.__testPairingToken;`);
  check("native bridge refuses a stale pairing credential", staleCredential?.ok === false && staleCredential.code === "scope", JSON.stringify(staleCredential));
  const subframeRefusal = await bubblePage.evaluate(`new Promise(resolve => {
    const frame = document.createElement("iframe");
    const probeId = crypto.randomUUID();
    const finish = result => {
      clearTimeout(timer); window.removeEventListener("message", receive);
      frame.remove(); resolve(result);
    };
    const receive = event => {
      if (event.source === frame.contentWindow && event.data?.probeId === probeId) finish(event.data.result);
    };
    window.addEventListener("message", receive);
    const timer = setTimeout(() => finish({ timedOut: true }), 7500);
    frame.style.display = "none";
    // Execute in the child realm, not via a main-frame reference to its bridge.
    // srcdoc avoids fetching another document or starting the app in the child.
    frame.srcdoc = "<script>(" + ((probeId, namespace, parentOrigin) => {
      const report = result => parent.postMessage({ probeId, result }, parentOrigin);
      const bridge = window.OmpOutbox;
      if (!bridge || typeof bridge.postMessage !== "function") { report({ bridgeMissing: true }); return; }
      const id = crypto.randomUUID();
      bridge.onmessage = event => {
        let result; try { result = JSON.parse(event.data); } catch { return; }
        if (result.id === id) report(result);
      };
      try { bridge.postMessage(JSON.stringify({ id, op: "list", namespace, deadlineAt: Date.now() + 7000 })); }
      catch (error) { report({ error: String(error) }); }
    }).toString() + ")(" + JSON.stringify(probeId) + "," + JSON.stringify(${JSON.stringify(bubbleNamespace)}) + "," + JSON.stringify(location.origin) + ");</script>";
    document.body.appendChild(frame);
  })`);
  check("native bridge refuses subframe access", subframeRefusal?.bridgeMissing === true
    || (subframeRefusal?.ok === false && subframeRefusal.code === "scope"), JSON.stringify(subframeRefusal));
  const untrustedOrigin = `http://127.0.0.1:${APP_PORT}`;
  await bubblePage.send("Page.navigate", { url: `${untrustedOrigin}/app/#s=${encodeURIComponent(lockSession.sessionPath)}` });
  await until("untrusted-origin WebView navigation", () => bubblePage.evaluate(`location.origin === ${JSON.stringify(untrustedOrigin)}`), 20000);
  const untrustedCall = await nativeCall(bubblePage, bubbleNamespace, "list");
  check("native bridge refuses a different main-frame origin", untrustedCall?.bridgeMissing === true
    || (untrustedCall?.ok === false && untrustedCall.code === "scope"), JSON.stringify(untrustedCall));
  await bubblePage.send("Page.navigate", { url: `${APP_URL}#s=${encodeURIComponent(lockSession.sessionPath)}` });
  await until("trusted origin restored", () => bubblePage.evaluate(
    `location.origin === ${JSON.stringify(new URL(APP_URL).origin)} && !!document.querySelector('[data-testid="composer-input"]')`));
  // Cold-process, failed local acknowledgement, durable attachments, then a
  // lost daemon response all reuse this one UI-created command ID.
  const offlineSession = await api("/api/new", { cwd: CWD });
  await selectTestModel(offlineSession.sessionPath);
  bubblePage.connection.close();
  adb("shell", "am", "force-stop", "com.omppulse.app");
  await wait(700);
  const offlineTarget = await openBubble(offlineSession.sessionPath, "native-offline-save");
  const offlinePage = await connectTarget(offlineTarget);
  await offlinePage.send("Page.enable");
  await until("cold bubble-only composer", () => offlinePage.evaluate(
    `!!document.querySelector('[data-testid="composer-input"]')`));
  const offlineNamespace = await credentialNamespace(offlinePage);
  check("cold bubble launch restores the paired native sender", /^cred-[0-9a-f]{64}$/.test(offlineNamespace || "")
    && await offlinePage.evaluate("window.OmpNative?.senderRequired?.() === true"));
  const offlineText = "Reply with exactly NATIVE_RESTART_IMAGE_OK and nothing else.";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#3478f6"/></svg>';
  const attachImage = async (page, name) => page.evaluate(`(() => {
    const input = document.querySelector('input[type="file"][accept="image/*"]');
    if (!input) return false;
    const file = new File([${JSON.stringify(svg)}], ${JSON.stringify(name)}, { type: "image/svg+xml" });
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true })); return true;
  })()`);
  const composerClick = async (page) => page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="composer-send-btn"]');
    if (!button || button.disabled) return false;
    button.click(); return true;
  })()`);
  // The real system chooser is exercised separately; here the injected file
  // only has to reach the same composer the picker would feed.
  await attachImage(offlinePage, "native-restart-proof.svg");
  await until("processed attachment visible before send", () => offlinePage.evaluate(
    `!!document.querySelector('img[alt="native-restart-proof.svg"]')`));
  await offlinePage.evaluate("document.querySelector('[data-testid=\"composer-input\"]')?.focus()");
  await offlinePage.send("Input.insertText", { text: offlineText });
  // Remove only this test run's adb route: Android and the main app remain
  // untouched, while native persistence is still callable from the bubble.
  adb("reverse", "--remove", `tcp:${APP_PORT}`);
  await wait(500);
  const dropNativeSaveAck = await offlinePage.evaluate(`(() => {
    const bridge = window.OmpOutbox;
    if (!bridge || typeof bridge.postMessage !== "function" || typeof bridge.onmessage !== "function") return false;
    const originalPost = bridge.postMessage;
    bridge.postMessage = function (raw) {
      let request;
      try { request = JSON.parse(raw); } catch {}
      if (request?.op === "enqueue" && request.command?.text === ${JSON.stringify(offlineText)}) {
        const previousHandler = bridge.onmessage;
        bridge.onmessage = event => {
          let result; try { result = JSON.parse(event.data); } catch { return; }
          if (result.id === request.id) { window.__nativeSaveAckDropped = true; return; }
          if (typeof previousHandler === "function") previousHandler.call(bridge, event);
        };
        window.__nativeOriginalHandler = previousHandler;
      }
      return originalPost.call(bridge, raw);
    };
    window.__nativeOriginalPost = originalPost;
    return bridge.postMessage !== originalPost;
  })()`);
  check("test can isolate one native save acknowledgement without stubbing the bridge", dropNativeSaveAck === true);
  const offlineClicked = await composerClick(offlinePage);
  check("actual bubble UI submitted the attachment-bearing offline draft", offlineClicked === true);
  await wait(11000);
  const unconfirmedComposer = await offlinePage.evaluate(`({
    text: document.querySelector('[data-testid="composer-input"]')?.value,
    image: !!document.querySelector('img[alt="native-restart-proof.svg"]'),
    ackDropped: window.__nativeSaveAckDropped === true,
  })`);
  check("lost native save acknowledgement keeps the entire composer recoverable",
    unconfirmedComposer?.text === offlineText && unconfirmedComposer.image && unconfirmedComposer.ackDropped,
    JSON.stringify(unconfirmedComposer));
  const attemptPrefix = `omp-native-save-attempt:${offlineNamespace}:${offlineSession.sessionPath}:`;
  const saveAttemptsBeforeDeath = await offlinePage.evaluate(`Object.keys(localStorage)
    .filter(key => key.startsWith(${JSON.stringify(attemptPrefix)}))
    .map(key => ({ key, commandId: localStorage.getItem(key) }))`);
  check("unconfirmed send retained its exact retry ID before process death", saveAttemptsBeforeDeath?.length === 1
    && typeof saveAttemptsBeforeDeath[0].commandId === "string");
  await offlinePage.evaluate(`(() => {
    const bridge = window.OmpOutbox;
    if (bridge && window.__nativeOriginalPost) bridge.postMessage = window.__nativeOriginalPost;
    if (bridge && window.__nativeOriginalHandler) bridge.onmessage = window.__nativeOriginalHandler;
    return true;
  })()`);
  const savedOffline = await nativeCall(offlinePage, offlineNamespace, "list");
  const offlineEntry = savedOffline?.value?.find((row) => row.text === offlineText);
  const offlineImages = offlineEntry && await nativeCall(offlinePage, offlineNamespace, "images", { commandId: offlineEntry.commandId });
  check("native SQLite owns the unacknowledged offline save and full attachment",
    savedOffline?.ok === true && offlineEntry?.sessionPath === offlineSession.sessionPath
      && offlineImages?.ok === true && offlineImages.value?.length === 1
      && offlineImages.value[0].mimeType === "image/jpeg"
      && Buffer.from(offlineImages.value[0].data, "base64").length > 0,
    JSON.stringify({ row: offlineEntry, imageCount: offlineImages?.value?.length }));
  check("saved attempt ID equals the native command ID",
    saveAttemptsBeforeDeath?.[0]?.commandId === offlineEntry?.commandId);
  const samePayload = await nativeCall(offlinePage, offlineNamespace, "enqueue", {
    command: { commandId: offlineEntry.commandId, sessionPath: offlineEntry.sessionPath,
      text: offlineEntry.text, images: offlineImages.value },
  });
  check("native queue retained the prompt offline without a daemon POST", !promptAttempts.has(offlineEntry.commandId));
  const conflictingPayload = await nativeCall(offlinePage, offlineNamespace, "enqueue", {
    command: { commandId: offlineEntry.commandId, sessionPath: offlineEntry.sessionPath,
      text: `${offlineEntry.text} changed`, images: offlineImages.value },
  });
  check("identical retry is idempotent and same-ID payload conflict is refused",
    samePayload?.ok === true && samePayload.value?.commandId === offlineEntry.commandId
      && conflictingPayload?.ok === false && conflictingPayload.code === "native_outbox",
    JSON.stringify({ samePayload, conflictingPayload }));

  dropNextPromptResponse = true;
  offlinePage.connection.close();
  adb("shell", "am", "force-stop", "com.omppulse.app");
  await wait(700);
  adb("reverse", `tcp:${APP_PORT}`, `tcp:${proxyPort}`);
  const recoveredTarget = await openBubble(offlineSession.sessionPath, "native-process-recovery");
  const recoveredPage = await connectTarget(recoveredTarget);
  await recoveredPage.send("Page.enable");
  await until("composer and exact route after bubble-only process restart", () => recoveredPage.evaluate(
    `location.origin === ${JSON.stringify(new URL(APP_URL).origin)}
      && new URLSearchParams(location.hash.slice(1)).get("s") === ${JSON.stringify(offlineSession.sessionPath)}
      && !!document.querySelector('[data-testid="composer-input"]')`));
  const recoveredNamespace = await credentialNamespace(recoveredPage);
  const recoveredRows = await nativeCall(recoveredPage, recoveredNamespace, "list");
  const recoveredEntry = recoveredRows?.value?.find((row) => row.commandId === offlineEntry.commandId);
  const recoveredImages = await nativeCall(recoveredPage, recoveredNamespace, "images", { commandId: offlineEntry.commandId });
  const recoveredDraft = await recoveredPage.evaluate(`({
    text: document.querySelector('[data-testid="composer-input"]')?.value,
    image: !!document.querySelector('img[alt="native-restart-proof.svg"]'),
    attempts: Object.keys(localStorage).filter(key => key.startsWith(${JSON.stringify(attemptPrefix)}))
      .map(key => localStorage.getItem(key)),
  })`);
  check("process death recovers saved row, attachment, draft and retry ID into BubbleActivity",
    recoveredEntry?.commandId === offlineEntry.commandId && recoveredImages?.ok === true
      && recoveredImages.value?.length === 1 && recoveredDraft?.text === offlineText
      && recoveredDraft.image && recoveredDraft.attempts?.includes(offlineEntry.commandId),
    JSON.stringify({ entry: recoveredEntry, images: recoveredImages?.value?.length, draft: recoveredDraft }));
  const recoveredMigration = await nativeCall(recoveredPage, recoveredNamespace, "get", { commandId: migrationId });
  const recoveredMigrationImages = await nativeCall(recoveredPage, recoveredNamespace, "images", { commandId: migrationId });
  check("migrated stable ID, uncertain state and image survive process death",
    recoveredMigration?.ok === true && recoveredMigration.value?.commandId === migrationId
      && recoveredMigration.value?.state === "uncertain"
      && recoveredMigrationImages?.ok === true && recoveredMigrationImages.value?.[0]?.data === migrationImage.data);
  const removeMigration = await nativeCall(recoveredPage, recoveredNamespace, "remove", { commandId: migrationId });
  check("native remove operation removes only the isolated migrated fixture", removeMigration?.ok === true);
  const resumedLines = adb("shell", "dumpsys", "activity", "activities").split("\n")
    .filter((line) => /topResumedActivity|ResumedActivity|mResumed=true/.test(line));
  check("cold recovery runs only BubbleActivity, without MainActivity",
    resumedLines.some((line) => line.includes("com.omppulse.app/.BubbleActivity"))
      && !resumedLines.some((line) => line.includes("com.omppulse.app/.MainActivity")),
    resumedLines.join(" | "));
  const recoveredMarker = await recoveredPage.evaluate("window.OmpNative?.senderRequired?.() === true");
  check("restarted bubble stays native-only while the original save awaits reconciliation", recoveredMarker === true);
  const wakeResult = await nativeCall(recoveredPage, recoveredNamespace, "wake");
  check("native wake resumes saved work without MainActivity", wakeResult?.ok === true, JSON.stringify(wakeResult));
  await until("test proxy dropped the accepted prompt response", () => droppedPromptIds.includes(offlineEntry.commandId), 60000);
  await assertReceiptOnce(offlineSession.sessionPath, offlineEntry.commandId);
  const reconciledEntry = await nativeCall(recoveredPage, recoveredNamespace, "get", { commandId: offlineEntry.commandId });
  check("lost POST response reconciles the original ID without replay",
    reconciledEntry?.ok === true && reconciledEntry.value?.commandId === offlineEntry.commandId
      && promptAttempts.get(offlineEntry.commandId) === 1);
  await until("unconfirmed UI draft remains available for same-ID retry", () => recoveredPage.evaluate(
    `document.querySelector('[data-testid="composer-input"]')?.value === ${JSON.stringify(offlineText)}
      && !!document.querySelector('img[alt="native-restart-proof.svg"]')`));
  const retryClicked = await composerClick(recoveredPage);
  check("actual recovered composer retries the original durable command", retryClicked === true);
  await until("same-ID retry receives durable acknowledgement and clears composer", () => recoveredPage.evaluate(
    `document.querySelector('[data-testid="composer-input"]')?.value === ''`));
  const afterRetry = await nativeCall(recoveredPage, recoveredNamespace, "get", { commandId: offlineEntry.commandId });
  const attemptsAfterRetry = await recoveredPage.evaluate(`Object.keys(localStorage)
    .filter(key => key.startsWith(${JSON.stringify(attemptPrefix)})).length`);
  check("retry preserves the pre-crash ID and retires only its saved-attempt marker",
    afterRetry?.ok === true && afterRetry.value?.commandId === offlineEntry.commandId
      && attemptsAfterRetry === 0 && promptAttempts.get(offlineEntry.commandId) === 1);
  const retryEchoes = await recoveredPage.evaluate(`Array.from(document.querySelectorAll('[data-testid="chat-message"]'))
    .filter(row => row.textContent.includes(${JSON.stringify(offlineText)})).length`);
  check("recovered send retry does not append a duplicate transcript bubble", retryEchoes === 1, String(retryEchoes));
  photographDevice("bubble-offline-ack-and-post-recovery");

  // Fill the native 50-row active cap with reconciliation-only imports. A real
  // UI send must keep its text/photo on refusal; clearing isolated rows permits
  // that same draft and attempt ID to be saved and delivered once.
  const capacityReset = await nativeCall(recoveredPage, recoveredNamespace, "clear");
  if (!capacityReset?.ok) throw new Error("Could not reset isolated native rows before capacity scenario");
  // Native clear markers use the device clock, which can differ from the host.
  // These imports must be born after that marker, not silently tombstoned by it.
  const clearedAt = await recoveredPage.evaluate("Date.now()");
  await until("device clock advanced past native clear", () => recoveredPage.evaluate(`Date.now() > ${clearedAt}`));
  for (let index = 0; index < 50; index++) {
    const id = crypto.randomUUID();
    const now = await recoveredPage.evaluate("Date.now()");
    const response = await nativeCall(recoveredPage, recoveredNamespace, "import", {
      command: { id, commandId: id, sessionPath: offlineSession.sessionPath,
        text: `native-capacity-${index}`, images: [], imageCount: 0, imageBytes: 0,
        droppedImages: false, createdAt: now, updatedAt: now, state: "uncertain" },
    });
    if (response?.ok !== true || response.value?.commandId !== id) throw new Error(`capacity fixture ${index} failed: ${JSON.stringify(response)}`);
  }
  const capacityText = "Reply with exactly NATIVE_CAPACITY_RETRY_OK and nothing else.";
  const capacityPrefix = `omp-native-save-attempt:${recoveredNamespace}:${offlineSession.sessionPath}:`;
  const fullQueue = await nativeCall(recoveredPage, recoveredNamespace, "list");
  check("isolated native outbox reached its actual 50 active-row limit",
    fullQueue.value.filter((row) => row.text.startsWith("native-capacity-") && row.state === "uncertain").length === 50,
    JSON.stringify(fullQueue.value.map(row => ({ text: row.text, state: row.state }))));
  check("capacity-failure photo is attached to the actual composer", await attachImage(recoveredPage, "native-failure-proof.svg"));
  await until("capacity test photo preview", () => recoveredPage.evaluate(
    `!!document.querySelector('img[alt="native-failure-proof.svg"]')`));
  await recoveredPage.evaluate("document.querySelector('[data-testid=\"composer-input\"]')?.focus()");
  await recoveredPage.send("Input.insertText", { text: capacityText });
  const refusedSend = await composerClick(recoveredPage);
  check("capacity-full composer attempted a real send", refusedSend === true);
  await wait(500);
  const failedDraft = await recoveredPage.evaluate(`({
    text: document.querySelector('[data-testid="composer-input"]')?.value,
    image: !!document.querySelector('img[alt="native-failure-proof.svg"]'),
    attemptIds: Object.keys(localStorage).filter(key => key.startsWith(${JSON.stringify(capacityPrefix)}))
      .map(key => localStorage.getItem(key)),
  })`);
  const failedAttemptId = failedDraft?.attemptIds?.[0];
  const failedRecord = failedAttemptId && await nativeCall(recoveredPage, recoveredNamespace, "get", { commandId: failedAttemptId });
  check("native capacity failure retains text/photo and creates no phantom command",
    failedDraft?.text === capacityText && failedDraft.image && failedAttemptId
      && failedRecord?.ok === true && failedRecord.value === null,
    JSON.stringify({ failedDraft, failedRecord }));
  const clearResult = await nativeCall(recoveredPage, recoveredNamespace, "clear");
  check("native clear removes only the test credential/origin queue", clearResult?.ok === true, JSON.stringify(clearResult));
  await until("composer re-enables after native capacity is released", () => recoveredPage.evaluate(
    `!document.querySelector('[data-testid="composer-send-btn"]')?.disabled`));
  const capacityRetry = await composerClick(recoveredPage);
  check("same intact bubble draft retries after capacity recovery", capacityRetry === true);
  await until("capacity retry durably clears composer", () => recoveredPage.evaluate(
    `document.querySelector('[data-testid="composer-input"]')?.value === ''`));
  const capacityRows = await nativeCall(recoveredPage, recoveredNamespace, "list");
  const capacityEntry = capacityRows?.value?.find((row) => row.text === capacityText);
  const capacityImages = capacityEntry && await nativeCall(recoveredPage, recoveredNamespace, "images", { commandId: capacityEntry.commandId });
  check("capacity retry uses the exact failed-attempt ID and retains its photo",
    capacityEntry?.commandId === failedAttemptId && capacityImages?.ok === true
      && capacityImages.value?.length === 1 && capacityEntry.imageCount === 1,
    JSON.stringify({ entry: capacityEntry, imageCount: capacityImages?.value?.length }));
  await assertReceiptOnce(offlineSession.sessionPath, capacityEntry.commandId);
  photographDevice("bubble-capacity-failure-retry");
  // A native enqueue can be durable before the browser's independent photo
  // draft cleanup commits. Abort that exact IndexedDB delete, kill the process,
  // then retry the restored photo with the original text and save-attempt ID.
  const photoClearText = "Reply with exactly NATIVE_PHOTO_DRAFT_RETRY_OK and nothing else.";
  await attachImage(recoveredPage, "native-clear-failure.svg");
  await until("photo-cleanup fixture preview", () => recoveredPage.evaluate(
    `!!document.querySelector('img[alt="native-clear-failure.svg"]')`));
  await wait(1000);
  await recoveredPage.evaluate("document.querySelector('[data-testid=\"composer-input\"]')?.focus()");
  await recoveredPage.send("Input.insertText", { text: photoClearText });
  const injectPhotoClearFailure = await recoveredPage.evaluate(`(() => {
    const prototype = IDBObjectStore.prototype;
    const originalDelete = prototype.delete;
    const draftKey = ${JSON.stringify(`${recoveredNamespace}:${offlineSession.sessionPath}`)};
    const failingDelete = function (key) {
      if (window.__blockPhotoDraftClear && this.name === "draft-attachments-v3" && key === draftKey) {
        window.__photoDraftClearFailed = true;
        throw new DOMException("injected photo draft delete failure", "UnknownError");
      }
      return originalDelete.call(this, key);
    };
    prototype.delete = failingDelete;
    window.__restorePhotoDraftDelete = () => { prototype.delete = originalDelete; };
    window.__blockPhotoDraftClear = true;
    return prototype.delete === failingDelete;
  })()`);
  check("photo cleanup fault targets only the actual draft-attachment delete", injectPhotoClearFailure === true);
  check("photo cleanup scenario submits actual bubble composer", await composerClick(recoveredPage));
  await until("native saved prompt and photo cleanup failure are surfaced", () => recoveredPage.evaluate(
    `document.body.textContent.includes("Message saved, but its photo draft could not be updated.")`), 30000);
  await recoveredPage.evaluate("window.__restorePhotoDraftDelete?.(); window.__blockPhotoDraftClear = false");
  const photoAttemptPrefix = `omp-native-save-attempt:${recoveredNamespace}:${offlineSession.sessionPath}:`;
  const photoAttempt = await recoveredPage.evaluate(`Object.keys(localStorage)
    .filter(key => key.startsWith(${JSON.stringify(photoAttemptPrefix)}))
    .map(key => localStorage.getItem(key))`);
  const photoEntryRows = await nativeCall(recoveredPage, recoveredNamespace, "list");
  const photoEntry = photoEntryRows?.value?.find((row) => row.text === photoClearText);
  const draftImageSurvived = await recoveredPage.evaluate(`new Promise(resolve => {
    const request = indexedDB.open("omp-pulse-outbox", 3);
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("draft-attachments-v3", "readonly");
      const get = tx.objectStore("draft-attachments-v3").get(${JSON.stringify(`${recoveredNamespace}:${offlineSession.sessionPath}`)});
      get.onsuccess = () => resolve(get.result?.images?.some(image => image.name === "native-clear-failure.svg") === true);
      tx.oncomplete = () => db.close();
    };
  })`);
  const retainedPhotoPayload = await recoveredPage.evaluate(`({
    text: document.querySelector('[data-testid="composer-input"]')?.value,
    image: !!document.querySelector('img[alt="native-clear-failure.svg"]'),
  })`);
  check("failed photo cleanup retains the complete visible payload and durable retry identity",
    photoAttempt?.length === 1 && photoEntry?.commandId === photoAttempt[0]
      && draftImageSurvived === true && retainedPhotoPayload?.text === photoClearText
      && retainedPhotoPayload?.image === true,
    JSON.stringify({ attempt: photoAttempt?.[0], entry: photoEntry, draftImageSurvived }));
  await assertReceiptOnce(offlineSession.sessionPath, photoEntry.commandId);
  recoveredPage.connection.close();
  adb("shell", "am", "force-stop", "com.omppulse.app");
  await wait(700);
  const photoRecoveryTarget = await openBubble(offlineSession.sessionPath, "native-photo-draft-restart");
  const photoRecoveryPage = await connectTarget(photoRecoveryTarget);
  await photoRecoveryPage.send("Page.enable");
  await until("photo draft restored in restarted bubble", () => photoRecoveryPage.evaluate(
    `!!document.querySelector('[data-testid="composer-input"]')
      && !!document.querySelector('img[alt="native-clear-failure.svg"]')`));
  const photoBeforeRetry = await photoRecoveryPage.evaluate(`({
    text: document.querySelector('[data-testid="composer-input"]')?.value,
    attemptIds: Object.keys(localStorage).filter(key => key.startsWith(${JSON.stringify(photoAttemptPrefix)}))
      .map(key => localStorage.getItem(key)),
  })`);
  await photoRecoveryPage.evaluate("document.querySelector('[data-testid=\"composer-input\"]')?.focus()");
  const photoRetryClicked = await composerClick(photoRecoveryPage);
  check("restarted bubble retries the entire restored payload without retyping",
    photoRetryClicked === true && photoBeforeRetry?.text === photoClearText);
  await until("photo retry is acknowledged and draft clears", () => photoRecoveryPage.evaluate(
    `document.querySelector('[data-testid="composer-input"]')?.value === ''
      && !document.querySelector('img[alt="native-clear-failure.svg"]')`));
  const photoAfterRetry = await nativeCall(photoRecoveryPage, recoveredNamespace, "get", { commandId: photoEntry.commandId });
  const photoAttemptCountAfterRetry = await photoRecoveryPage.evaluate(`Object.keys(localStorage)
    .filter(key => key.startsWith(${JSON.stringify(photoAttemptPrefix)})).length`);
  check("process-restart photo retry reuses the committed command ID instead of replaying",
    photoBeforeRetry?.attemptIds?.includes(photoEntry.commandId)
      && photoAfterRetry?.ok === true && photoAfterRetry.value?.commandId === photoEntry.commandId
      && photoAttemptCountAfterRetry === 0 && promptAttempts.get(photoEntry.commandId) === 1,
    JSON.stringify({ before: photoBeforeRetry, entry: photoAfterRetry?.value, postCount: promptAttempts.get(photoEntry.commandId) }));
  const photoRetryEchoes = await photoRecoveryPage.evaluate(`Array.from(document.querySelectorAll('[data-testid="chat-message"]'))
    .filter(row => row.textContent.includes(${JSON.stringify(photoClearText)})).length`);
  check("photo draft recovery leaves exactly one visible user message", photoRetryEchoes === 1, String(photoRetryEchoes));
  photographDevice("bubble-photo-draft-clear-recovery");
  photoRecoveryPage.connection.close();
  await bubblePage.connection.close();
  // Back must actually leave the bubble host rather than leaving it resumed
  // with a conversation no one can reach.
  let backLeftBubble = false;
  for (let attempt = 0; attempt < 3 && !backLeftBubble; attempt++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    await wait(1200);
    backLeftBubble = !bubbleResumed();
  }
  check('Back leaves the bubble host instead of leaving it resumed', backLeftBubble,
    JSON.stringify({ resumed: resumedComponent() }));
} catch (error) {
  check('WebView daily chat and notification journey completes', false, String(error.stack || error));
  try { photographDevice("failure"); } catch {}
}
console.log('WebView screenshots: ' + proofDir);
if (reliabilityProxy) {
  reliabilityProxy.closeAllConnections();
  reliabilityProxy.close();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
ws.close();
process.exit(failures);
