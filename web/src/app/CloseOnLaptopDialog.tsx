"use client";

import { useCallback, useLayoutEffect, useRef, useState, type JSX } from "react";
import { showToast } from "./Notices";
import { Notice } from "./ui/Notice";
import { humanizeDaemonError } from "./ui/OwnedBySession";
import { ConfirmSheet } from "./ui/Sheet";

import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi } from "@/runtime/rpc-client";

export function CloseOnLaptopDialog({
  open,
  onOpenChange,
  sessionPath,
  title,
  project,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionPath: string;
  title: string;
  project: string | null;
  onClosed: () => void;
}): JSX.Element {
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generation = useRef(0);
  const pending = useRef(false);
  const view = useRef({ open, sessionPath });
  view.current = { open, sessionPath };
  const invalidate = useCallback(() => {
    generation.current++;
    pending.current = false;
    setClosing(false);
  }, []);
  useLayoutEffect(() => {
    invalidate();
    setError(null);
    return invalidate;
  }, [open, sessionPath, invalidate]);

  const confirmClose = async () => {
    if (!open || pending.current) return;
    const request = ++generation.current;
    pending.current = true;
    const current = () => request === generation.current && view.current.open && view.current.sessionPath === sessionPath;
    setClosing(true);
    setError(null);
    try {
      const result = await new DaemonApi(readPairingToken()).closeOnLaptop(sessionPath);
      if (!current()) return;
      if (!result.ok) {
        setError(humanizeDaemonError(result.error ?? "Your computer couldn\u2019t confirm this session is idle, so nothing was closed."));
        return;
      }
      showToast("Closed on your computer", "success");
      onClosed();
      onOpenChange(false);
    } catch (cause: unknown) {
      if (current()) setError(humanizeDaemonError(cause));
    } finally {
      if (current()) { pending.current = false; setClosing(false); }
    }
  };

  return (
    <ConfirmSheet
      open={open}
      onOpenChange={(next) => {
        if (pending.current) return;
        if (!next) invalidate();
        onOpenChange(next);
      }}
      title="Close on your computer?"
      description="Only this idle session exits; its conversation stays saved, and your computer refuses if the session is busy."
      confirmLabel="Close on computer"
      onConfirm={() => void confirmClose()}
      busy={closing}
      busyLabel="Closing…"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="truncate text-ui text-foreground">{title}</p>
        {project ? <p className="truncate text-meta text-muted-foreground">{project}</p> : null}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </ConfirmSheet>
  );
}
