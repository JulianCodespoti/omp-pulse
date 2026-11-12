#!/usr/bin/env node
// Hydration must not replace a newer write from another tab.
//   node web/test/outbox-hydration-race.test.mjs
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent([
      "export async function resolve(specifier, context, next) {",
      "  if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier))",
      "    return next(specifier + '.ts', context);",
      "  return next(specifier, context);",
      "}",
    ].join("\n")),
);

const values = new Map();
const locks = new Map();
function pump(name) {
  const lock = locks.get(name);
  if (!lock || lock.held || lock.waiters.length === 0) return;
  lock.held = true;
  const { callback, resolve, reject } = lock.waiters.shift();
  let result;
  try {
    result = callback();
  } catch (error) {
    reject(error);
    lock.held = false;
    pump(name);
    return;
  }
  Promise.resolve(result).then(resolve, reject).finally(() => {
    lock.held = false;
    pump(name);
  });
}
const webLocks = {
  request(name, _options, callback) {
    let lock = locks.get(name);
    if (!lock) {
      lock = { held: false, waiters: [] };
      locks.set(name, lock);
    }
    return new Promise((resolve, reject) => {
      lock.waiters.push({ callback, resolve, reject });
      pump(name);
    });
  },
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { locks: webLocks },
});
let intercept = null;
let peerWrite = null;
globalThis.localStorage = {
  getItem(key) {
    const snapshot = values.has(key) ? values.get(key) : null;
    if (intercept && intercept.key === key &&
        (intercept.remaining === undefined || --intercept.remaining === 0)) {
      const current = intercept;
      intercept = null;
      const mutate = () => {
        const latest = JSON.parse(values.get(key) ?? "[]");
        current.action(latest);
        values.set(key, JSON.stringify(latest));
      };
      peerWrite = current.unlocked
        ? Promise.resolve().then(mutate)
        : webLocks.request("omp-pulse-outbox:" + current.namespace, { mode: "exclusive" }, mutate);
    }
    return snapshot;
  },
  setItem: (key, value) => void values.set(key, String(value)),
  removeItem: (key) => void values.delete(key),
  clear: () => values.clear(),
};

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}
function record(namespace, id, state, updatedAt, receipt) {
  return {
    id,
    commandId: id,
    sessionPath: "/tmp/hydration-race",
    text: id,
    images: [],
    imageCount: 0,
    imageBytes: 0,
    droppedImages: false,
    createdAt: updatedAt,
    updatedAt,
    state,
    ...(receipt ? { receipt } : {}),
    namespace,
    storageKey: namespace + ":" + id,
  };
}
async function loadQueue(tag) {
  return import(new URL("../src/runtime/offline-queue.ts?" + tag, import.meta.url).href);
}
async function runRace({ tag, state, staleAt, concurrentWrite, verify }) {
  const namespace = "hydration-" + tag + "-" + crypto.randomUUID();
  const key = "omp-pulse-queue-v3:" + namespace;
  const old = record(namespace, "old-command", state, staleAt);
  values.set(key, JSON.stringify([old]));
  const isolatedNamespace = "other-" + namespace;
  const isolatedKey = "omp-pulse-queue-v3:" + isolatedNamespace;
  const isolatedRecord = record(isolatedNamespace, "other-tab", "saved", Date.now());
  values.set(isolatedKey, JSON.stringify([isolatedRecord]));

  const queue = await loadQueue(tag);
  peerWrite = null;
  intercept = {
    key,
    namespace,
    action: (records) => concurrentWrite(records, namespace),
  };
  const hydration = await queue.getQueued("absent", namespace);
  if (peerWrite) await peerWrite;
  check(tag + " hydration lookup settles", hydration === null);
  const actual = await queue.getQueued(verify.id, namespace);
  check(verify.name, verify.check(actual), actual ? JSON.stringify(actual.receipt ?? actual.state) : "missing");
  check(tag + " does not cross namespaces", values.get(isolatedKey) === JSON.stringify([isolatedRecord]));
}

await runRace({
  tag: "new-message",
  state: "completed",
  staleAt: Date.now() - 48 * 60 * 60 * 1000,
  concurrentWrite(records, namespace) {
    records.push(record(namespace, "new-command", "saved", Date.now()));
  },
  verify: {
    id: "new-command",
    name: "a concurrent queued message survives stale-record pruning",
    check: (entry) => entry?.state === "saved" && entry?.text === "new-command",
  },
});

await runRace({
  tag: "newer-receipt",
  state: "dispatching",
  staleAt: Date.now() - 60 * 60 * 1000,
  concurrentWrite(records) {
    const entry = records.find((candidate) => candidate.commandId === "old-command");
    if (!entry) throw new Error("expected stale command to remain stored");
    const updatedAt = Date.now();
    entry.state = "completed";
    entry.updatedAt = updatedAt;
    entry.receipt = {
      commandId: entry.commandId,
      sessionPath: entry.sessionPath,
      state: "completed",
      createdAt: entry.createdAt,
      updatedAt,
    };
  },
  verify: {
    id: "old-command",
    name: "a newer receipt survives stale-dispatch recovery",
    check: (entry) => entry?.state === "completed" && entry?.receipt?.state === "completed",
  },
});

// A second document can reserve Edit after a dispatch read when Web Locks
// are unavailable. Claim and reservation must not both win that interleaving.
navigator.locks = undefined;
const queue = await loadQueue("dispatch-versus-edit");
const namespace = "dispatch-edit-" + crypto.randomUUID();
queue.setOfflineQueueNamespace(namespace);
const entry = await queue.enqueue({
  namespace, sessionPath: "/tmp/dispatch-edit", text: "Keep this exact message",
});
let edits = 0, posts = 0;
peerWrite = null;
intercept = {
  key: "omp-pulse-queue-v3:" + namespace, namespace, remaining: 2, unlocked: true,
  action(records) {
    const current = records.find(row => row.commandId === entry.commandId);
    if (current?.state !== "saved" || current.editToken) return;
    current.editToken = "peer-edit";
    edits++;
  },
};
await queue.flush(async command => {
  posts++;
  return {
    ok: true,
    receipt: { commandId: command.commandId, sessionPath: command.sessionPath, state: "completed", createdAt: 1, updatedAt: 2 },
    receiptBinding: { version: 1, requestedSessionPath: command.sessionPath, canonicalSessionPath: command.sessionPath },
  };
}, { namespace, isTransient: () => false });
if (peerWrite) await peerWrite;
check("a competing edit and HTTP dispatch cannot both claim the saved message without Web Locks",
  edits + posts === 1, `edits=${edits}, posts=${posts}`);
const afterRace = await queue.getQueued(entry.commandId, namespace);
check("the winning claim retains the original text",
  afterRace?.text === entry.text);
check("the final outbox state belongs to the winner",
  edits ? afterRace?.state === "saved" && afterRace?.editToken === "peer-edit" : afterRace?.state === "completed");

console.log(failures === 0 ? "\nall checks passed" : failures + " check(s) failed");
process.exit(failures === 0 ? 0 : 1);
