//! Output tokens per second, computed the way omp's own status line does it
//! (pi-coding-agent `modes/components/status-line/token-rate.ts`): output
//! tokens over the time since the assistant message began — `duration` once
//! the message is finished, `now - timestamp` while it streams. Using the same
//! formula means the phone converges on the number the desktop shows.
//!
//! The one thing the phone cannot copy is the live numerator. Anthropic
//! reports `usage.output` only in its final `message_delta`, and the delta wire
//! (src/server/delta.rs) forwards streamed TEXT, never the usage envelope, so a
//! streaming message's `usage.output` is the handful of tokens from
//! `message_start`. The live figure therefore estimates tokens from streamed
//! characters, using a tokens-per-character ratio learned from this session's
//! own finished messages, and the finished figure uses the real count.

import type { UiMessage } from "./messages";

/** omp ignores rates over windows this short; they are noise. */
const MIN_DURATION_MS = 100;
/** ~4 characters per token: the usual English/code figure, used until the session has history. */
const DEFAULT_TOKENS_PER_CHAR = 0.25;
/** Messages this short say more about framing overhead than about the ratio. */
const MIN_CALIBRATION_CHARS = 200;
const CALIBRATION_WINDOW = 20;

/** Characters the model generated for a message: reply, reasoning and tool-call arguments. */
export function generatedChars(message: UiMessage): number {
  let chars = 0;
  for (const part of message.parts) {
    if (part.kind === "text" || part.kind === "thinking") chars += part.text.length;
    else if (part.kind === "tool") {
      if (typeof part.args === "string") chars += part.args.length;
      else if (part.args != null) {
        try {
          chars += JSON.stringify(part.args).length;
        } catch {
          // Unserialisable args contribute nothing rather than breaking the counter.
        }
      }
    }
  }
  return chars;
}

/**
 * Tokens per generated character, from the newest finished assistant messages
 * that carry a real output count. Redacted or summarised reasoning makes
 * visible characters undercount the tokens; calibrating on the same session
 * absorbs that bias instead of pretending it away.
 */
export function tokensPerChar(messages: readonly UiMessage[]): number {
  let tokens = 0;
  let chars = 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < CALIBRATION_WINDOW; i--) {
    const m = messages[i];
    const output = m.usage?.output;
    if (m.role !== "assistant" || typeof output !== "number" || output <= 0) continue;
    const c = generatedChars(m);
    if (c < MIN_CALIBRATION_CHARS) continue;
    tokens += output;
    chars += c;
    seen++;
  }
  if (chars === 0) return DEFAULT_TOKENS_PER_CHAR;
  // Clamp: one pathological message (a huge redacted think) must not make the
  // live counter claim thousands of tokens per second.
  return Math.min(1, Math.max(0.1, tokens / chars));
}

function rate(tokens: number, ms: number): number | null {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(ms) || ms < MIN_DURATION_MS) return null;
  const r = (tokens * 1000) / ms;
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** Live rate of the message currently streaming, or null before it has produced anything. */
export function streamingTokenRate(streaming: UiMessage, ratio: number, nowMs: number): number | null {
  const start = streaming.createdAt?.getTime();
  if (start === undefined) return null;
  // The daemon's `generated` covers thinking and tool args that never arrive as
  // delta text; parts cover full-frame clients. Providers that do stream usage
  // (Cursor, Ollama, Bedrock) beat either estimate.
  const estimate = Math.max(streaming.generated ?? 0, generatedChars(streaming)) * ratio;
  return rate(Math.max(streaming.usage?.output ?? 0, estimate), nowMs - start);
}

/**
 * Rate across a whole turn: every assistant message since the last user
 * message, total output over total generation time. Tool execution sits
 * between those messages and is excluded, so a turn that spent a minute in
 * `cargo build` is not reported as a slow model.
 */
export function turnTokenRate(messages: readonly UiMessage[]): number | null {
  let tokens = 0;
  let ms = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") break;
    const output = m.usage?.output;
    if (typeof output === "number" && output > 0 && typeof m.duration === "number" && m.duration > 0) {
      tokens += output;
      ms += m.duration;
    }
  }
  return rate(tokens, ms);
}

export function formatTokenRate(tokensPerSecond: number): string {
  return `${tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond)} tok/s`;
}
