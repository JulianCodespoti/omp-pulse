import { FileIcon, FolderIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { rankMentionEntries, type MentionEntry, type MentionToken } from "../../domain/file-mention";
import type { DaemonApi } from "../../runtime/rpc-client";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { errorRecoveryAction } from "../ui/error-recovery";
import { ErrorNotice } from "../ui/ErrorNotice";

type Listing = { api: DaemonApi; key: string; entries: MentionEntry[] | null; truncated: boolean; error: string | null };

/** A bare `@` browses the root; typed names search the entire current project. */
export function useMentionEntries(
  api: DaemonApi,
  sessionPath: string | null,
  token: MentionToken | null,
): Pick<Listing, "entries" | "truncated" | "error"> {
  const cache = useRef({ api, values: new Map<string, Listing>() });
  if (cache.current.api !== api) cache.current = { api, values: new Map() };
  const [listing, setListing] = useState<Listing>({ api, key: "", entries: null, truncated: false, error: null });
  const query = token ? (token.dir ? `${token.dir}/${token.leaf}` : token.leaf) : "";
  const key = token && sessionPath ? `${sessionPath}\0${query}` : "";
  useEffect(() => {
    // Closing the picker invalidates its bounded visit cache: files may change.
    if (!key) {
      cache.current.values.clear();
      return;
    }
    if (!sessionPath) return;
    const cached = cache.current.values.get(key);
    if (cached) {
      setListing(cached);
      return;
    }
    let live = true;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.resolve().then(() => query
        ? api.searchFiles(sessionPath, query, abort.signal)
        : api.listFiles(sessionPath).then(entries => ({ entries: rankMentionEntries(entries, ""), truncated: false }))
      ).then(result => {
        if (!live || cache.current.api !== api) return;
        const next: Listing = { api, key, entries: result.entries, truncated: result.truncated, error: null };
        cache.current.values.set(key, next);
        if (cache.current.values.size > 16) {
          const oldest = cache.current.values.keys().next().value;
          if (oldest !== undefined) cache.current.values.delete(oldest);
        }
        setListing(next);
      }, (error: unknown) => {
        if (live && cache.current.api === api) setListing({ api, key, entries: [], truncated: false, error: humanizeDaemonError(error) });
      });
    }, query ? 120 : 0);
    return () => { live = false; window.clearTimeout(timer); abort.abort(); };
  }, [api, key, query, sessionPath]);
  return listing.api === api && listing.key === key
    ? listing
    : { entries: null, truncated: false, error: null };
}

/** The inline `@` list. Same surface as the slash palette; only one shows at a time. */
export function MentionPicker({
  entries,
  selected,
  onPick,
  truncated = false,
  error = null,
  id = "file-mention-list",
}: {
  entries: MentionEntry[];
  selected: number;
  onPick: (entry: MentionEntry) => void;
  truncated?: boolean;
  error?: string | null;
  id?: string;
}) {
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, entries]);
  return (
    <div
      id={id}
      data-testid="mention-picker"
      role="listbox"
      aria-label="Files"
      className="mb-2 origin-bottom overflow-hidden rounded-xl bg-surface-2 shadow-[var(--shadow-float)] motion-safe:animate-[slide-up_var(--dur-base)_var(--ease-spring)] motion-reduce:animate-none"
    >
      {/* One popover surface, rows run edge to edge with a flat fill a
          step above it, like the slash palette; no inset card inside the card. */}
      <div className="max-h-[min(20rem,40dvh)] overflow-auto overscroll-contain py-2">
        {entries.map((entry, i) => {
          const slash = entry.path.lastIndexOf("/");
          return (
            <button
              key={entry.path}
              id={`${id}-${i}`}
              ref={i === selected ? active : undefined}
              type="button"
              role="option"
              aria-selected={i === selected}
              aria-label={`${entry.path}${entry.type === "dir" ? "/" : ""}`}
              tabIndex={-1}
              data-testid="mention-row"
              // Keep the caret in the composer: a tap must not blur the field
              // (and on Android, close the keyboard) before the pick lands.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onPick(entry)}
              className={cn(
                "pressable flex min-h-12 w-full min-w-0 items-center gap-4 px-4 text-left transition-colors hover:bg-surface-3 active:bg-surface-3",
                i === selected && "bg-surface-3",
              )}
            >
              {entry.type === "dir" ? (
                <FolderIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                {entry.name}
                {entry.type === "dir" ? "/" : ""}
              </span>
              {slash > 0 ? (
                <span className="max-w-[40%] shrink truncate text-caption text-muted-foreground">{entry.path.slice(0, slash)}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {error ? <div className="px-4 pb-3"><ErrorNotice message={error} action={errorRecoveryAction(error)} /></div> : entries.length === 0 || truncated ? (
        <p role="status" className="px-4 pb-3 text-caption text-muted-foreground">
          {entries.length === 0 ? "No matching files." : "More matches. Keep typing to narrow them."}
        </p>
      ) : null}
    </div>
  );
}
