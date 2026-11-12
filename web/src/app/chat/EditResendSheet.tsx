"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/app/ui/Sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  DaemonApi,
  sendPromptDurably,
  isOwnershipError,
} from "@/runtime/rpc-client";
import { readPairingToken } from "@/platform/browser-storage";
import { showBanner, showToast } from "@/app/Notices";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import type { UiMessage } from "@/domain/messages";
import { loadMessageImages } from "@/runtime/message-images";

type EditResendSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialText: string;
  initialImages?: Pick<UiMessage, "parts" | "localAttachmentCount">;
  sessionPath: string | null;
  branchFromEntryId?: string | null;
  rewind?: boolean;
  onBranched?: (sessionPath: string) => void;
};

export function EditResendSheet({
  open,
  onOpenChange,
  initialText,
  initialImages,
  sessionPath,
  branchFromEntryId,
  rewind,
  onBranched,
}: EditResendSheetProps) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const isRewind = rewind ?? Boolean(branchFromEntryId);
  const token = readPairingToken() ?? "";
  const generation = useRef(0);
  const pending = useRef(false);
  const handedOff = useRef(false);
  // Once created, the branch belongs to this edit intent even if enqueue fails.
  const branchPath = useRef<string | null>(null);
  const view = useRef({ open, sessionPath, initialText, initialImages, branchFromEntryId, isRewind });
  view.current = { open, sessionPath, initialText, initialImages, branchFromEntryId, isRewind };
  const invalidate = useCallback(() => {
    generation.current++;
    pending.current = false;
    setBusy(false);
  }, []);
  useLayoutEffect(() => {
    invalidate();
    handedOff.current = false;
    branchPath.current = null;
    if (open) setText(initialText);
    return invalidate;
  }, [open, sessionPath, initialText, initialImages, branchFromEntryId, isRewind, token, invalidate]);
  const changeOpen = (next: boolean) => {
    if (!next) {
      view.current.open = false;
      invalidate();
    }
    onOpenChange(next);
  };
  const trimmed = text.trim();
  const imageCount = initialImages?.parts.filter((part) => part.kind === "image").length ?? 0;
  const canSend = (trimmed.length > 0 || imageCount > 0 || !!initialImages?.localAttachmentCount) && !busy && !handedOff.current && !!sessionPath;

  const handleSend = async () => {
    const selected = view.current;
    if (!selected.open || pending.current || handedOff.current || selected.sessionPath !== sessionPath ||
        selected.initialText !== initialText || selected.initialImages !== initialImages || selected.branchFromEntryId !== branchFromEntryId ||
        selected.isRewind !== isRewind || (readPairingToken() ?? "") !== token) return;
    if (!sessionPath) {
      showToast("Couldn’t find this chat.", "error");
      return;
    }
    if (!trimmed && !imageCount && !initialImages?.localAttachmentCount) return;
    const attempt = ++generation.current;
    pending.current = true;
    const current = () => generation.current === attempt && view.current.open &&
      (readPairingToken() ?? "") === token &&
      view.current.sessionPath === sessionPath && view.current.initialText === initialText &&
      view.current.initialImages === initialImages &&
      view.current.branchFromEntryId === branchFromEntryId && view.current.isRewind === isRewind;
    setBusy(true);
    try {
      const images = initialImages ? await loadMessageImages(initialImages, (path) => fetch(path, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })) : [];
      if (!current()) return;
      let target = sessionPath;
      if (isRewind) {
        if (!branchFromEntryId) {
          showToast("Couldn’t identify this turn. Reopen the conversation and try again.", "error");
          return;
        }
        if (!branchPath.current) {
          const branched = await new DaemonApi(token).branch(sessionPath, branchFromEntryId);
          if (!current()) return;
          if (branched.cancelled) {
            showToast("Branch cancelled", "warn");
            return;
          }
          branchPath.current = branched.sessionPath;
        }
        target = branchPath.current;
      }
      await sendPromptDurably(target, trimmed, images, {
        token,
        onSaved: () => {
          if (!current()) return;
          handedOff.current = true;
          // The outbox now owns recovery, including failures saving a later
          // receipt. Never leave the same payload available as a fresh draft.
          setText("");
          changeOpen(false);
          if (isRewind) {
            if (onBranched) onBranched(target);
            else window.location.hash = `#s=${encodeURIComponent(target)}`;
          }
        },
      });
    } catch (e) {
      if (!current()) return;
      if (isOwnershipError(e)) {
        // `humanizeDaemonError` strips the guard's pid/command line and shows
        // WHY automatic sharing failed; the raw message here used to be shown
        // verbatim whenever it merely mentioned "collab", boilerplate and all.
        showBanner(humanizeDaemonError(e), "warn");
      } else {
        showToast(humanizeDaemonError(e), "error");
      }
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <BottomSheet
      open={open}
      onOpenChange={changeOpen}
      title={isRewind ? "Edit & rewind" : "Edit & resend"}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => changeOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSend()} disabled={!canSend}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-meta text-muted-foreground">
          {isRewind
            ? "Starts a new branch from that message. The original stays as it was."
            : "Sends as a new message. The original stays in the transcript."}
        </p>
        {imageCount > 0 ? <p className="text-meta text-muted-foreground">{imageCount} {imageCount === 1 ? "photo" : "photos"} included</p> : null}
        <Textarea
          value={text}
          readOnly={busy || handedOff.current}
          onChange={(e) => { if (!pending.current && !handedOff.current) setText(e.target.value); }}
          placeholder="Edit your message…"
          className="min-h-30 max-h-[32dvh] resize-none rounded-lg border-0 bg-surface-2 px-4 py-3 text-body shadow-none focus-visible:ring-2 focus-visible:ring-ring/40"
          autoFocus
        />
      </div>
    </BottomSheet>
  );
}
