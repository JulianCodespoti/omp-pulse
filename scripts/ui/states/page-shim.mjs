// Document-start script injected into every recipe page, plus the CSS that
// freezes motion. Kept apart from the engine because it runs in the PAGE:
// it is serialised with `${fn}`, so it must stay self-contained.

// Clamped rather than zeroed: a 0s transition never fires `transitionend`,
// and dialog libraries that wait for it would hang half-open. Iterations are
// capped so an infinite pulse does not repaint every millisecond.
export const FREEZE_CSS = `*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

// ── document-start page shim ────────────────────────────────────────────────
// Serialised with `${fn}` and injected through CDP, which is NOT subject to the
// app's CSP (it forbids unsafe-eval, so page-side eval never installs a shim).
// It must stay self-contained.
//
// Everything the Node side reads back goes through DOM attributes or DOM
// events, never window globals: a CDP-injected script and puppeteer's evaluate
// can live in different JS worlds, and a global written in one reads as
// undefined in the other.
export function pageShim(cfg) {
  // The document-start script also runs in every iframe (the plugin sandbox is an opaque-origin
  // `blob:` frame with no storage). Only the app's top-level document is shimmed.
  if (window.top !== window) return;
  // At document start `document.documentElement` can still be null, and one
  // throw here used to abort the whole shim AFTER the token was stored: the
  // app booted paired but unstubbed, so writes reached the daemon and spawned
  // a real omp child. Attributes are therefore buffered until the root exists,
  // and the engine refuses to shoot unless `data-capture-shim` reads "ok".
  const pending = new Map();
  const mark = (key, value) => {
    const root = document.documentElement;
    if (root) root.setAttribute(key, value);
    else pending.set(key, value);
  };
  document.addEventListener("readystatechange", () => {
    for (const [k, v] of pending) document.documentElement.setAttribute(k, v);
    pending.clear();
  }, { once: true });

  // A pinned clock, so two runs render the same dates and relative times
  // ("20m", "Yesterday"): the page's `Date` starts at `cfg.clock` instead of
  // today. It runs at REAL speed from there. It cannot stand still: the
  // transcript's stick-to-bottom animation ends when `Date.now()` passes a
  // deadline, so a frozen (or minute-stepped) clock left it animating
  // forever, the scroller never reached the bottom, and history paging never
  // armed. The seconds that do elapse during a recipe are normalised out of
  // the rendered text just before the shot (stabilize.mjs), which first stops
  // the clock (`capture:freeze`): a ticking timer would otherwise re-render
  // its real value over the normalised one between that edit and the shot.
  if (cfg.clock) {
    const RealDate = Date;
    const offset = cfg.clock - RealDate.now();
    let frozen = null;
    const now = () => frozen ?? RealDate.now() + offset;
    window.addEventListener("capture:freeze", () => { frozen = now(); });
    function PinnedDate(...args) {
      if (!new.target) return new RealDate(now()).toString();
      return args.length ? new RealDate(...args) : new RealDate(now());
    }
    PinnedDate.prototype = RealDate.prototype;
    PinnedDate.now = now;
    PinnedDate.parse = RealDate.parse;
    PinnedDate.UTC = RealDate.UTC;
    window.Date = PinnedDate;
  }

  // Constructable sheet: needs no <head>, and React never touches it.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(cfg.css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

  if (cfg.notificationPermission && "Notification" in window) {
    Object.defineProperty(Notification, "permission", { get: () => cfg.notificationPermission });
  }

  if (cfg.native) {
    const ok = () => Promise.resolve({ ok: true });
    // Notification page: `cfg.native.prefs` / `cfg.native.notificationStatus` override these defaults.
    const prefs = {
      enabled: true, agentEnd: true, needsInput: true, alerts: true,
      quietEnabled: false, quietStart: 22 * 60, quietEnd: 7 * 60, background: true,
      ...cfg.native.prefs,
    };
    const plugin = {
      setToken: ok, clearToken: ok, haptic: ok,
      getStatus: () => Promise.resolve(cfg.native.status),
      checkPermission: () => Promise.resolve(cfg.native.permission),
      requestPermission: () => Promise.resolve({ granted: true }),
      openNotificationSettings: ok, openBubbleSettings: ok, openBatterySettings: ok,
      getNotificationPrefs: () => Promise.resolve({ ...prefs }),
      setNotificationPrefs: (changes) => Promise.resolve(Object.assign(prefs, changes)),
      getNotificationStatus: () => Promise.resolve({
        permission: "granted", bubbles: "on", paired: true, listener: "connected", batteryUnrestricted: true,
        ...cfg.native.notificationStatus,
      }),
      getChatNotifications: () => Promise.resolve({ enabled: true, agentEnd: true, needsInput: true, alerts: true }),
      setChatNotifications: ({ sessionPath, ...changes }) => Promise.resolve({ enabled: true, agentEnd: true, needsInput: true, alerts: true, ...changes }),
    };
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      registerPlugin: (name) => (name === "OmpNotify" ? plugin : {}),
      Plugins: { OmpNotify: plugin },
    };
  }

  // The Android run-mode bridge (web/src/platform/local-mode.ts), for the
  // Settings › Run on and onboarding states. Calls are accepted and ignored.
  if (cfg.ompLocal) {
    const json = (value) => () => JSON.stringify(value);
    window.OmpLocal = {
      state: json(cfg.ompLocal),
      access: json({}),
      setMode() {},
      useComputer: json({ ok: true }),
      computerStatus: json(cfg.ompLocal.computerStatus ?? {}),
      forgetComputer() {},
      connectLaptop: json({ ok: true }),
      prepare() {},
      grant() {},
      providers: json([]),
      loginStart() {}, loginInput() {}, loginCancel() {},
      loginState: json({}),
    };
  }

  // fetch: stubs + in-flight accounting. Pending URLs are published so a
  // state that never settles says which request held it.
  const inflight = new Map();
  let seq = 0;
  const publish = () => {
    mark("data-capture-inflight", String(inflight.size));
    mark("data-capture-pending", [...inflight.values()].join(" "));
  };
  const track = async (label, run) => {
    const id = ++seq;
    inflight.set(id, label);
    publish();
    try { return await run(); } finally { inflight.delete(id); publish(); }
  };
  publish();
  const hits = new Map();
  const realFetch = window.fetch.bind(window);
  const matches = (s, method, path, search, rpc) =>
    (!s.method || s.method === method) &&
    (s.path.endsWith("*") ? path.startsWith(s.path.slice(0, -1)) : path === s.path) &&
    (!s.query || search.includes(s.query)) &&
    (!s.rpc || s.rpc === rpc);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    let rpc = "";
    if (url.pathname === "/api/rpc" && typeof init.body === "string") {
      try { rpc = JSON.parse(init.body).command || ""; } catch {}
    }
    const isApi = url.pathname.startsWith("/api/");
    let stub = null;
    // Any path may be stubbed (`/app-release.json` lives at the origin root,
    // which vite does not proxy); the write guard below is about the API.
    for (const s of cfg.stubs) {
      if (!matches(s, method, url.pathname, url.search, rpc)) continue;
      const key = cfg.stubs.indexOf(s);
      const n = hits.get(key) ?? 0;
      hits.set(key, n + 1);
      if (n < (s.skip ?? 0)) { stub = "pass"; break; }
      stub = s;
      break;
    }
    // INVARIANT: no write reaches the daemon. See the header of capture.mjs.
    if (isApi && (stub === null || stub === "pass") && method !== "GET") stub = { status: 200, body: { ok: true, data: {} } };
    const label = `${method} ${url.pathname}${rpc ? `#${rpc}` : ""}`;
    if (stub && stub !== "pass") {
      if (stub.hang) return new Promise(() => {});
      // The browser's own transport failure: the request never reached the daemon.
      if (stub.fail) return Promise.reject(new TypeError("Failed to fetch"));
      return track(label, async () => {
        if (stub.delay) await new Promise((r) => setTimeout(r, stub.delay));
        return new Response(JSON.stringify(stub.body ?? { ok: true }), {
          status: stub.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      });
    }
    return track(label, () => realFetch(input, init));
  };

  // WebSocket: per-kind mode (real | hang | fail) + a frame tap.
  const NativeWS = window.WebSocket;
  const sockets = new Set();
  const kindOf = (u) => {
    const p = new URL(String(u), location.href).pathname;
    return p.endsWith("/ws/sessions") ? "sessions" : p.endsWith("/ws") ? "chat" : "other";
  };
  class HangingSocket extends EventTarget {
    constructor(url) {
      super();
      Object.assign(this, { url: String(url), readyState: 0, binaryType: "blob", protocol: "", extensions: "", bufferedAmount: 0, onopen: null, onmessage: null, onerror: null, onclose: null });
    }
    send() {}
    close() { this.readyState = 3; }
  }
  // Errors and closes on the next tick, like a refused connection, but without
  // touching the network: a real socket to a closed port failed after a
  // variable delay, so the header read "connecting" on some runs and
  // "reconnecting" on others.
  class FailingSocket extends HangingSocket {
    constructor(url) {
      super(url);
      setTimeout(() => {
        this.readyState = 3;
        const error = new Event("error");
        this.onerror?.(error);
        this.dispatchEvent(error);
        const close = new CloseEvent("close", { code: 1006 });
        this.onclose?.(close);
        this.dispatchEvent(close);
      }, 0);
    }
  }
  function CaptureWebSocket(url, protocols) {
    const kind = kindOf(url);
    const mode = cfg.ws[kind] || "real";
    if (mode === "hang") return new HangingSocket(url);
    if (mode === "fail") return new FailingSocket(url);
    const socket = new NativeWS(url, protocols);
    socket.__captureKind = kind;
    sockets.add(socket);
    socket.addEventListener("open", () => mark(`data-capture-ws-${kind}`, "open"));
    socket.addEventListener("close", () => { sockets.delete(socket); mark(`data-capture-ws-${kind}`, "closed"); });
    return socket;
  }
  CaptureWebSocket.prototype = NativeWS.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) CaptureWebSocket[k] = NativeWS[k];
  window.WebSocket = CaptureWebSocket;
  // detail is a JSON string: object details do not survive a world boundary.
  window.addEventListener("capture:frames", (event) => {
    const { kind, frames } = JSON.parse(event.detail);
    for (const socket of sockets) {
      if (socket.__captureKind !== kind || socket.readyState !== 1) continue;
      for (const frame of frames) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }
  });

  // Last, so a shim that threw anywhere above boots the app UNPAIRED rather
  // than paired-and-unstubbed.
  if (cfg.token === null) localStorage.removeItem("omp-remote-token");
  else localStorage.setItem("omp-remote-token", cfg.token);
  for (const [k, v] of Object.entries(cfg.storage)) localStorage.setItem(k, v);
  mark("data-capture-shim", "ok");
}
