#!/usr/bin/env node
// Both live sockets exist and speak: the per-conversation /ws (frames,
// watching, prewarm) and the listing nudge channel /ws/sessions.
//
// WHY THIS EXISTS: a router refactor once dropped the `/ws` registration with
// nothing noticing — the app limps on HTTP polling without it, merely laggy
// rather than broken, so no suite caught it. The daemon broadcast into the
// void (`__sessions__` with no route) while the client 404'd its sessions
// socket in a reconnect loop. Two dial tones prove the halves meet.
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { loadPuppeteer, loadWs } from "../lib/env.mjs";

const NodeWebSocket = await loadWs();
const puppeteer = await loadPuppeteer();

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
if (!BASE || !TOKEN || !SESSIONS) {
  console.error("run through e2e/with-test-daemon.sh");
  process.exit(2);
}
if (BASE.includes("7682")) {
  console.error("refusing to run against the live daemon on 7682");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? `ok    ${name}` : `FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

import { mkdirSync, writeFileSync } from "fs";
mkdirSync(`${SESSIONS}/-tmp-sockets`, { recursive: true });
writeFileSync(
  `${SESSIONS}/-tmp-sockets/2026-08-20T23-00-00-000Z_019ff401-0000-7000-0000-0000000dd40b.jsonl`,
  [
    { type: "session", id: "019ff401-0000-7000-0000-0000000dd40b", cwd: "/tmp", title: "Sockets fixture" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n") + "\n",
);

const wsBase = BASE.replace(/^http/, "ws");
const dial = (url) =>
  new Promise((resolve) => {
    const ws = new NodeWebSocket(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    let opened = false;
    const frames = [];
    const done = () => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ open: opened, frames });
    };
    const timer = setTimeout(done, 8000);
    ws.on("open", () => {
      opened = true;
    });
    ws.on("message", (data) => {
      frames.push(String(data));
      if (frames.length >= 2) done();
    });
    ws.on("error", () => {});
    ws.on("close", () => done());
    // A quiet-but-open socket (idle session: no frames, heartbeat at 20 s)
    // resolves by openness, not by chatter.
    setTimeout(() => {
      if (opened) done();
    }, 3000);
  });
// The client always polls alongside the socket: populate the index first so
// the daemon has an etag to greet with (a fresh daemon has scanned nothing).
const listing = await fetch(`${BASE}/api/sessions`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});

const sessions = await dial(`${wsBase}/ws/sessions`);
check("sessions socket connects", sessions.open, `frames=${sessions.frames.length}`);
const frames = sessions.frames.map((frame) => JSON.parse(frame));
check(
  "sessions socket preserves the quoted HTTP ETag as valid JSON",
  frames.some((frame) => frame.type === "sessions" && frame.etag === listing.headers.get("etag")),
  sessions.frames.slice(0, 2).join(" | ").slice(0, 160),
);

// 2. Per-conversation socket: opens against a real session file.
const chat = await dial(
  `${wsBase}/ws?session=${encodeURIComponent(`${SESSIONS}/-tmp-sockets/2026-08-20T23-00-00-000Z_019ff401-0000-7000-0000-0000000dd40b.jsonl`)}`,
);
check("conversation socket connects", chat.open, `frames=${chat.frames.length}`);

console.log(failures === 0 ? "all checks passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
