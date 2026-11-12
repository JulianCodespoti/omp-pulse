import type { JSX } from "react";

/** Starting points that make sense in any repo; each fills the composer, never sends. */
export const SUGGESTIONS = [
  "Explain this project",
  "Summarise recent changes",
  "Find and fix a failing test",
  "Review the last commit",
] as const;

/**
 * A new chat's empty state, after ChatGPT's: one large greeting and a few
 * tappable starting points. A chip only prefills the composer so the prompt
 * can still be edited before it goes.
 */
export function EmptyChatHero({ project, onPick }: { project: string | null; onPick: (text: string) => void }): JSX.Element {
  return (
    <div data-testid="chat-empty" className="my-auto flex min-w-0 flex-col items-center gap-6 px-2 py-10 text-center">
      <div className="flex min-w-0 flex-col items-center gap-1">
        <h2 className="max-w-[16ch] text-balance text-large-title font-semibold text-foreground">What should we work on?</h2>
        {project ? <p className="max-w-full truncate text-meta text-muted-foreground">in {project}</p> : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Suggestions">
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            type="button"
            data-testid="chat-suggestion"
            onClick={() => onPick(text)}
            className="min-h-11 rounded-full bg-surface-2 px-4 py-2 text-ui text-foreground outline-none active:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
