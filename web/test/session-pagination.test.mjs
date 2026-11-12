#!/usr/bin/env node
// Bounded session-list pages, validators, and stale-query race without a daemon.
// Run: node web/test/session-pagination.test.mjs
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const { createServer } = await import(
  new URL("../node_modules/vite/dist/node/index.js", import.meta.url).href
);
const listeners = () => {
  const map = new Map();
  return {
    addEventListener: (type, fn) => map.set(type, [...(map.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => map.set(type, (map.get(type) ?? []).filter((f) => f !== fn)),
    dispatchEvent: (event) => { for (const fn of map.get(event.type) ?? []) fn(event); return true; },
  };
};
const storage = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return storage.size; },
    key: (i) => [...storage.keys()][i] ?? null,
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  },
});
globalThis.window = Object.assign(globalThis, listeners(), { location: { origin: "http://daemon.test" } });
globalThis.document = { visibilityState: "visible", ...listeners() };

let failures = 0;
const check = (name, condition, detail = "") => {
  console.log((condition ? "PASS" : "FAIL") + "  " + name + (detail ? " (" + detail + ")" : ""));
  if (!condition) failures += 1;
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});
const row = (path, title = path) => ({ path, title, cwd: "/tmp", activeAt: 1, modifiedAt: 1, status: "idle" });
const listingCalls = [];
let releaseOld;
let changed = false;
const oldResponse = new Promise((resolve) => { releaseOld = resolve; });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "http://daemon.test");
  if (url.pathname === "/api/version")
    return json({ protocolVersion: 3, minClientProtocolVersion: 3, releaseId: "dev" });
  if (url.pathname === "/api/sessions") {
    const headers = new Headers(init.headers);
    listingCalls.push({ url, headers });
    const query = url.searchParams.get("q") ?? "";
    const cursor = url.searchParams.get("cursor");
    if (query === "needle" && !cursor) {
      if (changed) return json({ sessions: [row("fresh"), row("recent-a")], nextCursor: "cursor-2" }, 200, { ETag: '"changed"' });
      if (headers.get("If-None-Match") === '"first-page"') return new Response(null, { status: 304 });
      return json({ sessions: [row("recent-a"), row("pinned-old")], nextCursor: "cursor-1" }, 200, { ETag: '"first-page"' });
    }
    if (query === "needle" && cursor)
      return json({ sessions: [row("recent-a", "updated duplicate"), row("older-c")], nextCursor: null }, 200, { ETag: '"second-page"' });
    if (query === "old") {
      await oldResponse;
      return json({ sessions: [row("old-result")], nextCursor: null });
    }
    if (query === "new") return json({ sessions: [row("new-result")], nextCursor: null });
    return json({ sessions: [], nextCursor: null });
  }
  return json({});
};

const vite = await createServer({
  root: WEB,
  configFile: false,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  resolve: { alias: { "@": WEB + "src" } },
});
let controller;
try {
  const { OmpSessionController } = await vite.ssrLoadModule("/src/runtime/omp-session-controller.ts");
  const { createOmpStore } = await vite.ssrLoadModule("/src/runtime/omp-store.ts");
  const store = createOmpStore();
  controller = new OmpSessionController(store, "test-token", "http://daemon.test");
  const scope = { query: "needle", pinned: ["/sessions/pinned-old.jsonl"] };

  await controller.loadSessions(scope);
  const firstCall = listingCalls.at(-1);
  check("first request is one bounded, search-scoped page",
    firstCall?.url.searchParams.get("limit") === "50"
      && firstCall.url.searchParams.get("q") === "needle"
      && firstCall.url.searchParams.get("live") === "true"
      && firstCall.url.searchParams.getAll("pinned").includes("/sessions/pinned-old.jsonl")
      && store.getState().sessions.length === 2
      && store.getState().sessionsNextCursor === "cursor-1");

  await controller.loadMoreSessions();
  const secondCall = listingCalls.at(-1);
  const rowsAfterOlder = store.getState().sessions;
  check("older page appends once and deduplicates a repeated pinned/live row",
    secondCall?.url.searchParams.get("cursor") === "cursor-1"
      && rowsAfterOlder.length === 3
      && rowsAfterOlder.some((session) => session.path === "older-c")
      && rowsAfterOlder.find((session) => session.path === "recent-a")?.title === "updated duplicate"
      && store.getState().sessionsNextCursor === null);

  await controller.loadSessions(scope);
  const revalidation = listingCalls.at(-1);
  check("page revalidation sends its own ETag and retains already loaded history",
    revalidation?.headers.get("If-None-Match") === '"first-page"'
      && store.getState().sessions.length === 3
      && store.getState().sessionsNextCursor === null);
  changed = true;
  await controller.loadSessions(scope);
  check("changed first page replaces removed rows without losing loaded archive or reviving its cursor",
    store.getState().sessions.map((s) => s.path).join(",") === "fresh,recent-a,older-c"
      && store.getState().sessionsNextCursor === null);

  const oldLoad = controller.loadSessions({ query: "old" });
  while (!listingCalls.some((call) => call.url.searchParams.get("q") === "old"))
    await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.loadSessions({ query: "new" });
  releaseOld();
  await oldLoad;
  const finalState = store.getState();
  check("late search response cannot replace the newer query's page",
    finalState.sessions.length === 1
      && finalState.sessions[0]?.path === "new-result"
      && finalState.sessionsScope.includes("new")
      && finalState.sessionsNextCursor === null);
} catch (error) {
  check("pagination regression suite completed", false, String(error?.stack ?? error));
} finally {
  controller?.dispose();
  await vite.close();
}
console.log(failures ? "\n" + failures + " failed" : "\nall passed");
process.exit(failures ? 1 : 0);
