import { parseInterruption, sessionTurn, type OmpInterruption, type OmpSessionSummary } from "../domain/protocol";
import { contextPercent } from "../domain/usage-meter";
import { contextWindowFor } from "../runtime/omp-store";
import type { LinkIndicator } from "../runtime/link-indicator";
import type { LaptopOpened } from "../runtime/rpc-client";

/** Daemon session status values (src/sessions/index.rs). */
export type SessionStatus = "waiting" | "streaming" | "idle" | "unknown";

// INVARIANT: owning an open laptop session is orthogonal to running a turn.
// Canonical turn evidence wins over stale listing status; never alias live
// ownership to streaming (that previously marked every open session busy).
export function sessionStatus(session: OmpSessionSummary): SessionStatus {
  if (session.status === "waiting") return "waiting";
  const turn = sessionTurn(session);
  if (turn === "running") return "streaming";
  return turn === "unknown" && !session.sessionState ? "idle" : turn;
}

/**
 * The laptop already has this conversation: a desktop omp owns the file
 * (`ownerPid` is foreign-only, src/sessions/index.rs), its extension bridges it, or a
 * collab room shares it. `live` alone is not enough: the daemon also sets it
 * for its OWN child mid-turn, which is a phone conversation that simply
 * cannot move until the reply ends.
 */
export function isOnLaptop(session: OmpSessionSummary): boolean {
  const owner = session.sessionState?.owner.kind;
  if (owner === "child" || owner === "none") return false;
  if (owner === "bridge" || owner === "collab" || owner === "foreign") return true;
  if (session.ownerPid != null || session.bridge === true || session.shared === true) return true;
  return session.live === true && sessionStatus(session) !== "streaming";
}

/** Toast after "Open on computer": where to look for it there. */
export function laptopOpenedText(opened: LaptopOpened): string {
  const where = opened.tab.number
    ? `${opened.workspace.label}, tab ${opened.tab.number}`
    : opened.workspace.label;
  return opened.ready
    ? `Opened on your computer in ${where}`
    : `Opened in ${where}. It may still be starting.`;
}

/** What a running turn is doing, in a few words: the list's step line. */
export function activityText(session: OmpSessionSummary): string {
  const now = session.now;
  if (!now) return "Working…";
  if (now.state === "thinking") return "Thinking…";
  if (now.state === "writing") return "Writing…";
  return [now.tool || "Tool", now.label].filter(Boolean).join(" · ");
}

/**
 * `m:ss`, or `h:mm:ss` past an hour. Minutes-only once rendered a stale start
 * as "1427:02" on a running tool; hours keep a long turn readable.
 */
export function activityDuration(startedAt: number | undefined, now = Date.now()): string {
  if (!startedAt) return "0:00";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** `mtime` is milliseconds since the epoch as an f64 (src/sessions/jsonl.rs mtime_millis). */
export function relativeTime(
  mtime: number | undefined,
  now = Date.now(),
): string {
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) return "";
  const seconds = Math.max(0, Math.round((now - mtime) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.round(days / 30)}mo`;
}

/**
 * Last nonempty slash-separated segment, without the `split`/`filter` arrays.
 * An empty path, or one that is all slashes, has no segment and yields
 * `fallback`; a trailing slash is ignored just as the filtered split did.
 * Pure ASCII delimiter search, so unicode segments are returned byte-identical.
 */
function lastPathSegment(path: string, fallback: string): string {
  for (let end = path.length; end > 0; ) {
    const slash = path.lastIndexOf("/", end - 1);
    const segment = path.slice(slash + 1, end);
    if (segment.length > 0) return segment;
    if (slash < 0) break;
    end = slash;
  }
  return fallback;
}

/** Last path segment of the session's working directory — the repo the work lives in. */
export function projectLabel(session: OmpSessionSummary): string {
  const source = session.cwd || session.path;
  return lastPathSegment(source, source);
}

/** The daemon's title for a file with no chosen title and no prompt
 * (src/sessions/jsonl/listing.rs): a chat that was started but never sent. */
const UNSENT_TITLE = "Untitled session";

/** A chat created (a new-chat start, a picked project) that never got a
 * message. ChatGPT never lists those; six of them once filled the drawer as
 * "Untitled session #bb82", "#b472"… */
export function isUnsentChat(session: OmpSessionSummary): boolean {
  return session.title?.trim() === UNSENT_TITLE && !session.snippet?.text?.trim();
}

export function sessionTitle(session: OmpSessionSummary): string {
  const title = session.title?.trim();
  if (title === UNSENT_TITLE) return "New chat";
  return title || projectLabel(session);
}

/**
 * Titles still collide (branches copy the title, and chats started before
 * untitled rows took their first prompt were named after their folder), and
 * two identical rows are how a prompt or a Stop lands in the wrong
 * conversation. When a title occurs more than once, rows show
 * `identityHint` alongside it so the two are told apart.
 */
export function duplicateTitles(
  sessions: readonly OmpSessionSummary[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const title = sessionTitle(s);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }

  const out = new Set<string>();
  for (const [title, n] of counts) if (n > 1) out.add(title);
  return out;
}

/** Short stable distinguisher for a session whose title collides: the session
 * id's last four characters when present, else the session file's own name
 * (never the title). The tail, not the head: ids are UUIDv7, whose leading
 * characters are a timestamp, so sessions from the same days all began
 * "#01a14…" and an 8-character head both failed to tell them apart and took
 * the room the project name needed. */
export function identityHint(session: OmpSessionSummary): string {
  const id = typeof session.id === "string" ? session.id.trim().replace(/-/g, "") : "";
  if (id.length >= 4) return `#${id.slice(-4)}`;
  const last = lastPathSegment(session.path || "", "");
  const stem = last.replace(/\.jsonl$/i, "");
  return stem.length > 10 ? `…${stem.slice(-8)}` : stem || "session";
}

export type SessionGroup = { label: string; sessions: OmpSessionSummary[] };

/**
 * When the conversation last had a real message. The daemon's `activeAt`,
 * never the file mtime: omp appends exit bookkeeping to every session a
 * terminated process held, which made weeks-old chats look brand new.
 * `mtime` remains only as the fallback for an older daemon.
 */
export function activeTime(session: OmpSessionSummary): number {
  const at = Number(session.activeAt ?? session.mtime ?? 0);
  return Number.isFinite(at) ? at : 0;
}

const TRANSPORT_FAILURE = /failed to fetch|load failed|networkerror|network request failed|fetch failed|network error/i;

export function isTransportFailure(error: string | null | undefined): boolean {
  return typeof error === "string" && TRANSPORT_FAILURE.test(error);
}

/** One word per connection verdict: the drawer's computer row and the list say the same thing. */
export const LINK_INDICATOR_LABEL: Record<LinkIndicator["kind"], string> = {
  ok: "Connected",
  connecting: "Connecting…",
  unreachable: "Can’t reach",
  "daemon-down": "Not running",
  offline: "Offline",
};

/**
 * What to call the paired machine. The app is served by the daemon, so the
 * page's host is the computer: `studio.tail1234.ts.net` reads as "studio".
 * An address or localhost names nothing a person recognises. In phone mode
 * the daemon runs on this phone, at 127.0.0.1, and there is no computer.
 * `position` is where the name lands in a sentence: the unnamed fallbacks are
 * capitalised at the start and lower-case inside one ("Can’t reach Your
 * computer" read as a typo).
 */
export function computerName(hostname: string, onPhone = false, position: "start" | "inline" = "start"): string {
  const inline = position === "inline";
  if (onPhone) return inline ? "this phone" : "This phone";
  const unnamed = inline ? "your computer" : "Your computer";
  const host = hostname.trim().toLowerCase();
  if (!host || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return unnamed;
  return host.split(".")[0] || unnamed;
}

/** A MagicDNS name, or an address in the CGNAT range Tailscale hands out (100.64.0.0/10). */
function isTailnetHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host.endsWith(".ts.net")) return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return octets !== null && Number(octets[1]) === 100 && Number(octets[2]) >= 64 && Number(octets[2]) <= 127;
}

/**
 * What to check when the computer does not answer, by how this phone reaches
 * it. Tailscale is named only for a tailnet host: telling someone on a home
 * network to check Tailscale sent them to an app they do not use.
 */
export function linkAdvice(hostname: string, onPhone = false): string {
  if (onPhone) return "Open Settings › Computer to restart it.";
  return isTailnetHost(hostname)
    ? "Check that Tailscale is on and that the computer is awake."
    : "Check that the computer is awake and on the same network.";
}

/**
 * Recency buckets for the history below "Needs you" and "Running": Today,
 * Yesterday, the rest of the past week, then everything earlier.
 */
export function groupSessions(
  sessions: readonly OmpSessionSummary[],
  now = Date.now(),
): SessionGroup[] {
  const dayStart = (daysAgo: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  };
  const [today, yesterday, week] = [dayStart(0), dayStart(1), dayStart(6)];
  const buckets: Record<string, OmpSessionSummary[]> = { Today: [], Yesterday: [], "This week": [], Earlier: [] };
  for (const session of sessions) {
    const at = activeTime(session);
    buckets[at >= today ? "Today" : at >= yesterday ? "Yesterday" : at >= week ? "This week" : "Earlier"].push(session);
  }
  return Object.entries(buckets)
    .map(([label, sessions]) => ({ label, sessions }))
    .filter((group) => group.sessions.length > 0);
}

export function matchesQuery(
  session: OmpSessionSummary,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    (session.id ?? "").toLowerCase().includes(needle) ||
    sessionTitle(session).toLowerCase().includes(needle) ||
    (session.cwd ?? "").toLowerCase().includes(needle) ||
    (session.snippet?.text ?? "").toLowerCase().includes(needle)
  );
}

// ---------------------------------------------------------------------------
// Pins — localStorage['omp-pins'] as JSON array of paths
// ---------------------------------------------------------------------------
const PIN_KEY = "omp-pins";
const SEEN_PREFIX = "omp-seen:";

export function getPinnedPaths(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

export function getPinnedSet(): Set<string> {
  return new Set(getPinnedPaths());
}

export function isPinned(path: string): boolean {
  return getPinnedSet().has(path);
}

export function setPinnedPaths(paths: string[]): void {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(paths));
  } catch {
    // ignore
  }
}

export function togglePin(path: string): boolean {
  const set = getPinnedSet();
  const nextPinned = !set.has(path);
  if (nextPinned) set.add(path);
  else set.delete(path);
  setPinnedPaths([...set]);
  notifyLocalState();
  return nextPinned;
}

// ---------------------------------------------------------------------------
// Unread — size > localStorage['omp-seen:'+path]
//
// Read state lives in localStorage, so React has no way to know it changed.
// Components that derive from it (the unread dot, the Unread filter) subscribe
// here and re-read on every mutation; without this a memo keyed on `sessions`
// keeps a stale map and the filter silently matches nothing.
// ---------------------------------------------------------------------------

let localStateVersion = 0;
const localStateListeners = new Set<() => void>();

/** Subscribe to pin/seen mutations. Returns an unsubscribe function. */
export function subscribeLocalState(listener: () => void): () => void {
  localStateListeners.add(listener);
  return () => localStateListeners.delete(listener);
}

/** Snapshot for `useSyncExternalStore`; bumps whenever pins or seen change. */
export function getLocalStateVersion(): number {
  return localStateVersion;
}

function notifyLocalState(): void {
  localStateVersion += 1;
  for (const listener of localStateListeners) listener();
}

/**
 * Read state keys on the daemon's `revision` (identity of the newest VISIBLE
 * entry), never on file size. Size grows with bookkeeping the user never
 * sees: omp appends `session_exit` when a process holding a session is
 * terminated, so closing panes made weeks-old conversations read as unread
 * and pinned them under "Needs you". Markers are stored as `r:<revision>`;
 * a legacy bare-number marker (a byte size) means "opened before", which
 * reads as seen until the next open rewrites it.
 *
 * The open chat owns read state (see read-state.ts). The listing is not
 * polled while a chat is open, so the revision a reply produced is often
 * unknown when the chat closes. The chat therefore also records the newest
 * entry ids it showed (`r:<revision>;e:<id>,<id>`): a listing whose
 * `latestEntryId` is one of them was read in the open chat, whatever its
 * revision. Before this, every reply watched to the end showed a dot on Back.
 */
const SEEN_ENTRIES = ";e:";
/** Tail entries kept: the newest daemon-visible entry may sit behind a few the daemon ignores. */
export const SEEN_ENTRY_LIMIT = 8;

function getSeenMarker(path: string): string | null {
  try {
    return localStorage.getItem(SEEN_PREFIX + path);
  } catch {
    return null;
  }
}

function parseSeenMarker(marker: string): { revision: string; entries: string[] } {
  const split = marker.indexOf(SEEN_ENTRIES);
  if (split < 0) return { revision: marker, entries: [] };
  const entries = marker.slice(split + SEEN_ENTRIES.length).split(",").filter(Boolean);
  return { revision: marker.slice(0, split), entries };
}

export function hasUnread(session: OmpSessionSummary): boolean {
  const seen = getSeenMarker(session.path);
  if (seen == null || !seen.startsWith("r:")) return false;
  if (typeof session.revision !== "string" || session.revision === "") return false;
  const { revision, entries } = parseSeenMarker(seen);
  if (revision === `r:${session.revision}`) return false;
  // Markers written before the daemon sent revisions as strings hold the
  // JS-rounded number. Accept that spelling so an upgrade does not light up
  // every chat as unread; the next open rewrites the marker exactly.
  if (revision === `r:${Number(session.revision)}`) return false;
  const latest = session.latestEntryId;
  return !(typeof latest === "string" && latest !== "" && entries.includes(latest));
}

/**
 * Record what the user has seen of `path`. `revision` is the listing's (may be
 * unknown for a chat the listing has not caught up with, e.g. one just
 * created; the stored revision is then kept). `shownEntryIds` are the newest
 * entry ids the open chat displayed, oldest first. A chat with neither still
 * gets a marker, so later replies to a just-created chat show a dot.
 */
export function markSeen(path: string, revision: string | undefined, shownEntryIds?: readonly string[]): void {
  if (!path) return;
  const knownRevision = typeof revision === "string" && revision !== "";
  if (!knownRevision && shownEntryIds === undefined) return;
  const previous = getSeenMarker(path);
  const revisionPart = knownRevision
    ? `r:${revision}`
    : previous?.startsWith("r:") ? parseSeenMarker(previous).revision : "r:";
  const entries = (shownEntryIds ?? [])
    .filter((id) => id !== "" && !id.includes(",") && !id.includes(";"))
    .slice(-SEEN_ENTRY_LIMIT);
  const next = entries.length > 0 ? `${revisionPart}${SEEN_ENTRIES}${entries.join(",")}` : revisionPart;
  if (next === previous) return;
  try {
    localStorage.setItem(SEEN_PREFIX + path, next);
  } catch {
    // ignore
  }
  notifyLocalState();
}

// ---------------------------------------------------------------------------
// Model alias — shorten provider/model-name-20250101 to readable alias
// ---------------------------------------------------------------------------
export function shortModel(model: string | null | undefined): string {
  const value = String(model ?? "").trim();
  if (!value) return "";
  const base = value.slice(value.lastIndexOf("/") + 1).replace(/[-_]?20\d{6}$/, "").replace(/[-_](latest|preview|stable)$/i, "");
  const claude = base.match(/^(?:claude[- ]?)?(opus|sonnet|haiku)[- ](\d+)(?:[-.](\d+))?$/i)
    ?? base.match(/^claude[- ](\d+)(?:[-.](\d+))?[- ](opus|sonnet|haiku)$/i);
  if (claude) {
    const familyFirst = /opus|sonnet|haiku/i.test(claude[1]);
    const family = familyFirst ? claude[1] : claude[3];
    const major = familyFirst ? claude[2] : claude[1];
    const minor = familyFirst ? claude[3] : claude[2];
    return family[0].toUpperCase() + family.slice(1).toLowerCase() + " " + major + (minor ? "." + minor : "");
  }
  return base.replace(/^(?:openai|anthropic)[-_]/i, "").replace(/[-_](\d+)-(\d+)(?=$|[-_])/g, " $1.$2").replace(/[-_]/g, " ").replace(/\bgpt\b/gi, "GPT").replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}


// ---------------------------------------------------------------------------
// Context % and cost meters
// ---------------------------------------------------------------------------
/**
 * A row's context fill: the live child's exact figure when it reports one,
 * else the daemon's newest prompt size over the model's window. The window
 * comes from the cache the model catalogue fills, so a laptop-owned row shows
 * a figure once the phone has learned that model; unknown stays null.
 */
export function getCtxPercent(session: OmpSessionSummary): number | null {
  const raw = session.ctxPercent;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const model = typeof session.model === "string" ? session.model : undefined;
  return contextPercent(session.ctxTokens, contextWindowFor(model)) ?? null;
}

export function contextTier(
  ctxPercent: number | null | undefined,
): "amber" | "red" | null {
  if (ctxPercent == null || !Number.isFinite(ctxPercent)) return null;
  if (ctxPercent > 90) return "red";
  if (ctxPercent >= 70) return "amber";
  return null;
}


// ---------------------------------------------------------------------------
// Inbox state — exactly like reference item 4/29
// ---------------------------------------------------------------------------
export type InboxState = "asking" | "needs" | "running" | "live" | "done" | "unknown";

// Running and laptop ownership remain separate; unread never means asking.
export function inboxState(
  session: OmpSessionSummary,
  awaiting: ReadonlySet<string>,
): InboxState {
  if (awaiting.has(session.path)) return "asking";
  if (session.status === "waiting") return "needs";
  const turn = sessionTurn(session);
  if (session.sessionState && (turn === "unknown" || session.sessionState.connection !== "connected")) return "unknown";
  if (turn === "running") return "running";
  if (session.live) return "live";
  return "done";
}

// Interruptions the user already acted on here (Continue or dismiss), keyed by
// path and detection time: the list is cached for a few seconds, and the row
// must not bring a notice back that was just closed. A later cut-off has a
// new detection time and shows again.
const handledInterruptions = new Set<string>();
const interruptionKey = (path: string, cut: OmpInterruption) => `${path}\n${cut.detectedAt}`;

/** The session's cut-off turn, unless a turn is running or the user acted on it. */
export function sessionInterruption(session: OmpSessionSummary | null | undefined): OmpInterruption | null {
  if (!session) return null;
  const cut = parseInterruption(session.interrupted);
  if (!cut || sessionTurn(session) === "running") return null;
  return handledInterruptions.has(interruptionKey(session.path, cut)) ? null : cut;
}

/** Remember that the user continued or dismissed this cut-off turn. */
export function markInterruptionHandled(path: string, cut: OmpInterruption): void {
  handledInterruptions.add(interruptionKey(path, cut));
}

/** What the chat says about a cut-off turn. */
export function interruptionText(cut: OmpInterruption): string {
  return cut.cause === "exited"
    ? "The agent stopped while it was working."
    : "The app closed while the agent was working.";
}

// ---------------------------------------------------------------------------
// Inbox view persistence — filter + grouped

