import type { TimelineItem } from "@/domain/timeline";

/** Px between a turn's last item and its footer: the footer belongs to the reply it closes. */
export const TURN_FOOTER_GAP = 4;

/** A transcript gap as CSS: Compact density (Settings → Appearance) scales it via --gap-scale. */
export function scaledGap(px: number): string {
  return px === 0 ? "0px" : `calc(${px}px * var(--gap-scale))`;
}

type Slot = "user" | "assistant" | "tool" | "furniture";

function slot(item: TimelineItem): Slot {
  switch (item.kind) {
    case "message":
      return item.message.role === "user" ? "user" : "assistant";
    case "run":
    case "edits":
      return "tool";
    default:
      return "furniture";
  }
}

/**
 * The gap above `next`, in px. Spacing carries structure instead of a uniform
 * gap: activity of one turn sits tight, a new turn opens with air (Paseo's
 * agent-stream/spacing.ts matrix, with a larger new-turn step for a phone).
 */
export function transcriptGap(prev: TimelineItem | null, next: TimelineItem): number {
  if (!prev) return 0;
  const a = slot(prev);
  const b = slot(next);
  // Day separators and event markers sit between, not inside, the blocks.
  if (a === "furniture" || b === "furniture") return 16;
  if (b === "user") return a === "user" ? 4 : 24;
  // The reply starts under the prompt it answers.
  if (a === "user") return 16;
  if (a === "tool" && b === "tool") return 0;
  // Two text blocks of one turn.
  if (a === "assistant" && b === "assistant") return 12;
  // Prose ↔ its own tool activity.
  return 8;
}
