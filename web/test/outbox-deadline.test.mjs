#!/usr/bin/env node
// A dispatch whose HTTP request never answers must not hold the outbox.
//
// The drain lock is held for the whole network send, so one POST stuck on a
// dead keep-alive socket (laptop asleep behind Tailscale, a half-open TCP
// connection) used to park every later message as "saved" until the app was
// restarted: each new send, and every retry tap, queued behind it forever.
//
// No daemon, no browser: the outbox runs on Node's localStorage fallback and
// long timers are shortened so the dispatch deadline elapses in milliseconds.
//
//   node web/test/outbox-deadline.test.mjs
import { register } from "node:module";
import { readFileSync } from "node:fs";

const { protocolVersion, minClientProtocolVersion } = JSON.parse(
  readFileSync(new URL("../../protocol-version.json", import.meta.url), "utf8"),
);

// rpc-client.ts imports its siblings without an extension, the way Vite
// resolves them. Supply the same repository protocol define as Vite, while
// retaining Node's native TypeScript stripping for these production modules.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier))
          return next(specifier + ".ts", context);
        return next(specifier, context);
      }
      export async function load(url, context, next) {
        const result = await next(url, context);
        if (url.endsWith("/rpc-client.ts")) return {
          ...result,
          source: String(result.source).replaceAll(
            "import.meta.env.VITE_PROTOCOL_VERSION", ${JSON.stringify(String(protocolVersion))},
          ),
        };
        return result;
      }`),
);

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => void store.set(key, String(value)),
  removeItem: (key) => void store.delete(key),
  clear: () => store.clear(),
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, ms >= 60_000 ? 40 : ms, ...args);

const queue = await import("../src/runtime/offline-queue.ts");
const rpc = await import("../src/runtime/rpc-client.ts");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
}
/** Settles with `undefined` if `promise` has not settled after `ms` real ms. */
function within(promise, ms) {
  return Promise.race([
    promise.then(
      () => "settled",
      (error) => `rejected: ${error?.message ?? error}`,
    ),
    new Promise((resolve) => realSetTimeout(() => resolve(undefined), ms)),
  ]);
}
const never = () => new Promise(() => {});
const receipt = (entry, state) => ({
  ok: true,
  receipt: {
    commandId: entry.commandId,
    sessionPath: entry.sessionPath,
    state,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
  },
  receiptBinding: {
    version: 1,
    requestedSessionPath: entry.sessionPath,
    canonicalSessionPath: entry.sessionPath,
  },
});

// 1. A hung dispatch releases the drain; later work still goes out.
{
  const namespace = `deadline-${crypto.randomUUID()}`;
  queue.setOfflineQueueNamespace(namespace);
  const sessionPath = "/tmp/outbox-deadline";
  const hung = await queue.enqueue({ sessionPath, text: "first", namespace });
  const next = await queue.enqueue({ sessionPath, text: "second", namespace });
  const sends = [];
  let hungSignal = null;
  const send = (entry, signal) => {
    sends.push(entry.commandId);
    if (entry.commandId !== hung.commandId)
      return Promise.resolve(receipt(entry, "completed"));
    hungSignal = signal ?? null;
    return never();
  };
  const first = await within(queue.flush(send, { namespace, isTransient: () => false }), 2_000);
  check("a dispatch that never answers does not hold the drain", first === "settled", String(first));
  const stuck = await queue.getQueued(hung.commandId, namespace);
  check(
    "the unanswered command is uncertain, not failed or silently re-queued",
    stuck?.state === "uncertain",
    stuck?.state,
  );
  check("the unanswered request is aborted", hungSignal?.aborted === true);

  const second = await within(queue.flush(send, { namespace, isTransient: () => false }), 2_000);
  const delivered = await queue.getQueued(next.commandId, namespace);
  check(
    "the next queued message is delivered once the drain is free",
    second === "settled" && delivered?.state === "completed",
    `${second} ${delivered?.state}`,
  );
  check(
    "the uncertain command is never dispatched twice",
    sends.filter((id) => id === hung.commandId).length === 1,
    JSON.stringify(sends),
  );
}

// 2. The durable send surfaces (edit/resend, message actions, retry) return
//    instead of spinning forever, and abort the socket they were waiting on.
{
  const token = `deadline-token-${crypto.randomUUID()}`;
  queue.setOfflineQueueNamespace(queue.offlineQueueNamespaceForCredential(token));
  const prompts = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url), "http://daemon.test");
    if (target.origin !== "http://daemon.test") throw new Error(`Unexpected synthetic origin: ${target.origin}`);
    const path = target.pathname;
    if (path === "/api/version")
      return Response.json({ ok: true, protocolVersion, minClientProtocolVersion,
        capabilities: ["receipt-session-binding-v1"] });
    if (path === "/api/prompt") {
      prompts.push(init.signal ?? null);
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    }
    throw new Error(`Unexpected synthetic route: ${path}`);
  };
  const sent = rpc.sendPromptDurably("/tmp/outbox-deadline-durable", "hello", [], {
    token,
    baseUrl: "http://daemon.test",
  });
  const outcome = await within(sent, 2_000);
  const result = outcome === "settled" ? await sent : null;
  check(
    "a durable send whose POST never answers reports uncertain delivery",
    result?.state === "uncertain",
    outcome === "settled" ? result?.state : String(outcome),
  );
  check(
    "the durable send aborts its hung POST",
    prompts.length === 1 && prompts[0]?.aborted === true,
    `${prompts.length} POST(s), aborted=${prompts[0]?.aborted}`,
  );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
