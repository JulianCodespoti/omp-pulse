import { readPairingToken } from "./browser-storage";

let registered = false;
let swRegistration: ServiceWorkerRegistration | null = null;

export type OpenMessage = {
  sessionPath: string;
  reqId?: number | string;
  kind?: string;
};
export type OpenHandler = (msg: OpenMessage) => void;

const openHandlers = new Set<OpenHandler>();
const pendingOpenMessages: OpenMessage[] = [];

function dispatchOpen(msg: OpenMessage): void {
  if (openHandlers.size === 0) {
    // A warm notification can arrive while register() is still awaiting the
    // service-worker handshake. Queue it so the first App listener cannot
    // miss the conversation tap.
    pendingOpenMessages.push(msg);
    return;
  }
  for (const h of openHandlers) {
    try {
      h(msg);
    } catch {
      // handler threw — ignore
    }
  }
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registered) return swRegistration;
  // Skip in dev — Vite's HMR and the dev server already handle reloads.
  const rawMeta: unknown = import.meta;
  if (rawMeta !== null && typeof rawMeta === "object" && "env" in rawMeta) {
    const envCandidate: unknown = rawMeta.env;
    if (
      envCandidate !== null &&
      typeof envCandidate === "object" &&
      "DEV" in envCandidate
    ) {
      const devVal: unknown = envCandidate.DEV;
      if (devVal === true) return null;
    }
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
    return null;
  if (
    !(typeof window !== "undefined" && window.isSecureContext) &&
    window.location.hostname !== "localhost"
  )
    return null;
  registered = true;

  try {
    // The app is served under a base path (`/app/` on the daemon), so a
    // hard-coded `/sw.js` registers at the wrong origin root and the PWA never
    // gets a controller. BASE_URL is `/` for a root deploy and `/app/` here.
    const base = import.meta.env.BASE_URL || "/";
    const reg = await navigator.serviceWorker.register(`${base}sw.js`, {
      scope: base,
    });
    swRegistration = reg;

    // An unpaired page has no draft, turn or image to protect, and no Settings
    // to reach the update button from. It used to stay on its pinned release
    // forever: the phone kept a computer's old pairing page (no way back, a
    // flow the updated computer no longer matched) across every relaunch.
    let applying = false;
    const applyIfUnpaired = () => {
      if (applying || readPairingToken() || !(reg.waiting ?? reg.installing)) return;
      applying = true;
      applyClientUpdate().then(
        () => window.location.reload(),
        () => {
          applying = false;
        },
      );
    };

    // Update flow: call registration.update() when the app becomes visible.
    const maybeUpdate = () => {
      if (document.visibilityState === "hidden") return;
      reg.update().then(applyIfUnpaired, () => {});
    };

    // 1 s after load — catch a newly deployed sw.js without waiting for user interaction.
    window.setTimeout(() => {
      reg.update().then(applyIfUnpaired, () => {});
    }, 1000);

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) maybeUpdate();
    });
    window.addEventListener("focus", maybeUpdate);
    window.addEventListener("pageshow", maybeUpdate);
    window.addEventListener("online", maybeUpdate);

    // A newly installed worker remains waiting until the app explicitly asks
    // to apply it. Never reload from controllerchange: that used to interrupt
    // an active turn and discard a draft/image before the user could save it.

    // Listen for omp-open postMessage from the SW (notification tap warm start).
    navigator.serviceWorker.addEventListener(
      "message",
      (event: MessageEvent) => {
        const data = event.data as unknown;
        if (
          data === null ||
          typeof data !== "object" ||
          !("type" in (data as Record<string, unknown>)) ||
          (data as Record<string, unknown>).type !== "omp-open"
        ) {
          return;
        }
        const rec = data as Record<string, unknown>;
        const sessionPath =
          typeof rec.sessionPath === "string" ? rec.sessionPath : "";
        if (!sessionPath) return;
        const msg: OpenMessage = { sessionPath };
        if (rec.reqId != null) msg.reqId = rec.reqId as number | string;
        if (typeof rec.kind === "string" && rec.kind) msg.kind = rec.kind;
        dispatchOpen(msg);
      },
    );

    return reg;
  } catch {
    registered = false;
    return null;
  }
}

export function onOpenMessage(handler: OpenHandler): () => void {
  openHandlers.add(handler);
  // Drain a tap that arrived before App finished registering its listener.
  while (pendingOpenMessages.length > 0) {
    const msg = pendingOpenMessages.shift();
    if (msg === undefined) break;
    try {
      handler(msg);
    } catch {
      // handler threw — ignore
    }
  }
  return () => {
    openHandlers.delete(handler);
  };
}
/**
 * Explicitly activate the waiting worker. Registration itself never activates
 * a new worker, and this function intentionally does not reload the page:
 * callers choose a safe moment after persisting drafts and pending images.
 */
export async function applyClientUpdate(): Promise<void> {
  const registration = swRegistration ?? (await registerServiceWorker());
  if (registration === null) return;
  await registration.update();
  const worker = registration.waiting ?? registration.installing;
  if (worker === null) return;
  await new Promise<void>((resolve, reject) => {
    let activationRequested = false;
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      worker.removeEventListener("statechange", observe);
      if (error) reject(error);
      else resolve();
    };
    const observe = () => {
      if (worker.state === "activated") {
        finish();
      } else if (worker.state === "redundant") {
        finish(
          new Error(
            "The app update could not be installed. Your current page was kept.",
          ),
        );
      } else if (worker.state === "installed" && !activationRequested) {
        activationRequested = true;
        worker.postMessage({ type: "SKIP_WAITING" });
      }
    };
    const timer = window.setTimeout(
      () =>
        finish(
          new Error("The app update timed out. Your current page was kept."),
        ),
      10_000,
    );
    worker.addEventListener("statechange", observe);
    observe();
  });
}

/**
 * Compare the current app release id against the daemon's release id.
 * Returns true when the daemon reports a different release — the app is stale.
 */
export async function checkAppVersion(
  currentReleaseId: string,
): Promise<boolean> {
  if (!currentReleaseId) return false;
  try {
    const token = readPairingToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch("/api/version", { headers });
    if (!res.ok) return false;
    const body: unknown = await res.json().catch(() => null);
    if (body === null || typeof body !== "object") return false;
    const record = body as Record<string, unknown>;
    const remoteId =
      typeof record.releaseId === "string"
        ? record.releaseId
        : typeof record.build === "string"
          ? record.build
          : typeof record.version === "string"
            ? record.version
            : "";
    return remoteId !== "" && remoteId !== currentReleaseId;
  } catch {
    return false;
  }
}
