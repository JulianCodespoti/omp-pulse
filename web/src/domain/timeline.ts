import type { UiMessage } from "./messages";

export type TimelineItem =
  | { kind: "message"; message: UiMessage }
  /**
   * The agent went on after this run: the next message is a healthy assistant
   * message of the same turn (a reply, or more steps past a marker). False
   * when the turn ended here: a user message, an errored or stopped reply, or
   * nothing yet.
   */
  | {
      kind: "run"; key: string; messages: UiMessage[]; continued: boolean;
      /** Text of the assistant message that continued the run ("" when none): screenshots it names stay in view. */
      reply: string;
    }
  | { kind: "edits"; key: string; messages: UiMessage[] }
  /**
   * Consecutive provider attempts omp's auto-retry replaced: one muted row,
   * not one red row per attempt. `recovered` when a retry went through.
   */
  | { kind: "retry"; key: string; messages: UiMessage[]; recovered: boolean }
  | { kind: "day"; label: string; key: string }
  | { kind: "marker"; label: string; key: string; tone?: "muted" | "warn"; icon?: TimelineMarkerIcon; detail?: string };

const EMPTY: TimelineItem[] = [];

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export type TimelineMarkerIcon =
  | "model"
  | "compaction"
  | "job"
  | "agent"
  | "branch"
  | "rename";

export interface TimelineMarkerInput {
  key: string;
  label: string;
  at: number;
  tone?: "muted" | "warn";
  icon?: TimelineMarkerIcon;
  /** Longer text behind the caption (a compaction or branch summary), shown on tap. */
  detail?: string;
  /** Model markers: the thinking level in force from here, for the
   * `Switched to … · High` divider. */
  thinkingLevel?: string;
}

let _markers: TimelineMarkerInput[] = [];


export function addTimelineMarkers(markers: readonly TimelineMarkerInput[]): boolean {
  if (markers.length === 0) return false;
  const byKey = new Map<string, TimelineMarkerInput>();
  for (const m of _markers) byKey.set(m.key, m);
  let changed = false;
  for (const m of markers) {
    const old = byKey.get(m.key);
    if (old?.at === m.at && old.label === m.label && old.icon === m.icon
      && old.tone === m.tone && old.detail === m.detail && old.thinkingLevel === m.thinkingLevel) continue;
    byKey.set(m.key, m);
    changed = true;
  }
  if (changed) _markers = Array.from(byKey.values());
  return changed;
}

export function clearTimelineMarkers(): void {
  _markers = [];
}


/**
 * Pure, allocation-light day-label formatter. Receives the pre-computed
 * today/yesterday keys to avoid Date allocation per message.
 */
function formatDayLabel(
  date: Date,
  todayKey: string,
  yesterKey: string,
  dayKey: string,
): string {
  if (dayKey === todayKey) return "Today";
  if (dayKey === yesterKey) return "Yesterday";
  const d = date.getDate();
  const m = date.getMonth();
  const y = date.getFullYear();
  // Include year only when different from today.
  if (dayKey.slice(0, 4) === todayKey.slice(0, 4)) {
    return `${d} ${MONTHS[m]}`;
  }
  return `${d} ${MONTHS[m]} ${y}`;
}

/**
 * A message that belongs in a run: assistant thinking and calls, no prose.
 * INVARIANT: prose, provider errors and timeline furniture never disappear into a run.
 */
export function isRunMessage(message: UiMessage): boolean {
  return message.role === "assistant" && message.customType === undefined && !message.errorMessage && !message.parts.some((part) => part.kind === "text");
}

/**
 * omp aborts a step on a TTSR rule match and re-runs it at once: the turn
 * never stopped, so the abort is not shown and does not split the run around it.
 */
export function isInternalRerun(errorMessage: string | undefined): boolean {
  return !!errorMessage && /^\s*TTSR matched rule\b/i.test(errorMessage);
}

function isHiddenStep(message: UiMessage): boolean {
  return message.role === "assistant" && isInternalRerun(message.errorMessage);
}

function sameMessages(a: readonly UiMessage[], b: readonly UiMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Build a chronological plan with day separators, event markers and maximal
 * tool-only assistant runs. Timestamp-less messages inherit the previous day.
 * Pass the previous plan to reuse unchanged runs and their message arrays;
 * immutable message identity is the token-stream memoization boundary.
 *
 * Markers (session events like compaction/model changes) are stored in a
 * module-level registry populated by the controller. They are merged by
 * timestamp among messages so they appear in the correct chronological
 * position, rendered as muted left-aligned lines via TranscriptMarkers.
 *
 * Where consecutive assistant messages name different models and no model
 * marker sits between them (a retry fallback, or a `model_change` entry
 * outside the loaded window), one `Switched to …` marker goes before the
 * first message of the new model. `names` supplies the header pill's
 * formatters so the transcript and the pill name a model the same way.
 */
export function buildTimeline(
  messages: readonly UiMessage[],
  previous: TimelineItem[] = EMPTY,
  names: { model: (id: string) => string; thinking: (level: string) => string } = { model: (id) => id, thinking: (level) => level },
  // The registry holds the OPEN CHAT's session events; another transcript
  // (an agent's own conversation) passes its own, usually none.
  registry: readonly TimelineMarkerInput[] = _markers,
): TimelineItem[] {
  if (messages.length === 0 && registry.length === 0) return EMPTY;
  const markers = registry.length > 1 ? registry.slice().sort((a, b) => a.at - b.at) : registry;
  let out: TimelineItem[] | null = null;
  let itemIndex = 0;
  let runStart = -1;
  let runHidden = false;
  let turnStart = 0;
  let turnEnd = 0;
  let editReply = -1;
  let prevDayKey: string | null = null;
  let prevDate: Date | null = null;
  let markerIndex = 0;
  let lastModel: string | undefined;
  let modelMarked = false;
  let thinkingLevel: string | undefined;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const yester = new Date(now);
  yester.setDate(now.getDate() - 1);
  const yesterKey = `${yester.getFullYear()}-${yester.getMonth()}-${yester.getDate()}`;

  const emit = (item: TimelineItem): void => {
    const old = previous[itemIndex];
    const same = old === item || old?.kind === "message" && item.kind === "message" && old.message === item.message
      || old?.kind === "day" && item.kind === "day" && old.key === item.key && old.label === item.label
      || old?.kind === "marker" && item.kind === "marker" && old.key === item.key && old.label === item.label && old.tone === item.tone && old.icon === item.icon && old.detail === item.detail
      || old?.kind === "retry" && item.kind === "retry" && old.key === item.key && old.recovered === item.recovered && sameMessages(old.messages, item.messages);
    if (!out && !same) out = previous.slice(0, itemIndex);
    if (out) out.push(same ? old! : item);
    itemIndex++;
  };
  const nextShown = (index: number): UiMessage | undefined => {
    while (index < messages.length && isHiddenStep(messages[index]!)) index++;
    return messages[index];
  };
  const emitGroup = (kind: "run" | "edits", start: number, end: number, key: string): void => {
    const atIndex = previous[itemIndex];
    const old = atIndex?.kind === kind && atIndex.key === key
      ? atIndex : previous.find((item) => item.kind === kind && item.key === key);
    const next = kind === "run" ? nextShown(end) : undefined;
    // A retry that follows is the agent going on, not the turn ending here.
    const continued = !!next && next.role === "assistant" && (!!next.retry || !next.errorMessage && next.stopReason !== "aborted");
    // The reply that continued the run names the screenshots it relied on.
    const reply = continued && next && !next.retry ? next.text : "";
    // Only a run that swallowed a hidden step pays for a filtered copy.
    const members = kind === "run" && runHidden ? messages.slice(start, end).filter((message) => !isHiddenStep(message)) : null;
    const count = members ? members.length : end - start;
    let same = old?.kind === kind && old.messages.length === count && (old.kind !== "run" || old.continued === continued && old.reply === reply);
    if (same && old?.kind === kind) {
      for (let i = 0; i < count; i++) {
        if (old.messages[i] !== (members ? members[i] : messages[start + i])) { same = false; break; }
      }
    }
    if (same && old) emit(old);
    else if (kind === "run") emit({ kind, key, messages: members ?? messages.slice(start, end), continued, reply });
    else emit({ kind, key, messages: messages.slice(start, end) });
  };
  const flushRun = (end: number): void => {
    if (runStart < 0) return;
    emitGroup("run", runStart, end, `run:${messages[runStart]!.id}`);
    runStart = -1;
    runHidden = false;
  };
  const emitMarker = (marker: TimelineMarkerInput): void => {
    if (marker.icon === "model") modelMarked = true;
    if (marker.thinkingLevel) thinkingLevel = marker.thinkingLevel;
    emit({ kind: "marker", key: marker.key, label: marker.label, tone: marker.tone ?? "muted", icon: marker.icon, detail: marker.detail });
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (i === turnEnd) {
      turnStart = i;
      turnEnd = i + 1;
      while (turnEnd < messages.length && messages[turnEnd]!.role !== "user") turnEnd++;
      editReply = -1;
      let edited = false;
      for (let j = turnStart; j < turnEnd; j++) {
        const entry = messages[j]!;
        if (entry.role !== "assistant") continue;
        if (entry.text.trim() && !entry.errorMessage) editReply = j;
        // Same rule as messages.ts landedEdits; a value import would break the plain-node tests that load this file.
        if (entry.parts.some((part) => part.kind === "tool" && part.state !== "running" && !!part.edits?.some((edit) => !edit.error)
          && (part.state !== "error" || !!part.edits?.some((edit) => edit.error)))) edited = true;
      }
      if (!edited) editReply = -1;
    }
    const date: Date | null = message.createdAt ?? prevDate;
    const at = date?.getTime() ?? 0;
    while (markerIndex < markers.length && markers[markerIndex]!.at <= at) {
      flushRun(i);
      emitMarker(markers[markerIndex++]!);
    }
    if (date) {
      const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      if (prevDayKey !== dayKey) {
        flushRun(i);
        emit({ kind: "day", key: `day:${dayKey}`, label: formatDayLabel(date, todayKey, yesterKey, dayKey) });
        prevDayKey = dayKey;
      }
      prevDate = date;
    }
    if (isHiddenStep(message)) {
      if (runStart >= 0) runHidden = true;
      continue;
    }
    if (message.role === "assistant" && message.model) {
      if (lastModel !== undefined && message.model !== lastModel && !modelMarked) {
        flushRun(i);
        const thinking = thinkingLevel ? names.thinking(thinkingLevel) : "";
        emit({ kind: "marker", key: `switch:${message.id}`, label: `Switched to ${names.model(message.model)}${thinking ? ` · ${thinking}` : ""}`, tone: "muted", icon: "model" });
      }
      lastModel = message.model;
      modelMarked = false;
    }
    if (message.retry) {
      flushRun(i);
      // The attempts omp replaced, up to the one that went through or the
      // error the turn ended on.
      let end = i;
      const attempts: UiMessage[] = [];
      let recovered = false;
      while (end < messages.length && (messages[end]!.retry || isHiddenStep(messages[end]!))) {
        const attempt = messages[end]!;
        if (attempt.retry) {
          attempts.push(attempt);
          if (attempt.retry.status === "recovered") recovered = true;
        }
        end++;
      }
      const after = nextShown(end);
      if (after?.role === "assistant" && !after.errorMessage) recovered = true;
      emit({ kind: "retry", key: `retry:${message.id}`, messages: attempts, recovered });
      i = end - 1;
      continue;
    }
    if (isRunMessage(message)) {
      if (runStart < 0) runStart = i;
    } else {
      flushRun(i);
      emit({ kind: "message", message });
    }
    if (i === editReply) emitGroup("edits", turnStart, turnEnd, `edits:${message.id}`);
  }
  flushRun(messages.length);
  while (markerIndex < markers.length) emitMarker(markers[markerIndex++]!);
  // Reuse the plan AND each run's message array on token-only rerenders.
  return out ?? (itemIndex === previous.length ? previous : previous.slice(0, itemIndex));
}
