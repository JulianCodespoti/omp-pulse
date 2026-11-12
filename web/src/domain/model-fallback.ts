import type { TimelineMarkerInput } from "./timeline";

/** OMP 18.10.4 AgentSessionEvent.retry_fallback_applied. */
export interface ModelFallback {
  from: string;
  to: string;
  role: string;
  reason?: string;
  /** Pulse journal identity/time, absent on native live events. */
  entryId?: string;
  at?: number;
}

/** Accept live events and the owner-persisted custom entry's data alike. */
export function parseModelFallback(value: unknown): ModelFallback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.from !== "string" || !event.from.trim() || typeof event.to !== "string" || !event.to.trim() || typeof event.role !== "string") return null;
  return {
    from: event.from,
    to: event.to,
    role: event.role,
    ...(typeof event.reason === "string" && event.reason.trim() ? { reason: event.reason } : {}),
    ...(typeof event.entryId === "string" ? { entryId: event.entryId } : {}),
    ...(typeof event.at === "number" && Number.isFinite(event.at) ? { at: event.at } : {}),
  };
}

/** A durable explanation, not a prediction about restoring the original model. */
export function modelFallbackMarker(fallback: ModelFallback, key: string, at: number): TimelineMarkerInput {
  return {
    key,
    at,
    icon: "model",
    tone: "warn",
    label: `Fallback to ${fallback.to}`,
    detail: `Switched automatically from ${fallback.from} to ${fallback.to}.${fallback.reason ? `\n\n${fallback.reason}` : ""}`,
  };
}
