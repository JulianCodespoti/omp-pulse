import { ChevronRightIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentDiscussionReference } from "../../domain/agent-discussion";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "../ui/Sheet";

type ReferenceVisit = {
  opener: HTMLButtonElement;
  open: boolean;
  mounted: boolean;
  relinquished: boolean;
};

/** Presentation only: the Composer owns proof that these bytes are in its draft. */
export function AgentReferenceRows({ references, onRemove, onEditFullDraft, getEditor }: {
  references: readonly AgentDiscussionReference[];
  onRemove: (identity: string) => void;
  onEditFullDraft: () => void;
  getEditor: () => HTMLTextAreaElement | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const visitRef = useRef<ReferenceVisit | null>(null);
  const visit = visitRef.current;
  const reference = references.find((item) => item.identity === selected);
  const open = !!reference;
  useEffect(() => {
    if (!reference) setSelected(null);
  }, [reference]);
  useLayoutEffect(() => {
    if (!visit) return;
    visit.open = open;
    visit.mounted = true;
    // A closing visit must remember a successor even if it immediately blurs.
    // Checking only document.activeElement at the end would revive this sheet.
    const onFocus = (event: FocusEvent) => {
      const next = event.target;
      const target = visit.opener.isConnected ? visit.opener : getEditor();
      if (!visit.open && next instanceof HTMLElement && next !== document.body
        && next !== target && !next.closest('[data-testid="compact-reference-sheet"]')) {
        visit.relinquished = true;
      }
    };
    const onNavigation = () => { visit.relinquished = true; };
    document.addEventListener("focusin", onFocus, true);
    window.addEventListener("popstate", onNavigation);
    window.addEventListener("hashchange", onNavigation);
    return () => {
      visit.mounted = false;
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("popstate", onNavigation);
      window.removeEventListener("hashchange", onNavigation);
    };
  }, [getEditor, open, visit]);
  const returnFocus = useCallback(
    () => {
      if (!visit || visitRef.current !== visit || !visit.mounted || visit.open || visit.relinquished) return false;
      const editor = getEditor();
      return editor ? (visit.opener.isConnected ? visit.opener : editor) : false;
    },
    [getEditor, visit],
  );
  const closeDetails = useCallback(() => {
    // Close intent precedes React's commit. A successor can focus and blur in
    // this same event, before the closing layout effect has a chance to run.
    if (visitRef.current) visitRef.current.open = false;
    setSelected(null);
  }, []);

  return <>
    {references.length ? <div className="px-3 pt-3">
      {references.length > 2 ? <p className="mb-1 text-meta text-muted-foreground" aria-hidden="true">
        {references.length} agent references
      </p> : null}
      <div
        aria-label={`${references.length} agent ${references.length === 1 ? "reference" : "references"}`}
        className="flex max-h-24 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain"
        data-testid="compact-reference-list"
        role="group"
      >
        {references.map((item) => <div
          className="flex h-11 min-w-0 shrink-0 items-center rounded-lg bg-surface-2"
          data-testid="compact-reference-row"
          key={item.identity}
        >
          <button
            aria-label={`Details for ${item.name}`}
            className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-l-lg px-3 text-left text-ui active:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="compact-reference-details"
            onClick={(event) => {
              if (visitRef.current) visitRef.current.relinquished = true;
              visitRef.current = { opener: event.currentTarget, open: true, mounted: true, relinquished: false };
              setSelected(item.identity);
            }}
            type="button"
          >
            <span className="shrink-0 text-muted-foreground">About</span>
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <ChevronRightIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          </button>
          <button
            aria-label={`Remove reference to ${item.name}`}
            className="flex size-11 shrink-0 items-center justify-center rounded-r-lg text-muted-foreground active:bg-surface-3 focus-visible:outline-2 focus-visible:outline-ring"
            data-testid="compact-reference-remove"
            onClick={() => {
              if (selected === item.identity) closeDetails();
              onRemove(item.identity);
            }}
            type="button"
          ><XIcon aria-hidden="true" className="size-5" /></button>
        </div>)}
      </div>
    </div> : null}
    <BottomSheet
      open={open}
      onOpenChange={(open) => { if (!open) closeDetails(); }}
      returnFocus={returnFocus}
      testId="compact-reference-sheet"
      title="Agent reference"
      footer={<Button
        className="w-full"
        data-testid="compact-reference-edit-full-draft"
        onClick={() => { closeDetails(); onEditFullDraft(); }}
      >Edit full draft</Button>}
    >
      <p className="mb-2 break-words text-ui font-medium [overflow-wrap:anywhere]">{reference?.name}</p>
      <p className="mb-4 text-ui text-muted-foreground">Included with your message in main chat.</p>
      <div className="mb-4 whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 text-meta [overflow-wrap:anywhere]" data-testid="compact-reference-text">{reference?.text}</div>
    </BottomSheet>
  </>;
}
