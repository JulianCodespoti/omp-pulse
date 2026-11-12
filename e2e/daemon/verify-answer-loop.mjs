#!/usr/bin/env node
// Answer-endpoint guards: every rejection branch of POST /api/panes/answer,
// deterministic, no model calls.
//
// This suite deliberately starts no omp child or model turn. Native ask
// handoff/closure and collab answer lifetimes have UI/controller and daemon
// unit coverage; these checks exercise the HTTP rejection contract:
//
//   missing sessionPath -> 400          invalid path -> ok:false
//   missing file -> 404                 bad text -> 400
//   valid file, no pane, no child dialog -> ok:false "not waiting"
//
// Runs under e2e/with-test-daemon.sh. Exit code = number of failures.

import { mkdirSync, writeFileSync } from "fs";

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
const post = async (body) => {
  const r = await fetch(`${BASE}/api/panes/answer`, {
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

let r = await post({ text: "1" });
check("missing sessionPath -> 400", r.status === 400);

r = await post({ sessionPath: "n/a", text: "1" });
check("invalid path -> ok:false", r.json?.ok === false);

// A real idle session with no dialog anywhere: verifies the endpoint
// resolves (file exists, text valid) and then refuses honestly. Path
// validation runs before text validation, so text guards need an in-root
// path to reach the text checks.
mkdirSync(`${SESSIONS}/-tmp-answer-guards`, { recursive: true });
const fp = `${SESSIONS}/-tmp-answer-guards/idle.jsonl`;
writeFileSync(fp, JSON.stringify({ type: "session", id: "idle-1", cwd: "/tmp", title: "Idle" }) + "\n");

r = await post({ sessionPath: fp, text: "1\n" });
check("control chars -> 400", r.status === 400);

r = await post({ sessionPath: fp, text: "x".repeat(501) });
check("overlong text -> 400", r.status === 400);

r = await post({ sessionPath: `${SESSIONS}/nope.jsonl`, text: "1" });
check("missing file -> 404", r.status === 404);
r = await post({ sessionPath: fp, text: "1" });
check(
  "idle session answers not-waiting, not held-pane",
  r.json?.ok === false && typeof r.json?.error === "string" && r.json.error.length > 0,
  JSON.stringify(r.json),
);

console.log(failures === 0 ? "all checks passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
