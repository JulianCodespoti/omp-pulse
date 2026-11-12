//! Typed adapters for omp's run-status events: the auto-retry backoff,
//! auto-compaction and thinking-level changes (upstream
//! `session/agent-session-events.ts`). Before these existed the phone dropped
//! all of them, so a provider hiccup or a long compaction looked like a hung
//! app. Every field is parsed defensively: an event from an older or newer omp
//! with a missing or odd field degrades the retry row (`retrying`, without a
//! count or countdown), never shows a bogus number.

import { providerErrorSummary } from "./turn-errors";

/** omp is waiting out a retry backoff. `resumeAt` is local epoch ms. */
export interface RetryStatus {
  readonly attempt: number | null;
  readonly maxAttempts: number | null;
  readonly resumeAt: number | null;
  /** The provider error that triggered the retry, raw. */
  readonly error: string | null;
}

/** omp is compacting context on its own (threshold, overflow, idle, …). */
export interface CompactingStatus {
  readonly reason: string | null;
}

// A backoff longer than this is a clock or wire error, not a countdown.
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function parseRetryStart(event: Readonly<Record<string, unknown>>, now: number): RetryStatus {
  const attempt = typeof event.attempt === "number" && Number.isSafeInteger(event.attempt) && event.attempt >= 1 ? event.attempt : null;
  const max = typeof event.maxAttempts === "number" && Number.isSafeInteger(event.maxAttempts) && event.maxAttempts >= 1 ? event.maxAttempts : null;
  const delay = event.delayMs;
  const resumeAt = typeof delay === "number" && Number.isFinite(delay) && delay >= 0 && delay <= MAX_RETRY_DELAY_MS
    ? now + delay : null;
  return {
    attempt,
    // "attempt 6 of 5" would read as a bug; drop the bound instead.
    maxAttempts: max !== null && attempt !== null && attempt > max ? null : max,
    resumeAt,
    error: text(event.errorMessage),
  };
}

export function parseCompactionStart(event: Readonly<Record<string, unknown>>): CompactingStatus {
  return { reason: text(event.reason) };
}

/**
 * The selected setting, never the per-turn resolution. OMP reports
 * `configured: "auto"` whenever Auto owns the concrete effort.
 */
export function parseThinkingLevelChanged(event: Readonly<Record<string, unknown>>): string | null {
  return text(event.configured) ?? text(event.thinkingLevel);
}

/** OMP's concrete effort for this turn; it must not replace the selector. */
export function parseEffectiveThinkingLevel(event: Readonly<Record<string, unknown>>): string | null {
  return text(event.thinkingLevel);
}

/**
 * Whether the phone may cancel a backoff for a session with this owner kind.
 * Only the daemon's own child can: a desktop owner refuses abort_retry at the
 * ownership gate, and its Stop already cancels omp's retry. Unreported
 * ownership keeps the option (the daemon answers either way).
 */
export function canCancelRetry(ownerKind: string | undefined): boolean {
  return ownerKind === undefined || ownerKind === "child";
}

/**
 * Time left in the backoff (`8s`, `1m 5s`), or null when unknown or elapsed:
 * at zero omp is already re-sending, so the retry row drops the countdown
 * rather than showing a stale `0s`.
 */
export function retryCountdown(retry: RetryStatus, now: number): string | null {
  if (retry.resumeAt === null) return null;
  const seconds = Math.ceil((retry.resumeAt - now) / 1000);
  if (seconds <= 0) return null;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** `Retrying in 8s · attempt 2 of 5`, or null once the countdown has elapsed. */
export function retryLabel(retry: RetryStatus, now: number): string | null {
  const countdown = retryCountdown(retry, now);
  // At zero omp is already re-sending; the normal running line says more.
  if (retry.resumeAt !== null && countdown === null) return null;
  const head = countdown === null ? "Retrying…" : `Retrying in ${countdown}`;
  if (retry.attempt === null) return head;
  return `${head} · attempt ${retry.attempt}${retry.maxAttempts !== null ? ` of ${retry.maxAttempts}` : ""}`;
}

const MAX_ERROR_CHARS = 140;

/** One short human line for the provider error behind a retry. */
export function humanizeProviderError(raw: string | null): string | null {
  if (!raw) return null;
  const message = providerErrorSummary(raw).replace(/\s+/g, " ").trim();
  if (!message) return null;
  const all = `${raw} ${message}`;
  if (/rate.?limit|too many requests|\b429\b/i.test(all)) return "The provider is rate limiting requests";
  if (/overloaded|\b529\b/i.test(all)) return "The provider is overloaded";
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(all)) return "The provider took too long to answer";
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|network error/i.test(all)) return "Couldn't reach the provider";
  const status = all.match(/\b(5\d\d)\b/);
  if (status || /internal server error|bad gateway|service unavailable/i.test(all)) {
    return status ? `The provider had an error (${status[1]})` : "The provider had an error";
  }
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…` : message;
}
