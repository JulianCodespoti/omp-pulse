/**
 * Deep-link fragment parser for `#s=<encodedSessionPath>&q=<reqId>`.
 *
 * Session routes can accompany a one-use `pair=` enrollment code. The
 * enrollment parser removes only that code; this parser reads the target.
 * Native URLEncoder uses '+' for spaces, so URLSearchParams (not raw
 * decodeURIComponent) must decode the fragment values.
 */

export interface DeepLink {
  sessionPath: string;
  reqId?: string;
  kind?: string;
}

/**
 * Parse `location.hash` for a deep link. Returns `null` when absent or
 * malformed (e.g. `s=` empty).
 */
export function readDeepLink(): DeepLink | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const sessionPath = params.get("s");
  if (!sessionPath) return null;
  const link: DeepLink = { sessionPath };
  const reqId = params.get("q");
  const kind = params.get("k");
  if (reqId) link.reqId = reqId;
  if (kind) link.kind = kind;
  return link;
}

/**
 * `#new=1`: the Android widget's "New chat" button, as a boot or warm link.
 * A `location.hash` assignment fires popstate before hashchange, and App reads
 * popstate as Back, so App must not treat a pending new-chat link as one.
 */
export function readNewChatLink(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.hash.slice(1)).get("new") === "1";
}

/**
 * Take the new-chat link: true once, and the fragment is gone so the next tap
 * is a fresh change. History state is kept; only the URL is rewritten.
 */
export function consumeNewChatLink(): boolean {
  if (!readNewChatLink()) return false;
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    // history unavailable in some embedded contexts — ignore
  }
  return true;
}
