"use client";
// Derived from Vercel AI Elements (Apache-2.0, Copyright 2023 Vercel, Inc.); modified for omp-pulse. See NOTICE in this directory.

import { cn } from "@/lib/utils";
import { NavigationOwnershipProvider } from "./navigation-ownership";
import {
  TranscriptViewportContent,
  TranscriptViewportRoot,
  type TranscriptViewportContentProps,
  type TranscriptViewportRootProps,
} from "./transcript-viewport";

export type ConversationProps = TranscriptViewportRootProps;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <NavigationOwnershipProvider>
  <TranscriptViewportRoot
    className={cn("relative flex-1 overflow-y-hidden", className)}
    // Who moves the view (following a stream, a row toggle keeping its place,
    // the escapes a reader makes) lives in transcript-viewport.tsx.
    //
    // There is no `initial` animation to choose: opening is instant and happens
    // inside the first measurement. It used to be "smooth" because message
    // navigation moved the view without leaving the stick-to-bottom lock, so
    // content growing afterwards (lazy images, async Shiki replacing code
    // markup) re-stuck and yanked the view back, undoing the reader's first Up
    // presses (verify-nav-paging walked 119, 118, 119, 118). Navigation now
    // calls `release("program")` before it moves, so an instant opening cannot
    // be undone. "smooth" is also what painted the page 5,546 px above the
    // newest message and travelled 730-790 ms through ~45 visible positions,
    // flashing the Down button on the way.
    //
    // `log` keeps the transcript's semantics, but its implicit polite live
    // region re-read the whole conversation as it streamed (A11Y-04). The
    // turn status line (TurnStatus.tsx) announces progress instead.
    role="log"
    aria-live="off"
    {...props}
  />
  </NavigationOwnershipProvider>
);

export type ConversationContentProps = TranscriptViewportContentProps;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <TranscriptViewportContent
    // No gap: the transcript's rhythm is per pair of items (parts/spacing.ts).
    className={cn("flex flex-col p-4", className)}
    {...props}
  />
);
