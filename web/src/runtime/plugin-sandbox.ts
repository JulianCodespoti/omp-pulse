import { PLUGIN_WORKER_PRELUDE } from "./plugin-worker-prelude";

/**
 * The isolation boundary around one plugin script.
 *
 * A hidden `<iframe sandbox="allow-scripts">` (no other token: its origin is
 * opaque, so it reaches neither this page's storage nor its credentials) shows
 * a `blob:` document built here. The document carries a CSP that allows one
 * nonce'd first-party bootstrap script and `blob:` workers, nothing else. The
 * bootstrap never evaluates plugin text; it starts a `blob:` Worker from the
 * source this module sends it and relays messages over a `MessagePort`. In that
 * worker `fetch`, XHR, WebSocket, `importScripts(url)`, dynamic `import`,
 * `eval`, storage and the page's DOM are all unavailable, and `terminate()`
 * stops an infinite loop without touching this page.
 *
 * `srcdoc` is not used (the frame cannot be messaged in our test browser) and
 * neither is `script-src 'self'` (it would let the worker `importScripts` from
 * the daemon's origin).
 */

export interface PluginSandboxOptions {
  /** The plugin's script text; it is only ever handed to the worker. */
  script: string;
  /** A message from the worker, parsed from JSON. Untrusted: check its shape. */
  onMessage(message: unknown): void;
  /** The worker raised an uncaught error, or the frame never answered. Called at most once. */
  onFailure(reason: string): void;
}

export interface PluginSandbox {
  /** Send a structured-cloneable message to the worker. Ignored after `dispose`. */
  post(message: unknown): void;
  /** Stop the worker and remove the frame. Safe to call twice. */
  dispose(): void;
}

/** A worker-to-host message longer than this is dropped by the bootstrap. */
const MAX_WORKER_MESSAGE_CHARS = 131072;
const FRAME_ANSWER_TIMEOUT_MS = 5000;
const PORT_HANDOFF = "omp-pulse-plugin-port";
/** The failure reason for a worker message that is not bounded JSON text. */
const INVALID_MESSAGE = "The plugin sent an invalid message";

// INVARIANT (Android): the shell injects `window.OmpLocal` and `window.OmpNative`
// into every frame, including this one, and trusts by main-frame URL. Plugin text
// must therefore never be evaluated on the frame's main thread, only inside the
// worker. Nothing below may call eval, new Function, import(), or put plugin
// text in a script element.
//
// Wire format over the port. Frame to host: a STRING is a relayed worker
// message (the only thing the worker can produce); an object is a bootstrap
// control message ({ c: "ready" } or { c: "error", message }). A worker cannot
// forge a control message because the bootstrap relays only strings.
// Host to frame: { c: "boot", source } once, { c: "w", d } to forward to the
// worker, { c: "stop" } to terminate it.
const BOOTSTRAP = String.raw`"use strict";
// INVARIANT (Android): the shell injects window.OmpLocal and window.OmpNative into
// every frame, including this one, and trusts by main-frame URL. Plugin text must
// therefore never be evaluated on this thread, only inside the worker it starts.
(function () {
  var MAX = __MAX__;
  var port = null;
  var worker = null;
  var workerUrl = null;

  function control(message) {
    if (port !== null) port.postMessage(message);
  }
  function stop() {
    if (worker !== null) { worker.terminate(); worker = null; }
    if (workerUrl !== null) { URL.revokeObjectURL(workerUrl); workerUrl = null; }
  }
  function boot(source) {
    if (worker !== null || typeof source !== "string") return;
    try {
      workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
    } catch (error) {
      control({ c: "error", message: String(error && error.message ? error.message : error).slice(0, 500) });
      return;
    }
    // Anything but a string within the cap is hostile (the prelude never sends it).
    // Stopping here, not skipping, keeps a flood of bad messages from being free.
    function reject() {
      stop();
      control({ c: "error", message: "__INVALID__" });
    }
    worker.onmessage = function (event) {
      var data = event.data;
      if (typeof data !== "string" || data.length > MAX) { reject(); return; }
      port.postMessage(data);
    };
    worker.onmessageerror = reject;
    worker.onerror = function (event) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      var text = event && typeof event.message === "string" ? event.message : "The plugin script failed";
      control({ c: "error", message: text.slice(0, 500) });
    };
  }
  function fromHost(event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.c === "boot") boot(message.source);
    else if (message.c === "w") { if (worker !== null) worker.postMessage(message.d); }
    else if (message.c === "stop") stop();
  }

  window.addEventListener("message", function (event) {
    if (port !== null || event.source !== window.parent || event.data !== "__HANDOFF__") return;
    if (!event.ports || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = fromHost;
    control({ c: "ready" });
  });
})();
`;

function bootstrapText(): string {
  return BOOTSTRAP.replace("__MAX__", String(MAX_WORKER_MESSAGE_CHARS))
    .replace("__HANDOFF__", PORT_HANDOFF)
    .replace("__INVALID__", INVALID_MESSAGE);
}

function freshNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // base64url: no character that could close the attribute or the CSP source.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function frameHtml(nonce: string): string {
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' blob:; worker-src blob:; connect-src 'none'`;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `</head><body><script nonce="${nonce}">${bootstrapText()}</` +
    "script></body></html>"
  );
}

export function createPluginSandbox(options: PluginSandboxOptions): PluginSandbox {
  let disposed = false;
  let failed = false;
  let answered = false;
  let handedOff = false;
  let timer: number | null = null;

  const channel = new MessageChannel();
  const port = channel.port1;
  const frameUrl = URL.createObjectURL(new Blob([frameHtml(freshNonce())], { type: "text/html" }));
  const iframe = document.createElement("iframe");
  // Only allow-scripts: no allow-same-origin (opaque origin), forms, popups or top navigation.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.hidden = true;

  const fail = (reason: string) => {
    if (disposed || failed) return;
    failed = true;
    options.onFailure(reason);
  };

  port.onmessage = (event: MessageEvent) => {
    // After a failure nothing more is parsed: the page must not keep paying for a hostile worker.
    if (disposed || failed) return;
    const data: unknown = event.data;
    if (typeof data === "string") {
      // Everything the prelude sends is valid JSON under the cap, so anything else is
      // hostile. It FAILS the plugin rather than being dropped: a silent drop would
      // sit outside the host's flood limit, which only counts parsed messages.
      if (data.length > MAX_WORKER_MESSAGE_CHARS) {
        fail(INVALID_MESSAGE);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        fail(INVALID_MESSAGE);
        return;
      }
      options.onMessage(parsed);
      return;
    }
    if (data === null || typeof data !== "object") return;
    const control = data as { c?: unknown; message?: unknown };
    if (control.c === "ready") {
      answered = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    } else if (control.c === "error") {
      fail(typeof control.message === "string" && control.message ? control.message.slice(0, 500) : "The plugin script failed");
    }
  };

  iframe.addEventListener("load", () => {
    const frameWindow = iframe.contentWindow;
    if (disposed || handedOff || !frameWindow) return;
    handedOff = true;
    // The handoff is the only message the frame accepts; "*" is required because
    // the frame's origin is opaque. Nothing secret crosses it: just the port.
    frameWindow.postMessage(PORT_HANDOFF, "*", [channel.port2]);
    port.postMessage({ c: "boot", source: `${PLUGIN_WORKER_PRELUDE}\n${options.script}` });
  });

  timer = window.setTimeout(() => {
    timer = null;
    if (!answered) fail("The plugin sandbox did not start in time");
  }, FRAME_ANSWER_TIMEOUT_MS);

  iframe.src = frameUrl;
  document.body.appendChild(iframe);

  return {
    post(message: unknown): void {
      if (disposed) return;
      try {
        port.postMessage({ c: "w", d: message });
      } catch {
        // Not cloneable: the host only sends plain data, so there is nothing to deliver.
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      // Ask the bootstrap to terminate the worker first; removing the frame ends it regardless.
      try {
        port.postMessage({ c: "stop" });
      } catch {
        // The port is closed below either way.
      }
      iframe.remove();
      URL.revokeObjectURL(frameUrl);
      port.close();
    },
  };
}
