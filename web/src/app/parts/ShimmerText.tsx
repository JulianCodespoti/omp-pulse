import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// ChatGPT's ShimmerText timing (oai_ui): a 1.4s cycle that starts 304ms in,
// sweeps for 1.096s and rests 304ms; each glyph dips for 0.45s.
const START_MS = 304;
const SWEEP_MS = 1096;
const GLYPH_MS = 450;

/**
 * Live-state label, as ChatGPT draws "Thinking": a dip in opacity travels
 * through the text one glyph at a time (keyframes `shimmer-glyph`). The
 * glyphs stay ordinary text, so the label reads and copies as one string.
 * Non-string children dip as one piece.
 */
export function ShimmerText({
  children,
  active = true,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  if (!active) return <span className={cn("text-muted-foreground", className)}>{children}</span>;
  if (typeof children !== "string") {
    return (
      <span data-shimmer="" className={cn("text-muted-foreground animate-[shimmer-glyph_1.4s_infinite] motion-reduce:animate-none", className)} style={{ animationDelay: `${START_MS}ms` }}>
        {children}
      </span>
    );
  }
  const glyphs = Array.from(children);
  const step = (SWEEP_MS - GLYPH_MS) / Math.max(1, glyphs.length - 1);
  return (
    <span data-shimmer="" className={cn("text-muted-foreground", className)}>
      {/* One inline run, so a flex `className` cannot turn each glyph (and
          a lone space) into its own flex item. */}
      <span>
        {glyphs.map((glyph, index) => (
          <span
            key={index}
            className="animate-[shimmer-glyph_1.4s_infinite] motion-reduce:animate-none"
            style={{ animationDelay: `${Math.round(START_MS + index * step)}ms` }}
          >
            {glyph}
          </span>
        ))}
      </span>
    </span>
  );
}
