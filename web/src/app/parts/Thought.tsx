"use client";

import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { MessageResponse } from "@/components/ai-elements/message";

import { prefersReducedMotion, useAppearance } from "@/platform/appearance";

import { cn } from "@/lib/utils";

import { ShimmerText } from "./ShimmerText";
import { thoughtLabel, type ThinkingUiPart } from "./run-summary";

/**
 * Reasoning is a side note to the reply: muted UI text, never a quote, never a card.
 * It goes through the reply's markdown renderer (`**Planning**` and `- item` showed
 * literally as raw text), scaled down: paragraphs and lists sit tight, headings are
 * the same 15px as the text so a title never outshouts the answer it precedes.
 */
const THOUGHT_TEXT = "min-w-0 break-words [overflow-wrap:anywhere] text-ui text-muted-foreground " +
  "[&_.md-body]:text-ui [&_.md-body_p]:my-1.5 [&_.md-body_ul]:my-1.5 [&_.md-body_ol]:my-1.5 [&_.md-body_li]:my-0.5 [&_.md-body_li>p]:my-0.5 " +
  "[&_.md-body_:is(h1,h2,h3,h4)]:mt-2 [&_.md-body_:is(h1,h2,h3,h4)]:mb-1 [&_.md-body_:is(h1,h2,h3,h4)]:text-ui [&_.md-body_:is(h1,h2,h3,h4)]:leading-normal [&_.md-body_:is(h1,h2,h3,h4)]:font-medium " +
  "[&_.md-body_pre]:my-2 [&_.md-body>*:first-child]:mt-0 [&_.md-body>*:last-child]:mb-0";

/** `--dur-disclosure` as milliseconds; the Web Animations API cannot read a var(). */
function disclosureMs(el: HTMLElement): number {
  const raw = getComputedStyle(el).getPropertyValue("--dur-disclosure").trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 240;
  return raw.endsWith("ms") ? value : value * 1000;
}

/**
 * The model's reasoning, in one component everywhere: a quiet "Thought for
 * 12s" row that opens in place. Only the block being written streams its
 * words open; once it settles it folds into the row.
 */
export function Thought({ thought, live = false, ms, latest = false }: {
  thought: ThinkingUiPart;
  live?: boolean;
  /** Measured duration (run-summary `thoughtMs`). */
  ms?: number;
  /** The newest thought in the chat: Thinking → "latest" leaves it open once settled. */
  latest?: boolean;
}) {
  const { thinking } = useAppearance();
  // null until tapped: "latest" keeps only the newest thought open and folds it
  // once a newer one arrives, unless the reader has chosen for this thought.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (latest && thinking === "latest");
  const text = thought.text.trim();
  const liveBlock = live && !thought.redacted && !!text && thinking !== "hidden";
  // Settling used to swap the whole live block for the one-line row in one commit,
  // so everything below jumped up by the thought's height. Only a block that was
  // on screen live folds; one that mounts settled (history) never does. Derived in
  // render, not in an effect, so the first settled commit already keeps the old
  // height and the parent's own settle tween (RunSummary) sees no change to chase.
  const [wasLive, setWasLive] = useState(liveBlock);
  const [folding, setFolding] = useState(false);
  if (wasLive !== liveBlock) {
    setWasLive(liveBlock);
    setFolding(wasLive && !live && !thought.redacted && !!text && thinking !== "hidden" && !prefersReducedMotion()
      && typeof document !== "undefined" && typeof document.documentElement.animate === "function");
  }
  const foldRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = foldRef.current;
    if (!folding || !el) return;
    const end = () => setFolding(false);
    // The text is unchanged this commit, so the height is still the live one.
    const from = el.offsetHeight;
    const to = 2 * parseFloat(getComputedStyle(document.documentElement).fontSize); // the row's min-h-8
    if (from - to <= 1) { end(); return; }
    const tween = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: disclosureMs(el), easing: "ease-in-out" });
    tween.onfinish = end;
    tween.oncancel = end;
    return () => { tween.onfinish = null; tween.oncancel = null; tween.cancel(); };
  }, [folding]);
  if (folding && !live) {
    return (
      <div ref={foldRef} className="min-w-0 overflow-hidden py-1.5" data-testid="thought" data-folding="true">
        <div aria-live="off" className={THOUGHT_TEXT}>
          <MessageResponse>{text}</MessageResponse>
        </div>
      </div>
    );
  }
  if (live && !thought.redacted) {
    if (!text || thinking === "hidden") return <ShimmerText className="flex h-8 items-center text-ui">Thinking…</ShimmerText>;
    return (
      <div ref={foldRef} className="min-w-0 py-1.5" data-testid="thought" data-live="true">
        {/* Streaming text must not be announced token by token. */}
        <div aria-live="off" className={THOUGHT_TEXT} data-testid="thought-text">
          <MessageResponse isAnimating>{text}</MessageResponse>
        </div>
      </div>
    );
  }
  if (thinking === "hidden" || (!text && !thought.redacted)) return null;
  const label = thoughtLabel(thought, ms);
  return (
    <div className="min-w-0" data-testid="thought">
      <button
        type="button"
        disabled={thought.redacted}
        aria-expanded={thought.redacted ? undefined : open}
        onClick={() => setChosen(!open)}
        className="relative flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg text-left text-ui text-muted-foreground outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] press-bounce focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="thought-toggle"
      >
        <BrainIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {thought.redacted ? null : (
          <ChevronRightIcon aria-hidden className={cn("size-4 shrink-0 text-tertiary transition-transform duration-[var(--dur-disclosure)] ease-in-out", open && "rotate-90")} />
        )}
      </button>
      {!thought.redacted && open ? (
        <div className={cn(THOUGHT_TEXT, "disclosure pb-1 pl-6")} data-testid="thought-text">
          <MessageResponse>{text}</MessageResponse>
        </div>
      ) : null}
    </div>
  );
}
