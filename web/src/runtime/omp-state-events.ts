/**
 * omp state frames that used to fall into the controller's `default:` and be
 * dropped, so the header model, thinking level and title went stale after a
 * slash command, and auto-compaction ran in silence. Shapes: omp 18.8.6
 * `wire/events.ts` (model_changed, thinking_level_changed, notice,
 * auto_compaction_*) and `wire/frames.ts` (config_update, session_info_update,
 * available_commands_update); identical in 18.11.0.
 */
import { parseCompactionStart, parseEffectiveThinkingLevel, parseThinkingLevelChanged } from "../domain/run-status";
import { parseSessionModel, type OmpStore } from "./omp-store";
import { parseModelFallback } from "../domain/model-fallback";

export interface StateNotice {
  tone: "info" | "warn" | "error";
  message: string;
}

/** What the store cannot do itself: a toast, or a state read (model_changed carries no payload). */
export interface StateEventFollowUp {
  notice?: StateNotice;
  refreshModel?: true;
}

const NOTICE_TONES: Record<string, StateNotice["tone"]> = { info: "info", warning: "warn", error: "error" };

/**
 * omp announces some of its own bookkeeping as notices: tool-device mounts
 * ("xd://: mounted mcp__phone_act, …", source `xdev`) and the prewalk model
 * router's arm/switch chatter (source `prewalk`). They name internals the
 * user never asked about, so the phone drops them. Older omp builds send no
 * `source`, hence the message-shape fallback for the mount line.
 */
const INTERNAL_NOTICE_SOURCES: Record<string, true> = { xdev: true, prewalk: true };
const MOUNT_NOTICE = /^[a-z][a-z0-9+.-]*:\/\/: (?:un)?mounted /i;

export function isInternalNotice(event: Record<string, unknown>, message: string): boolean {
  if (event.level !== "info" && event.level !== undefined) return false;
  if (typeof event.source === "string" && Object.hasOwn(INTERNAL_NOTICE_SOURCES, event.source)) return true;
  return MOUNT_NOTICE.test(message);
}

/**
 * The outcome worth a word once auto-compaction ends. A benign skip, an abort
 * (the user stopped it) and a failure omp is about to retry say nothing; the
 * retry's own start/end frames follow. Success is claimed only when omp
 * reports a result: a bare end proves nothing.
 */
export function compactionEndNotice(event: Record<string, unknown>): StateNotice | null {
  if (event.skipped === true || event.aborted === true || event.willRetry === true) return null;
  const error = typeof event.errorMessage === "string" ? event.errorMessage.trim() : "";
  if (error) return { tone: "error", message: `Couldn't compact the conversation: ${error}` };
  return event.result ? { tone: "info", message: "Conversation compacted" } : null;
}

/**
 * Reduce one state frame for the open session `path` into the store.
 * Returns `null` for a frame this module does not own.
 */
export function reduceStateEvent(state: OmpStore, path: string, event: Record<string, unknown>): StateEventFollowUp | null {
  switch (event.type) {
    // No payload: the new model is only readable from get_state.
    case "model_changed":
      return { refreshModel: true };
    case "retry_fallback_applied": {
      const fallback = parseModelFallback(event);
      if (fallback) state.setSessionModel({ modelFallback: fallback }, "live");
      return { refreshModel: true };
    }
    // A builtin slash command (/model, /effort…) changed the model config.
    // `model` is omp's ModelInfo object; parseSessionModel reads its id,
    // provider and context window.
    case "config_update": {
      const patch = parseSessionModel({ model: event.model, thinkingLevel: event.thinkingLevel });
      // config_update/get_state carry only the effective effort in 18.10.4.
      // A subsequent summary frame cannot undo the configured Auto receipt.
      if (state.sessionModel?.thinkingLevel === "auto") delete patch.thinkingLevel;
      state.setSessionModel(patch);
      return {};
    }
    case "thinking_level_changed": {
      const level = parseThinkingLevelChanged(event);
      const effective = parseEffectiveThinkingLevel(event);
      if (level !== null) state.setSessionModel({ thinkingLevel: level, ...(effective !== null ? { effectiveThinkingLevel: effective } : {}) }, "live");
      return {};
    }
    case "session_info_update":
      if (typeof event.title === "string" && event.title.trim()) state.setSessionTitle(path, event.title.trim());
      return {};
    case "auto_compaction_start":
      state.setCompacting(parseCompactionStart(event));
      return {};
    case "auto_compaction_end": {
      state.setCompacting(null);
      const notice = compactionEndNotice(event);
      return notice ? { notice } : {};
    }
    case "notice": {
      const message = typeof event.message === "string" ? event.message.trim() : "";
      if (!message || isInternalNotice(event, message)) return {};
      const tone = typeof event.level === "string" ? NOTICE_TONES[event.level] : undefined;
      return { notice: { tone: tone ?? "info", message } };
    }
    case "available_commands_update":
      if (Array.isArray(event.commands)) state.setAvailableCommands(event.commands);
      return {};
    default:
      return null;
  }
}
