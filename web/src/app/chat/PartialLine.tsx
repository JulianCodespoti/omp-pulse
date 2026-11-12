import type { JSX } from "react";

export interface PartialLineProps {
  text: string;
}

/**
 * Provisional tail your computer is still writing (a desktop turn the phone
 * only sees as file growth). It reads as the reply forming: chat prose,
 * muted, never parsed as markdown, ending in a caret so it cannot be mistaken
 * for settled content. No box and no monospace: it is prose, not output.
 */
export function PartialLine({ text }: PartialLineProps): JSX.Element | null {
  if (!text) return null;
  return (
    <div
      data-testid="partial-line"
      role="status"
      // Silent like the rest of the transcript (A11Y-04): streamed text would
      // be re-read on every write. The turn status line is the live region.
      aria-live="off"
      aria-label="Streaming"
      className="partial-line min-w-0 motion-safe:animate-[fade-in_var(--dur-base)_var(--ease-smooth)] motion-reduce:animate-none"
    >
      <p className="whitespace-pre-wrap break-words text-body text-muted-foreground">
        {text}
        <span aria-hidden className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[2px] bg-foreground/60 align-text-bottom" />
      </p>
    </div>
  );
}
