import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one empty state: a quiet unboxed icon, a title, at most one sentence
 * and at most one way forward. Centred, so a first run looks the same in
 * every sheet and screen.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  testId,
}: {
  /** A Lucide icon element; drawn at 24px, muted. */
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  className?: string;
  testId?: string;
}): JSX.Element {
  return (
    <div
      data-slot="empty-state"
      data-testid={testId}
      className={cn("flex min-w-0 flex-col items-center justify-center gap-1 px-4 py-10 text-center", className)}
    >
      <span aria-hidden className="mb-2 flex size-6 items-center justify-center text-muted-foreground [&_svg]:size-6">
        {icon}
      </span>
      <p className="max-w-sm text-ui font-medium text-foreground break-words">{title}</p>
      {description ? (
        <p className="max-w-sm text-meta text-muted-foreground break-words">{description}</p>
      ) : null}
      {action ? (
        <Button className="mt-4" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
