import { CircleAlertIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { Chip } from "../ui/Chip";

export interface TrackStripProps {
  sessionPath: string | null;
  /** A question waits for an answer (or an answer is held until reconnect). */
  question?: { held: boolean; onOpen?: () => void } | null;
  /** The compaction pill (chat/CompactPill.tsx), when it has something to say. */
  compact?: ReactNode;
}

/**
 * One quiet row above the composer: a waiting question and the compaction
 * pill. Task progress, subagents and changes used to be pills here too; they
 * are badges on the session's tab row now (SessionPager), so the row exists
 * only while one of these has something to say and an ordinary chat keeps the
 * composer flush against the transcript.
 */
export function TrackStrip({ sessionPath, question, compact }: TrackStripProps): JSX.Element | null {
  if (!sessionPath || (!question && !compact)) return null;
  return (
    <div
      data-testid="track-strip"
      className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-1 motion-safe:animate-[fade-in_var(--dur-slow)_var(--ease-panel)]"
    >
      {question ? (
        <Chip
          tone="warning"
          size="md"
          testId="collab-banner"
          leading={<CircleAlertIcon className="size-4" aria-hidden />}
          aria-label={question.held ? "Answer held until you reconnect" : "Question waiting. Answer it"}
          onClick={question.onOpen}
        >
          {question.held ? "Held" : "Question"}
        </Chip>
      ) : null}
      {compact}
    </div>
  );
}
