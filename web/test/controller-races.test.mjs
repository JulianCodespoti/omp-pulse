#!/usr/bin/env node
// Live-stream races in the conversation controller, without a daemon.
//
// WHY: the phone's live state is assembled from two channels that do not
// share a clock — the /ws frame stream and /api/history pages — and the
// socket itself carries two kinds of frame. Three races lost streamed text or
// left a finished turn "running" (Stop up, every send refused as busy):
//
//  1. Frames >= 4 KB arrive as raw-deflate BINARY and decode asynchronously
//     (Blob stream + DecompressionStream); small frames are TEXT and were
//     handled synchronously. Measured in Chromium: a binary frame's decode
//     completes AFTER the next message task, every time. So a reconnect or
//     open bundle (snapshot: turn running) was applied after the `agent_end`
//     and idle `activity` queued behind it, and a lagging client's full
//     message snapshot was applied after the delta built on it, dropping text.
//  2. A history page carries the daemon's word on the turn as of when it was
//     computed. Landing after a live `agent_end` (or `agent_start`) it
//     overwrote the fresher socket state.
//  3. A `resync` (frames were dropped, the turn end among them) or `poll`
//     (the watcher jumped to EOF) arriving while a catch-up was in flight, or
//     a poll inside the 1.5 s cooldown, was simply discarded.
//
// Real controller and store, loaded through vite's SSR module loader; fake
// WebSocket and fetch; frames delivered one per macrotask like a browser
// delivers WebSocket messages. No daemon, no model calls, safe to run anywhere:
//   node web/test/controller-races.test.mjs

import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const { createServer } = await import(
  new URL("../node_modules/vite/dist/node/index.js", import.meta.url).href
);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};
const nextTask = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// ---- browser surface the controller touches -------------------------------
const listeners = () => {
  const map = new Map();
  return {
    addEventListener: (type, fn) => map.set(type, [...(map.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => map.set(type, (map.get(type) ?? []).filter((f) => f !== fn)),
    dispatchEvent: (event) => {
      for (const fn of map.get(event.type) ?? []) fn(event);
      return true;
    },
  };
};
const storage = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return storage.size; },
    key: (i) => [...storage.keys()][i] ?? null,
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  },
});
globalThis.window = Object.assign(globalThis, listeners(), {
  location: { origin: "http://daemon.test" },
});
globalThis.document = { visibilityState: "visible", ...listeners() };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = "blob";
    this.sent = [];
    FakeWebSocket.all.push(this);
  }
  send(data) { this.sent.push(data); }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  text(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  /** What the daemon sends a `defl` client for any frame >= ws_deflate_min. */
  binary(frame) {
    const bytes = deflateRawSync(Buffer.from(JSON.stringify(frame)));
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}
globalThis.WebSocket = FakeWebSocket;

// The daemon's truth, read when a request is SERVED; `hold` delays delivery.
const daemon = { running: false, now: null, endOffset: 100, historyCalls: [], hold: null };
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/api/history") {
    daemon.historyCalls.push(url.search);
    const body = {
      entries: [],
      endOffset: daemon.endOffset,
      nextBefore: null,
      running: daemon.running,
      now: daemon.now,
      at: Date.now(),
      sessionState: daemon.sessionState,
      extensionFeedback: url.searchParams.get("feedback") === "true" ? structuredClone(daemon.feedback) : undefined,
      extensionDialogs: url.searchParams.get("feedback") === "true" ? structuredClone(daemon.dialogs) : undefined,
    };
    const hold = daemon.hold;
    if (hold) {
      const signal = init.signal;
      let abort;
      try {
        await Promise.race([hold.promise, new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        })]);
      } finally { signal?.removeEventListener("abort", abort); }
    }
    return json(body);
  }
  if (url.pathname === "/api/version")
    return json({ protocolVersion: 3, minClientProtocolVersion: 3, releaseId: "dev" });
  if (url.pathname.startsWith("/api/receipts/")) return json({ error: "not found" }, 404);
  return json({});
};

const vite = await createServer({
  root: WEB,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  resolve: { alias: { "@": `${WEB}src` } },
});

try {
  const { OmpSessionController } = await vite.ssrLoadModule("/src/runtime/omp-session-controller.ts");
  const { createOmpStore, selectActivity, selectSessionCapability } = await vite.ssrLoadModule("/src/runtime/omp-store.ts");
  const { isOnLaptop } = await vite.ssrLoadModule("/src/app/session-format.ts");

  let sessionSeq = 0;
  const writing = () => ({ state: "writing", since: Date.now() - 2_000, turnStartedAt: Date.now() - 9_000, tools: 1 });
  const transcript = (count) =>
    Array.from({ length: count }, (_, i) => ({
      type: "message",
      id: `e${i}`,
      timestamp: new Date(Date.now() - (count - i) * 1_000).toISOString(),
      message: {
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `message ${i} ${"lorem ipsum ".repeat(20)}` }],
      },
    }));
  const bundle = (path, running) => ({
    type: "bundle",
    history: { entries: transcript(40), endOffset: daemon.endOffset, nextBefore: null },
    state: { streaming: running },
    running,
    now: running ? writing() : null,
    at: Date.now(),
  });

  /** A controller with a conversation open. `binaryBundle` is left to the caller. */
  async function openChat({ running, deliverBundle = true }) {
    daemon.running = running;
    daemon.now = running ? writing() : null;
    daemon.historyCalls = [];
    daemon.hold = null;
    daemon.feedback = undefined;
    daemon.dialogs = undefined;
    const path = `/sessions/race-${++sessionSeq}.jsonl`;
    const store = createOmpStore();
    const controller = new OmpSessionController(store, "test-token", "http://daemon.test");
    const opened = controller.openSession(path);
    const ws = FakeWebSocket.all.at(-1);
    ws.serverOpen();
    if (deliverBundle) {
      ws.text(bundle(path, running));
      await opened;
      await sleep(10);
    }
    const state = () => store.getState();
    const activity = () => selectActivity(store.getState(), path);
    return { path, store, controller, ws, opened, state, activity };
  }

  {
    const chat = await openChat({ running: false });
    const { seedDraft, readDraft } = await vite.ssrLoadModule("/src/app/composer/use-draft.ts");
    const destination = "/sessions/approved-plan.jsonl";
    seedDraft(chat.path, "Unsent planning feedback");
    seedDraft(destination, "Existing implementation draft");
    chat.ws.text({ type: "event", event: { type: "session_follow", sessionPath: destination, reason: "approved_plan" } });
    await nextTask();
    check("fresh approval follows the currently viewed planning conversation", chat.state().sessionPath === destination);
    check("fresh approval keeps source and destination drafts separate",
      readDraft(chat.path) === "Unsent planning feedback" && readDraft(destination) === "Existing implementation draft");
    const destinationSocket = FakeWebSocket.all.at(-1);
    destinationSocket.serverOpen();
    destinationSocket.text(bundle(destination, false));
    await nextTask();
    const unrelated = "/sessions/unrelated.jsonl";
    const opened = chat.controller.openSession(unrelated);
    const unrelatedSocket = FakeWebSocket.all.at(-1);
    unrelatedSocket.serverOpen();
    unrelatedSocket.text(bundle(unrelated, false));
    await opened;
    // A decoded frame from the retired socket must not steal a new chat.
    chat.ws.text({ type: "event", event: { type: "session_follow", sessionPath: destination, reason: "approved_plan" } });
    await nextTask();
    check("late fresh approval cannot replace an unrelated active conversation", chat.state().sessionPath === unrelated);
    chat.controller.dispose();
  }

  // Mobile network changes must replace half-open listing transports too.
  {
    const controller = new OmpSessionController(createOmpStore(), "test-token", "http://daemon.test");
    controller.startSessionsPolling(20);
    const socket = FakeWebSocket.all.at(-1);
    socket.serverOpen();
    window.dispatchEvent({ type: "focus" });
    const now = Date.now;
    Date.now = () => now() + 40_000;
    socket.text({ type: "sessions", etag: "fresh" });
    Date.now = () => now() + 60_000;
    await sleep(50);
    Date.now = now;
    check("fresh listing frames and brief focus do not churn a healthy socket",
      socket.readyState === FakeWebSocket.OPEN && FakeWebSocket.all.at(-1) === socket);
    controller.dispose();
  }
  for (const opened of [false, true]) {
    const controller = new OmpSessionController(createOmpStore(), "test-token", "http://daemon.test");
    controller.startSessionsPolling();
    const old = FakeWebSocket.all.at(-1);
    if (opened) old.serverOpen();
    window.dispatchEvent({ type: "online" });
    check(`network return replaces ${opened ? "OPEN" : "CONNECTING"} listing socket`,
      old.readyState === FakeWebSocket.CLOSED && FakeWebSocket.all.at(-1) !== old);
    controller.dispose();
  }
  {
    const controller = new OmpSessionController(createOmpStore(), "test-token", "http://daemon.test");
    controller.startSessionsPolling();
    const old = FakeWebSocket.all.at(-1);
    old.serverOpen();
    document.visibilityState = "hidden";
    document.dispatchEvent({ type: "visibilitychange" });
    const now = Date.now;
    Date.now = () => now() + 60_000;
    document.visibilityState = "visible";
    document.dispatchEvent({ type: "visibilitychange" });
    Date.now = now;
    check("return from suspend replaces a half-open listing socket",
      old.readyState === FakeWebSocket.CLOSED && FakeWebSocket.all.at(-1) !== old);
    controller.dispose();
  }
  for (const opened of [false, true]) {
    const controller = new OmpSessionController(createOmpStore(), "test-token", "http://daemon.test");
    controller.startSessionsPolling(20);
    const old = FakeWebSocket.all.at(-1);
    if (opened) old.serverOpen();
    const now = Date.now;
    Date.now = () => now() + 60_000;
    await sleep(50);
    Date.now = now;
    check(`silent ${opened ? "OPEN" : "CONNECTING"} listing transport expires without browser events`,
      old.readyState === FakeWebSocket.CLOSED && FakeWebSocket.all.at(-1) !== old);
    controller.dispose();
  }
  {
    const chat = await openChat({ running: false });
    window.dispatchEvent({ type: "online" });
    const connecting = FakeWebSocket.all.at(-1);
    window.dispatchEvent({ type: "online" });
    check("network return replaces a stranded chat handshake",
      connecting.readyState === FakeWebSocket.CLOSED && FakeWebSocket.all.at(-1) !== connecting);
    chat.controller.dispose();
  }
  {
    const chat = await openChat({ running: false });
    const held = deferred();
    const bytes = deflateRawSync(Buffer.from(JSON.stringify({ type: "event", event: { type: "agent_end", messages: [] } })));
    const blob = new Blob([bytes]);
    blob.arrayBuffer = () => held.promise;
    chat.ws.onmessage({ data: blob });
    window.dispatchEvent({ type: "online" });
    const replacement = FakeWebSocket.all.at(-1);
    replacement.serverOpen();
    replacement.text({ type: "event", event: { type: "agent_start" } });
    await sleep(20);
    check("retired socket decode cannot block a replacement turn", chat.state().agentWorking === true);
    held.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await sleep(60);
    check("retired socket frame cannot end the replacement turn", chat.state().agentWorking === true);
    chat.controller.dispose();
  }

  // 1. The open bundle is binary; the turn ended right after the socket
  //    attached, so `agent_end` + idle activity are queued behind it.
  {
    const chat = await openChat({ running: true, deliverBundle: false });
    chat.ws.binary(bundle(chat.path, true));
    await nextTask();
    daemon.running = false;
    daemon.now = null;
    chat.ws.text({ type: "event", event: { type: "agent_end", messages: [] } });
    await nextTask();
    chat.ws.text({ type: "activity", path: chat.path, now: null, at: Date.now() });
    await chat.opened;
    await sleep(60);
    check(
      "binary bundle does not resurrect a turn that ended behind it",
      chat.state().agentWorking === false && chat.activity() === null,
      `agentWorking=${chat.state().agentWorking} activity=${JSON.stringify(chat.activity())}`,
    );
    check("bundle transcript still painted", chat.state().messages.length === 40, `messages=${chat.state().messages.length}`);
    chat.controller.dispose();
  }

  // 2. A lagging client gets a FULL (binary) snapshot, then the next delta
  //    built on it. The delta must land on the snapshot, not vanish.
  {
    const chat = await openChat({ running: true });
    const update = (text) => ({
      type: "event",
      event: {
        type: "message_update",
        message: { role: "assistant", responseId: "resp-1", content: [{ type: "text", text }] },
      },
    });
    chat.ws.text(update("Hello"));
    await nextTask();
    chat.ws.text({ type: "md", id: "resp-1", a: " world" });
    await sleep(40);
    const snapshot = `Hello world. ${"The snapshot a conflated client receives. ".repeat(120)}`;
    chat.ws.binary(update(snapshot));
    await nextTask();
    chat.ws.text({ type: "md", id: "resp-1", a: "TAIL" });
    await nextTask();
    chat.ws.text({ type: "md", id: "resp-1", a: "+MORE" });
    await sleep(80);
    const text = chat.state().streamingMessage?.text ?? "";
    check(
      "delta after a binary full snapshot extends the snapshot",
      text === `${snapshot}TAIL+MORE`,
      `got …${JSON.stringify(text.slice(-24))} (${text.length} chars, want ${snapshot.length + 9})`,
    );
    chat.controller.dispose();
  }

  // 3a. A catch-up page computed while the turn ran lands after the live
  //     `agent_end`: the socket is fresher and must win.
  {
    const chat = await openChat({ running: true });
    daemon.hold = deferred();
    const catchUp = chat.controller.reloadHistory();
    await sleep(10); // request served: running=true, writing
    daemon.running = false;
    daemon.now = null;
    chat.ws.text({ type: "event", event: { type: "agent_end", messages: [] } });
    await nextTask();
    chat.ws.text({ type: "activity", path: chat.path, now: null, at: Date.now() });
    await nextTask();
    daemon.hold.resolve();
    await catchUp;
    await sleep(20);
    check(
      "stale history page does not undo a live agent_end",
      chat.state().agentWorking === false && chat.activity() === null,
      `agentWorking=${chat.state().agentWorking} activity=${JSON.stringify(chat.activity())}`,
    );
    chat.controller.dispose();
  }

  // 3b. The mirror: a page computed while idle lands after the next turn
  //     started streaming. It must not end the turn or commit the live text.
  {
    const chat = await openChat({ running: false });
    daemon.hold = deferred();
    const catchUp = chat.controller.reloadHistory();
    await sleep(10); // request served: running=false
    daemon.running = true;
    chat.ws.text({ type: "event", event: { type: "agent_start" } });
    await nextTask();
    chat.ws.text({
      type: "event",
      event: {
        type: "message_update",
        message: { role: "assistant", responseId: "resp-2", content: [{ type: "text", text: "Starting" }] },
      },
    });
    await nextTask();
    daemon.hold.resolve();
    await catchUp;
    chat.ws.text({ type: "md", id: "resp-2", a: " now" });
    await sleep(60);
    check(
      "stale idle page does not end a turn that started meanwhile",
      chat.state().agentWorking === true && chat.state().streamingMessage?.text === "Starting now",
      `agentWorking=${chat.state().agentWorking} streaming=${JSON.stringify(chat.state().streamingMessage?.text ?? null)}`,
    );
    chat.controller.dispose();
  }

  // 4. The turn's end frames were dropped (queue overflow) and a `resync`
  //    arrives while an older catch-up is still in flight.
  {
    const chat = await openChat({ running: true });
    daemon.hold = deferred();
    const first = chat.controller.reloadHistory();
    await sleep(10); // served before the end: running=true
    daemon.running = false;
    daemon.now = null;
    chat.ws.text({ type: "resync", reason: "overflow" });
    await nextTask();
    const hold = daemon.hold;
    daemon.hold = null;
    hold.resolve();
    await first;
    await sleep(60);
    check(
      "resync during an in-flight catch-up still refetches and ends the turn",
      chat.state().agentWorking === false && daemon.historyCalls.length === 2,
      `agentWorking=${chat.state().agentWorking} history calls=${daemon.historyCalls.length}`,
    );
    chat.controller.dispose();
  }

  // 5. The watcher jumped to EOF and sent `poll` inside the catch-up cooldown.
  //    Coalescing may delay that fetch, never drop it.
  {
    const chat = await openChat({ running: false });
    await chat.controller.reloadHistory();
    const before = daemon.historyCalls.length;
    daemon.endOffset += 5_000;
    chat.ws.text({ type: "poll" });
    await sleep(2_000);
    check(
      "poll inside the cooldown is fetched once the cooldown ends",
      daemon.historyCalls.length === before + 1 && chat.state().endOffset === daemon.endOffset,
      `history calls ${before}→${daemon.historyCalls.length}, endOffset=${chat.state().endOffset} want ${daemon.endOffset}`,
    );
    chat.controller.dispose();
  }
  // Switching chats must not inherit an old conversation's blocked fetch.
  {
    const chat = await openChat({ running: false });
    const oldHold = deferred();
    daemon.hold = oldHold;
    let cancelled = false;
    const oldFetch = chat.controller.reloadHistory().finally(() => { cancelled = true; });
    await sleep(10);
    daemon.hold = null;
    const path = `/sessions/race-${++sessionSeq}.jsonl`;
    const opened = chat.controller.openSession(path);
    const ws = FakeWebSocket.all.at(-1);
    ws.serverOpen();
    ws.text(bundle(path, false));
    await opened;
    daemon.endOffset += 100;
    await chat.controller.reloadHistory();
    check("new chat recovers while the old chat history request is blocked",
      chat.state().endOffset === daemon.endOffset,
      `endOffset=${chat.state().endOffset} want ${daemon.endOffset}`);
    check("switching chats cancels the old HTTP read without waiting for its server", cancelled);
    oldHold.resolve();
    await oldFetch;
    chat.controller.dispose();
  }
  // Captured from a real early Stop: no provider responseId is available.
  for (const historyFirst of [false, true]) {
    const chat = await openChat({ running: true });
    const message = { role: "assistant", content: [], timestamp: 1790398070674,
      model: "test-model", provider: "test-provider", stopReason: "aborted",
      errorMessage: "Interrupted by user", completedAt: 1790398070675 };
    const entry = { type: "message", id: "saved-stop", timestamp: "2026-09-26T04:47:50.675Z", message };
    const persisted = () => chat.ws.text({ type: "entries", entries: [entry] });
    if (historyFirst) persisted();
    chat.ws.text({ type: "event", event: { type: "message_start", message } });
    chat.ws.text({ type: "event", event: { type: "message_end", message } });
    if (!historyFirst) persisted();
    chat.ws.text({ type: "event", event: { type: "agent_end", messages: [message] } });
    await sleep(20);
    const outcomes = chat.state().messages.filter(m => m.errorMessage);
    check(`interrupted stream and history converge (${historyFirst ? "history" : "stream"} first)`,
      outcomes.length === 1 && outcomes[0].id === "saved-stop", `outcomes=${outcomes.length}`);
    check("explicit interrupted status reaches the renderer", outcomes[0]?.stopReason === "aborted");
    const second = { ...message, timestamp: message.timestamp + 1000 };
    chat.ws.text({ type: "event", event: { type: "message_end", message: second } });
    chat.ws.text({ type: "entries", entries: [{ ...entry, id: "second-stop", message: second }] });
    await sleep(20);
    check("a separate interruption remains a separate outcome",
      chat.state().messages.filter(m => m.errorMessage).map(m=>m.id).join(",") === "saved-stop,second-stop");
    chat.controller.dispose();
  }
  const authority = (revision, turn, daemonInstanceId = "daemon-a", bindingEpoch = 1) => ({
    daemonInstanceId, revision, bindingEpoch, owner: { kind: "child", pid: 123, processStart: 10 },
    turn, confidence: "confirmed", connection: "connected", observedAt: Date.now(),
    activity: turn === "running" ? { source: "child", kind: "writing", observedAt: Date.now(), stale: false } : null,
    capabilities: { read: true, stream: true, control: true, send: true, stop: true, answer: true, settings: true, bash: true },
  });

  const uiRequest = (id, method, fields) => ({ type: "extension_ui_request", id, method, ...fields });
  const feedbackSnapshot = (requests) => ({ type: "extension_ui_snapshot", requests });
  const editorRequest = (id, text) => uiRequest(id, "set_editor_text", { text });
  const statusRequest = (id, text) => uiRequest(id, "setStatus", { statusKey: "review", statusText: text });
  const feedbackEvent = (chat, event, sessionState = authority(10, "idle")) =>
    chat.ws.text({ type: "event", sessionState, event });
  const staleFeedback = () => feedbackSnapshot([
    statusRequest("stale-status", "Reviewing"),
    uiRequest("stale-widget", "setWidget", { widgetKey: "old", widgetLines: ["Old summary"] }),
    uiRequest("stale-notice", "notify", { message: "Old notice" }),
  ]);
  const dialogSnapshot = (requests) => ({ type: "extension_dialog_snapshot", requests });
  const askRequest = (id) => uiRequest(id, "ask", {
    questions: [{ id: "db", question: "Which database?", options: [{ label: "SQLite", description: "Single file", preview: "  exact\npreview" }], multi: false, recommended: 0 }],
  });
  {
    const chat = await openChat({ running: true });
    feedbackEvent(chat, { type: "extension_error", extensionPath: "/extensions/review.ts", event: "tool_call", error: "hook rejected its input" }, authority(10, "running"));
    await nextTask();
    check("recoverable native extension failure exposes extension, hook and reason",
      chat.state().extensionFeedback.notices[0]?.message === "Extension /extensions/review.ts (tool_call): hook rejected its input");
    check("recoverable native extension failure does not terminalise or create a transport error",
      chat.state().agentWorking && chat.state().error === null);
    chat.controller.dispose();
  }
  {
    const chat = await openChat({ running: false });
    const notice = uiRequest("native:123:1:8", "notify", { message: "Handoff failed: provider unavailable", notifyType: "info" });
    // Native output has no request id and may arrive after the prompt ACK.
    feedbackEvent(chat, { type: "command_output", text: notice.message, feedbackId: notice.id });
    await nextTask();
    check("late native command output appears without claiming a new agent turn",
      chat.state().extensionFeedback.notices[0]?.message === notice.message && !chat.state().agentWorking);
    daemon.sessionState = authority(11, "idle");
    daemon.feedback = feedbackSnapshot([notice]);
    chat.ws.text({ type: "resync" });
    await sleep(40);
    check("late command result survives same-socket recovery once with its binding identity",
      chat.state().extensionFeedback.notices.length === 1 && chat.state().extensionFeedback.notices[0]?.id === notice.id);
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  {
    const chat = await openChat({ running: false });
    const elsewhere = `/sessions/race-${++sessionSeq}.jsonl`;
    const moved = chat.controller.openSession(elsewhere);
    const elsewhereSocket = FakeWebSocket.all.at(-1);
    elsewhereSocket.serverOpen();
    elsewhereSocket.text(bundle(elsewhere, false));
    await moved;
    const notice = uiRequest("native:123:1:late", "notify", {
      message: "Handoff failed: initiating conversation only", notifyType: "info",
    });
    // A decoded result from A's retired socket must never become B's result.
    feedbackEvent(chat, { type: "command_output", text: notice.message, feedbackId: notice.id });
    await nextTask();
    check("late output from a retired conversation cannot enter the new conversation",
      chat.state().sessionPath === elsewhere && chat.state().extensionFeedback.notices.length === 0);
    const returned = chat.controller.openSession(chat.path);
    const returnedSocket = FakeWebSocket.all.at(-1);
    returnedSocket.serverOpen();
    returnedSocket.text(bundle(chat.path, false));
    await returned;
    daemon.sessionState = authority(11, "idle");
    daemon.feedback = feedbackSnapshot([notice]);
    returnedSocket.text({ type: "resync" });
    await sleep(40);
    const latestRead = new URLSearchParams(daemon.historyCalls.at(-1));
    check("returning to the initiating conversation recovers its retained late result",
      latestRead.get("session") === chat.path && chat.state().extensionFeedback.notices[0]?.id === notice.id);
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  for (const frame of ["resync", "poll"]) {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, askRequest("stale-question"));
    daemon.sessionState = authority(11, "idle");
    daemon.dialogs = dialogSnapshot([askRequest("missed-question")]);
    const socketsBefore = FakeWebSocket.all.length;
    chat.ws.text({ type: frame });
    await sleep(40);
    const dialogs = chat.state().extensionDialogs;
    check(`${frame} restores the exact missing ask and closes an authoritatively absent question`,
      dialogs.pending.map(dialog => dialog.id).join(",") === "missed-question"
      && dialogs.pending[0]?.questions[0]?.options[0]?.preview === "  exact\npreview"
      && dialogs.closed.includes("stale-question") && FakeWebSocket.all.length === socketsBefore);
    daemon.dialogs = dialogSnapshot([]);
    chat.ws.text({ type: "resync" });
    await sleep(40);
    check(`${frame} removes a missed answer/cancel closure`, chat.state().extensionDialogs.pending.length === 0
      && chat.state().extensionDialogs.closed.includes("missed-question"));
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, askRequest("closed-during-read"));
    daemon.sessionState = authority(11, "idle");
    daemon.dialogs = dialogSnapshot([askRequest("closed-during-read"), askRequest("recovered-during-read")]);
    const hold = daemon.hold = deferred();
    chat.ws.text({ type: "resync" });
    await nextTask();
    feedbackEvent(chat, uiRequest("cancel-now", "cancel", { targetId: "closed-during-read" }), authority(12, "idle"));
    feedbackEvent(chat, askRequest("new-live-question"), authority(13, "idle"));
    hold.resolve();
    await sleep(40);
    check("question catch-up recovers missing ids while preserving newer live asks and closures",
      chat.state().extensionDialogs.pending.map(dialog => dialog.id).join(",") === "recovered-during-read,new-live-question"
      && chat.state().extensionDialogs.closed.includes("closed-during-read"));
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  {
    const chat = await openChat({ running: true });
    daemon.sessionState = authority(11, "running");
    daemon.dialogs = dialogSnapshot([askRequest("unseen-before-turn-ended")]);
    const hold = daemon.hold = deferred();
    chat.ws.text({ type: "resync" });
    await nextTask();
    feedbackEvent(chat, { type: "agent_end", isTerminal: true }, authority(12, "idle"));
    hold.resolve();
    await sleep(40);
    check("a newer terminal boundary fences even a snapshot question never seen locally",
      chat.state().extensionDialogs.pending.length === 0 && !chat.state().agentWorking);
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  for (const change of ["binding", "daemon"]) {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, askRequest("current-question"));
    daemon.sessionState = authority(10, "idle");
    daemon.dialogs = dialogSnapshot([askRequest("retired-question")]);
    const hold = daemon.hold = deferred();
    chat.ws.text({ type: "resync" });
    await nextTask();
    chat.ws.text({ type: "activity", path: chat.path, now: null,
      sessionState: change === "binding" ? authority(11, "idle", "daemon-a", 2) : authority(1, "idle", "daemon-b") });
    hold.resolve();
    await sleep(40);
    check(`retired ${change} question snapshot cannot introduce an old question`,
      !chat.state().extensionDialogs.pending.some(dialog => dialog.id === "retired-question"));
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  for (const frame of ["resync", "poll"]) {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, staleFeedback());
    daemon.sessionState = authority(11, "idle");
    daemon.feedback = feedbackSnapshot([
      editorRequest(`recovered-${frame}`, "  Prepared while updates were dropped\nExact text  "),
      uiRequest("current-widget", "setWidget", { widgetKey: "summary", widgetLines: ["Current summary"], widgetPlacement: "belowEditor" }),
      uiRequest("current-notice", "notify", { message: "Current notice", notifyType: "warning" }),
    ]);
    const socketsBefore = FakeWebSocket.all.length;
    chat.ws.text({ type: frame });
    await sleep(40);
    const recovered = chat.state().extensionFeedback;
    check(`${frame} clears stale status and restores current widget and notice without reconnect`,
      recovered.statuses.length === 0 && recovered.widgets.length === 1
      && recovered.widgets[0].lines[0] === "Current summary" && recovered.widgets[0].placement === "belowEditor"
      && recovered.notices.length === 1 && recovered.notices[0].message === "Current notice"
      && recovered.notices[0].severity === "warning" && FakeWebSocket.all.length === socketsBefore);
    check(`${frame} recovers the exact missing prepared draft`, recovered.editorDraft?.text === "  Prepared while updates were dropped\nExact text  ");
    chat.controller.consumeEditorDraft(chat.path, `recovered-${frame}`);
    daemon.feedback = feedbackSnapshot([editorRequest(`recovered-${frame}`, "  Prepared while updates were dropped\nExact text  ")]);
    chat.ws.text({ type: "resync" });
    await sleep(40);
    check(`${frame} replay clears removed surfaces without resurrecting consumed prepared text`,
      chat.state().extensionFeedback.editorDraft === null && chat.state().extensionFeedback.widgets.length === 0
      && chat.state().extensionFeedback.notices.length === 0);
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  for (const change of ["revision", "binding", "daemon"]) {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, staleFeedback());
    daemon.sessionState = authority(10, "idle");
    daemon.feedback = feedbackSnapshot([statusRequest("old-result", "Old response"), editorRequest(`old-${change}`, "Must not appear")]);
    const hold = daemon.hold = deferred();
    chat.ws.text({ type: "resync" });
    await nextTask();
    const replacement = change === "revision" ? authority(11, "idle")
      : change === "binding" ? authority(11, "idle", "daemon-a", 2)
      : authority(1, "idle", "daemon-b");
    chat.ws.text({ type: "activity", path: chat.path, now: null, sessionState: replacement });
    hold.resolve();
    await sleep(40);
    check(`late feedback from a retired ${change} cannot change surfaces or prepare a draft`,
      chat.state().extensionFeedback.statuses[0]?.text === "Reviewing" && chat.state().extensionFeedback.editorDraft === null);
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, staleFeedback());
    daemon.sessionState = authority(10, "idle");
    daemon.feedback = feedbackSnapshot([statusRequest("old-status", "Old response"), editorRequest("old-live", "Old prepared text")]);
    const hold = daemon.hold = deferred();
    chat.ws.text({ type: "resync" });
    await nextTask();
    // Feedback does not necessarily advance the authority revision.
    feedbackEvent(chat, statusRequest("new-status", "Live response"));
    feedbackEvent(chat, editorRequest("new-live", "New prepared text"));
    hold.resolve();
    await sleep(40);
    check("same-revision live feedback wins over a delayed catch-up snapshot",
      chat.state().extensionFeedback.statuses[0]?.text === "Live response"
      && chat.state().extensionFeedback.editorDraft?.text === "New prepared text");
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  for (const [liveChange, noticeCount] of [["question", 0], ["status", 0], ["revision", 0], ["status", 24]]) {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, staleFeedback());
    const initialNotices = Array.from({ length: noticeCount }, (_, index) => ({
      type: "extension_ui_request", method: "notify", id: `old-${index}`, message: `Earlier notice ${index}`,
    }));
    for (const notice of initialNotices) feedbackEvent(chat, notice);
    daemon.sessionState = authority(10, "idle");
    daemon.feedback = feedbackSnapshot([
      ...initialNotices,
      { type: "extension_ui_request", method: "notify", id: `missed-${liveChange}-${noticeCount}`, notifyType: "error", message: "Handoff failed: delayed provider failure" },
      statusRequest("snapshot-status", "Older status"),
    ]);
    const hold = daemon.hold = Promise.withResolvers();
    chat.ws.text({ type: "resync" });
    await nextTask();
    if (liveChange === "question") feedbackEvent(chat, { type: "extension_ui_request", method: "confirm", id: "new-question", title: "Keep waiting?" });
    if (liveChange === "status") feedbackEvent(chat, statusRequest("live-status", "New live status"));
    if (liveChange === "revision") chat.ws.text({ type: "activity", path: chat.path, now: null, sessionState: authority(11, "idle") });
    hold.resolve();
    await sleep(40);
    check(`missed native output survives concurrent ${liveChange} with ${noticeCount} retained notices`,
      chat.state().extensionFeedback.notices.some(notice => notice.id === `missed-${liveChange}-${noticeCount}`));
    if (noticeCount) check("new recovered output evicts the oldest notice rather than itself",
      chat.state().extensionFeedback.notices.length === 24
      && !chat.state().extensionFeedback.notices.some(notice => notice.id === "old-0")
      && chat.state().extensionFeedback.notices.some(notice => notice.id === "old-23"));
    check(`native output recovery preserves the newer ${liveChange} surface`,
      liveChange === "status" ? chat.state().extensionFeedback.statuses[0]?.text === "New live status"
        : liveChange === "question" ? chat.state().extensionDialogs.pending.some(request => request.id === "new-question")
          : chat.state().extensionFeedback.statuses[0]?.text === "Reviewing");
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  for (const action of ["prepare", "consume"]) {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, staleFeedback());
    if (action === "consume") feedbackEvent(chat, editorRequest("pending-consumption", "Prepared before catch-up"));
    daemon.sessionState = authority(10, "idle");
    daemon.feedback = feedbackSnapshot([editorRequest(`old-${action}`, "Older server preparation")]);
    const hold = daemon.hold = deferred();
    chat.ws.text({ type: "resync" });
    await nextTask();
    if (action === "prepare") chat.controller.prepareEditorDraft(chat.path, "New local preparation");
    else chat.controller.consumeEditorDraft(chat.path, "pending-consumption");
    hold.resolve();
    await sleep(40);
    check(`catch-up preserves a local ${action} made during the read while clearing stale status`,
      chat.state().extensionFeedback.statuses.length === 0
      && (action === "prepare" ? chat.state().extensionFeedback.editorDraft?.text === "New local preparation"
        : chat.state().extensionFeedback.editorDraft === null));
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  {
    const chat = await openChat({ running: false });
    feedbackEvent(chat, staleFeedback());
    daemon.sessionState = authority(10, "idle");
    daemon.feedback = feedbackSnapshot([editorRequest("old-session", "Old conversation text")]);
    const hold = daemon.hold = deferred();
    chat.ws.text({ type: "resync" });
    await nextTask();
    daemon.hold = null;
    delete daemon.sessionState;
    const destination = `/sessions/feedback-destination-${++sessionSeq}.jsonl`;
    const opened = chat.controller.openSession(destination);
    const ws = FakeWebSocket.all.at(-1);
    ws.serverOpen();
    ws.text(bundle(destination, false));
    await opened;
    ws.text({ type: "event", sessionState: authority(1, "idle"), event: feedbackSnapshot([
      statusRequest("destination-status", "Destination feedback"), editorRequest("destination-draft", "Destination preparation"),
    ]) });
    hold.resolve();
    await sleep(40);
    check("late catch-up cannot replace destination feedback or draft after a session switch",
      chat.state().sessionPath === destination && chat.state().extensionFeedback.statuses[0]?.text === "Destination feedback"
      && chat.state().extensionFeedback.editorDraft?.text === "Destination preparation");
    chat.controller.dispose();
  }
  check("uncertain daemon child is not misclassified as a laptop owner", !isOnLaptop({ path: "/child.jsonl", live: true, sessionState: authority(1, "unknown") }));
  check("canonical laptop owner stays discoverable without legacy live flags", isOnLaptop({ path: "/desktop.jsonl", sessionState: { ...authority(1, "idle"), owner: { kind: "bridge", pid: 456 } } }));
  {
    const chat = await openChat({ running: true });
    const at = Date.now() - 60_000;
    const canonical = authority(10, "running");
    canonical.activity = { source: "child", kind: "tool", observedAt: at, since: at - 3_000, turnStartedAt: at - 9_000, tools: 2, stale: false };
    chat.ws.text({ type: "activity", path: chat.path, at, now: { ...writing(), since: at - 3_000, turnStartedAt: at - 9_000 }, sessionState: canonical });
    await nextTask();
    const activity = chat.state().activity;
    check("canonical activity preserves elapsed clocks across device skew", activity?.tools === 2 && Math.abs(Date.now() - activity.since - 3_000) < 500 && Math.abs(Date.now() - activity.turnStartedAt - 9_000) < 500);
    chat.controller.dispose();
  }
  {
    daemon.sessionState = authority(8, "running");
    const chat = await openChat({ running: true, deliverBundle: false });
    await chat.opened;
    check("HTTP-first open installs canonical turn before socket bundle", chat.state().agentWorking && chat.state().sessionAuthorities[chat.path]?.revision === 8);
    chat.ws.text({ ...bundle(chat.path, false), sessionState: authority(7, "idle") });
    await nextTask();
    check("late initial bundle cannot replace fresher HTTP state", chat.state().agentWorking && chat.state().sessionAuthorities[chat.path]?.revision === 8);
    chat.controller.dispose();
    delete daemon.sessionState;
  }
  {
    const chat = await openChat({ running: false });
    chat.ws.text({ type: "event", sessionState: authority(4, "running"), event: { type: "agent_start" } });
    await nextTask();
    chat.ws.text({ type: "event", sessionState: authority(5, "idle"), event: { type: "agent_end", isTerminal: true } });
    await nextTask();
    chat.ws.text({ ...bundle(chat.path, true), sessionState: authority(3, "running") });
    await nextTask();
    check("older canonical bundle cannot resurrect a completed turn", !chat.state().agentWorking && chat.state().sessionAuthorities[chat.path]?.revision === 5);
    chat.ws.text({ type: "event", sessionState: authority(4, "running"), event: { type: "agent_start" } });
    await nextTask();
    check("older same-owner start cannot resurrect an idle turn", !chat.state().agentWorking && chat.state().sessionAuthorities[chat.path]?.revision === 5);
    chat.ws.text({ type: "activity", path: chat.path, now: writing(), sessionState: authority(1, "running", "daemon-b") });
    await nextTask();
    chat.ws.text({ type: "activity", path: chat.path, now: null, sessionState: authority(100, "idle", "daemon-a") });
    await nextTask();
    check("retired daemon cannot overwrite restarted daemon state", chat.state().agentWorking && chat.state().sessionAuthorities[chat.path]?.daemonInstanceId === "daemon-b");
    chat.controller.dispose();
  }
  {
    const chat = await openChat({ running: true });
    chat.ws.text({ type: "event", sessionState: authority(8, "running", "daemon-a", 2), event: { type: "message_update", message: { role: "assistant", responseId: "new-owner", content: [{ type: "text", text: "New owner response" }] } } });
    await sleep(40);
    chat.ws.text({ type: "event", sessionState: authority(7, "idle", "daemon-a", 1), event: { type: "agent_end", isTerminal: true } });
    await nextTask();
    check("retired owner end cannot commit a replacement live response", chat.state().agentWorking && chat.state().streamingMessage?.text === "New owner response");
    chat.controller.dispose();
  }
  {
    const chat = await openChat({ running: true });
    chat.ws.text({ type: "event", event: { type: "agent_end", isTerminal: false } });
    await nextTask();
    check("nonterminal legacy end preserves running state", chat.state().agentWorking);
    chat.ws.text({ type: "event", event: { type: "message_update", message: { role: "assistant", responseId: "live-current", content: [{ type: "text", text: "Current live response" }] } } });
    await sleep(40);
    chat.controller.reconcileSessionState("/sessions/another-chat.jsonl", { running: false, now: null });
    check("idle listing row cannot commit another chat response", chat.state().streamingMessage?.text === "Current live response");
    chat.controller.dispose();
  }
  {
    const store = createOmpStore();
    store.getState().beginSession("/open.jsonl");
    store.getState().reconcileSessionState("/open.jsonl", { sessionState: authority(4, "running", "old") }, 4);
    store.getState().reconcileSessionState("/listed.jsonl", { sessionState: authority(1, "idle", "new") }, 5);
    check("daemon replacement clears old open-chat turn evidence", !store.getState().agentWorking && !store.getState().sessionAuthorities["/open.jsonl"]);
    store.getState().reconcileSessionState("/listed.jsonl", { sessionState: authority(50, "running", "unseen-stale") }, 3);
    check("old HTTP response cannot introduce a stale daemon namespace", store.getState().sessionAuthorities["/listed.jsonl"]?.daemonInstanceId === "new");
    store.getState().reconcileSessionState("/listed.jsonl", { sessionState: authority(2, "idle", "new", 2) }, 6);
    store.getState().reconcileSessionState("/listed.jsonl", { sessionState: authority(3, "running", "new", 1) }, 7);
    check("retired owner binding cannot resurrect a turn", store.getState().sessionAuthorities["/listed.jsonl"]?.turn === "idle");
    const caps = createOmpStore();
    caps.getState().setSessions([{ path: "/legacy-read-only.jsonl", capabilities: { read: true, stream: true, control: false } }]);
    caps.getState().reconcileSessionState("/confirmed.jsonl", { sessionState: { ...authority(1, "idle", "new"), capabilities: { send: false, stop: true } } }, 8);
    caps.getState().reconcileSessionState("/inferred.jsonl", { sessionState: { ...authority(1, "unknown", "new"), confidence: "inferred", owner: { kind: "foreign" }, capabilities: { send: false, stop: false } } }, 9);
    check("confirmed per-method capability is honored", selectSessionCapability(caps.getState(), "/confirmed.jsonl", "send") === false && selectSessionCapability(caps.getState(), "/confirmed.jsonl", "stop") === true);
    check("inferred capability does not remove existing child/foreign routes", selectSessionCapability(caps.getState(), "/inferred.jsonl", "send") === null && selectSessionCapability(caps.getState(), "/inferred.jsonl", "stop") === null);
    check("legacy explicit read-only fallback remains honored", selectSessionCapability(caps.getState(), "/legacy-read-only.jsonl", "send") === false);
    check("missing legacy capability remains route-compatible", selectSessionCapability(caps.getState(), "/legacy-unknown.jsonl", "send") === null);
  }
} catch (error) {
  check("suite ran to completion", false, String(error?.stack ?? error));
} finally {
  await vite.close();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures);
