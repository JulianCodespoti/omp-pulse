/**
 * How an agent turn's error or stop reads in the transcript.
 *
 * omp writes every provider failure onto the assistant message as
 * `errorMessage`, including the attempts its own auto-retry later replaced,
 * restarts that resumed the turn, and internal rule aborts that re-ran the
 * step. Only some of those are something the user must act on, so the label,
 * tone and next step are chosen here, once, from the message alone.
 */

import { isInternalRerun } from "./timeline";

export interface TurnErrorView {
  label: string;
  /** Danger only when the turn ended on it and the user has to act. */
  tone: "muted" | "danger";
  /** One short line after the label; the raw text stays behind a tap. */
  summary?: string;
  hint?: string;
  /** A different model is the way forward (refusal, usage limit). */
  switchModel?: boolean;
  /** Internal furniture: never rendered, never breaks a run. */
  hidden?: boolean;
  /** Sending the prompt again may go through (provider, network, context). */
  retryable?: boolean;
}

export interface TurnErrorSource {
  errorMessage?: string;
  stopReason?: string;
}

const NETWORK =
  /getaddrinfo|\bE(?:CONN[A-Z]*|TIMEDOUT|TIMEOUT|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)\b|socket (?:connection )?(?:was )?closed|connection error|timed out|fetch failed|network (?:error|is unreachable)/i;
const EXHAUSTED = /^\s*Retry budget exhausted after (\d+) retr(?:y|ies)\s*:?\s*([\s\S]*)$/i;
const USAGE_LIMIT = /usage limit|insufficient_quota|exceeded your (?:current )?quota/i;
const RESET_IN = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/i;
const BY_USER = /\b(?:interrupted|stopped|aborted|cancelled|canceled) by user\b/i;
const CONTEXT = /context|token limit|too many tokens|maximum context/i;

export const NETWORK_HINT = "Check your connection; retries automatically";
export const REFUSAL_NOTE = "The model declined this request.";

/** A model refusal, as the daemon's receipts (`Refusal (…)`) or providers word it. */
export function isRefusalText(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /^\s*(?:agent_(?:failed|refused):\s*)?Refusal\b/i.test(raw) ||
    /flagged for possible (?:cyber)?security risk/i.test(raw);
}

export function isNetworkError(raw: string | null | undefined): boolean {
  return !!raw && NETWORK.test(raw);
}

/** `~6 d`, `~3 h`, `~20 min` from a provider's "Try again in ~8645 min". */
export function usageResetIn(raw: string): string | null {
  const match = raw.match(RESET_IN);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2]!.toLowerCase();
  const minutes = unit.startsWith("s") ? value / 60
    : unit.startsWith("h") ? value * 60
    : unit.startsWith("d") ? value * 1440
    : value;
  if (minutes >= 1440) return `~${Math.round(minutes / 1440)} d`;
  if (minutes >= 60) return `~${Math.round(minutes / 60)} h`;
  return `~${Math.max(1, Math.round(minutes))} min`;
}

/** Pulls the human sentence out of provider boilerplate like
 *  `Error: 400 {"type":"error","error":{"message":"..."}}` or an HTML error page.
 *  The two failures people hit most get plain words; the raw code stays one
 *  tap away under Details. */
export function providerErrorSummary(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("overloaded") || /\b529\b/.test(lower)) return "The model is busy right now. Try again in a moment.";
  if (lower.includes("rate_limit") || lower.includes("rate limit") || /\b429\b/.test(lower)) return "Too many requests. Try again shortly.";
  const quoted = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  if (quoted) return quoted[1]!.replace(/\\"/g, '"').replace(/\\n/g, " ");
  const stripped = raw.replace(/^(?:\s*(?:error|provider error)\s*:?\s*)+/i, "").replace(/^\d{3}\s+/, "").trim();
  if (/^<(?:!doctype|html|head|body)\b/i.test(stripped)) return "The provider sent back an error page.";
  return stripped || raw;
}

/** Whether a raw error carries a provider body rather than a sentence. */
export function looksLikeProviderBody(raw: string): boolean {
  return /^\s*(?:\d{3}\s+)?[{<]/.test(raw) || /"message"\s*:/.test(raw);
}

/**
 * The view for an assistant message's error or stop, or null when it has
 * neither. Retried attempts are grouped by the timeline before they get here.
 */
export function classifyTurnError(message: TurnErrorSource): TurnErrorView | null {
  const raw = message.errorMessage ?? "";
  if (!raw && message.stopReason !== "aborted") return null;
  // A rule match aborts the step and omp re-runs it: the turn never stopped.
  if (isInternalRerun(raw)) return { label: "", tone: "muted", hidden: true };
  if (/previous omp process exited/i.test(raw)) return { label: "Interrupted by a restart", tone: "muted" };
  if (message.stopReason === "aborted" || BY_USER.test(raw)) return { label: "Stopped", tone: "muted" };
  if (isRefusalText(raw)) return { label: "Declined", tone: "muted", summary: REFUSAL_NOTE, switchModel: true };
  if (USAGE_LIMIT.test(raw)) {
    const reset = usageResetIn(raw);
    return { label: reset ? `Usage limit reached · resets in ${reset}` : "Usage limit reached", tone: "danger", switchModel: true };
  }
  const exhausted = raw.match(EXHAUSTED);
  if (exhausted) {
    const cause = exhausted[2] ?? "";
    const network = isNetworkError(cause);
    return {
      label: network ? "Network issue" : "Provider error",
      tone: "danger",
      summary: `Gave up after ${exhausted[1]} retries`,
      hint: network ? "Check your connection, then send again." : undefined,
      retryable: true,
    };
  }
  if (CONTEXT.test(raw)) return { label: "Context limit", tone: "danger", retryable: true };
  if (isNetworkError(raw)) return { label: "Network issue", tone: "muted", hint: NETWORK_HINT, retryable: true };
  return { label: "Provider error", tone: "danger", summary: raw ? providerErrorSummary(raw) : undefined, retryable: true };
}

/**
 * The retry-group caption: `Network issue · retried 3×, recovered`; while omp
 * waits out the backoff, `Provider error · retrying in 8s (2/5)`. An unknown
 * attempt or bound is left out rather than guessed.
 */
export function retryCaption(
  attempts: number,
  network: boolean,
  state: {
    live?: { attempt: number | null; maxAttempts: number | null } | null;
    /** Backoff left (`retryCountdown`); null once elapsed or unknown. */
    countdown?: string | null;
    recovered: boolean;
  },
): string {
  const kind = network ? "Network issue" : "Provider error";
  if (state.live) {
    const { attempt, maxAttempts } = state.live;
    const count = attempt === null ? "" : ` (${attempt}${maxAttempts === null ? "" : `/${maxAttempts}`})`;
    return `${kind} · retrying${state.countdown ? ` in ${state.countdown}` : ""}${count}`;
  }
  const count = `retried ${attempts}×`;
  return state.recovered ? `${kind} · ${count}, recovered` : `${kind} · ${count}`;
}
