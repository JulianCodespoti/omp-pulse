
import { looksLikeProviderBody, providerErrorSummary } from "../../domain/turn-errors";

function extractRaw(e: unknown): string {
  let value = e;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object") break;
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) return record.message;
    value = record.error ?? record.detail ?? record.reason;
  }
  return typeof e === "number" || typeof e === "boolean" ? String(e) : "";
}

function stripPidAndCmdline(s: string): string {
  let out = s;
  out = out.replace(/\s*\(pid[^)]*\)\s*/gi, " ");
  out = out.replace(/\bpid\s*\d+\b/gi, " ");
  // strip absolute paths that contain omp (the leaked command line)
  out = out.replace(/\/[^\s]*omp[^\s]*/gi, " ");
  // strip common flag fragments that leak ( --mode rpc --cwd ... )
  out = out.replace(/\s--\w+[^\s]*/g, " ");
  out = out.replace(/\s{2,}/g, " ").trim();
  out = out.replace(/^[,\s:;-]+|[,\s:;-]+$/g, "").trim();
  return out;
}

// Daemon replies often surface as the raw response body, sometimes behind a
// status prefix (`503: {"ok":false,"error":"index unavailable"}`). Pull the
// human field out so no JSON ever reaches the screen.
function unwrapJsonBody(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return raw;
  try {
    const body = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (body !== null && typeof body === "object") {
      const r = body as Record<string, unknown>;
      for (const key of ["error", "message", "detail", "reason"]) {
        const v = r[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      // No human field: the caller falls back to the generic sentence.
      return "";
    }
  } catch {
    // Not JSON after all; fall through with the original text.
  }
  return raw;
}

const UNPAIRED = "This phone is no longer paired. Pair it again.";
const FORBIDDEN = "This device doesn\u2019t have access.";
const UNREACHABLE = "Couldn\u2019t reach your computer.";
const TOO_SLOW = "Your computer took too long to answer.";
const AGENT_STOPPED = "The agent stopped unexpectedly.";
const NO_MODEL = "No model is selected.";
const GENERIC = "Something went wrong. Try again.";
const GONE_SESSION = "That conversation no longer exists.";

// Terse daemon codes that deserve a real sentence. Keys are lowercase, with
// trailing punctuation removed. The git and session rows are the
// `/api/changes` vocabulary (docs: .ref API.md §1).
const KNOWN_ERRORS: Record<string, string> = {
  "index unavailable": "Search is unavailable right now.",
  "search unavailable": "Search is unavailable right now.",
  unauthorized: UNPAIRED,
  "authentication failed": UNPAIRED,
  forbidden: FORBIDDEN,
  "this device is not allowed to perform that operation": FORBIDDEN,
  "not found": "That item no longer exists.",
  "session not found": GONE_SESSION,
  "session file not found": GONE_SESSION,
  "invalid session path": GONE_SESSION,
  "session has not started yet": "This conversation hasn\u2019t started yet.",
  "session has no working directory": "This conversation has no project folder.",
  "working directory no longer exists": "This conversation\u2019s folder no longer exists.",
  "git is not installed on this computer": "Git isn\u2019t installed on your computer.",
  "git timed out": "Git took too long to read the changes.",
  timeout: TOO_SLOW,
  // `/api/new` and `/api/browse` refusals (new-session screen).
  "invalid cwd": "That folder isn\u2019t on your computer anymore.",
  "child pool saturated: every child is busy": "Your computer is busy with other sessions. Try again in a moment.",
  "path outside home": "Only folders in your home folder can be opened.",
  "not a directory": "That isn\u2019t a folder.",
};

// Transport failures as each engine words them: Chromium/WebView ("Failed to
// fetch"), WebKit ("Load failed"), Gecko ("NetworkError when attempting…"),
// React Native style ("Network request failed"), Java/Node socket errors
// relayed by the native shell, and Chromium net error names.
const NETWORK =
  /failed to fetch|load failed|networkerror|network request failed|network error|err_(?:internet_disconnected|connection_\w+|name_not_resolved|network_changed|address_unreachable)|unknownhost|enotfound|econnrefused|econnreset|ehostunreach|enetunreach|host is unreachable|connection (?:refused|reset|failed)/i;
const TIMEOUT = /timed? ?out\b|\btimeout\b|deadline exceeded/i;
// The daemon's words for a dead or unopenable omp child: `agent process
// <why>` (exited, open failure, not running, terminated (…)), the channel
// closing under it, and the kill reason on its own.
const AGENT_DEATH =
  /agent process\b|rpc channel closed|\bopen failure\b|child (?:exited|terminated|died)|sidecar exited/i;

/**
 * The daemon's notice that a session's agent process died or is gone:
 * "agent process exited", "agent process terminated (open failure)", "agent
 * process not running", "… ended during boot", or a request cut off by it
 * ("rpc channel closed (agent process terminated)"). The parenthetical is a
 * daemon-internal reason that means nothing to the reader; the chat
 * header shows "Stopped" while this notice is up.
 */
export function isAgentStoppedError(raw: string | null | undefined): boolean {
  const text = raw?.trim() ?? "";
  return /^agent process (exited|terminated|not running|ended)\b/i.test(text)
    || /^rpc channel closed \(agent process terminated\)$/i.test(text);
}

function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function sentence(s: string): string {
  const t = sentenceCase(s);
  return /[.!?\u2026]$/.test(t) ? t : `${t}.`;
}

/**
 * Text that is a program talking to itself, not a person: stack frames,
 * exception class prefixes, leftover JSON, bare status lines, multi-line
 * dumps. Shown verbatim it reads as a crash, so it becomes the generic line.
 */
function looksRaw(s: string): boolean {
  return (
    s.length > 240 ||
    /[\r\n]/.test(s) ||
    /[{}]|\[object /.test(s) ||
    /\bat \S+ \(|\.(?:m?js|tsx?|rs|java|kt):\d+/.test(s) ||
    // A filesystem path is the computer's insides, never copy for a person.
    /(?:^|[\s"'(])(?:~\/|\/(?:home|Users|tmp|var|root|etc)\/|[A-Za-z]:\\)|\S\.jsonl?\b/.test(s) ||
    /^[A-Z]\w*(?:Error|Exception)\b/.test(s) ||
    /^HTTP \d{3}\b/.test(s)
  );
}

function statusOf(e: unknown): number | null {
  if (e === null || typeof e !== "object") return null;
  const status = (e as Record<string, unknown>).status;
  return typeof status === "number" ? status : null;
}

function nameOf(e: unknown): string {
  if (e === null || typeof e !== "object") return "";
  const name = (e as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
}

function gitFailure(raw: string): string | null {
  const m = raw.match(/^git [\w -]+ failed:\s*([\s\S]*)$/i);
  if (!m) return null;
  const detail = m[1] ?? "";
  if (/dubious ownership|safe\.directory/i.test(detail))
    return "Git doesn\u2019t trust this folder. Mark it as a safe directory on your computer.";
  if (/not a git repository/i.test(detail)) return "This folder isn\u2019t a git repository.";
  return "Git couldn\u2019t read this repository.";
}

function byStatus(status: number | null): string | null {
  if (status === 401) return UNPAIRED;
  if (status === 403) return FORBIDDEN;
  if (status === 404) return "That item no longer exists.";
  if (status === 408 || status === 504) return TOO_SLOW;
  if (status !== null && status >= 500) return "Your computer ran into a problem. Try again.";
  return null;
}

export type DaemonErrorCause = "model" | "provider-auth" | "pairing" | "access" | "connection" | "runtime" | "ownership";

/** Classify the original failure, before human wording discards codes or stderr. */
export function daemonErrorCause(error: unknown): DaemonErrorCause | undefined {
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const nested = record?.error !== null && typeof record?.error === "object" ? record.error as Record<string, unknown> : undefined;
  const code = [record?.code, nested?.code, nested?.type].find(value => typeof value === "string") ?? "";
  const message = extractRaw(error).trim();
  const original = code ? `${code}: ${message}` : message;
  const raw = unwrapJsonBody(message).trim();
  const name = nameOf(error);
  // These classes are transport/device authentication, never model credentials.
  if (name === "AuthError") return "pairing";
  if (name === "ForbiddenError") return "access";
  // Specific boot/provider causes beat a generic child exit or HTTP status.
  if (/no[_ ]default[_ ]model[_ ]selected|no model (?:is )?selected|no model to use yet/i.test(original)) return "model";
  if (/authentication_error|invalid_api_key|invalid (?:x-api-key|api key)|(?:no|missing) api key|api key (?:is )?(?:missing|invalid|expired)|(?:oauth|access|refresh|authentication) token (?:has )?(?:expired|invalid)|not logged in to (?:the )?provider|sign in to (?:a|the) provider|model provider needs you to sign in/i.test(original)) return "provider-auth";
  if (/session_owned_by_terminal|collab-hosted|connect via \/collab|run \/collab/i.test(original)) return "ownership";
  if (code === "unauthorized" || code === "authentication_failed" || /^(?:unauthorized|authentication failed)\.?$/i.test(raw) || statusOf(error) === 401
    || /no longer paired/i.test(raw)) return "pairing";
  if (code === "forbidden" || /^(?:forbidden|this device is not allowed to perform that operation)\.?$/i.test(raw)
    || statusOf(error) === 403 || /this device doesn.t have access/i.test(raw)) return "access";
  if (NETWORK.test(original) || TIMEOUT.test(original) || name === "TimeoutError"
    || /couldn.t reach your computer|computer took too long to answer/i.test(raw)) return "connection";
  if (/failed to spawn|runtime (?:is )?(?:not installed|missing|unavailable)|omp (?:is )?not installed/i.test(original)) return "runtime";
  return undefined;
}

/**
 * The refusal shown when the daemon named no reason: the manual path is the
 * one remedy that always works, so the message carries it instead of leaving
 * the user with a dead end ("open it on the computer" — where it already is).
 * One constant because several call sites (send, resend, fork, rename, slash
 * command) must not drift into hand-written variants of the same sentence.
 */
export const NO_REASON_OWNED =
  "This session is open on your computer, so it can\u2019t be controlled from here. Run /collab there to share it.";

/** The pre-hold pool refusal (and a bare busy code), however worded. */
const AGENTS_BUSY = /child pool saturated|every child is busy|^agents_busy$/i;

/**
 * Every error a person reads goes through here. Known shapes become one plain
 * sentence about "your computer" or "the agent"; anything that still looks
 * like program output becomes the generic line, so a raw stack, JSON body or
 * engine message ("Failed to fetch") never reaches the screen.
 */
export function humanizeDaemonError(e: unknown): string {
  const cause = daemonErrorCause(e);
  if (cause === "model") return NO_MODEL;
  if (cause === "provider-auth") return "Your model provider needs you to sign in again.";
  const name = nameOf(e);
  if (name === "ForbiddenError") return FORBIDDEN;
  if (name === "AuthError") return UNPAIRED;
  if (name === "TimeoutError") return TOO_SLOW;
  if (name === "AbortError") return "The request was cancelled.";

  const original = extractRaw(e).trim();
  if (AGENTS_BUSY.test(original)) return "Your computer is busy with other sessions. Try again in a moment.";
  const raw = unwrapJsonBody(original).trim();
  if (!raw) return byStatus(statusOf(e)) ?? GENERIC;
  const known = KNOWN_ERRORS[raw.toLowerCase().replace(/[.\s]+$/, "")];
  if (known) return known;
  if (/session header is missing|malformed|file was not modified/i.test(raw)) return "This chat\u2019s file couldn\u2019t be read.";

  // Ownership specifically — must never leak pid or command line
  if (raw.includes("session_owned_by_terminal")) {
    const m = raw.match(/^session_owned_by_terminal:\s*([\s\S]*)$/);
    let after = m ? m[1].trim() : raw.replace(/session_owned_by_terminal/g, "").trim();
    after = after.replace(/^[:\s,;-]+/, "").trim();
    after = stripPidAndCmdline(after);
    // Preserve the daemon's already-human collab messages (bash + generic write-path)
    if (/collab-hosted|connect via \/collab|run the command in the desktop|change this setting in the desktop/i.test(after)) {
      return after;
    }
    // The daemon appends WHY automatic sharing failed after the guard
    // boilerplate: `… (pid N, …) — auto-sharing failed: <reason>`. The
    // boilerplate is the part that reads as "go open it on the desktop" —
    // exactly what the user just did before tapping send — so the reason is
    // the only part worth showing. Rendering the generic sentence instead is
    // the reported complaint verbatim: "it just says this conversation is
    // held on my desktop", while the laptop's collab box is open on screen.
    const failure = after.match(/auto-sharing failed:\s*([\s\S]+)$/i);
    if (failure?.[1]?.trim()) {
      return `This session is open on your computer, and automatic sharing failed: ${failure[1].trim()}`;
    }
    if (/session file is held open|held open by another/i.test(after) || after.length < 24) {
      return NO_REASON_OWNED;
    }
    if (after) return after;
    return NO_REASON_OWNED;
  }

  const git = gitFailure(raw);
  if (git) return git;
  if (NETWORK.test(raw)) return UNREACHABLE;
  // Specific setup causes were classified before generic child death above.
  if (AGENT_DEATH.test(raw)) return AGENT_STOPPED;
  if (/failed to spawn/i.test(raw)) return "Couldn\u2019t start the agent.";
  if (TIMEOUT.test(raw)) return TOO_SLOW;
  // A script fault (undefined property, bad JSON) says nothing a person can
  // act on; only its network flavour, matched above, does.
  if (/^(?:TypeError|SyntaxError|RangeError|ReferenceError)$/.test(name)) return GENERIC;
  // A server-side failure's own words ("device registry unavailable") are
  // the computer describing its insides; only a known entry above beats the
  // plain status sentence.
  const status = statusOf(e);
  if (status !== null && status >= 500) return byStatus(status) ?? GENERIC;

  // Any other snake_case prefix — strip code, keep human remainder
  let text = raw;
  const snake = raw.match(/^([a-z][a-z0-9_]*):\s*([\s\S]*)$/);
  if (snake?.[1]?.includes("_")) {
    text = stripPidAndCmdline(snake[2].trim()).replace(/\bpid\b.*/i, "").trim();
  } else if (/\bpid\b/i.test(raw) && /omp/i.test(raw)) {
    // Generic pid/cmdline leak without prefix — clean it
    text = stripPidAndCmdline(raw);
    if (/session file is held open/i.test(text)) return NO_REASON_OWNED;
  }
  if (!text || looksRaw(text)) return byStatus(statusOf(e)) ?? GENERIC;
  return sentence(text);
}

/**
 * A command receipt's `error` field, safe for a toast.
 *
 * The receipt is the daemon's own refusal text, so when a desktop terminal owns
 * the session it is the guard's line — pid and command line included. Every
 * surface that shows a receipt therefore goes through the humanizer, and the
 * fallback keeps a receipt that carried no text from rendering as "undefined"
 * (`humanizeDaemonError` stringifies what it is given).
 */
export function humanizeReceiptError(
  error: string | null | undefined,
  fallback = "Command failed",
): string {
  if (!error) return fallback;
  const cause = daemonErrorCause(error);
  if (cause === "model" || cause === "provider-auth") return humanizeDaemonError(error);
  // A turn error carries the provider's raw body (`403 {"error":{…}}`, an
  // HTML page); only its message is worth reading.
  const body = error.replace(/^[a-z][a-z0-9_]*:\s*/, "");
  return looksLikeProviderBody(body) ? providerErrorSummary(body) : humanizeDaemonError(error);
}

