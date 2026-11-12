import type { JSX } from "react";

import { shortModel } from "../session-format";

/**
 * Which model answers, as one quiet line. The chat screen mounts it only
 * where the model changes, so a session on one model never repeats its name.
 */
export function TurnModel({ model }: { model: string }): JSX.Element | null {
  const name = shortModel(model);
  if (!name) return null;
  return (
    <div data-testid="turn-model" className="mb-1 min-w-0 truncate text-meta text-tertiary">
      {name}
    </div>
  );
}
