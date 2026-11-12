"use client";

import type { JSX } from "react";
import { ListChecksIcon } from "lucide-react";

import { useStoreValue } from "@/app/store-hooks";
import type { OmpStoreApi } from "@/runtime/omp-store";

/**
 * A quiet row under the header while plan mode is on, so a reply that only
 * proposes is never mistaken for one that did nothing. Tap opens Session
 * settings, where the switch lives.
 */
export function PlanChip({ store, onOpen }: { store: OmpStoreApi; onOpen: () => void }): JSX.Element | null {
  const on = useStoreValue(store, (state) => state.planMode?.enabled === true);
  if (!on) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="plan-chip"
      aria-label="Plan mode is on. Open session settings"
      className="pressable mx-3 flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-3 text-meta text-muted-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <ListChecksIcon aria-hidden className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 truncate text-left text-foreground">Plan mode</span>
    </button>
  );
}
