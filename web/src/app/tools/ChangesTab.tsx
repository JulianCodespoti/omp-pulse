import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  AlertTriangleIcon,
  FileMinusIcon,
  FilePenIcon,
  FilePlusIcon,
  FileQuestionIcon,
  FileSymlinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCompareIcon,
  NotebookPenIcon,
  RefreshCwIcon,
  WrapTextIcon,
} from "lucide-react";

import { closePanels, openSettingsPage, openSwitcher, openWorkspace } from "@/app/nav/panels";
import { ChangeCounts, DiffView } from "@/app/parts/DiffPart";
import { EmptyState } from "@/app/ui/EmptyState";
import { Notice } from "@/app/ui/Notice";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { RowSkeleton } from "@/app/ui/Row";
import { BottomSheet } from "@/app/ui/Sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { buildAnnotatedReviewPrompt, reviewNoteIsCurrent, type ReviewLineAnchor, type ReviewNote } from "@/domain/review-notes";
import { cn } from "@/lib/utils";
import { getAppearance } from "@/platform/appearance";
import { readPairingToken } from "@/platform/browser-storage";
import { isPhoneMode } from "@/platform/local-mode";
import type { WorkspaceChangedFile, WorkspaceChangeStatus, WorkspaceChanges, WorkspaceUnmergedStatus } from "@/runtime/api-types";
import { getOfflineQueueNamespace } from "@/runtime/offline-queue";
import { readReviewNotes, removeReviewNote, saveReviewNote } from "@/runtime/review-notes";
import { selectSessionTurn } from "@/runtime/omp-store";
import { DaemonApi, ForbiddenError } from "@/runtime/rpc-client";

import { useWorkspaceHost } from "./workspace-host";

const STATUS: Record<WorkspaceChangeStatus, { Icon: typeof FilePenIcon; tone: string; label: string }> = {
  modified: { Icon: FilePenIcon, tone: "text-warning", label: "Modified" },
  added: { Icon: FilePlusIcon, tone: "text-success", label: "Added" },
  deleted: { Icon: FileMinusIcon, tone: "text-danger", label: "Deleted" },
  renamed: { Icon: FileSymlinkIcon, tone: "text-running", label: "Renamed" },
  untracked: { Icon: FileQuestionIcon, tone: "text-muted-foreground", label: "Untracked" },
  conflicted: { Icon: AlertTriangleIcon, tone: "text-danger", label: "Unresolved conflict" },
};

const CONFLICT_LABELS: Record<WorkspaceUnmergedStatus, string> = {
  DD: "Both deleted",
  AU: "Added by us",
  UD: "Deleted by them",
  UA: "Added by them",
  DU: "Deleted by us",
  AA: "Both added",
  UU: "Both modified",
};

type Load =
  | { state: "loading" }
  | { state: "ready"; data: WorkspaceChanges }
  | { state: "forbidden" }
  | { state: "unsupported" }
  | { state: "error"; message: string; cause: unknown };

function FilePath({ path, stacked }: { path: string; stacked: boolean }): JSX.Element {
  // An untracked nested repository is listed as `dir/`; its name is the dir.
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  const dir = cut === -1 ? "" : trimmed.slice(0, cut + 1);
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  // Collapsed: the name is the title and the directory its one muted line, so
  // a long path never crowds the name. Expanded (a 30px pinned header) both
  // share a line, the directory giving way first.
  if (stacked) {
    return (
      <span className="flex min-w-0 flex-1 flex-col" title={path}>
        <span className="truncate text-foreground">{name}</span>
        {dir ? <span className="truncate text-meta text-muted-foreground">{dir}</span> : null}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-baseline" title={path}>
      {dir ? <span className="min-w-0 truncate text-muted-foreground">{dir}</span> : null}
      <span className="min-w-0 shrink-0 truncate text-foreground">{name}</span>
    </span>
  );
}

function FileBody({ file, wrap, onAnnotate }: { file: WorkspaceChangedFile; wrap: boolean; onAnnotate?: (line: ReviewLineAnchor) => void }): JSX.Element {
  if (file.binary) return <p className="px-4 py-3 text-meta text-muted-foreground">Binary file, not shown.</p>;
  if (!file.patch) {
    return (
      <p className="px-4 py-3 text-meta text-muted-foreground">
        {file.patchTruncated ? "Diff too large to show." : "No diff to show."}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <DiffView patch={file.patch} wrap={wrap} onAnnotate={onAnnotate} />
      {file.patchTruncated ? (
        <p className="px-4 py-3 text-meta text-muted-foreground">Diff too large. The rest isn’t shown.</p>
      ) : null}
    </div>
  );
}

function ChangedFile({
  file,
  expanded,
  wrap,
  onToggle,
  onFileNote,
  onLineNote,
}: {
  file: WorkspaceChangedFile;
  expanded: boolean;
  wrap: boolean;
  onToggle: () => void;
  onFileNote?: () => void;
  onLineNote?: (line: ReviewLineAnchor) => void;
}): JSX.Element {
  const status = STATUS[file.status];
  const conflictLabel = file.status === "conflicted"
    ? `Unresolved conflict${file.unmerged ? ` · ${CONFLICT_LABELS[file.unmerged]}` : ""}`
    : null;
  return (
    <section data-testid="changes-file" data-status={file.status} className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${conflictLabel ?? status.label} ${file.path}, ${file.additions} added, ${file.deletions} removed`}
        onClick={onToggle}
        className={cn(
          "relative flex min-w-0 items-center gap-3 text-left text-ui outline-none pressable focus-visible:bg-surface-2",
          // Expanded, the row shrinks to a 30px header that stays pinned while
          // its diff scrolls under it; the hit area keeps 44px.
          expanded
            ? "sticky top-0 z-sticky h-[30px] w-full bg-background px-4 text-meta after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']"
            : "pressable mx-1 min-h-14 w-[calc(100%-0.5rem)] rounded-xl px-3 py-2",
        )}
      >
        {expanded ? (
          <status.Icon aria-hidden className={cn("size-3.5 shrink-0", status.tone)} />
        ) : (
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2">
            <status.Icon className={cn("size-4.5", status.tone)} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <FilePath path={file.path} stacked={!expanded} />
          {!expanded && file.status === "renamed" && file.oldPath ? (
            <span className="truncate text-meta text-muted-foreground">Renamed from {file.oldPath}</span>
          ) : null}
          {conflictLabel ? <span className="text-meta text-danger">{conflictLabel}</span> : null}
        </span>
        <span className="text-meta">
          <ChangeCounts added={file.additions} removed={file.deletions} />
        </span>
      </button>
      {expanded ? (
        <>
          {conflictLabel ? <p className="px-4 py-2 text-meta text-muted-foreground">Git still has unmerged index entries. Removing conflict markers alone does not mark this file resolved.</p> : null}
          {onFileNote ? <div className="px-4 pt-2"><Button type="button" variant="ghost" className="min-h-12" onClick={onFileNote}>Add file note</Button></div> : null}
          <FileBody file={file} wrap={wrap} onAnnotate={onLineNote} />
        </>
      ) : null}
    </section>
  );
}

export function ChangesTab({ sessionPath, active }: { sessionPath: string; active: boolean }): JSX.Element {
  const host = useWorkspaceHost();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [wrap, setWrap] = useState(() => getAppearance().wrapCode);
  const request = useRef<AbortController | null>(null);
  const namespace = getOfflineQueueNamespace();
  const token = readPairingToken();
  const scopeKey = JSON.stringify([namespace, sessionPath]);
  const [saved, setSaved] = useState<{ key: string; notes: ReviewNote[] }>({ key: scopeKey, notes: [] });
  const notes = saved.key === scopeKey ? saved.notes : [];
  const [notesMode, setNotesMode] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ note: ReviewNote; text: string; saved: boolean } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const view = useRef({ sessionPath, namespace, token, host, active });
  view.current = { sessionPath, namespace, token, host, active };
  const current = useCallback(() => {
    const now = view.current;
    return now.sessionPath === sessionPath && now.namespace === namespace && now.token === token
      && now.host === host && now.active && getOfflineQueueNamespace() === namespace && readPairingToken() === token;
  }, [sessionPath, namespace, token, host]);

  useEffect(() => {
    setEditor(null);
    setNoteError(null);
    try { setSaved({ key: scopeKey, notes: readReviewNotes({ namespace, sessionPath }) }); }
    catch (error) { setSaved({ key: scopeKey, notes: [] }); setNoteError(error instanceof Error ? error.message : String(error)); }
  }, [scopeKey, namespace, sessionPath, active, token]);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPreparing(false);
    setRefreshing(true);
    try {
      const data = await new DaemonApi(token).getChanges(sessionPath, controller.signal);
      if (request.current !== controller || !current()) return;
      setLoad({ state: "ready", data });
    } catch (error) {
      if (request.current !== controller || !current()) return;
      // A refresh that fails keeps the list it had; only a first read shows
      // the failure in place of the list.
      setLoad((previous) => {
        if (error instanceof ForbiddenError) return { state: "forbidden" };
        // A 404 for anything but the session file is a computer whose
        // omp-pulse predates /api/changes: an upgrade, not a failure.
        const status = (error as { status?: unknown } | null)?.status;
        if (status === 404 && !/session file not found/i.test(String((error as Error).message))) return { state: "unsupported" };
        return previous.state === "ready" ? previous : { state: "error", message: humanizeDaemonError(error), cause: error };
      });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setRefreshing(false);
      }
    }
  }, [sessionPath, token, current]);

  useEffect(() => {
    setLoad({ state: "loading" });
    setExpanded(new Set());
    setRefreshing(false);
    setPreparing(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [sessionPath, namespace, token]);

  // Every visit re-reads: the agent edits files between looks.
  useEffect(() => {
    if (active) void refresh();
    return () => {
      request.current?.abort();
      request.current = null;
      setRefreshing(false);
      setPreparing(false);
    };
  }, [active, refresh]);

  // A finished turn is when the working tree settles; re-read then if shown.
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!host) return;
    const store = host.controller.getStore();
    let running = selectSessionTurn(store.getState(), sessionPath) === "running";
    return store.subscribe(() => {
      const now = selectSessionTurn(store.getState(), sessionPath) === "running";
      if (running && !now && activeRef.current) void refresh();
      running = now;
    });
  }, [host, sessionPath, refresh]);

  const toggle = (path: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const openNote = (file: WorkspaceChangedFile, line?: ReviewLineAnchor) => {
    if (!current() || load.state !== "ready" || !load.data.repoRoot) return;
    setNoteError(null);
    setEditor({
      note: {
        id: crypto.randomUUID(), text: "", scope: line ? "line" : "file",
        file: { ...file }, repoRoot: load.data.repoRoot, branch: load.data.branch,
        ...(line ? { line: { ...line } } : {}),
      },
      text: "", saved: false,
    });
  };

  const saveNote = () => {
    if (!editor || !current()) return;
    try {
      const updated = saveReviewNote({ namespace, sessionPath }, { ...editor.note, text: editor.text });
      setSaved({ key: scopeKey, notes: updated });
      setEditor(null);
      setNoteError(null);
    } catch (error) { setNoteError(error instanceof Error ? error.message : String(error)); }
  };

  const removeNote = () => {
    if (!editor || !current()) return;
    try {
      setSaved({ key: scopeKey, notes: removeReviewNote({ namespace, sessionPath }, editor.note.id) });
      setEditor(null);
      setNoteError(null);
    } catch (error) { setNoteError(error instanceof Error ? error.message : String(error)); }
  };

  const prepareReview = async () => {
    if (!host || !current() || preparing || !notes.length) return;
    const receiptScope = host.controller.getReceiptScope();
    const ownsSession = () => current() && receiptScope !== "" && host.controller.getReceiptScope() === receiptScope
      && host.controller.getStore().getState().sessionPath === sessionPath && !host.controller.getStore().getState().authRejected;
    if (!ownsSession()) { setNoteError("Open this session in Chat before preparing its review."); return; }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPreparing(true);
    setRefreshing(true);
    setNoteError(null);
    try {
      const changes = await new DaemonApi(token).getChanges(sessionPath, controller.signal);
      if (request.current !== controller || !ownsSession()) return;
      setLoad({ state: "ready", data: changes });
      // Read persisted notes again: another view may have changed them.
      const persisted = readReviewNotes({ namespace, sessionPath });
      setSaved({ key: scopeKey, notes: persisted });
      if (!persisted.length) throw new Error("Add a note before preparing a review.");
      const prompt = buildAnnotatedReviewPrompt(persisted, changes);
      if (!ownsSession()) return;
      if (!host.controller.prepareEditorDraft(sessionPath, prompt)) throw new Error("The open session changed. Your notes are saved; reopen this session before preparing its review.");
      closePanels();
    } catch (error) {
      if (request.current === controller && ownsSession()) setNoteError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPreparing(false);
        setRefreshing(false);
      }
    }
  };

  let body: JSX.Element;
  if (load.state === "loading") {
    body = (
      <div aria-busy className="-mx-4 flex flex-col" data-testid="changes-loading">
        <RowSkeleton leading />
        <RowSkeleton leading />
        <RowSkeleton leading />
      </div>
    );
  } else if (load.state === "forbidden") {
    body = <Notice tone="warning" action={{ label: "Device access", onClick: () => openSettingsPage("computer") }}>This device can’t view changes.</Notice>;
  } else if (load.state === "unsupported") {
    body = (
      <EmptyState
        icon={<GitCompareIcon />}
        title="Changes aren’t available"
        description={isPhoneMode() ? "Update the Android app to see changes here." : "Update omp-pulse on your computer to see changes here."}
        action={{ label: "Update guide", onClick: () => { window.open(isPhoneMode() ? "https://github.com/JulianCodespoti/omp-pulse/blob/main/docs/user/phone-mode.md#getting-the-app-and-updates" : "https://github.com/JulianCodespoti/omp-pulse#desktop-daemon-mode", "_blank", "noopener,noreferrer"); } }}
      />
    );
  } else if (load.state === "error") {
    body = (
      <Notice tone="danger" title="Couldn’t load changes." action={errorRecoveryAction(load.cause) ?? (/safe.directory|dubious ownership/i.test(load.cause instanceof Error ? load.cause.message : String(load.cause)) ? { label: "Open terminal", onClick: () => openWorkspace("terminal") } : { label: "Retry", onClick: () => void refresh() })}>
        {load.message}
      </Notice>
    );
  } else if (load.data.notRepo) {
    body = (
      <EmptyState
        icon={<FolderGit2Icon />}
        title="Not a git repository"
        description="This session’s folder isn’t tracked by git."
      />
    );
  } else if (load.data.files.length === 0) {
    body = <EmptyState icon={<GitCompareIcon />} title="No changes" description="The working tree matches the last commit." />;
  } else {
    const { files } = load.data;
    body = (
      <div className="-mx-4 flex min-w-0 flex-col" data-testid="changes-list">
        {files.map((file) => (
          <ChangedFile
            key={file.path} file={file} expanded={expanded.has(file.path)} wrap={wrap} onToggle={() => toggle(file.path)}
            onFileNote={notesMode && active ? () => openNote(file) : undefined}
            onLineNote={notesMode && active ? (line) => openNote(file, line) : undefined}
          />
        ))}
        {load.data.truncated && files.length >= 1000 ? (
          <p className="px-4 py-3 text-meta text-muted-foreground">Showing the first 1,000 files.</p>
        ) : null}
      </div>
    );
  }

  const ready = load.state === "ready" && !load.data.notRepo ? load.data : null;
  const totals = ready?.files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  );

  const toolbar = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={notes.length ? `Notes (${notes.length})` : "Notes"}
        aria-pressed={notesMode}
        disabled={!active}
        onClick={() => setNotesMode((value) => !value)}
        className={cn("text-muted-foreground", notesMode && "bg-surface-3 text-foreground")}
      >
        <NotebookPenIcon aria-hidden className="size-4" />
        {notes.length ? <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-caption text-primary-foreground">{notes.length}</span> : null}
      </Button>
      {ready && ready.files.some((file) => !file.binary && file.patch) ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Wrap lines"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
          className={cn("text-muted-foreground", wrap && "bg-surface-3 text-foreground")}
        >
          <WrapTextIcon aria-hidden className="size-4" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={refreshing ? "Refreshing changes" : "Refresh changes"}
        aria-busy={refreshing}
        disabled={!active || refreshing}
        onClick={() => void refresh()}
        className="text-muted-foreground"
      >
        {refreshing ? <Spinner size={16} label={null} /> : <RefreshCwIcon aria-hidden className="size-4" />}
      </Button>
    </>
  );

  return (
    <div data-testid="changes-tab" className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {/* Keyed on the first read only: a refresh keeps the list in place. */}
        <div key={load.state === "loading" ? "loading" : "ready"} className="px-4 pb-6 pt-3 motion-safe:animate-fade-in">
          {ready ? null : <div className="mb-3 flex items-center justify-end gap-1">{toolbar}</div>}
          {ready ? (
            <div data-testid="changes-summary" className="mb-3 flex flex-col gap-2.5 rounded-xl bg-surface-1 p-4">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-title font-semibold text-foreground">
                  {ready.files.length === 0 ? "No changes" : ready.files.length === 1 ? "1 file" : `${ready.files.length} files`}
                </span>
                {toolbar}
              </div>
              {totals && totals.additions + totals.deletions > 0 ? (
                <div aria-hidden className="flex h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <span className="bg-success" style={{ width: `${(totals.additions / (totals.additions + totals.deletions)) * 100}%` }} />
                  <span className="flex-1 bg-danger" />
                </div>
              ) : null}
              <div className="flex min-w-0 items-center gap-3 text-meta text-muted-foreground">
                {totals && ready.files.length > 0 ? <ChangeCounts added={totals.additions} removed={totals.deletions} /> : null}
                <span className="flex min-w-0 items-center gap-1.5">
                  <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{ready.branch ?? "Detached HEAD"}</span>
                </span>
              </div>
            </div>
          ) : null}
          {noteError && !editor ? <Notice tone="danger" action={/open.*(?:session|chat)|reopen this session/i.test(noteError) ? { label: host?.controller.getStore().getState().sessionPath === sessionPath ? "Open chat" : "Choose session", onClick: () => { if (host?.controller.getStore().getState().sessionPath === sessionPath) closePanels(); else openSwitcher(); } } : errorRecoveryAction(noteError)}>{noteError}</Notice> : null}
          {notesMode ? <p className="py-2 text-meta text-muted-foreground">Expand a file to add a file note or choose an added, removed or context line. Notes stay on this device until you explicitly include them in a review.</p> : null}
          {notes.length ? (
            <section aria-label="Saved review notes" className="mb-3 border-b border-hairline">
              {notes.map((note) => {
                const stale = load.state === "ready" && !reviewNoteIsCurrent(note, load.data);
                return (
                  <button key={note.id} type="button" disabled={!active} className="flex min-h-12 w-full min-w-0 flex-col justify-center py-2 text-left text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setNoteError(null); setEditor({ note, text: note.text, saved: true }); }}>
                    <span className="max-w-full truncate text-foreground">{note.file.path} · {note.scope === "file" ? "File" : `old ${note.line?.oldLine ?? "—"} / new ${note.line?.newLine ?? "—"}`}{stale ? " · Stale" : ""}</span>
                    <span className="max-w-full truncate whitespace-pre text-muted-foreground">{note.text}</span>
                  </button>
                );
              })}
            </section>
          ) : null}
          {body}
        </div>
      </ScrollArea>
      {notes.length ? (
        <div className="shrink-0 border-t border-hairline p-3">
          <Button type="button" className="min-h-12 w-full" disabled={!active || !host || preparing || refreshing || !ready || notes.some((note) => !reviewNoteIsCurrent(note, ready))} onClick={() => void prepareReview()}>
            {preparing ? "Preparing review…" : "Prepare review"}
          </Button>
          <p className="pt-1 text-center text-meta text-muted-foreground">
            {!host ? "Open a chat to prepare a review." : ready && notes.some((note) => !reviewNoteIsCurrent(note, ready)) ? "Remove stale notes and recreate them on current changes." : "Prepares a draft in Chat. Only Send starts the review."}
            {!host ? <Button type="button" variant="ghost" className="min-h-12" onClick={openSwitcher}>Choose session</Button> : ready && notes.some((note) => !reviewNoteIsCurrent(note, ready)) ? <Button type="button" variant="ghost" className="min-h-12" onClick={() => { const note = notes.find((note) => !reviewNoteIsCurrent(note, ready)); if (note) setEditor({ note, text: note.text, saved: true }); }}>Review stale notes</Button> : null}
          </p>
        </div>
      ) : null}
      <BottomSheet
        open={active && editor !== null}
        onOpenChange={(open) => { if (!open) { setEditor(null); setNoteError(null); } }}
        title={editor?.saved ? "Edit review note" : "Add review note"}
        description={editor?.note.file.path}
        testId="review-note-editor"
        footer={(
          <div className="flex gap-2 p-4">
            {editor?.saved ? <Button type="button" variant="danger" className="min-h-12" onClick={removeNote}>Remove</Button> : null}
            <Button type="button" variant="ghost" className="min-h-12" onClick={() => { setEditor(null); setNoteError(null); }}>Cancel</Button>
            <Button type="button" className="ml-auto min-h-12" disabled={!editor?.text.trim()} onClick={saveNote}>Save note</Button>
          </div>
        )}
      >
        {editor ? (
          <div className="space-y-3 pb-4">
            {load.state === "ready" && !reviewNoteIsCurrent(editor.note, load.data) ? <Notice tone="warning">This snapshot changed or is missing. This note still refers to the captured context below. Remove it and recreate it on current changes before preparing a review.</Notice> : null}
            <p className="text-meta text-muted-foreground">{editor.note.branch ?? "Detached HEAD"} · {editor.note.repoRoot}</p>
            {editor.note.line ? (
              <div className="overflow-x-auto rounded-md bg-surface-1 p-3 font-mono text-code">
                <p className="text-muted-foreground">Old {editor.note.line.oldLine ?? "—"} / New {editor.note.line.newLine ?? "—"}</p>
                <pre className="whitespace-pre">{editor.note.line.hunkHeader}{"\n"}{editor.note.line.lineText}</pre>
              </div>
            ) : <p className="text-meta text-muted-foreground">Whole-file note · {editor.note.file.status}</p>}
            <details className="text-meta text-muted-foreground">
              <summary className="flex min-h-12 cursor-pointer items-center">Captured file diff</summary>
              <FileBody file={editor.note.file} wrap={wrap} />
            </details>
            <label className="block space-y-2 text-ui">
              <span>Note</span>
              <Textarea aria-label="Note" value={editor.text} onChange={(event) => setEditor({ ...editor, text: event.target.value })} className="min-h-32" />
            </label>
            {noteError ? <Notice tone="danger">{noteError}</Notice> : null}
          </div>
        ) : null}
      </BottomSheet>
    </div>
  );
}
