import { CpuIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import {
  rankModelMentionEntries,
  type ModelMentionEntry,
  type ModelMentionToken,
} from "../../domain/model-mention";
import type { DaemonApi } from "../../runtime/rpc-client";

type Listing = { key: string; entries: ModelMentionEntry[] | null };

/** Query the active owner's mention scope, never the unscoped model switcher. */
export function useModelMentionEntries(
  api: DaemonApi,
  sessionPath: string | null,
  token: ModelMentionToken | null,
): ModelMentionEntry[] | null {
  const [listing, setListing] = useState<Listing>({ key: "", entries: null });
  const key = token && sessionPath
    ? JSON.stringify([sessionPath, token.start, token.end, token.query])
    : "";
  useEffect(() => {
    if (!key || !sessionPath) {
      setListing({ key: "", entries: null });
      return;
    }
    let live = true;
    api.getModelMentionChoices(sessionPath).then(
      (entries) => { if (live) setListing({ key, entries }); },
      () => { if (live) setListing({ key, entries: [] }); },
    );
    return () => { live = false; };
  }, [api, key, sessionPath]);
  if (!key || !token || listing.key !== key || listing.entries === null) return null;
  return rankModelMentionEntries(listing.entries, token.query);
}

/** Composer owns arrow/Enter/Tab/Escape handling while focus stays in its field. */
export function ModelMentionPicker({
  entries,
  selected,
  onPick,
  id = "model-mention-list",
}: {
  entries: ModelMentionEntry[];
  selected: number;
  onPick: (entry: ModelMentionEntry) => void;
  id?: string;
}) {
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, entries]);
  if (!entries.length) return null;
  return (
    <div
      id={id}
      data-testid="model-mention-picker"
      role="listbox"
      aria-label="Models"
      className="mb-2 origin-bottom overflow-hidden rounded-xl bg-surface-2 shadow-[var(--shadow-float)] motion-safe:animate-[slide-up_var(--dur-base)_var(--ease-spring)] motion-reduce:animate-none"
    >
      <div className="max-h-[min(20rem,40dvh)] overflow-auto overscroll-contain py-2">
        {entries.map((entry, i) => (
          <button
            key={entry.selector}
            id={`${id}-${i}`}
            ref={i === selected ? active : undefined}
            type="button"
            role="option"
            aria-selected={i === selected}
            tabIndex={-1}
            data-testid="model-mention-row"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onPick(entry)}
            className={cn(
              "pressable flex min-h-12 w-full min-w-0 items-center gap-4 px-4 text-left transition-colors hover:bg-surface-3 active:bg-surface-3",
              i === selected && "bg-surface-3",
            )}
          >
            <CpuIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui text-foreground">{entry.selector}</span>
              {entry.name ? <span className="block truncate text-caption text-muted-foreground">{entry.name}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
