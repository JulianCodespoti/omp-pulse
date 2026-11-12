import { HistoryIcon, MessageSquareIcon } from "lucide-react";
import { errorRecoveryAction } from "../ui/error-recovery";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  filterPromptHistory,
  mergePromptHistory,
  resolveHistoryText,
  type HistoryItem,
  type PromptHistoryEntry,
  type TranscriptHit,
} from "../../domain/prompt-history";
import type { DaemonApi } from "../../runtime/rpc-client";
import { relativeTime } from "../session-format";
import { SearchField } from "../ui/SearchField";
import { Notice } from "../ui/Notice";
import { BottomSheet, SheetEmpty, SheetGroup, SheetRow } from "../ui/Sheet";
import { readPromptHistory } from "./prompt-history-store";
import { getDraftNamespace } from "./use-draft";

/** Shorter queries match nearly every message; the scan is not free on a phone. */
const MIN_TRANSCRIPT_QUERY = 2;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Prompt history for touch (the hardware-keyboard route is
 * Up/Down in the composer). Prompts this device sent come first, then the
 * user's own messages found in transcripts. A tap puts the text in the
 * composer and never sends: recall is for editing, the way Up works in the TUI.
 */
export function HistorySheet({
  open,
  onOpenChange,
  api,
  sessionPath,
  prepareInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: DaemonApi;
  sessionPath: string | null;
  /** Capture the editor visit before the full-message read starts. */
  prepareInsert: () => ((text: string) => boolean) | null;
}) {
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<PromptHistoryEntry[]>([]);
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const namespace = getDraftNamespace();
  const visit = useRef(0);
  const pending = useRef(false);
  useLayoutEffect(() => {
    ++visit.current;
    pending.current = false;
    setInserting(false);
    setError(null);
    return () => { ++visit.current; pending.current = false; };
  }, [api, open, sessionPath, namespace, query]);

  useEffect(() => {
    if (!open) return;
    setLocal(readPromptHistory(namespace));
    setQuery("");
    setHits([]);
  }, [api, open, sessionPath, namespace]);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < MIN_TRANSCRIPT_QUERY) {
      setHits([]);
      setSearching(false);
      return;
    }
    let live = true;
    const requestVisit = visit.current;
    const current = () => live && requestVisit === visit.current && namespace === getDraftNamespace();
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.search(q, 50).then(
        (found) => { if (current()) setHits(found); },
        () => { if (current()) setHits([]); },
      ).finally(() => { if (current()) setSearching(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, open, query, sessionPath, namespace]);

  const items = useMemo(
    () => mergePromptHistory(filterPromptHistory(local, query), hits),
    [hits, local, query],
  );
  const sentAt = useMemo(() => new Map(local.map((e) => [e.text, e.at])), [local]);

  const pick = async (item: HistoryItem) => {
    if (pending.current || !open) return;
    const insert = prepareInsert();
    if (!insert) return;
    const requestVisit = visit.current;
    const current = () => requestVisit === visit.current && namespace === getDraftNamespace();
    pending.current = true;
    setInserting(true);
    setError(null);
    try {
      const text = await resolveHistoryText(item, (path, offset, entryId) => api.readUserMessageAt(path, offset, entryId));
      if (!current()) return;
      if (!insert(text)) {
        setError("Your draft changed while loading this prompt. Choose it again to insert into the current draft.");
        return;
      }
      onOpenChange(false);
    } catch {
      if (current()) setError("The full original prompt is unavailable. Search again or retry; the preview was not inserted.");
    } finally {
      if (current()) {
        pending.current = false;
        setInserting(false);
      }
    }
  };

  const now = Date.now();
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="History" testId="history-sheet">
      <SearchField value={query} onChange={setQuery} placeholder="Search your messages" testId="history-search" className="mb-2" />
      {error ? <Notice tone="danger" className="mb-2" action={errorRecoveryAction(error)} testId="history-error">{error}</Notice> : null}
      {items.length === 0 ? (
        searching ? null : (
          <SheetEmpty
            icon={<HistoryIcon />}
            title={query.trim() ? "No matches" : "Nothing sent yet"}
            description={query.trim() ? undefined : "Messages you send from this phone appear here."}
          />
        )
      ) : (
        <SheetGroup testId="history-list">
          {items.map((item, i) => {
            const at = sentAt.get(item.text);
            return (
              <SheetRow
                key={`${item.origin}:${i}:${item.text.slice(0, 40)}`}
                testId="history-row"
                icon={item.origin === "device" ? <HistoryIcon /> : <MessageSquareIcon />}
                title={item.text.replace(/\s+/g, " ")}
                meta={item.origin === "device" ? (at ? relativeTime(at, now) : undefined) : item.session?.title}
                disabled={inserting}
                onClick={() => void pick(item)}
              />
            );
          })}
        </SheetGroup>
      )}
    </BottomSheet>
  );
}
