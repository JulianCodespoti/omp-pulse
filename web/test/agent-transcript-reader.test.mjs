import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Bundle the real framework-free modules. Every transport below is synthetic;
// no browser, daemon, desktop session, persistent storage, or model is involved.
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = `
  export * from ${JSON.stringify(resolve(root, "web/src/domain/agent-transcript.ts"))};
  export * from ${JSON.stringify(resolve(root, "web/src/runtime/agent-transcript-reader.ts"))};
  export { DaemonApi } from ${JSON.stringify(resolve(root, "web/src/runtime/rpc-client.ts"))};
`;
const build = await rolldown({
  input: "agent-transcript-reader-fixture",
  platform: "node",
  transform: { define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1 }) } },
  plugins: [{
    name: "agent-transcript-reader-fixture",
    resolveId: (id) => id === "agent-transcript-reader-fixture" ? "\0agent-transcript-reader-fixture" : null,
    load: (id) => id === "\0agent-transcript-reader-fixture" ? source : null,
  }],
});
let actual;
try {
  const generated = await build.generate({ format: "esm", codeSplitting: false });
  assert.equal(generated.output.length, 1, "bundle all production dependencies");
  actual = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString("base64")}`);
} finally {
  await build.close();
}
const {
  AGENT_MESSAGE_LIMIT, AGENT_BYTE_LIMIT, AGENT_RECORD_LIMIT,
  appendAgentEntries, appendAgentJsonl, emptyAgentTranscript, visibleAgentTranscript,
  AgentTranscriptReader, emptyAgentTranscriptSnapshot, DaemonApi,
} = actual;

beforeEach((t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Real network access is prohibited in this suite"); });
});

const sessionPath = "/synthetic/parent session #1.jsonl";
const agentId = "registry-agent/é #1";
const connectionId = "synthetic-connection/+?& #1";
const row = (id, text = id, role = "assistant") => ({ type: "message", id, message: { role, content: text } });
const call = (id = "assistant-call", callId = "call-one") => ({
  type: "message", id, message: { role: "assistant", content: [
    { type: "text", text: "Checking the synthetic file" },
    { type: "toolCall", id: callId, name: "read", arguments: { path: "/synthetic/file.txt" } },
  ] },
});
const result = (callId = "call-one", output = "line one\n\nline two\n", isError = false) => ({
  type: "message", id: `result-${callId}`, timestamp: "2026-10-07T12:00:00Z",
  message: { role: "toolResult", toolCallId: callId, toolName: "read", isError, content: [{ type: "text", text: output }] },
});
const jsonl = (...values) => values.map((value) => `${JSON.stringify(value)}\n`).join("");
const byteLength = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const retainedBytes = (state) => byteLength(state.messages) + byteLength(state.orphanResults) + byteLength(state.carry);
const tool = (message) => message.parts.find((part) => part.kind === "tool");
const texts = (snapshot) => snapshot.messages.map((message) => message.text);
const codedError = (code, message = `Synthetic ${code}`) => Object.assign(new Error(message), { code });

function fixture(t, source = "desktop", selection = {}) {
  const requests = [];
  const snapshots = [];
  const enqueue = (kind, path, id, fromByte, signal, expectedCreatedAt, expectedConnectionId) => new Promise((resolve, reject) => {
    requests.push({ kind, path, id, fromByte, signal, expectedCreatedAt, expectedConnectionId, resolve, reject });
  });
  const api = {
    getDesktopAgentTranscript: (path, id, fromByte, signal, expectedCreatedAt, expectedConnectionId) =>
      enqueue("desktop", path, id, fromByte, signal, expectedCreatedAt, expectedConnectionId),
    getSubagentMessages: (path, sel, signal) => {
      assert.deepEqual(Object.keys(sel).sort(), ["fromByte", "subagentId"], "never select an arbitrary session file");
      return enqueue("rpc", path, sel.subagentId, sel.fromByte, signal);
    },
  };
  const reader = new AgentTranscriptReader(api, sessionPath, { source, id: agentId, ...selection }, (snapshot) => snapshots.push(snapshot));
  t.after(() => reader.dispose());
  const respond = (index, values = [], nextByte = requests[index].fromByte, extra = {}) => {
    const request = requests[index];
    request.resolve(source === "desktop"
      ? { ok: true, connectionId, agentId: request.id, fromByte: request.fromByte, nextByte, text: Array.isArray(values) ? jsonl(...values) : values, reset: false, ...extra }
      : { entries: values, nextByte, ...extra });
    return nextByte;
  };
  // Normal desktop reads expose exactly the bytes returned. RPC offsets are
  // independent and may include records that never become visible messages.
  // Use respond directly only for explicit reset/protocol-error fixtures.
  const advance = (index, values = [], rpcNextByte = requests[index].fromByte) => respond(index, values,
    source === "desktop" ? requests[index].fromByte + byteLength(Array.isArray(values) ? jsonl(...values) : values) : rpcNextByte);
  return { reader, requests, snapshots, respond, advance, latest: () => snapshots.at(-1) };
}

test("phone transcript reuse cannot append another registry file into a retained completed conversation", async t => {
  const f=fixture(t,"rpc",{sessionFile:"/synthetic/agent-original.jsonl"});
  let pending=f.reader.read();f.respond(0,[row("old","Original completed conversation")],100,{sessionFile:"/synthetic/agent-original.jsonl"});await pending;
  pending=f.reader.read();f.respond(1,[row("new","Other agent's private output")],200,{sessionFile:"/synthetic/agent-reused.jsonl"});await pending;
  assert.deepEqual(texts(f.latest()),["Original completed conversation"]);
  assert.equal(f.latest().retryable,false);assert.match(f.latest().error,/identity/);
  await f.reader.read(true);assert.equal(f.requests.length,2);
});

test("empty buffers and snapshots are independent visit-owned values", () => {
  const first = emptyAgentTranscript();
  first.messages.push({ id: "mutation" });
  assert.deepEqual(emptyAgentTranscript(), { messages: [], orphanResults: [], carry: "", sequence: 0, limited: false });
  const snapshot = emptyAgentTranscriptSnapshot();
  snapshot.messages.push({ id: "mutation" });
  assert.deepEqual(emptyAgentTranscriptSnapshot(), {
    messages: [], loading: false, error: null, retryable: false, limited: false, partial: false, nextByte: 0,
  });
});

test("JSONL fragments retain exact Unicode while no-newline records stay uncommitted", () => {
  const prose = "  café 👩🏽‍💻 日本語\n\n```txt\n  exact whitespace\n```\n";
  const first = JSON.stringify(row("unicode", prose));
  const second = JSON.stringify(row("last", "No terminating newline"));
  const split = first.indexOf("café") + "café".length;
  let state = appendAgentJsonl(emptyAgentTranscript(), first.slice(0, split));
  assert.deepEqual(state.messages, []);
  assert.equal(state.carry, first.slice(0, split));
  assert.equal(visibleAgentTranscript(state).partial, true);
  state = appendAgentJsonl(state, `${first.slice(split)}\r\n\n${second}`);
  assert.equal(state.sequence, 1);
  assert.equal(state.carry, second);
  const visible = visibleAgentTranscript(state);
  assert.deepEqual(texts(visible), [prose]);
  assert.equal(visible.partial, true, "even valid JSON remains incomplete until its newline commits it");
  assert.equal(state.messages.length, 1);
  assert.deepEqual(visibleAgentTranscript(state), visible, "repeated reads must not consume the tail");
  state = appendAgentJsonl(state, "\n");
  assert.equal(state.carry, "");
  assert.equal(state.sequence, 2);
  assert.deepEqual(texts(visibleAgentTranscript(state)), [prose, "No terminating newline"]);
});

test("every character split reconstructs one record without losing its stable identity", () => {
  const serialized = jsonl(row("fragmented", "quote \" slash \\ tab\t emoji 🧭\n"));
  for (let index = 0; index <= serialized.length; index++) {
    const prefix = appendAgentJsonl(emptyAgentTranscript(), serialized.slice(0, index));
    const state = appendAgentJsonl(prefix, serialized.slice(index));
    assert.deepEqual(state.messages.map((message) => message.id), ["fragmented"], `split at ${index}`);
    assert.equal(state.messages[0].text, "quote \" slash \\ tab\t emoji 🧭\n");
    assert.equal(state.carry, "");
  }
});

test("raw RPC messages and missing IDs normalize with unique sequence IDs across pages", () => {
  let state = appendAgentEntries(emptyAgentTranscript(), [{ role: "user", content: "Task" }]);
  state = appendAgentEntries(state, [{ role: "assistant", content: "Reply" }]);
  assert.deepEqual(state.messages.map(({ id, role, text }) => ({ id, role, text })), [
    { id: "agent-record-0", role: "user", text: "Task" },
    { id: "agent-record-1", role: "assistant", text: "Reply" },
  ]);
});

for (const order of ["call first", "result first"]) {
  test(`toolResult stitches across pages (${order}) and preserves full output`, () => {
    const output = "\n  preserved output\n\nlast line\n";
    const entries = order === "call first" ? [call(), result("call-one", output)] : [result("call-one", output), call()];
    let state = appendAgentJsonl(emptyAgentTranscript(), jsonl(entries[0]));
    assert.equal(state.orphanResults.length, order === "result first" ? 1 : 0);
    state = appendAgentJsonl(state, jsonl(entries[1]));
    assert.equal(state.messages.length, 1);
    assert.equal(state.orphanResults.length, 0);
    assert.equal(tool(state.messages[0]).callId, "call-one");
    assert.equal(tool(state.messages[0]).state, "ok");
    assert.equal(tool(state.messages[0]).output, output);
  });
}

test("a final no-newline tool result cannot complete its call until the record commits", () => {
  const state = appendAgentJsonl(emptyAgentTranscript(), `${jsonl(call())}${JSON.stringify(result("call-one", "failure", true))}`);
  assert.equal(tool(state.messages[0]).state, "running");
  const visible = visibleAgentTranscript(state);
  assert.equal(tool(visible.messages[0]).state, "running");
  assert.equal(tool(visible.messages[0]).output, undefined);
  assert.equal(visible.partial, true);
  const complete = appendAgentJsonl(state, "\n");
  assert.equal(complete.messages.length, 1);
  assert.equal(tool(complete.messages[0]).state, "error");
  assert.equal(tool(complete.messages[0]).output, "failure");
});

test("a newer page-local tool result wins over an older unmatched result for the same call", () => {
  const initial = appendAgentEntries(emptyAgentTranscript(), [result("call-one", "old result")]);
  const state = appendAgentEntries(initial, [call(), result("call-one", "new result")]);
  assert.equal(state.orphanResults.length, 0);
  assert.equal(state.messages.length, 1);
  assert.equal(tool(state.messages[0]).output, "new result");
});

test("same-ID revisions replace one row and replayed tool calls keep completed results", () => {
  let state = appendAgentEntries(emptyAgentTranscript(), [row("same", "old"), call(), result()]);
  for (let index = 0; index < 4; index++) {
    state = appendAgentEntries(state, [row("same", `revision-${index}`), call()]);
    assert.deepEqual(state.messages.map((message) => message.id), ["same", "assistant-call"]);
    assert.equal(state.messages[0].text, `revision-${index}`);
    assert.equal(tool(state.messages[1]).state, "ok");
    assert.equal(tool(state.messages[1]).output, "line one\n\nline two\n");
  }
});

test("200-row retention keeps newest turns and makes truncation sticky and visible", () => {
  assert.equal(AGENT_MESSAGE_LIMIT, 200);
  const state = appendAgentEntries(emptyAgentTranscript(), Array.from({ length: 205 }, (_, index) => row(`row-${index}`)));
  assert.equal(state.messages.length, 200);
  assert.equal(state.messages[0].id, "row-5");
  assert.equal(state.messages.at(-1).id, "row-204");
  assert.equal(visibleAgentTranscript(state).limited, true);
  assert.equal(appendAgentEntries(state, []).limited, true);
});

test("a valid no-newline tail cannot evict a visible row until it commits", () => {
  const initial = appendAgentEntries(emptyAgentTranscript(), Array.from({ length: 200 }, (_, index) => row(`row-${index}`)));
  const state = appendAgentJsonl(initial, JSON.stringify(row("pending")));
  const visible = visibleAgentTranscript(state);
  assert.equal(visible.messages.length, 200);
  assert.equal(visible.messages[0].id, "row-0");
  assert.equal(visible.messages.at(-1).id, "row-199");
  assert.equal(visible.limited, false);
  assert.equal(visible.partial, true);
  assert.equal(state.limited, false);
  assert.equal(state.messages[0].id, "row-0");
  const committed = visibleAgentTranscript(appendAgentJsonl(state, "\n"));
  assert.equal(committed.messages.length, 200);
  assert.equal(committed.messages[0].id, "row-1");
  assert.equal(committed.messages.at(-1).id, "pending");
  assert.equal(committed.limited, true);
  assert.equal(committed.partial, false);
});

test("retained UTF-8 payload bytes stay within 8 MiB while newest full messages survive", () => {
  assert.equal(AGENT_BYTE_LIMIT, 8 * 1024 * 1024);
  const prose = "🧭".repeat(300_000);
  const state = appendAgentEntries(emptyAgentTranscript(), Array.from({ length: 5 }, (_, index) => row(`large-${index}`, prose)));
  assert.ok(state.messages.length > 0 && state.messages.length < 5);
  assert.ok(retainedBytes(state) <= AGENT_BYTE_LIMIT);
  assert.equal(state.messages.at(-1).id, "large-4");
  assert.equal(state.messages.at(-1).text, prose, "never silently crop a retained turn");
  assert.equal(visibleAgentTranscript(state).limited, true);
});

test("unmatched tool results are bounded by count and bytes with an honest limit flag", () => {
  const many = appendAgentEntries(emptyAgentTranscript(), Array.from({ length: 205 }, (_, index) => result(`orphan-${index}`)));
  assert.equal(many.orphanResults.length, 200);
  assert.equal(many.orphanResults[0].callId, "orphan-5");
  assert.equal(visibleAgentTranscript(many).limited, true);
  const output = "é".repeat(1_500_000);
  const large = appendAgentEntries(emptyAgentTranscript(), Array.from({ length: 4 }, (_, index) => result(`large-${index}`, output)));
  assert.ok(large.orphanResults.length > 0 && large.orphanResults.length < 4);
  assert.ok(retainedBytes(large) <= AGENT_BYTE_LIMIT);
  assert.equal(large.orphanResults.at(-1).output, output);
  assert.equal(visibleAgentTranscript(large).limited, true);
});

test("incomplete JSONL carry participates in the retained-byte budget", () => {
  const prose = "x".repeat(1_100_000);
  const initial = appendAgentEntries(emptyAgentTranscript(), [row("old", prose), row("middle", prose), row("new", prose)]);
  assert.equal(initial.limited, false);
  const carry = `{"unfinished":"${"y".repeat(2_000_000)}`;
  const state = appendAgentJsonl(initial, carry);
  assert.ok(retainedBytes(state) <= AGENT_BYTE_LIMIT);
  assert.equal(state.carry, carry);
  assert.equal(state.messages.at(-1).id, "new");
  assert.equal(visibleAgentTranscript(state).limited, true);
  assert.equal(visibleAgentTranscript(state).partial, true);
});

for (const [label, text] of [
  ["malformed complete JSON", "{invalid}\n"],
  ["primitive complete JSON", "42\n"],
  ["invalid message envelope", '{"message":42}\n'],
]) {
  test(`invalid input is explicit and atomic: ${label}`, () => {
    const state = appendAgentEntries(emptyAgentTranscript(), [row("kept")]);
    assert.throws(() => appendAgentJsonl(state, text), /invalid record/i);
    assert.deepEqual(texts(state), ["kept"]);
    assert.equal(state.sequence, 1);
  });
}

test("oversized complete records and incomplete carry fail without dropping saved history", () => {
  const state = appendAgentEntries(emptyAgentTranscript(), [row("kept")]);
  const oversized = JSON.stringify(row("oversized", "é".repeat(AGENT_RECORD_LIMIT / 2)));
  assert.throws(() => appendAgentJsonl(state, oversized), /too large/i);
  assert.throws(() => appendAgentJsonl(state, `${oversized}\n`), /too large/i);
  assert.deepEqual(texts(state), ["kept"]);
  assert.equal(state.carry, "");
});

test("desktop holds the byte cursor until complete emoji records arrive exactly once", async (t) => {
  const f = fixture(t);
  const text = "café 🧭\n\nverbatim trailing whitespace  \n";
  const serialized = jsonl(row("unicode", text));
  const laterText = "👩🏽‍💻 日本語 is complete now\n";
  const later = jsonl(row("later", laterText));
  // The backend withholds both torn UTF-8 and syntactically valid JSON without
  // a newline. The reader receives empty text and the unchanged byte cursor.
  const first = f.reader.read();
  f.respond(0, "", 0);
  await first;
  assert.equal(f.latest().nextByte, 0);
  assert.equal(f.latest().partial, false);
  assert.equal(f.latest().error, null);
  assert.deepEqual(f.latest().messages, []);
  const second = f.reader.read();
  assert.equal(f.requests[1].fromByte, 0);
  f.respond(1, serialized, byteLength(serialized));
  await second;
  assert.ok(byteLength(serialized) > serialized.length, "fixture distinguishes bytes from UTF-16 characters");
  assert.deepEqual(texts(f.latest()), [text]);
  assert.equal(f.latest().nextByte, byteLength(serialized));
  assert.equal(f.latest().partial, false);
  const third = f.reader.read();
  assert.equal(f.requests[2].fromByte, byteLength(serialized));
  f.respond(2, "", byteLength(serialized));
  await third;
  assert.deepEqual(texts(f.latest()), [text]);
  assert.equal(f.latest().nextByte, byteLength(serialized));
  const fourth = f.reader.read();
  assert.equal(f.requests[3].fromByte, byteLength(serialized));
  f.respond(3, later, byteLength(serialized) + byteLength(later));
  await fourth;
  assert.deepEqual(texts(f.latest()), [text, laterText]);
  assert.equal(f.latest().nextByte, byteLength(serialized) + byteLength(later));
  const idle = f.reader.read();
  f.respond(4, "", byteLength(serialized) + byteLength(later));
  await idle;
  assert.deepEqual(texts(f.latest()), [text, laterText]);
  assert.deepEqual(f.latest().messages.map((message) => message.id), ["unicode", "later"]);
});

for (const source of ["desktop", "rpc"]) {
  test(`${source}: selection is exact and synchronous duplicate reads are single-flight`, async (t) => {
    const f = fixture(t, source);
    const first = f.reader.read();
    await Promise.all([f.reader.read(), f.reader.read(true)]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.snapshots.length, 1);
    assert.equal(f.latest().loading, true);
    assert.equal(f.requests[0].kind, source);
    assert.equal(f.requests[0].path, sessionPath);
    assert.equal(f.requests[0].id, agentId);
    assert.equal(f.requests[0].fromByte, 0);
    assert.ok(f.requests[0].signal instanceof AbortSignal);
    const cursor = f.advance(0, [row("first")], 137);
    await first;
    const next = f.reader.read();
    assert.equal(f.requests[1].fromByte, cursor);
    f.advance(1, [], 137);
    await next;
    assert.deepEqual(texts(f.latest()), ["first"]);
    assert.equal(f.latest().loading, false);
  });

  test(`${source}: repeated pages with same IDs keep one row and completed tool output`, async (t) => {
    const f = fixture(t, source);
    for (let index = 0; index < 3; index++) {
      const pending = f.reader.read();
      f.advance(index, index === 0 ? [call(), result()] : [call()], (index + 1) * 1000);
      await pending;
      assert.equal(f.latest().messages.length, 1);
      assert.equal(tool(f.latest().messages[0]).output, "line one\n\nline two\n");
      assert.equal(tool(f.latest().messages[0]).state, "ok");
    }
    const idle = f.reader.read();
    f.advance(3, [], 3000);
    await idle;
    assert.equal(f.latest().messages.length, 1);
  });

  for (const outcome of ["success", "error"]) {
    test(`${source}: disposing a visit aborts and makes late ${outcome} inert`, async (t) => {
      const old = fixture(t, source);
      const pending = old.reader.read();
      old.reader.dispose();
      assert.equal(old.requests[0].signal.aborted, true);
      const fresh = fixture(t, source);
      const current = fresh.reader.read();
      const oldCount = old.snapshots.length;
      if (outcome === "success") old.advance(0, [row("stale")], 900);
      else old.requests[0].reject(new Error("stale failure"));
      await pending;
      assert.equal(old.snapshots.length, oldCount);
      await old.reader.read(true);
      assert.equal(old.requests.length, 1, "disposed readers never retry");
      assert.equal(fresh.latest().loading, true, "obsolete finally must not unlock a replacement visit");
      await fresh.reader.read();
      assert.equal(fresh.requests.length, 1);
      fresh.advance(0, [row("current")], 100);
      await current;
      assert.deepEqual(texts(fresh.latest()), ["current"]);
    });
  }

  for (const mode of source === "desktop" ? ["explicit reset"] : ["explicit reset", "shrinking cursor"]) {
    test(`${source}: ${mode} clears history with source-specific replacement semantics`, async (t) => {
      const f = fixture(t, source);
      const initial = f.reader.read();
      f.advance(0, [row("old"), result("old-orphan", "must be discarded")], 700);
      await initial;
      const reset = f.reader.read();
      const replacement = [row("new"), call("new-call", "old-orphan")];
      f.respond(1, source === "desktop" ? [] : replacement, source === "desktop" ? 20 : mode === "explicit reset" ? 800 : 20,
        mode === "explicit reset" ? { reset: true } : {});
      if (source === "desktop") {
        // Desktop reset responses contain no records. Observe the cleared view
        // before the immediate zero-byte replacement read has settled.
        await Promise.resolve();
        assert.equal(f.requests.length, 3);
        assert.equal(f.requests[2].fromByte, 0);
        assert.equal(f.latest().nextByte, 0);
        assert.equal(f.latest().loading, true);
        assert.deepEqual(f.latest().messages, []);
        f.advance(2, replacement);
      }
      await reset;
      assert.equal(f.requests.length, source === "desktop" ? 3 : 2, "RPC reset pages already contain the replacement transcript");
      assert.deepEqual(f.latest().messages.map((message) => message.id), ["new", "new-call"]);
      assert.equal(tool(f.latest().messages[1]).state, "running", "reset must also drop orphan results");
      assert.equal(f.latest().nextByte, source === "desktop" ? byteLength(jsonl(...replacement)) : mode === "explicit reset" ? 800 : 20);
      assert.equal(f.latest().limited, false);
      assert.equal(f.latest().error, null);
    });
  }

  test(`${source}: reset at zero is bounded and honors source-specific semantics`, async (t) => {
    const f = fixture(t, source);
    const pending = f.reader.read();
    f.respond(0, [], 0, { reset: true });
    await pending;
    assert.equal(f.requests.length, 1);
    assert.equal(f.latest().loading, false);
    if (source === "desktop") {
      assert.equal(f.latest().retryable, false);
      assert.match(f.latest().error, /invalid response/i);
      await f.reader.read();
      await f.reader.read(true);
      assert.equal(f.requests.length, 1);
      return;
    } else {
      assert.equal(f.latest().retryable, false);
      assert.equal(f.latest().error, null, "an empty replacement RPC transcript is valid");
    }
    const retry = f.reader.read(true);
    assert.equal(f.requests[1].fromByte, 0);
    f.advance(1, [row("recovered")], 100);
    await retry;
    assert.deepEqual(texts(f.latest()), ["recovered"]);
  });

  for (const [name, error, match] of [
    ["transport failure", new Error("synthetic disconnect"), /synthetic disconnect/],
    ["host disconnect", codedError("host_unavailable"), /connection is unavailable/i],
    ["host timeout", codedError("transcript_timeout"), /timed out/i],
    ["request deadline", Object.assign(new Error("deadline expired"), { name: "TimeoutError" }), /timed out/i],
  ]) {
    test(`${source}: ${name} preserves content and retries the same server cursor only on request`, async (t) => {
      const f = fixture(t, source);
      const initial = f.reader.read();
      const cursor = f.advance(0, [row("kept")], 777);
      await initial;
      const pending = f.reader.read();
      f.requests[1].reject(error);
      await pending;
      assert.deepEqual(texts(f.latest()), ["kept"]);
      assert.equal(f.latest().nextByte, cursor);
      assert.equal(f.latest().loading, false);
      assert.equal(f.latest().retryable, true);
      assert.match(f.latest().error, match);
      await f.reader.read();
      assert.equal(f.requests.length, 2, "background polling must not silently retry errors");
      const retry = f.reader.read(true);
      assert.equal(f.requests[2].fromByte, cursor);
      assert.equal(f.latest().loading, true);
      assert.equal(f.latest().error, null);
      const nextCursor = f.advance(2, [row("after-retry")], 901);
      await retry;
      assert.deepEqual(texts(f.latest()), ["kept", "after-retry"]);
      assert.equal(f.latest().nextByte, nextCursor);
      assert.equal(f.latest().error, null);
    });
  }

  for (const error of [
    codedError("host_error"), codedError("transcript_unavailable"), codedError("session_not_found"), codedError("agent_changed"),
    codedError("session_owned_by_terminal"), new Error("Unknown subagent agent-one"),
    new Error("No transcript available for that agent"),
  ]) {
    test(`${source}: terminal ${error.code ?? error.message} retains content and never retries`, async (t) => {
      const f = fixture(t, source);
      const initial = f.reader.read();
      const cursor = f.advance(0, [row("kept")], 100);
      await initial;
      const pending = f.reader.read();
      f.requests[1].reject(error);
      await pending;
      assert.deepEqual(texts(f.latest()), ["kept"]);
      assert.equal(f.latest().nextByte, cursor);
      assert.equal(f.latest().loading, false);
      assert.equal(f.latest().retryable, false);
      assert.match(f.latest().error, /no longer available/i);
      await f.reader.read();
      await f.reader.read(true);
      assert.equal(f.requests.length, 2);
    });
  }

  test(`${source}: known-unavailable selection never starts a transport`, async (t) => {
    const f = fixture(t, source, { unavailable: true });
    await f.reader.read();
    assert.equal(f.requests.length, 0);
    assert.equal(f.latest().retryable, false);
    assert.match(f.latest().error, /no conversation transcript available/i);
    await f.reader.read(true);
    assert.equal(f.snapshots.length, 1);
  });
}

for (const [name, text] of [
  ["valid JSON without newline", JSON.stringify(row("uncommitted", "complete JSON is still uncommitted 🧭"))],
  ["torn record", '{"message":{"role":"assistant","content":"unfinished 🧭'],
  ["complete record followed by torn suffix", `${jsonl(row("must-not-partially-commit"))}{"torn":"`],
]) {
  test(`desktop rejects ${name} terminally without advancing or partially committing`, async (t) => {
    const f = fixture(t);
    const initial = f.reader.read();
    const cursor = f.advance(0, [row("kept")]);
    await initial;
    const pending = f.reader.read();
    f.respond(1, text, cursor + byteLength(text));
    await pending;
    assert.deepEqual(texts(f.latest()), ["kept"]);
    assert.equal(f.latest().nextByte, cursor);
    assert.equal(f.latest().partial, false);
    assert.equal(f.latest().loading, false);
    assert.equal(f.latest().retryable, false);
    assert.match(f.latest().error, /invalid response/i);
    await f.reader.read();
    await f.reader.read(true);
    assert.equal(f.requests.length, 2);
  });
}

for (const createdAt of [undefined, 1_791_374_400_000]) {
  test(`desktop selection forwards ${createdAt === undefined ? "no invented" : "the exact"} creation timestamp on every read`, async (t) => {
    const f = fixture(t, "desktop", { createdAt });
    for (let index = 0; index < 2; index++) {
      const pending = f.reader.read();
      assert.equal(f.requests[index].expectedCreatedAt, createdAt);
      f.advance(index, [row(`row-${index}`)]);
      await pending;
    }
  });
}

for (const seeded of [false, true]) {
  test(`desktop ${seeded ? "roster-seeded" : "first-response-bound"} connection identity survives polling, retry, and reset`, async (t) => {
    const f = fixture(t, "desktop", seeded ? { connectionId } : {});
    const initial = f.reader.read();
    assert.equal(f.requests[0].expectedConnectionId, seeded ? connectionId : undefined);
    f.advance(0, []);
    await initial;
    const poll = f.reader.read();
    assert.equal(f.requests[1].expectedConnectionId, connectionId, "even an empty success binds the host identity");
    f.advance(1, [row("kept")]);
    await poll;
    const failed = f.reader.read();
    assert.equal(f.requests[2].expectedConnectionId, connectionId);
    f.requests[2].reject(new Error("Synthetic disconnect"));
    await failed;
    const retry = f.reader.read(true);
    assert.equal(f.requests[3].expectedConnectionId, connectionId);
    assert.equal(f.latest().loading, true);
    f.advance(3, [row("after-retry")]);
    await retry;
    const reset = f.reader.read();
    assert.equal(f.requests[4].expectedConnectionId, connectionId);
    f.respond(4, [], 0, { reset: true });
    await Promise.resolve();
    assert.equal(f.requests.length, 6);
    assert.equal(f.requests[5].fromByte, 0);
    assert.equal(f.requests[5].expectedConnectionId, connectionId, "reset restarts the file, not the host identity");
    assert.equal(f.latest().loading, true);
    f.advance(5, [row("replacement")]);
    await reset;
    assert.deepEqual(texts(f.latest()), ["replacement"]);
    assert.equal(f.latest().error, null);
  });
}

for (const seeded of [false, true]) {
  test(`desktop rejects a ${seeded ? "roster-seeded" : "previously bound"} connection identity mismatch without consuming new content`, async (t) => {
    const f = fixture(t, "desktop", seeded ? { connectionId } : {});
    let index = 0;
    let cursor = 0;
    if (!seeded) {
      const initial = f.reader.read();
      cursor = f.advance(0, [row("kept")]);
      await initial;
      index = 1;
    }
    const pending = f.reader.read();
    assert.equal(f.requests[index].expectedConnectionId, connectionId);
    const text = jsonl(row("wrong-host-content"));
    f.respond(index, text, cursor + byteLength(text), { connectionId: "different-host-connection" });
    await pending;
    assert.deepEqual(texts(f.latest()), seeded ? [] : ["kept"]);
    assert.equal(f.latest().nextByte, cursor);
    assert.equal(f.latest().loading, false);
    assert.equal(f.latest().retryable, false);
    assert.match(f.latest().error, /invalid response/i);
    await f.reader.read(true);
    assert.equal(f.requests.length, index + 1);
  });
}

for (const source of ["desktop", "rpc"]) {
  test(`${source}: successful empty history settles loading and later polls stay quiet until explicit retry`, async (t) => {
    const f = fixture(t, source);
    const initial = f.reader.read();
    assert.equal(f.latest().loading, true);
    f.advance(0, []);
    await initial;
    assert.equal(f.latest().loading, false);
    assert.deepEqual(f.latest().messages, []);
    const poll = f.reader.read();
    assert.equal(f.latest().loading, false, "an established empty transcript must not flash a full loader");
    await f.reader.read();
    assert.equal(f.requests.length, 2, "quiet loading state must still retain the single-flight guard");
    f.requests[1].reject(new Error("Synthetic poll failure"));
    await poll;
    const retry = f.reader.read(true);
    assert.equal(f.latest().loading, true);
    f.advance(2, []);
    await retry;
    assert.equal(f.latest().loading, false);
    const later = f.reader.read();
    assert.equal(f.latest().loading, false);
    f.advance(3, []);
    await later;
    assert.equal(f.latest().error, null);
  });
}

test("disposal during the desktop reset reread prevents its stale replacement from publishing", async (t) => {
  const f = fixture(t);
  const initial = f.reader.read();
  f.advance(0, [row("old")]);
  await initial;
  const reset = f.reader.read();
  f.respond(1, [], 0, { reset: true });
  await Promise.resolve();
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].fromByte, 0);
  f.reader.dispose();
  assert.equal(f.requests[2].signal.aborted, true);
  const count = f.snapshots.length;
  f.advance(2, [row("stale replacement")]);
  await reset;
  assert.equal(f.snapshots.length, count);
  await f.reader.read(true);
  assert.equal(f.requests.length, 3);
});

for (const source of ["desktop", "rpc"]) {
  test(`${source}: replacement reset clears a previously displayed retention limit`, async (t) => {
    const f = fixture(t, source);
    const initial = f.reader.read();
    f.advance(0, Array.from({ length: 201 }, (_, index) => row(`old-${index}`)), 1000);
    await initial;
    assert.equal(f.latest().limited, true);
    const reset = f.reader.read();
    f.respond(1, source === "desktop" ? [] : [row("new")], 100, { reset: true });
    if (source === "desktop") {
      await Promise.resolve();
      assert.equal(f.latest().limited, false);
      f.advance(2, [row("new")]);
    }
    await reset;
    assert.equal(f.latest().limited, false);
    assert.deepEqual(texts(f.latest()), ["new"]);
  });
}

test("a transient failure retries the unchanged cursor before a withheld emoji record commits", async (t) => {
  const f = fixture(t);
  const serialized = jsonl(row("withheld", "exact recovered café 🧭 text"));
  const first = f.reader.read();
  f.respond(0, "", 0);
  await first;
  const failure = f.reader.read();
  assert.equal(f.requests[1].fromByte, 0);
  f.requests[1].reject(new Error("synthetic disconnection"));
  await failure;
  const retry = f.reader.read(true);
  assert.equal(f.requests[2].fromByte, 0);
  f.respond(2, serialized, byteLength(serialized));
  await retry;
  assert.deepEqual(texts(f.latest()), ["exact recovered café 🧭 text"]);
  assert.equal(f.latest().nextByte, byteLength(serialized));
  assert.equal(f.latest().partial, false);
  const idle = f.reader.read();
  assert.equal(f.requests[3].fromByte, byteLength(serialized));
  f.respond(3, "", byteLength(serialized));
  await idle;
  assert.deepEqual(f.latest().messages.map((message) => message.id), ["withheld"]);
});

for (const nextByte of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, "123", undefined]) {
  test(`invalid server cursor ${String(nextByte)} stops without consuming the page`, async (t) => {
    const f = fixture(t);
    const pending = f.reader.read();
    f.respond(0, [row("must-not-display")], 10, { nextByte });
    await pending;
    assert.deepEqual(f.latest().messages, []);
    assert.equal(f.latest().nextByte, 0);
    assert.equal(f.latest().retryable, false);
    assert.match(f.latest().error, /invalid cursor/i);
    await f.reader.read(true);
    assert.equal(f.requests.length, 1);
  });
}

for (const [name, extra] of [
  ["wrong agent ID", { agentId: "another-agent" }],
  ["wrong start cursor", { fromByte: 13 }],
  ["missing success marker", { ok: undefined }],
  ["non-string text", { text: [] }],
  ["missing reset marker", { reset: undefined }],
  ["missing connection identity", { connectionId: undefined }],
  ["empty connection identity", { connectionId: "" }],
  ["non-string connection identity", { connectionId: 42 }],
]) {
  test(`desktop response rejects ${name}`, async (t) => {
    const f = fixture(t);
    const pending = f.reader.read();
    const values = [row("must-not-display")];
    f.respond(0, values, byteLength(jsonl(...values)), extra);
    await pending;
    assert.deepEqual(f.latest().messages, []);
    assert.equal(f.latest().nextByte, 0);
    assert.equal(f.latest().retryable, false);
    assert.match(f.latest().error, /invalid response/i);
  });
}

const rangeText = jsonl(row("range-check", "café 🧭 must remain exact"));
for (const [name, response] of [
  ["empty text with advanced cursor", (cursor) => ({ text: "", nextByte: cursor + 1 })],
  ["text shorter than declared byte span", (cursor) => ({ text: rangeText, nextByte: cursor + byteLength(rangeText) + 1 })],
  ["text longer than declared byte span", (cursor) => ({ text: rangeText, nextByte: cursor + byteLength(rangeText) - 1 })],
  ["UTF-16 character count used as byte span", (cursor) => ({ text: rangeText, nextByte: cursor + rangeText.length })],
  ["reset flag with unchanged cursor", (cursor) => ({ text: "", nextByte: cursor, reset: true })],
  ["reset flag with advancing cursor", (cursor) => ({ text: "", nextByte: cursor + 1, reset: true })],
  ["shrinking cursor without reset flag", () => ({ text: "", nextByte: 0, reset: false })],
  ["reset response containing text", () => ({ text: rangeText, nextByte: 0, reset: true })],
]) {
  test(`desktop rejects inconsistent range: ${name}`, async (t) => {
    const f = fixture(t);
    const initial = f.reader.read();
    const cursor = f.advance(0, [row("kept")]);
    await initial;
    const pending = f.reader.read();
    f.respond(1, "", cursor, response(cursor));
    await pending;
    assert.deepEqual(texts(f.latest()), ["kept"]);
    assert.equal(f.latest().nextByte, cursor);
    assert.equal(f.latest().loading, false);
    assert.equal(f.latest().retryable, false);
    assert.match(f.latest().error, /invalid response/i);
    await f.reader.read();
    await f.reader.read(true);
    assert.equal(f.requests.length, 2, "malformed ranges neither restart nor retry");
  });
}

for (const source of ["desktop", "rpc"]) {
  test(`${source}: nonempty replay without cursor advance is terminal`, async (t) => {
    const f = fixture(t, source);
    const pending = f.reader.read();
    f.respond(0, [row("replay")], 0);
    await pending;
    assert.deepEqual(f.latest().messages, []);
    assert.equal(f.latest().retryable, false);
    assert.match(f.latest().error, source === "desktop" ? /invalid response/i : /cursor did not advance/i);
  });
}

test("RPC messages response shape is normalized without inventing a cursor", async (t) => {
  const f = fixture(t, "rpc");
  const pending = f.reader.read();
  f.requests[0].resolve({ messages: [{ id: "raw", role: "assistant", content: "RPC reply" }], nextByte: 9001 });
  await pending;
  assert.deepEqual(texts(f.latest()), ["RPC reply"]);
  assert.equal(f.latest().nextByte, 9001);
});

test("RPC raw-message revisions preserve their source ID and replace one row across progressive ranges", async (t) => {
  const f = fixture(t, "rpc");
  const cursors = [1001, 3700, 9001];
  for (let index = 0; index < cursors.length; index++) {
    const pending = f.reader.read();
    assert.equal(f.requests[index].fromByte, index === 0 ? 0 : cursors[index - 1]);
    f.requests[index].resolve({
      messages: [{ id: "stable-raw-message", role: "assistant", content: `revision-${index}` }],
      nextByte: cursors[index],
    });
    await pending;
    assert.equal(f.latest().messages.length, 1);
    assert.equal(f.latest().messages[0].id, "stable-raw-message");
    assert.equal(f.latest().messages[0].sourceEntryId, "stable-raw-message", "normalization must not invent a new source entry for each revision");
    assert.equal(f.latest().messages[0].text, `revision-${index}`);
    assert.equal(f.latest().nextByte, cursors[index]);
    assert.equal(f.latest().error, null);
  }
});

test("RPC may advance over nonmessage records without applying desktop text-span rules", async (t) => {
  const f = fixture(t, "rpc");
  const initial = f.reader.read();
  f.advance(0, [row("kept")], 9001);
  await initial;
  const empty = f.reader.read();
  f.respond(1, [], 12345);
  await empty;
  assert.deepEqual(texts(f.latest()), ["kept"]);
  assert.equal(f.latest().nextByte, 12345);
  assert.equal(f.latest().error, null);
});

test("RPC response without message records stops as an explicit protocol error", async (t) => {
  const f = fixture(t, "rpc");
  const pending = f.reader.read();
  f.requests[0].resolve({ nextByte: 100 });
  await pending;
  assert.equal(f.latest().retryable, false);
  assert.equal(f.latest().nextByte, 0);
  assert.match(f.latest().error, /no message records/i);
});

test("reader exposes truncation while keeping newest bounded messages", async (t) => {
  const f = fixture(t);
  const pending = f.reader.read();
  const cursor = f.advance(0, Array.from({ length: 205 }, (_, index) => row(`row-${index}`)));
  await pending;
  assert.equal(f.latest().messages.length, 200);
  assert.equal(f.latest().messages[0].id, "row-5");
  assert.equal(f.latest().limited, true);
  assert.equal(f.latest().error, null);
  assert.equal(f.latest().nextByte, cursor);
});

test("an oversized desktop record fails terminally while retaining the prior cursor and history", async (t) => {
  const f = fixture(t);
  const initial = f.reader.read();
  const cursor = f.advance(0, [row("kept")]);
  await initial;
  const pending = f.reader.read();
  f.advance(1, [row("oversized", "x".repeat(AGENT_RECORD_LIMIT))]);
  await pending;
  assert.deepEqual(texts(f.latest()), ["kept"]);
  assert.equal(f.latest().nextByte, cursor);
  assert.equal(f.latest().retryable, false);
  assert.match(f.latest().error, /too large/i);
});

test("desktop API is an authenticated passive GET with canonical session, exact registry ID, and byte cursor", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true, connectionId, agentId, fromByte: 12345, nextByte: 12345, text: "", reset: false });
  });
  const api = new DaemonApi("synthetic-token", "https://synthetic.invalid");
  const abort = new AbortController();
  const response = await api.getDesktopAgentTranscript(sessionPath, agentId, 12345, abort.signal);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://synthetic.invalid");
  assert.equal(url.pathname, "/api/agents/transcript");
  assert.deepEqual(Object.fromEntries(url.searchParams), { session: sessionPath, agentId, fromByte: "12345" });
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer synthetic-token");
  assert.equal(response.nextByte, 12345);
  abort.abort();
  assert.equal(calls[0].init.signal.aborted, true, "visit cancellation reaches fetch");
});

test("desktop API includes an expected creation timestamp only when supplied", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(new URL(url, "https://synthetic.invalid"));
    return Response.json({ ok: true });
  });
  const api = new DaemonApi("synthetic-token");
  await api.getDesktopAgentTranscript(sessionPath, agentId);
  await api.getDesktopAgentTranscript(sessionPath, agentId, 50, undefined, 1_791_374_400_000);
  assert.equal(urls[0].searchParams.has("expectedCreatedAt"), false);
  assert.equal(urls[0].searchParams.get("fromByte"), "0");
  assert.equal(urls[1].searchParams.get("expectedCreatedAt"), "1791374400000");
  assert.equal(urls[1].searchParams.get("fromByte"), "50");
});

test("desktop API includes the exact opaque connection identity only when supplied", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(new URL(url, "https://synthetic.invalid"));
    return Response.json({ ok: true, connectionId });
  });
  const api = new DaemonApi("synthetic-token");
  await api.getDesktopAgentTranscript(sessionPath, agentId);
  await api.getDesktopAgentTranscript(sessionPath, agentId, 50, undefined, undefined, connectionId);
  await api.getDesktopAgentTranscript(sessionPath, agentId, 75, undefined, 1_791_374_400_000, connectionId);
  assert.equal(urls[0].searchParams.has("expectedConnectionId"), false);
  assert.deepEqual(Object.fromEntries(urls[1].searchParams), {
    session: sessionPath, agentId, fromByte: "50", expectedConnectionId: connectionId,
  });
  assert.deepEqual(Object.fromEntries(urls[2].searchParams), {
    session: sessionPath, agentId, fromByte: "75", expectedCreatedAt: "1791374400000", expectedConnectionId: connectionId,
  });
});

test("desktop roster API makes one authenticated passive GET and preserves cancellation and connection identity", async (t) => {
  const calls = [];
  const roster = { ok: true, connectionId, agents: [{ id: agentId, createdAt: 1_791_374_400_000 }] };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return Response.json(roster);
  });
  const api = new DaemonApi("synthetic-token", "https://synthetic.invalid");
  const abort = new AbortController();
  const response = await api.getDesktopAgentRoster(sessionPath, abort.signal);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://synthetic.invalid");
  assert.equal(url.pathname, "/api/agents/roster");
  assert.deepEqual(Object.fromEntries(url.searchParams), { session: sessionPath });
  assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.get("Authorization"), "Bearer synthetic-token");
  assert.deepEqual(response, roster);
  abort.abort();
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(calls.length, 1, "roster discovery must not attach or start an RPC follow-up");
});

test("agent_changed HTTP 409 is terminal through the actual desktop transport", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ ok: false, code: "agent_changed", error: "Synthetic registry ID was reused" }, { status: 409 });
  });
  const snapshots = [];
  const reader = new AgentTranscriptReader(new DaemonApi("synthetic-token"), sessionPath,
    { id: agentId, source: "desktop", createdAt: 1_791_374_400_000 }, (value) => snapshots.push(value));
  t.after(() => reader.dispose());
  await reader.read();
  assert.equal(snapshots.at(-1).retryable, false);
  assert.match(snapshots.at(-1).error, /no longer available/i);
  await reader.read(true);
  assert.equal(requests, 1);
});

for (const source of ["desktop", "rpc"]) {
  for (const stalled of ["headers", "body"]) {
    test(`${source}: read deadline bounds stalled ${stalled} and surfaces retryable timeout`, async (t) => {
      const deadlines = [];
      const requests = [];
      t.mock.method(AbortSignal, "timeout", (milliseconds) => {
        assert.equal(milliseconds, 20_000);
        const deadline = new AbortController();
        deadlines.push(deadline);
        return deadline.signal;
      });
      t.mock.method(globalThis, "fetch", (url, init) => {
        requests.push({ url, init });
        const stalledRead = () => new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
        return stalled === "headers" ? stalledRead() : Promise.resolve({ ok: true, status: 200, json: stalledRead });
      });
      const snapshots = [];
      const reader = new AgentTranscriptReader(new DaemonApi("synthetic-token"), sessionPath, { id: agentId, source }, (value) => snapshots.push(value));
      t.after(() => reader.dispose());
      const pending = reader.read();
      // Drain every microtask, not one: the request wrapper reports link
      // evidence after fetch resolves, and a stalled body only listens for the
      // deadline once json() has been called.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.length, 1);
      assert.equal(deadlines.length, 1);
      if (source === "rpc") {
        assert.equal(requests[0].url, "/api/rpc");
        assert.deepEqual(JSON.parse(requests[0].init.body), {
          sessionPath, command: "get_subagent_messages", params: { subagentId: agentId, fromByte: 0 },
        });
      }
      deadlines[0].abort(new DOMException("Synthetic deadline expired", "TimeoutError"));
      await pending;
      const snapshot = snapshots.at(-1);
      assert.equal(snapshot.loading, false);
      assert.equal(snapshot.retryable, true);
      assert.equal(snapshot.nextByte, 0);
      assert.match(snapshot.error, /timed out/i);
      await reader.read();
      assert.equal(requests.length, 1, "timeout requires explicit retry");
    });
  }
}
