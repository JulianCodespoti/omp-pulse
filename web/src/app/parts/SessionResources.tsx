"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { showToast } from "@/app/Notices";
import { retryableLazy as lazy } from "../ui/retryable-lazy";
import { LazyMount } from "../ui/LazyMount";

// Static import would pull the reader/editor sheet into every eager chat chunk.
const FileViewer = lazy(async () => ({ default: (await import("@/app/tools/FileViewer")).FileViewer }));
const ResourceContext = createContext<((uri: string) => void) | null>(null);
// The conversation a transcript part belongs to: the daemon serves an image
// embedded by a computer path only for the transcript that embeds it.
const ResourceSessionContext = createContext<string | null>(null);

export function useResourceSession(): string | null {
  return useContext(ResourceSessionContext);
}

export function isSessionResource(uri: string): boolean {
  return /^(?:local|artifact):/i.test(uri);
}

/** The source is supplied by the transcript, never read from the active store. */
export function SessionResources({ sessionPath, children }: { sessionPath?: string | null; children: ReactNode }) {
  const [selection, setSelection] = useState<{ sessionPath: string; uri: string } | null>(null);
  const [open, setOpen] = useState(false);
  const activate = useCallback((uri: string) => {
    if (!sessionPath) {
      showToast("This conversation’s saved files are unavailable.", "warn");
      return;
    }
    setSelection({ sessionPath, uri });
    setOpen(true);
  }, [sessionPath]);
  return <ResourceContext.Provider value={activate}>
    <ResourceSessionContext.Provider value={sessionPath ?? null}>{children}</ResourceSessionContext.Provider>
    {selection ? <LazyMount open={open} onClose={() => setOpen(false)}>
      <FileViewer open={open} onOpenChange={setOpen} path={selection.uri} sessionPath={selection.sessionPath} />
    </LazyMount> : null}
  </ResourceContext.Provider>;
}

export function SessionResourceLink({ uri, children }: { uri: string; children: ReactNode }) {
  const activate = useContext(ResourceContext);
  const onClick = useMemo(() => () => {
    if (activate) activate(uri);
    else showToast("This conversation’s saved files are unavailable.", "warn");
  }, [activate, uri]);
  // No custom-scheme href can reach browser/system URL dispatch, including
  // modifier clicks, context menus, and a missing originating conversation.
  return <button type="button" className="inline break-all text-left underline decoration-primary/30 underline-offset-2" onClick={onClick} title={uri}>{children}</button>;
}
