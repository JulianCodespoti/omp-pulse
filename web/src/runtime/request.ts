import { probeLink, reportLinkError, reportLinkResponse } from "./link-state";

// A deadline covers headers AND body consumption. Clearing a timer as soon as
// fetch resolves leaves a stalled JSON body holding the same loading locks.
const READ_TIMEOUT_MS = 20_000;
// A request still waiting after this long asks the link whether the computer
// is there at all, so a dead link is named in seconds, not at the 20 s read
// deadline. Writes arm it too: a send into a dead link said "Sending…" for
// 45 s because only reads asked.
const SLOW_REQUEST_MS = 3_000;

export function readRequestSignal(signal?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(READ_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Every daemon request ends here, so each one is evidence about the link. */
export async function fetchWithDeadline(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const read = method === "GET" || method === "HEAD";
  const slow = setTimeout(() => void probeLink(), SLOW_REQUEST_MS);
  try {
    const response = await fetch(input, read ? { ...init, signal: readRequestSignal(init.signal) } : init);
    reportLinkResponse(response);
    return response;
  } catch (error) {
    reportLinkError(error);
    throw error;
  } finally {
    clearTimeout(slow);
  }
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    // Non-JSON error pages still report their HTTP status. A cancelled or timed
    // out body must reject, never masquerade as a successful empty response.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
