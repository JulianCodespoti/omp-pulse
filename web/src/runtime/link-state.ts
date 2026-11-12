/**
 * Whether the daemon on your computer can be reached, as one shared fact.
 *
 * It is a by-product of traffic the app already has, not a poll of its own:
 * every daemon request reports how it ended (see `fetchWithDeadline`), and the
 * session sockets report each frame they hear. The only request made for this
 * purpose is `probeLink`, and only when something says the link may be gone: a
 * socket closed or went silent, or a request has been pending for seconds.
 * Recovery needs no probing at all, because the sockets' own reconnect backoff
 * and the listing poll keep dialling and the first reply flips the state back.
 *
 * Why it exists: the UI used to infer "can't reach your computer" from the
 * text of the last error (`failed to fetch`). A request that timed out, or a
 * dead daemon behind a live Tailscale Serve, matched nothing, so both read as
 * "Connected" over a skeleton that never resolved.
 *
 *  - `live`        something answered, or a socket delivered a frame
 *  - `unreachable` nothing answered: a network error or a timeout. The phone's
 *                  Tailscale is off, or the computer is asleep or off.
 *  - `daemon-down` a proxy answered with a gateway error that is not the
 *                  daemon's own JSON: the computer is up, omp-pulse is not.
 */
export type LinkKind = "live" | "unreachable" | "daemon-down";

export interface LinkState {
  readonly kind: LinkKind;
  /** When the state last changed. */
  readonly since: number;
  /** The last moment anything answered; `null` if nothing has this session. */
  readonly lastLiveAt: number | null;
}

const PROBE_TIMEOUT_MS = 4_000;
const PROBE_MIN_GAP_MS = 3_000;

let origin: string | null = null;
let lastOkAt: number | null = null;
let lastProbeAt = 0;
let probing: Promise<LinkKind> | null = null;
let state: LinkState = { kind: "live", since: Date.now(), lastLiveAt: null };
const listeners = new Set<() => void>();

export function getLinkState(): LinkState {
  return state;
}

export function subscribeLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The daemon the probe asks. Set by the controller from its own base URL. */
export function setLinkOrigin(next: string): void {
  origin = next.replace(/\/$/, "");
}

function enter(kind: LinkKind): void {
  if (state.kind === kind) return;
  const now = Date.now();
  state = { kind, since: now, lastLiveAt: kind === "live" ? now : lastOkAt };
  for (const listener of [...listeners]) listener();
}

/** Something answered. Cheap enough to call on every socket frame. */
export function reportLinkOk(): void {
  lastOkAt = Date.now();
  enter("live");
}

/**
 * A gateway error without the daemon's JSON body comes from the proxy in front
 * of it. The daemon's own 5xx answers (`{"ok":false,"error":"index
 * unavailable"}`) prove it is running.
 */
export function linkKindOfResponse(response: { status: number; headers?: Headers }): LinkKind {
  const status = response.status;
  if (status !== 502 && status !== 503 && status !== 504) return "live";
  const type = response.headers?.get("content-type") ?? "";
  return /json/i.test(type) ? "live" : "daemon-down";
}

export function reportLinkResponse(response: { status: number; headers?: Headers }): void {
  const kind = linkKindOfResponse(response);
  if (kind === "live") reportLinkOk();
  else enter(kind);
}

/** A request that never got an answer. A caller's own abort says nothing. */
export function reportLinkError(error: unknown): void {
  if (error instanceof DOMException && error.name === "TimeoutError") enter("unreachable");
  else if (error instanceof TypeError) enter("unreachable");
}

/**
 * One short request to find out why the link looks gone. Shared by every
 * caller while one is in flight, and spaced so a flapping socket cannot turn
 * it into a poll. `force` is for a person tapping Retry.
 */
export function probeLink(force = false): Promise<LinkKind> {
  if (probing) return probing;
  if (origin === null) return Promise.resolve(state.kind);
  if (!force && Date.now() - lastProbeAt < PROBE_MIN_GAP_MS) return Promise.resolve(state.kind);
  lastProbeAt = Date.now();
  const target = new URL("/api/version", `${origin}/`);
  probing = (async () => {
    try {
      const response = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      void response.body?.cancel().catch(() => undefined);
      reportLinkResponse(response);
    } catch (error) {
      reportLinkError(error);
    } finally {
      probing = null;
    }
    return state.kind;
  })();
  return probing;
}

let chatSocketDownSince: number | null = null;

/**
 * The chat socket's own transitions, for the indicator's grace. "down" keeps
 * the first time it was recorded across retries (a retry's "connecting" must
 * not restart the clock, or a dead link flickers); "open" and "none" (no chat)
 * clear it.
 */
export function reportChatSocket(socket: "open" | "down" | "none"): void {
  const next = socket === "down" ? (chatSocketDownSince ?? Date.now()) : null;
  if (next === chatSocketDownSince) return;
  chatSocketDownSince = next;
  for (const listener of [...listeners]) listener();
}

export function getChatSocketDownSince(): number | null {
  return chatSocketDownSince;
}
