"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/markdown";
import { SessionResources } from "@/app/parts/SessionResources";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi } from "@/runtime/rpc-client";
import {
  adoptBtwRecord,
  btwTurns,
  latestBtwTurn,
  mergeBtwHistory,
  parseBtwRecord,
  type BtwRecord,
  type BtwStore,
  type BtwTurn,
} from "@/runtime/btw";

import { BottomSheet, SheetEmpty, SheetGroup, SheetRow, SheetLoading } from "../ui/Sheet";
import { ErrorNotice } from "../ui/ErrorNotice";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { relativeTime } from "../session-format";

// The field takes all spare width (min-w-0 lets it shrink below its
// placeholder) and the placeholder stays on one line with an ellipsis, so
// large text never splits it mid-word. The action keeps its label width.
const FIELD_CLASS =
  "min-h-12 min-w-0 flex-1 basis-0 resize-none rounded-lg border-0 bg-surface-2 px-4 py-3 text-body shadow-none placeholder:truncate placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40";
const ACTION_CLASS = "pressable h-12 w-auto flex-none rounded-lg px-4 text-ui font-semibold";

/** What a conversation keeps of its side-question sheet between visits. */
interface SideView {
  draft: string;
  selectedId: string | null;
}
const NO_VIEW: SideView = { draft: "", selectedId: null };

function statusText(turn: BtwTurn): string {
  if (turn.status === "running") return "Answering…";
  if (turn.status === "cancelled") return "Stopped";
  if (turn.status === "interrupted") return "Interrupted";
  if (turn.status === "error") return "Couldn't answer";
  return turn.answer.trim().split("\n", 1)[0] ?? "";
}

function TurnView({ turn, sessionPath }: { turn: BtwTurn; sessionPath?: string | null }): JSX.Element {
  const running = turn.status === "running";
  return (
    <div className="flex flex-col gap-2">
      <p className="self-end rounded-xl bg-surface-2 px-4 py-2.5 text-body text-foreground [overflow-wrap:anywhere]">{turn.question}</p>
      {turn.answer ? <SessionResources sessionPath={sessionPath}><Markdown isAnimating={running}>{turn.answer}</Markdown></SessionResources> : null}
      {running && !turn.answer ? <p className="text-meta text-muted-foreground">Thinking…</p> : null}
      {turn.status === "error" ? (
        <ErrorNotice message={turn.error ? humanizeDaemonError(turn.error) : "Couldn't answer this one."} />
      ) : turn.status === "cancelled" || turn.status === "interrupted" ? (
        <p className="text-meta text-muted-foreground">{statusText(turn)}</p>
      ) : null}
    </div>
  );
}

/**
 * omp's `/btw`: a quick question about the work that is answered beside the
 * running turn, never queued into it and never added to the conversation.
 * Records stream in through the session socket (controller → `btwStore`), so
 * an answer keeps arriving while the sheet is closed and is there on reopen.
 */
export function BtwSheet({
  open,
  onOpenChange,
  seed,
  sessionPath,
  controller,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Each new object opens a fresh visit; a non-empty question is asked at once. */
  seed: { question: string } | null;
  sessionPath: string | null;
  // The controller, not its store: ChatScreen evaluates these props on every
  // render even while the sheet is unmounted, so the store is resolved only
  // once the sheet actually mounts.
  controller: { getBtwStore(): BtwStore };
}): JSX.Element {
  const btwStore = controller.getBtwStore();
  const snapshot = useSyncExternalStore(btwStore.subscribe, btwStore.getState);
  const records: readonly BtwRecord[] = sessionPath && snapshot.path === sessionPath ? snapshot.records : [];
  const running = records.find((record) => latestBtwTurn(record).status === "running") ?? null;
  // The typed draft and the open thread belong to the conversation, not to a
  // visit: closing the sheet (a brush of the grab handle) used to wipe a
  // half-typed question and drop back to the list. Keyed by path, so a
  // conversation switch shows that conversation's own draft and returning
  // restores it.
  const [views, setViews] = useState<ReadonlyMap<string, SideView>>(() => new Map());
  const { draft, selectedId } = (sessionPath ? views.get(sessionPath) : undefined) ?? NO_VIEW;
  const patchView = (path: string | null, patch: Partial<SideView> | ((now: SideView) => Partial<SideView>)): void => {
    if (!path) return;
    setViews((all) => {
      const now = all.get(path) ?? NO_VIEW;
      const next = { ...now, ...(typeof patch === "function" ? patch(now) : patch) };
      const kept = new Map(all);
      if (next.draft === "" && next.selectedId === null) kept.delete(path);
      else kept.set(path, next);
      return kept;
    });
  };
  const selected = records.find((record) => record.id === selectedId) ?? null;
  // The question between the tap and omp's reply; shown so the tap is never silent.
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const token = readPairingToken() ?? "";
  const visit = useMemo(() => ({ open, sessionPath, seed, token, btwStore }), [open, sessionPath, seed, token, btwStore]);
  const view = useRef(visit);
  view.current = visit;
  const mounted = useRef(false);
  const request = useRef<object | null>(null);
  const ownsView = () => mounted.current && view.current === visit && visit.open &&
    (readPairingToken() ?? "") === visit.token;
  useLayoutEffect(() => {
    mounted.current = true;
    request.current = null;
    setPending(null);
    setError(null);
    setLoading(false);
    return () => { mounted.current = false; request.current = null; };
  }, [visit]);
  // A different pairing is a different person's drafts.
  useLayoutEffect(() => () => setViews(new Map()), [token]);

  const ask = async (question: string, recordId?: string): Promise<void> => {
    const path = sessionPath;
    const text = question.trim();
    if (!path || !text || !ownsView() || request.current !== null) return;
    const attempt = {};
    request.current = attempt;
    const current = () => ownsView() && request.current === attempt;
    setPending(text);
    setError(null);
    patchView(path, { draft: "" });
    try {
      const data = await new DaemonApi(token).rpc<{ record?: unknown }>(
        path,
        "btw",
        recordId ? { question: text, recordId } : { question: text },
      );
      if (!current()) return;
      btwStore.setState(adoptBtwRecord(btwStore.getState(), path, data?.record));
      const record = parseBtwRecord(data?.record);
      if (record) patchView(path, { selectedId: record.id });
    } catch (e) {
      if (!current()) return;
      setError(humanizeDaemonError(e));
      patchView(path, (now) => ({ draft: now.draft || text }));
    } finally {
      if (current()) {
        request.current = null;
        setPending(null);
      }
    }
  };

  const cancel = async (): Promise<void> => {
    if (!sessionPath || !running || !ownsView()) return;
    try {
      await new DaemonApi(token).rpc(sessionPath, "btw_cancel", { recordId: running.id });
    } catch (e) {
      if (ownsView()) setError(humanizeDaemonError(e));
    }
  };

  // A typed `/btw …` starts a fresh visit: the list, and the question asked at
  // once. A bare reopen keeps the draft and thread (a new seed object arrives on
  // every open, so the seed alone cannot decide).
  const seenSeed = useRef<typeof seed>(null);
  useEffect(() => {
    if (!open || !seed || seenSeed.current === seed) return;
    seenSeed.current = seed;
    if (!seed.question.trim()) return;
    patchView(sessionPath, { selectedId: null, draft: "" });
    setError(null);
    void ask(seed.question);
    // `ask` reads current props; only a new seed starts a visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit]);

  // The history also carries a running record's partial answer, so a
  // reopened sheet rebuilds the stream it missed.
  useEffect(() => {
    if (!open || !sessionPath) return;
    let cancelled = false;
    setLoading(true);
    void new DaemonApi(token)
      .rpc<{ records?: unknown }>(sessionPath, "get_btw_history", {})
      .then((data) => {
        if (cancelled || !ownsView()) return;
        btwStore.setState(mergeBtwHistory(btwStore.getState(), sessionPath, data?.records));
      })
      .catch((e: unknown) => {
        if (!cancelled && ownsView()) setError(humanizeDaemonError(e));
      })
      .finally(() => {
        if (!cancelled && ownsView()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Ownership includes the seed and credential, not just a path that can be revisited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit]);

  const busy = running !== null || pending !== null;
  // omp's started record usually arrives over the socket before the reply;
  // from then on it shows the question and the placeholder would repeat it.
  const placeholder = pending !== null && running === null
    ? <TurnView turn={{ question: pending, answer: "", status: "running", createdAt: 0, updatedAt: 0 }} />
    : null;
  const submit = () => {
    if (!busy) void ask(draft, selected?.id);
  };

  const footer = (
    <div className="flex items-end gap-2">
      <Textarea
        value={draft}
        onChange={(e) => patchView(sessionPath, { draft: e.currentTarget.value })}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!e.repeat) submit();
          }
        }}
        placeholder={selected ? "Ask a follow-up" : "Ask a side question"}
        aria-label={selected ? "Follow-up question" : "Side question"}
        rows={1}
        className={FIELD_CLASS}
        data-testid="btw-input"
      />
      {running ? (
        <Button className={ACTION_CLASS} variant="secondary" type="button" onClick={() => void cancel()} data-testid="btw-stop">
          Stop
        </Button>
      ) : (
        <Button className={ACTION_CLASS} type="button" disabled={!draft.trim() || pending !== null} onClick={submit} data-testid="btw-ask">
          Ask
        </Button>
      )}
    </div>
  );

  let body: JSX.Element;
  if (selected) {
    body = (
      <div className="flex flex-col gap-5" data-testid="btw-thread">
        {btwTurns(selected).map((turn, index) => (
          <TurnView key={`${selected.id}:${index}`} turn={turn} sessionPath={sessionPath} />
        ))}
        {placeholder}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {placeholder}
        {/* No "Recent" label: the sheet title already names the list. */}
        {records.length > 0 ? (
          <SheetGroup testId="btw-history">
            {records.map((record) => {
              const latest = latestBtwTurn(record);
              return (
                <SheetRow
                  key={record.id}
                  title={record.question}
                  meta={statusText(latest)}
                  trailing={<span className="text-caption tabular-nums">{relativeTime(latest.updatedAt || undefined)}</span>}
                  onClick={() => patchView(sessionPath, { selectedId: record.id })}
                />
              );
            })}
          </SheetGroup>
        ) : loading ? (
          <SheetLoading />
        ) : pending === null ? (
          <SheetEmpty
            title="Ask without interrupting"
            description="The agent keeps working. Answers stay out of the conversation."
          />
        ) : null}
      </div>
    );
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) { view.current.open = false; request.current = null; }
        onOpenChange(next);
      }}
      title={selected ? "Side question" : "Side questions"}
      testId="btw-sheet"
      leading={
        selected ? (
          <button
            type="button"
            aria-label="All side questions"
            onClick={() => patchView(sessionPath, { selectedId: null })}
            className="pressable -ml-3 flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ArrowLeftIcon aria-hidden className="size-5" />
          </button>
        ) : undefined
      }
      footer={footer}
    >
      {error ? <ErrorNotice message={error} onDismiss={() => setError(null)} className="mb-3" /> : null}
      {body}
    </BottomSheet>
  );
}
