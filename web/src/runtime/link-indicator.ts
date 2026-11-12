import type { LinkState } from "./link-state";

/**
 * The one connection verdict the UI shows. It is derived from the link state
 * (what answered) plus how long this chat's socket has been down; the socket's
 * own state machine drove the UI before and flickered on every retry.
 */
export type LinkIndicator =
  | { kind: "ok" }
  /** The computer answers, but this chat's live updates have been down past the grace. */
  | { kind: "connecting" }
  | { kind: "unreachable"; lastLiveAt: number | null }
  | { kind: "daemon-down" }
  /** Unreachable, and the platform also reports no network. */
  | { kind: "offline"; lastLiveAt: number | null };

/** A socket that reopens inside this window never shows as a problem. */
export const LINK_GRACE_MS = 2000;

interface LinkIndicatorInput {
  link: LinkState;
  /** When this chat's socket last stopped being open (or started connecting and has not opened yet); null while open or with no chat. */
  socketDownSince: number | null;
  platformOffline: boolean;
  now: number;
}

/**
 * `unreachable` and `daemon-down` come straight from the link with no grace: a
 * probe that got no answer is a fact. Only a live link waits out the grace
 * before a down socket reads as `connecting`, and a socket's "connecting" state
 * never resets `socketDownSince`, which is what ends the per-retry flicker.
 */
export function linkIndicator(input: LinkIndicatorInput): LinkIndicator {
  const { link, socketDownSince, platformOffline, now } = input;
  if (link.kind === "daemon-down") return { kind: "daemon-down" };
  if (link.kind === "unreachable") {
    return platformOffline
      ? { kind: "offline", lastLiveAt: link.lastLiveAt }
      : { kind: "unreachable", lastLiveAt: link.lastLiveAt };
  }
  if (socketDownSince !== null && now - socketDownSince >= LINK_GRACE_MS) return { kind: "connecting" };
  return { kind: "ok" };
}

/** When the result can next change by time alone (the grace ending), or null. */
export function linkIndicatorChangesAt(input: LinkIndicatorInput): number | null {
  if (input.link.kind !== "live" || input.socketDownSince === null) return null;
  const at = input.socketDownSince + LINK_GRACE_MS;
  return at > input.now ? at : null;
}
