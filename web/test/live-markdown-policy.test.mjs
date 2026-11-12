import test, { after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Exercise the production store, normalizer, and cache. No source copies,
// browser, daemon, persistent database, sockets, or provider calls are used.
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = `
  export { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  export { entryToUiMessage, entriesToTranscript } from ${JSON.stringify(resolve(root, "web/src/domain/messages.ts"))};
  export { saveTail, loadTail } from ${JSON.stringify(resolve(root, "web/src/runtime/offline-cache.ts"))};
`;
const build = await rolldown({
  input: "live-markdown-policy-fixture",
  platform: "node",
  plugins: [{
    name: "live-markdown-policy-fixture",
    resolveId: (id) => id === "live-markdown-policy-fixture" ? "\0live-markdown-policy-fixture" : null,
    load: (id) => id === "\0live-markdown-policy-fixture" ? source : null,
  }],
});
let actual;
try {
  const generated = await build.generate({ format: "esm", codeSplitting: false });
  assert.equal(generated.output.length, 1, "fixture must bundle all production dependencies");
  actual = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString("base64")}`);
} finally {
  await build.close();
}
const { createOmpStore, entryToUiMessage, entriesToTranscript, saveTail, loadTail } = actual;
const path = "/synthetic/live-markdown.jsonl";
const prose = "## First section\n\nA complete reply.\n\n## Last section\n\nExact source.\n";
const message = (id = "assistant-stable", extra = {}) => ({
  id, role: "assistant", text: prose, parts: [{ kind: "text", text: prose }], ...extra,
});
const fixture = () => {
  const store = createOmpStore();
  store.getState().beginSession(path);
  return store;
};
const noHint = (row, detail = "cold history must not own the live hint") => {
  assert.ok(row, "expected a message");
  assert.equal(Object.hasOwn(row, "eagerMarkdown"), false, detail);
};
const eager = (row, detail = "the currently owned live response must remain eager") => {
  assert.ok(row, "expected a message");
  assert.equal(row.eagerMarkdown, true, detail);
};
const ingest = (store, method, rows) => method === "appendMessage"
  ? rows.forEach((row) => store.getState().appendMessage(row))
  : store.getState()[method](rows);
const methods = ["setHistory", "mergeMessages", "prependMessages", "appendMessage"];

// Minimal asynchronous IndexedDB adapter for the real saveTail/loadTail code.
// It clones at both boundaries and implements request/cursor completion, so a
// swallowed write failure cannot pass merely because loadTail returned null.
function memoryIndexedDb() {
  const stores = new Map();
  const calls = { open: 0, get: 0, put: 0, cursor: 0 };
  let opened = false;
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name, { keyPath }) { stores.set(name, { keyPath, records: new Map() }); },
    deleteObjectStore(name) { stores.delete(name); },
    close() {},
    transaction(name) {
      const table = stores.get(name);
      assert.ok(table, `unexpected object store ${name}`);
      let pending = 0;
      let ended = false;
      const tx = {
        objectStore(requested) {
          assert.equal(requested, name);
          const request = (operation) => {
            assert.equal(ended, false, "request issued after transaction completion");
            const result = {};
            pending++;
            queueMicrotask(() => {
              result.result = operation();
              result.onsuccess?.({ target: result });
              pending--;
              if (pending === 0) {
                ended = true;
                tx.oncomplete?.();
              }
            });
            return result;
          };
          return {
            keyPath: table.keyPath,
            get(key) {
              calls.get++;
              return request(() => structuredClone(table.records.get(key)));
            },
            put(value) {
              calls.put++;
              const copied = structuredClone(value);
              return request(() => table.records.set(copied[table.keyPath], copied));
            },
            delete(key) { return request(() => table.records.delete(key)); },
            openCursor() {
              calls.cursor++;
              const entries = [...table.records.entries()].sort(([a], [b]) => a.localeCompare(b));
              let index = 0;
              const cursorRequest = {};
              const next = () => {
                const tick = request(() => {
                  const pair = entries[index++];
                  return pair ? {
                    key: pair[0], value: structuredClone(pair[1]),
                    continue: next,
                    delete: () => request(() => table.records.delete(pair[0])),
                  } : null;
                });
                tick.onsuccess = () => {
                  cursorRequest.result = tick.result;
                  cursorRequest.onsuccess?.({ target: cursorRequest });
                };
              };
              next();
              return cursorRequest;
            },
          };
        },
        abort() { ended = true; tx.onabort?.(); },
      };
      return tx;
    },
  };
  return {
    calls,
    indexedDB: {
      open(name, version) {
        assert.equal(name, "omp-pulse-offline");
        assert.equal(version, 3);
        calls.open++;
        const request = {};
        queueMicrotask(() => {
          request.result = database;
          if (!opened) { request.onupgradeneeded?.(); opened = true; }
          request.onsuccess?.();
        });
        return request;
      },
    },
    record: (namespace, sessionPath) => structuredClone(stores.get("history")?.records.get(`${namespace}:${sessionPath}`)),
    inject(record) { stores.get("history").records.set(record.key, structuredClone(record)); },
  };
}
const idb = memoryIndexedDb();
const previousIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
Object.defineProperty(globalThis, "indexedDB", { configurable: true, writable: true, value: idb.indexedDB });
after(() => {
  if (previousIndexedDb) Object.defineProperty(globalThis, "indexedDB", previousIndexedDb);
  else delete globalThis.indexedDB;
});

test("setStreamingMessage stamps assistant ingestion without mutating its input", () => {
  const store = fixture();
  const live = message("live", { eagerMarkdown: false });
  store.getState().setStreamingMessage(live);
  eager(store.getState().streamingMessage);
  assert.notEqual(store.getState().streamingMessage, live);
  assert.equal(live.eagerMarkdown, false);
  assert.equal(store.getState().streamingMessage.text, prose);
  assert.equal(store.getState().streamingMessage.parts, live.parts);
  store.getState().setStreamingMessage(message("user", { role: "user" }));
  noHint(store.getState().streamingMessage, "user ingestion must not receive the assistant hint");
  store.getState().setStreamingMessage(null);
  assert.equal(store.getState().streamingMessage, null);
});

test("same-identity live token updates preserve the history array and row references", () => {
  const store = fixture();
  const responseKey = "response:stable-stream";
  store.getState().setHistory([message("persisted", { responseKey }), message("cold")]);
  store.getState().setStreamingMessage(message("stream", { responseKey }));
  const history = store.getState().messages;
  const rows = history.slice();
  eager(rows[0]);
  noHint(rows[1]);
  for (let index = 0; index < 5; index++) {
    const text = `Updated streaming text ${index}`;
    const update = message("stream", { responseKey, text, parts: [{ kind: "text", text }] });
    store.getState().setStreamingMessage(update);
    assert.equal(store.getState().messages, history, "token updates must not rebuild history");
    assert.equal(store.getState().messages[0], rows[0]);
    assert.equal(store.getState().messages[1], rows[1]);
    eager(store.getState().streamingMessage);
    assert.equal(store.getState().streamingMessage.text, text);
    noHint(update, "the caller's live message is not mutated");
  }
  store.getState().setStreamingMessage(message("cold"));
  eager(store.getState().messages[1], "a new live identity still updates an already-present history row");
});

for (const method of methods) {
  for (const value of [true, false]) {
    test(`${method} strips an incoming-only eagerMarkdown=${value} hint`, () => {
      const store = fixture();
      const incoming = message("untrusted", { eagerMarkdown: value });
      ingest(store, method, [incoming]);
      noHint(store.getState().messages[0]);
      assert.equal(incoming.eagerMarkdown, value, "sanitizing must not mutate incoming history");
      const revised = message("untrusted", { responseKey: "response:untrusted" });
      store.getState().mergeMessages([revised]);
      noHint(store.getState().messages[0], "an untrusted hint cannot become a later owner");
    });
  }
  for (const identity of ["stable id", "responseKey"]) {
    test(`${method} inherits current live ownership by ${identity}`, () => {
      const store = fixture();
      const shared = identity === "responseKey" ? { responseKey: "response:shared" } : {};
      store.getState().setStreamingMessage(message("live", shared));
      const id = identity === "stable id" ? "live" : "persisted";
      ingest(store, method, [message(id, shared)]);
      eager(store.getState().messages[0]);
      assert.equal(store.getState().messages[0].id, id);
      store.getState().setStreamingMessage(null);
      store.getState().setHistory([message(id, shared)]);
      eager(store.getState().messages[0], "current history ownership survives a tail reseed");
    });
  }
}

const identities = [
  ["ordinary stable id", { id: "provider:message-1" }, { id: "provider:message-1" }, true],
  ["positional entry:0", { id: "entry:0" }, { id: "entry:0" }, false],
  ["positional entry:127", { id: "entry:127" }, { id: "entry:127" }, false],
  ["empty id", { id: "" }, { id: "" }, false],
  ["blank id", { id: "  " }, { id: "  " }, false],
  ["missing id", { id: undefined }, { id: undefined }, false],
  ["different stable ids with equal text", { id: "a" }, { id: "b" }, false],
  ["same timestamp without responseKey", { id: "a", createdAt: new Date(1000) }, { id: "b", createdAt: new Date(1000) }, false],
  ["matching existing responseKey", { id: "a", responseKey: "response:r" }, { id: "b", responseKey: "response:r" }, true],
  ["entry ids with existing responseKey", { id: "entry:1", responseKey: "response:r" }, { id: "entry:2", responseKey: "response:r" }, true],
  ["missing ids with existing responseKey", { id: undefined, responseKey: "response:r" }, { id: undefined, responseKey: "response:r" }, true],
  ["empty responseKey", { id: "a", responseKey: "" }, { id: "b", responseKey: "" }, false],
  ["blank responseKey", { id: "a", responseKey: "  " }, { id: "b", responseKey: "  " }, false],
  ["different responseKeys with equal text", { id: "a", responseKey: "response:a" }, { id: "b", responseKey: "response:b" }, false],
];
for (const [label, live, history, expected] of identities) {
  test(`identity policy: ${label}`, () => {
    const store = fixture();
    store.getState().setStreamingMessage(message("unused", live));
    store.getState().mergeMessages([message("unused", history)]);
    if (expected) eager(store.getState().messages[0]);
    else noHint(store.getState().messages[0]);
  });
}

test("wire normalization supplies existing response identity but never trusts a wire hint", () => {
  const entry = (id, extra = {}) => ({ type: "message", id,
    message: { role: "assistant", timestamp: "2026-10-07T00:00:00.000Z", provider: "synthetic", model: "synthetic", content: prose, eagerMarkdown: true, ...extra } });
  const live = entryToUiMessage(entry(undefined), 5);
  const persisted = entryToUiMessage(entry("persisted-entry"), 17);
  assert.equal(live.id, "entry:5");
  assert.equal(persisted.id, "persisted-entry");
  assert.equal(live.responseKey, persisted.responseKey);
  assert.ok(live.responseKey);
  noHint(live);
  noHint(persisted);
  const store = fixture();
  store.getState().setStreamingMessage(live);
  store.getState().mergeMessages([persisted]);
  store.getState().commitStreamingMessage();
  assert.equal(store.getState().messages.length, 1);
  eager(store.getState().messages[0]);
});

test("wire positional fallbacks without existing response identity stay cold", () => {
  const raw = { type: "message", message: { role: "assistant", content: prose } };
  const live = entryToUiMessage(raw, 3);
  const history = entryToUiMessage(raw, 3);
  assert.equal(live.id, "entry:3");
  assert.equal(live.responseKey, undefined);
  const store = fixture();
  store.getState().setStreamingMessage(live);
  store.getState().mergeMessages([history]);
  noHint(store.getState().messages[0]);
  store.getState().commitStreamingMessage();
  noHint(store.getState().messages[0]);
});

test("a matching user row and an unrelated assistant never inherit ownership", () => {
  const store = fixture();
  store.getState().setStreamingMessage(message("live", { responseKey: "response:live" }));
  store.getState().mergeMessages([
    message("live", { role: "user", responseKey: "response:live", eagerMarkdown: true }),
    message("unrelated", { eagerMarkdown: true }),
  ]);
  for (const row of store.getState().messages) noHint(row);
});

test("untrusted rows in the same history batch cannot seed each other's ownership", () => {
  const store = fixture();
  store.getState().setHistory([
    message("injected", { responseKey: "response:injected", eagerMarkdown: true }),
    message("related-to-injection", { responseKey: "response:injected" }),
  ]);
  for (const row of store.getState().messages) noHint(row);
});

for (const order of ["history-live-commit", "live-history-commit", "live-commit-history"]) {
  test(`${order} preserves the hint through repeated events and persisted-id replacement`, () => {
    const store = fixture();
    const responseKey = "response:handoff";
    const live = message("stream-id", { responseKey });
    const persisted = message("persisted-id", { responseKey });
    const actions = {
      live: () => store.getState().setStreamingMessage(live),
      history: () => store.getState().mergeMessages([persisted]),
      commit: () => store.getState().commitStreamingMessage(),
    };
    for (const operation of order.split("-")) actions[operation]();
    assert.equal(store.getState().streamingMessage, null);
    assert.equal(store.getState().messages.length, 1);
    assert.equal(store.getState().messages[0].id, "persisted-id");
    eager(store.getState().messages[0]);
    for (let repeat = 0; repeat < 3; repeat++) {
      store.getState().mergeMessages([persisted]);
      store.getState().commitStreamingMessage();
      store.getState().setStreamingMessage(live);
      store.getState().commitStreamingMessage();
      assert.equal(store.getState().messages.length, 1);
      assert.equal(store.getState().messages[0].id, "persisted-id");
      eager(store.getState().messages[0]);
    }
    const replacement = message("later-persisted-id", { responseKey, text: "Authoritative revision", parts: [{ kind: "text", text: "Authoritative revision" }] });
    store.getState().mergeMessages([replacement]);
    assert.equal(store.getState().messages.length, 1);
    assert.equal(store.getState().messages[0].id, replacement.id);
    assert.equal(store.getState().messages[0].text, replacement.text);
    eager(store.getState().messages[0]);
    store.getState().setHistory([message(replacement.id, { responseKey })]);
    eager(store.getState().messages[0]);
    assert.equal(store.getState().messages[0].text, prose, "tail reseeding retains authoritative history text");
  });
}

test("hint propagation leaves current text, tool results, errors, and receipt metadata authoritative", () => {
  const store = fixture();
  const responseKey = "response:rich";
  const tool = { kind: "tool", callId: "call-1", name: "test-tool", args: {}, state: "ok", output: "live result", startedAt: 10, endedAt: 20 };
  store.getState().setStreamingMessage(message("live", { responseKey, parts: [{ kind: "text", text: prose }, tool] }));
  store.getState().commitStreamingMessage();
  const text = "Revised source\n\n```text\nexact whitespace  \n```\n";
  const authoritative = message("persisted", {
    responseKey, text, parts: [{ kind: "text", text }, { kind: "tool", callId: "call-1", name: "test-tool", args: {}, state: "running" }],
    errorMessage: "authoritative provider error", stopReason: "error", sourceEntryId: "entry-authoritative",
    createdAt: new Date(1000), completedAt: new Date(2000), usage: { output: 12 }, duration: 1000,
  });
  store.getState().mergeMessages([authoritative]);
  const row = store.getState().messages[0];
  eager(row);
  for (const key of ["id", "text", "errorMessage", "stopReason", "sourceEntryId", "createdAt", "completedAt", "usage", "duration"]) {
    assert.deepEqual(row[key], authoritative[key], `${key} is history-authoritative`);
  }
  assert.deepEqual(row.parts[0], authoritative.parts[0]);
  for (const key of Object.keys(tool)) assert.deepEqual(row.parts[1][key], tool[key], `live tool ${key} is preserved`);
  store.getState().applyResults([{ callId: "call-1", name: "test-tool", output: "new result", isError: true, pruned: false, at: 30 }]);
  eager(store.getState().messages[0]);
  assert.equal(store.getState().messages[0].parts[1].output, "new result");
  assert.equal(store.getState().messages[0].parts[1].state, "error");
});

test("setHistory can replace a persisted id while the current responseKey still owns the hint", () => {
  const store = fixture();
  store.getState().setStreamingMessage(message("live", { responseKey: "response:reseed" }));
  store.getState().commitStreamingMessage();
  store.getState().setHistory([message("new-id", { responseKey: "response:reseed" })]);
  eager(store.getState().messages[0]);
  store.getState().setHistory([message("unrelated", { eagerMarkdown: true })]);
  noHint(store.getState().messages[0]);
  store.getState().setHistory([message("new-id", { responseKey: "response:reseed", eagerMarkdown: true })]);
  noHint(store.getState().messages[0], "a removed owner cannot be recovered from a hidden registry");
});

for (const reset of ["clearSession", "beginSession-same", "beginSession-other-and-reopen"]) {
  test(`${reset} ends both current live and current-history ownership`, () => {
    const store = fixture();
    store.getState().setStreamingMessage(message("committed", { responseKey: "response:committed" }));
    store.getState().commitStreamingMessage();
    store.getState().setStreamingMessage(message("streaming", { responseKey: "response:streaming" }));
    if (reset === "clearSession") store.getState().clearSession();
    else store.getState().beginSession(reset === "beginSession-same" ? path : "/synthetic/other.jsonl");
    assert.equal(store.getState().messages.length, 0);
    assert.equal(store.getState().streamingMessage, null);
    if (reset !== "beginSession-same") store.getState().beginSession(path);
    store.getState().setHistory([
      message("committed", { responseKey: "response:committed", eagerMarkdown: true }),
      message("streaming", { responseKey: "response:streaming", eagerMarkdown: true }),
    ]);
    for (const row of store.getState().messages) noHint(row);
    store.getState().setStreamingMessage(message("streaming", { responseKey: "response:streaming" }));
    eager(store.getState().messages.find((row) => row.id === "streaming"), "fresh live ingestion restores ownership");
    noHint(store.getState().messages.find((row) => row.id === "committed"));
  });
}

test("persisted-id replacement does not retain an old stable-id alias outside current ownership", () => {
  const store = fixture();
  store.getState().setStreamingMessage(message("stream-id", { responseKey: "response:replacement" }));
  store.getState().commitStreamingMessage();
  store.getState().mergeMessages([message("persisted-id", { responseKey: "response:replacement" })]);
  assert.deepEqual(store.getState().messages.map((row) => row.id), ["persisted-id"]);
  eager(store.getState().messages[0]);
  store.getState().appendMessage(message("stream-id", { eagerMarkdown: true }));
  noHint(store.getState().messages[1], "a departed id cannot transfer ownership without the shared responseKey");
  eager(store.getState().messages[0]);
});

test("clearing an uncommitted stream leaves no owner for a later history arrival", () => {
  const store = fixture();
  store.getState().setStreamingMessage(message("live", { responseKey: "response:forgotten" }));
  store.getState().setStreamingMessage(null);
  store.getState().mergeMessages([message("live", { responseKey: "response:forgotten", eagerMarkdown: true })]);
  noHint(store.getState().messages[0]);
});

for (const mode of ["whole-page-top", "partial-page-top", "bottom", "multi-page-bottom"]) {
  test(`actual trimWindow ${mode} eviction ends ownership while retained rows stay eager`, () => {
    const store = fixture();
    const bottom = mode.endsWith("bottom");
    for (let index = 0; index < 6; index++) {
      store.getState().setStreamingMessage(message(`row-${index}`, { responseKey: `response:${index}` }));
      store.getState().commitStreamingMessage();
    }
    const pages = mode === "whole-page-top" ? [
      { before: 100, nextBefore: 0, firstId: "row-0", lastId: "row-2", count: 3 },
      { before: null, nextBefore: 100, firstId: "row-3", lastId: "row-5", count: 3 },
    ] : mode === "multi-page-bottom" ? [
      { before: 300, nextBefore: 200, firstId: "row-0", lastId: "row-1", count: 2 },
      { before: 200, nextBefore: 100, firstId: "row-2", lastId: "row-3", count: 2 },
      { before: null, nextBefore: 100, firstId: "row-4", lastId: "row-5", count: 2 },
    ] : [{ before: null, nextBefore: 100, firstId: "row-0", lastId: "row-5", count: 6 }];
    store.getState().resetPages(pages);
    store.getState().trimWindow(3, !bottom);
    assert.equal(store.getState().messages.length, 3);
    const retained = bottom ? [0, 1, 2] : [3, 4, 5];
    const removed = bottom ? [3, 4, 5] : [0, 1, 2];
    assert.deepEqual(store.getState().messages.map((row) => row.id), retained.map((index) => `row-${index}`));
    for (const row of store.getState().messages) eager(row);
    if (mode === "whole-page-top") assert.deepEqual(store.getState().evictedTop, { before: 100, count: 3 });
    if (mode === "partial-page-top") assert.equal(store.getState().trimmedTop, 3);
    if (bottom) assert.equal(store.getState().evictedBottom, 3);
    assert.equal(store.getState().historyPages.reduce((count, page) => count + page.count, 0), 3);
    for (const page of store.getState().historyPages) {
      assert.ok(store.getState().messages.some((row) => row.id === page.firstId));
      assert.ok(store.getState().messages.some((row) => row.id === page.lastId));
    }
    if (mode === "multi-page-bottom") assert.deepEqual(store.getState().historyPages, [
      { before: 300, nextBefore: 200, firstId: "row-0", lastId: "row-1", count: 2 },
      { before: 200, nextBefore: 100, firstId: "row-2", lastId: "row-2", count: 1 },
    ]);
    const reloaded = removed.map((index) => message(`row-${index}`, { responseKey: `response:${index}`, eagerMarkdown: true }));
    if (bottom) store.getState().mergeMessages(reloaded);
    else store.getState().prependMessages(reloaded);
    for (const index of removed) noHint(store.getState().messages.find((row) => row.id === `row-${index}`));
    for (const index of retained) eager(store.getState().messages.find((row) => row.id === `row-${index}`));
  });
}

test("offline saveTail serializes no eager hints and loadTail cannot revive live ownership", async () => {
  const namespace = "synthetic-policy-roundtrip";
  const rows = Array.from({ length: 55 }, (_, index) => message(`cache-${index}`, {
    responseKey: `response:cache-${index}`, eagerMarkdown: true, createdAt: new Date(1000 + index), completedAt: new Date(2000 + index),
  }));
  await saveTail(path, rows, namespace);
  const stored = idb.record(namespace, path);
  assert.ok(stored, "saveTail must really write through IndexedDB");
  assert.equal(stored.messages.length, 50);
  assert.equal(stored.messages[0].id, "cache-5");
  assert.equal(JSON.stringify(stored).includes('"eagerMarkdown"'), false, "serialized storage must exclude the client-only field");
  for (const row of stored.messages) noHint(row);
  for (const row of rows) eager(row, "offline serialization must not strip the currently owned input");
  const cached = await loadTail(path, namespace);
  assert.ok(cached, "loadTail must read the saved record");
  assert.equal(cached.savedAt, stored.savedAt);
  assert.equal(cached.messages.length, 50);
  for (const row of cached.messages) {
    noHint(row);
    assert.equal(row.text, prose);
    assert.deepEqual(row.parts, [{ kind: "text", text: prose }]);
    assert.ok(row.createdAt instanceof Date);
    assert.ok(row.completedAt instanceof Date);
  }
  const reopened = fixture();
  reopened.getState().setHistory(cached.messages);
  for (const row of reopened.getState().messages) noHint(row);
  assert.equal(idb.calls.open, 1);
  assert.ok(idb.calls.put > 0 && idb.calls.cursor > 0 && idb.calls.get > 0, "exercise write, pruning scan, and read boundaries");
});

test("loadTail strips a stored injected hint independently of saveTail sanitization", async () => {
  const namespace = "synthetic-policy-injected";
  // Open through the public API, then represent data left by an older or
  // compromised cache writer. The load must be safe without calling saveTail.
  await saveTail(path, [message("bootstrap")], namespace);
  const base = idb.record(namespace, path);
  const rows = [
    message("injected-created", { responseKey: "response:injected", eagerMarkdown: true, createdAt: "2026-10-07T00:00:00.000Z" }),
    message("injected-completed", { eagerMarkdown: true, completedAt: "2026-10-07T00:01:00.000Z" }),
    message("injected-undated", { eagerMarkdown: false }),
  ];
  idb.inject({ ...base, messages: rows });
  assert.equal(idb.record(namespace, path).messages[0].eagerMarkdown, true);
  const writesBefore = idb.calls.put;
  const cached = await loadTail(path, namespace);
  assert.ok(cached);
  assert.equal(cached.messages.length, 3);
  assert.equal(idb.calls.put, writesBefore, "revival cannot depend on a sanitizing rewrite");
  for (const row of cached.messages) noHint(row);
  assert.ok(cached.messages[0].createdAt instanceof Date);
  assert.ok(cached.messages[1].completedAt instanceof Date);
  assert.equal(cached.messages[0].responseKey, "response:injected");
  assert.equal(cached.messages[0].text, prose);
  assert.equal(idb.record(namespace, path).messages[0].eagerMarkdown, true, "read must operate on a cloned record");
});


test("optimistic attachment composition is neither persisted nor revived", async () => {
  const namespace = "synthetic-local-attachment-count";
  const row = message("local:photo-command", {role: "user", text: "Caption", parts: [{kind: "text", text: "Caption"}], localAttachmentCount: 2});
  const store = fixture();
  store.getState().appendMessage(row);
  store.getState().mergeMessages([message("unrelated-history")]);
  await saveTail(path, store.getState().messages, namespace);
  const stored = idb.record(namespace, path);
  assert.ok(stored);
  assert.equal(Object.hasOwn(stored.messages[0], "localAttachmentCount"), false);
  assert.equal(row.localAttachmentCount, 2, "serialization does not mutate the active message");
  const loaded = await loadTail(path, namespace);
  assert.equal(Object.hasOwn(loaded.messages[0], "localAttachmentCount"), false);
  idb.inject({...stored, messages: [row]});
  const writes = idb.calls.put;
  const revived = await loadTail(path, namespace);
  assert.equal(Object.hasOwn(revived.messages[0], "localAttachmentCount"), false);
  assert.equal(revived.messages[0].text, "Caption");
  assert.equal(idb.calls.put, writes, "revival needs no cache rewrite");
});

test("native search coverage and provider failure survive the actual cold-open cache", async () => {
  const namespace = "synthetic-native-search-cache";
  const coverage = {matchCount:24,fileCount:1,truncated:true,perFileLimitReached:24,fileLimitReached:20,linesTruncated:true,
    meta:{truncation:{direction:"head",truncatedBy:"bytes",totalLines:999,totalBytes:99999,outputLines:24,outputBytes:1024}}};
  const providerError = "All web search providers failed: Brave: denied";
  const entries = ["grep", "web_search"].flatMap((name, index) => [
    {type:"message",id:`search-call-${index}`,message:{role:"assistant",content:[{type:"toolCall",id:`search-${index}`,name,arguments:{query:"needle"}}]}},
    {type:"message",id:`search-result-${index}`,message:{role:"toolResult",toolName:name,toolCallId:`search-${index}`,
      content:[{type:"text",text:index ? `Error: ${providerError}` : "recorded match\n".repeat(2000)}],
      details:index ? {response:{provider:"brave",sources:[]},error:providerError} : coverage}},
  ]);
  const rows = entriesToTranscript(entries).messages;
  await saveTail(path, rows, namespace);
  const cached = await loadTail(path, namespace);
  assert.ok(cached);
  const [grep, web] = cached.messages.map(message => message.parts[0]);
  assert.deepEqual(grep.search, rows[0].parts[0].search);
  assert.equal(grep.search.perFileLimitReached, 24);
  assert.equal(grep.search.fileLimitReached, 20);
  assert.equal(grep.search.linesTruncated, true);
  assert.equal(grep.search.outputTruncated, true);
  assert.ok(grep.output.length < rows[0].parts[0].output.length, "the real cache cap runs without discarding coverage");
  assert.equal(web.state, "error");
  assert.equal(web.search.error, providerError);
  assert.equal(web.output, `Error: ${providerError}`);
});
