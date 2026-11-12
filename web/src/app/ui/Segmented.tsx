import type { JSX, KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

/**
 * A segmented choice between a few peers (2–5; five only with short labels).
 * A radio group: arrow keys move and select, one tab stop for the whole
 * control. 36px visual track; each 32px segment's hit area extends to 44px.
 * The selected segment is a raised surface-3 on a surface-1 track, so it
 * reads at a glance rather than as a faint tint. That surface is one
 * indicator sliding between equal-width segments, on ChatGPT's selection
 * timing (0.3s, cubic-bezier(0.19, 1, 0.22, 1)).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  testId,
  "aria-label": ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** md: 36px track. compact: 32px track for toolbars (Steer | Queue). Both keep 44px hits. */
  size?: "md" | "compact";
  className?: string;
  testId?: string;
  "aria-label"?: string;
}): JSX.Element {
  const enabled = options.filter((o) => !o.disabled);
  const selected = options.findIndex((o) => o.value === value);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || !enabled.length) return;
    event.preventDefault();
    const at = enabled.findIndex((o) => o.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    onChange(next.value);
    const group = event.currentTarget;
    requestAnimationFrame(() => {
      group.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
    });
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-slot="segmented"
      data-testid={testId}
      onKeyDown={onKeyDown}
      data-size={size}
      className={cn(
        "relative flex min-w-0 items-stretch gap-0.5 rounded-full bg-surface-1 p-0.5 ring-1 ring-hairline ring-inset",
        size === "compact" ? "h-8" : "h-9",
        className,
      )}
    >
      {selected >= 0 ? (
        <span
          aria-hidden
          data-testid="segmented-indicator"
          className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-full bg-surface-3 shadow-[0_1px_2px_oklch(0_0_0/0.35)] transition-transform duration-[200ms] ease-[var(--ease-position)]"
          // Segments are flex-1 with a 2px gap: one segment is (track − 4px
          // padding − gaps) / n wide, and each step is a width plus a gap.
          style={{
            width: `calc((100% - 4px - ${options.length - 1} * 2px) / ${options.length})`,
            transform: `translateX(calc(${selected} * (100% + 2px)))`,
          }}
        />
      ) : null}
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={option.value}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            onClick={() => { if (!checked) onChange(option.value); }}
            // The label truncates in its own span: `truncate` (overflow:
            // hidden) on the button clipped the after: hit extension, and an
            // ellipsis cannot apply to a flex container anyway.
            className={cn(
              "relative flex min-w-0 flex-1 items-center justify-center rounded-full px-2 text-meta outline-none [-webkit-tap-highlight-color:transparent]",
              "after:absolute after:inset-x-0 after:content-[''] transition-colors duration-[var(--dur-control)] ease-[var(--ease-control)] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              // 32px segment + 6px, or 28px compact segment + 8px, either side = 44px.
              size === "compact" ? "after:-inset-y-2" : "after:-inset-y-1.5",
              checked ? "font-medium text-foreground" : "press-bounce text-muted-foreground",
            )}
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
