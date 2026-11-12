import type { ComponentPropsWithRef, JSX, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ChipTone = "neutral" | "success" | "warning" | "danger" | "running" | "accent";

const TONE: Record<ChipTone, string> = {
  neutral: "bg-surface-2 text-foreground",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  running: "bg-running-tint text-running",
  accent: "bg-primary-tint text-primary-text",
};

// Visual height is 24/32; a pressable chip extends its hit area to 44 with
// an invisible inset so a dense chip row stays tappable.
const SIZE = {
  sm: "h-6 gap-1 px-2.5 [&_svg:not([class*='size-'])]:size-3.5 after:-inset-y-2.5",
  md: "h-8 gap-1.5 px-3 [&_svg:not([class*='size-'])]:size-4 after:-inset-y-1.5",
} as const;

export type ChipProps = {
  tone?: ChipTone;
  size?: keyof typeof SIZE;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Selection is violet regardless of tone (selection is what violet means). */
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  testId?: string;
  "aria-label"?: string;
  /** Pressable only: passed to the button, so a chip can be a menu trigger (Base UI's `render`). */
} & Omit<ComponentPropsWithRef<"button">, "onClick" | "children" | "className" | "disabled">;

export function Chip({
  tone = "neutral",
  size = "sm",
  leading,
  trailing,
  selected = false,
  onClick,
  disabled,
  children,
  className,
  testId,
  "aria-label": ariaLabel,
  ...button
}: ChipProps): JSX.Element {
  const cls = cn(
    "relative inline-flex min-w-0 max-w-full shrink-0 items-center rounded-full text-meta whitespace-nowrap",
    SIZE[size],
    selected ? "bg-primary-tint text-primary-text" : TONE[tone],
    className,
  );
  const body = (
    <>
      {leading}
      <span className="min-w-0 truncate">{children}</span>
      {trailing}
    </>
  );
  if (onClick) {
    return (
      <button
        {...button}
        type="button"
        data-slot="chip"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-pressed={selected}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          cls,
          "outline-none [-webkit-tap-highlight-color:transparent] after:absolute after:inset-x-0 after:content-[''] press-bounce focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <span data-slot="chip" data-testid={testId} aria-label={ariaLabel} className={cls}>
      {body}
    </span>
  );
}
