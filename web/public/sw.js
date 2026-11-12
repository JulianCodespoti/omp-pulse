"use strict";

// omp-pulse service worker — Vite pins the shell and its complete asset set.
// PWA shell cacher, Web Push receiver, notification router.

const SHELL_HASH = "__OMP_PULSE_SHELL_HASH__";
const RELEASE_ASSETS = /*__OMP_PULSE_RELEASE_ASSETS__*/ [];
const CACHE_NAME = "omp-pulse-release-" + SHELL_HASH;
const STATE_CACHE = "omp-pulse-release-state";

const BASE = new URL("./", self.registration.scope).pathname;
const STATE_URL = BASE + "__worker_release_state__";
const SHELL_URLS = [
  BASE + "manifest.webmanifest",
  BASE + "icon-192.png",
  BASE + "badge-96.png",
  BASE + "icon.svg",
];
const PRECACHE_CONCURRENCY = 4;

async function releaseState() {
  const cache = await caches.open(STATE_CACHE);
  const response = await cache.match(STATE_URL);
  return response ? response.json() : {};
}

async function installRelease() {
  // The source worker is intentionally not installable: dev uses Vite/HMR.
  if (!/^[a-f0-9]{64}$/.test(SHELL_HASH) || RELEASE_ASSETS.length === 0) {
    throw new Error("service worker has no built release");
  }
  const cache = await caches.open(CACHE_NAME);
  // A same-release reinstall must never delete or mutate its usable cache.
  if (await cache.match(BASE)) return;
  try {
    const options = { cache: "reload", credentials: "omit", redirect: "error" };
    const shell = await fetch(BASE, options);
    if (!shell.ok) throw new Error("shell fetch failed");
    const digest = await crypto.subtle.digest("SHA-256", await shell.clone().arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    // A deploy racing installation can serve another release's HTML.
    if (hash !== SHELL_HASH) throw new Error("shell release changed");
    const urls = [...SHELL_URLS, ...RELEASE_ASSETS.map((asset) => BASE + asset)];
    let next = 0;
    let failure = null;
    // Bound memory/network pressure on phones, and drain in-flight writes
    // before deleting a failed staging cache.
    await Promise.all(Array.from({ length: PRECACHE_CONCURRENCY }, async () => {
      while (!failure && next < urls.length) {
        const url = urls[next++];
        try {
          const response = await fetch(url, options);
          if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
            throw new Error("release asset fetch failed");
          }
          await cache.put(url, response);
        } catch (error) {
          failure = error;
        }
      }
    }));
    if (failure) throw failure;
    // INVARIANT: the canonical shell is the commit marker, written LAST.
    // No navigation or previous-release lookup can use a partial release.
    await cache.put(BASE, shell);
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener("install", (event) => {
  // Never skipWaiting here: the existing explicit apply-update flow owns it.
  event.waitUntil(installRelease());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const state = await releaseState();
    const keys = await caches.keys();
    // First upgrade: keep the latest legacy cache for already-open pages'
    // chunks, but never use its mutable HTML for navigation.
    const legacy = keys.filter((key) => key.startsWith("omp-pulse-") &&
      key !== STATE_CACHE && key !== CACHE_NAME && !key.startsWith("omp-pulse-release-")).at(-1);
    const previous = state.current === CACHE_NAME ? state.previous : (state.current || legacy);
    const cache = await caches.open(STATE_CACHE);
    await cache.put(STATE_URL, new Response(JSON.stringify({ current: CACHE_NAME, previous })));
    // Keep exactly the previous activated release for already-open pages.
    // Failed/superseded installs and older legacy caches are discarded.
    await Promise.all(keys
      .filter((key) => key.startsWith("omp-pulse-") &&
        key !== STATE_CACHE && key !== CACHE_NAME && key !== previous)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (!path.startsWith(BASE) || path.startsWith("/api/") || path.startsWith("/ws")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const shell = await cache.match(BASE);
      if (!shell) throw new Error("offline release unavailable");
      // Pin navigation to the activated release. Previously a response arriving
      // after the 1.5 s deadline replaced old HTML without fetching its new
      // chunks, making the next offline launch unusable. Only a fully installed,
      // explicitly activated worker may promote a different shell now.
      return shell;
    })());
    return;
  }

  if (path.startsWith(BASE + "assets/") || path.startsWith(BASE + "providers/")) {
    const response = (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const state = await releaseState();
      if (state.previous && state.previous !== CACHE_NAME) {
        const previous = await caches.open(state.previous);
        if (await previous.match(BASE)) {
          const retained = await previous.match(request);
          if (retained) return retained;
        }
      }
      const fetched = await fetch(request);
      // Only stable public provider logos are runtime-cached. Build assets
      // belong exclusively to their install-time release, never a late deploy.
      if (fetched.ok && path.startsWith(BASE + "providers/")) {
        await cache.put(request, fetched.clone());
      }
      return fetched;
    })();
    event.respondWith(response);
    event.waitUntil(response.then(() => undefined, () => undefined));
    return;
  }

  if (SHELL_URLS.includes(path)) {
    event.respondWith(caches.open(CACHE_NAME).then((cache) => cache.match(path)));
  }
});

// Kind strings are a contract with the daemon (src/server/push/alerts.rs).
const KIND_AGENT_END = "agent_end";
const KIND_NEEDS_INPUT = "needs_input";
const AUTO_CLOSE_MS = 4000;

// True when a visible window of this app is showing exactly this conversation
// (App.tsx writes `#s=<encoded path>` and keeps it on the open chat).
async function conversationIsVisible(sessionPath) {
  const target = "#s=" + encodeURIComponent(sessionPath);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((client) => {
    if (client.visibilityState !== "visible") return false;
    const hash = new URL(client.url).hash;
    return hash === target || hash.startsWith(target + "&");
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        if (event.data) {
          payload = event.data.json();
        }
      } catch (_err) {
        // Malformed payload — fall back to defaults.
      }
      if (!payload || typeof payload !== "object") {
        payload = {};
      }
      const title =
        typeof payload.title === "string" && payload.title ? payload.title : "omp";
      const body =
        typeof payload.body === "string" && payload.body ? payload.body : "Agent finished";
      const tag =
        typeof payload.tag === "string" && payload.tag ? payload.tag : "omp-pulse";
      const sessionPath =
        typeof payload.sessionPath === "string" && payload.sessionPath
          ? payload.sessionPath
          : null;
      const reqId =
        typeof payload.reqId === "number" && Number.isFinite(payload.reqId)
          ? payload.reqId
          : typeof payload.reqId === "string" && payload.reqId
            ? payload.reqId
            : null;
      const data = {};
      if (sessionPath) data.sessionPath = sessionPath;
      if (reqId !== null) data.reqId = reqId;
      if (typeof payload.kind === "string" && payload.kind) data.kind = payload.kind;
      // ensure sessionPath/reqId are present at top-level per contract.
      if (payload && typeof payload === "object") {
        for (const k of Object.keys(payload)) {
          if (!(k in data)) data[k] = payload[k];
        }
      }
      const options = {
        body: body,
        tag: tag,
        icon: BASE + "icon-192.png",
        // Android draws the badge as a mask: the full-colour icon became a
        // white square, so it gets its own white-on-transparent silhouette.
        badge: BASE + "badge-96.png",
        data: data,
      };
      // A second question from the same conversation shares the first one's
      // tag; without renotify it replaced the first silently, with no buzz.
      if (payload.kind === KIND_NEEDS_INPUT && payload.tag) options.renotify = true;
      await self.registration.showNotification(title, options);
      // The daemon notifies every finished turn even while the app is open
      // (it must, or the buzz is unreliable), so the entry for the
      // conversation the user is looking at is withdrawn after a moment
      // instead of lingering in the shade. A question is never withdrawn.
      if (payload.kind === KIND_AGENT_END && sessionPath && (await conversationIsVisible(sessionPath))) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_CLOSE_MS));
        const shown = await self.registration.getNotifications({ tag: tag });
        for (const notification of shown) notification.close();
      }
    })().catch(() => {})
  );
});

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(
    (async () => {
      event.notification.close();
      const data = event.notification.data;
      const sessionPath =
        data && typeof data.sessionPath === "string" && data.sessionPath
          ? data.sessionPath
          : null;
      const reqId =
        data && data.reqId != null ? data.reqId : null;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ("focus" in client) {
          client.focus();
          if (sessionPath) {
            const msg = { type: "omp-open", sessionPath: sessionPath };
            if (reqId !== null) msg.reqId = reqId;
            if (data && typeof data.kind === "string" && data.kind) msg.kind = data.kind;
            client.postMessage(msg);
          }
          return;
        }
      }
      let url = BASE;
      if (sessionPath) {
        url = BASE + "#s=" + encodeURIComponent(sessionPath);
        if (reqId !== null) url += "&q=" + encodeURIComponent(String(reqId));
        if (data && typeof data.kind === "string" && data.kind) url += "&k=" + encodeURIComponent(data.kind);
      }
      return self.clients.openWindow(url);
    })().catch(() => {})
  );
});
self.addEventListener("message", (event) => {
  try {
    const data = event.data;
    if (data && typeof data.type === "string" && data.type === "SKIP_WAITING") {
      self.skipWaiting();
      return;
    }
    if (data && typeof data.type === "string" && data.type === "ping") {
      event.source.postMessage({ type: "pong" });
    }
  } catch (_err) {
    // Ignore — never throw out of a handler.
  }
});
