import {
  CopyIcon,
  CopyPlusIcon,
  MonitorIcon,
  MonitorOffIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ClipboardAttempt } from "@/platform/clipboard";
import { isPhoneMode } from "@/platform/local-mode";

import { sessionTurn, type OmpSessionSummary } from "../../domain/protocol";
import { haptic } from "../../platform/haptic";
import { showToast } from "../Notices";
import { readPairingToken } from "../../platform/browser-storage";
import { DaemonApi, isOwnershipError } from "../../runtime/rpc-client";
import {
  isOnLaptop,
  isPinned,
  laptopOpenedText,
  projectLabel,
  sessionTitle,
  togglePin,
} from "../session-format";
import { BottomSheet, SheetFooter } from "../ui/Sheet";
import { Notice } from "../ui/Notice";
import { Row, RowGroup } from "../ui/Row";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { errorRecoveryAction } from "../ui/error-recovery";
import { CloseOnLaptopDialog } from "../CloseOnLaptopDialog";
import { PluginMenuItems } from "../plugins/PluginMenuItems";
import { toPluginSession } from "../plugins/session-info";
import { usePluginKey } from "../plugins/use-plugin-host";
import { deleteSessionWithUndo } from "./delete-session";
import { ModelPicker } from "./ModelPicker";
import { SessionStopRequest } from "./stop-request";

const OWNED_RENAME = "Close this session on your computer to rename it.";

/** Stop for a working session. `capability` is the session authority's verdict (null = unknown, try). */
export interface SessionStopAction {
  run: (path: string) => Promise<unknown>;
  capability: boolean | null;
}

export function SessionActionsSheet({
  session,
  onOpenChange,
  onChanged,
  onOpenSession,
  stop,
  startRenaming = false,
}: {
  session: OmpSessionSummary | null;
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
  /** Open a session the way a row tap does (a fresh duplicate). */
  onOpenSession: (path: string) => void;
  /** Offered only while the session is working. */
  stop?: SessionStopAction;
  /** Open straight into the rename field (the drawer's Rename item); Cancel still returns to the actions. */
  startRenaming?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [mutationKind, setMutationKind] = useState<"rename" | "duplicate" | "computer" | "stop" | null>(null);
  const renameSaving = mutationKind === "rename";
  const duplicating = mutationKind === "duplicate";
  const [renameRefusal, setRenameRefusal] = useState<{ name: string; owned: boolean; message: string } | null>(null);
  const renameAttempt = useRef("");
  const openingOnComputer = mutationKind === "computer";
  const stopping = mutationKind === "stop";
  const mutationGeneration = useRef(0);
  const mutationPending = useRef(false);
  const sessionPathRef = useRef(session?.path);
  sessionPathRef.current = session?.path;
  const [stopRequest] = useState(() => new SessionStopRequest());
  const cancelMutation = useCallback(() => {
    mutationGeneration.current++;
    mutationPending.current = false;
    stopRequest.reset();
    setMutationKind(null);
  }, [stopRequest]);
  const [closeOnComputerOpen, setCloseOnComputerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  const [copyAttempt] = useState(() => new ClipboardAttempt());
  const [copying, setCopying] = useState(false);
  const [copyRecovery, setCopyRecovery] = useState<string | null>(null);
  const recoveryInput = useRef<HTMLTextAreaElement>(null);
  const clearCopy = useCallback(() => {
    copyAttempt.cancel();
    setCopying(false);
    setCopyRecovery(null);
  }, [copyAttempt]);
  const closeSheet = useCallback(() => {
    clearCopy();
    cancelMutation();
    onOpenChange(false);
  }, [clearCopy, cancelMutation, onOpenChange]);
  useLayoutEffect(() => {
    clearCopy();
    return () => copyAttempt.cancel();
  }, [session?.path, clearCopy, copyAttempt]);

  useLayoutEffect(() => {
    cancelMutation();
    setModelPickerOpen(false);
    setCloseOnComputerOpen(false);
    return cancelMutation;
  }, [session?.path, cancelMutation]);

  const open = !!session;
  // The key is retained only while the sheet is open (it has a session).
  const pluginContext = useMemo(() => (session ? { session: toPluginSession(session) } : null), [session]);
  const pluginMenu = usePluginKey("session.menu", session?.path ?? null, pluginContext);

  useEffect(() => {
    if (open && session) {
      setRenaming(startRenaming);
      setRenameValue((session.title as string) ?? "");
      setError(null);
      setRenameRefusal(null);
    }
    // Polling metadata for the same session must not erase a rename draft.
    // Opening the sheet or selecting another identity owns this reset.
  }, [open, session?.path]);

  const handlePinToggle = useCallback(() => {
    if (!session) return;
    // The row moving is the feedback; a toast only repeated it.
    togglePin(session.path);
    onChanged();
    closeSheet();
  }, [session, onChanged, closeSheet]);

  const handleCopyPath = useCallback(async () => {
    if (!session || copyAttempt.busy) return;
    const text = session.path;
    setCopyRecovery(null);
    setError(null);
    setCopying(true);
    const copied = await copyAttempt.run(text);
    if (copied === null) return;
    setCopying(false);
    if (copied) {
      showToast("Copied path", "success");
      closeSheet();
    } else {
      setCopyRecovery(text);
    }
  }, [session, copyAttempt, closeSheet]);

  // One mutation owns this menu visit. Closing cannot undo a server request,
  // but its late result must not close or change a later visit.
  const runMutation = useCallback(async (
    kind: "rename" | "duplicate" | "computer",
    action: (api: DaemonApi, current: () => boolean) => Promise<string | null>,
  ) => {
    if (!session || mutationPending.current) return;
    const path = session.path;
    const generation = ++mutationGeneration.current;
    mutationPending.current = true;
    const current = () => generation === mutationGeneration.current && sessionPathRef.current === path;
    clearCopy();
    setMutationKind(kind);
    setError(null);
    try {
      const message = await action(new DaemonApi(readPairingToken()), current);
      // null: the action reported for itself and the sheet stays for another try.
      if (!current() || message === null) return;
      showToast(message, "success");
      onChanged();
      closeSheet();
    } catch (e: unknown) {
      if (!current()) return;
      // A refused rename is the field's problem, said under it.
      if (kind === "rename") {
        const owned = isOwnershipError(e);
        setRenameRefusal({ name: renameAttempt.current, owned, message: owned ? OWNED_RENAME : humanizeDaemonError(e) });
      } else setError(humanizeDaemonError(e));
    } finally {
      if (current()) { mutationPending.current = false; setMutationKind(null); }
    }
  }, [session, clearCopy, onChanged, closeSheet]);

  const handleRenameSave = useCallback(async () => {
    if (!session || !renameValue.trim()) return;
    const name = renameValue.trim();
    // The computer refused this exact name for ownership: asking again
    // before anything changed would only be refused again.
    if (renameRefusal?.owned && renameRefusal.name === name) return;
    renameAttempt.current = name;
    setRenameRefusal(null);
    await runMutation("rename", async (api) => {
      await api.setSessionName(session.path, name);
      return "Renamed";
    });
  }, [session, renameValue, renameRefusal, runMutation]);

  // A duplicate is the whole conversation (omp's /fork), continued
  // separately; branching at the newest entry rewound to before it and
  // dropped the newest exchange. The copy opens, as in-chat Fork does.
  const handleDuplicate = useCallback(async () => {
    if (!session) return;
    await runMutation("duplicate", async (api, current) => {
      const result = await api.fork(session.path);
      if (result.cancelled) {
        if (current()) showToast("omp kept this conversation as it was.");
        return null;
      }
      if (current()) onOpenSession(result.sessionPath);
      return "Duplicated, opening the copy";
    });
  }, [session, runMutation, onOpenSession]);

  // A phone reply mid-stream cannot move (the daemon refuses `turn_running`),
  // so the row stays visible but says why it is unavailable.
  const working = session ? sessionTurn(session) === "running" : false;

  const handleOpenOnComputer = useCallback(async () => {
    if (!session || working) return;
    await runMutation("computer", async (api) => laptopOpenedText(await api.openOnLaptop(session.path)));
  }, [session, working, runMutation]);

  const handleStop = useCallback(async () => {
    if (!session || !stop || mutationPending.current) return;
    const path = session.path;
    if (stop.capability !== false) haptic("medium");
    mutationPending.current = true;
    setMutationKind("stop");
    setError(null);
    const outcome = await stopRequest.run(() => stop.run(path), stop.capability);
    // null: superseded by a newer visit or a close, which already reset state.
    if (outcome === null || sessionPathRef.current !== path) return;
    mutationPending.current = false;
    setMutationKind(null);
    if (outcome === "requested") {
      // Acknowledged is not stopped: the row's Working state clears when the
      // session itself reports idle.
      showToast("Stop requested");
      closeSheet();
    } else {
      setError(outcome === "unavailable" ? "This session can’t be stopped from here." : "Couldn’t stop this session. Try again.");
    }
  }, [session, stop, stopRequest, closeSheet]);

  const cancelRename = useCallback(() => {
    cancelMutation();
    setRenaming(false);
    setRenameRefusal(null);
    setError(null);
  }, [cancelMutation]);

  const title = session ? sessionTitle(session) : "";
  // Project name, not the raw absolute session path (it truncated to noise at 390px).
  const project = session ? projectLabel(session) : undefined;
  const busy = copying || mutationKind !== null;

  return (
    <>
      <BottomSheet
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            clearCopy();
            cancelMutation();
            setRenaming(false);
            setError(null);
          }
          onOpenChange(v);
        }}
        title={renaming ? "Rename session" : title || "Session"}
        description={renaming ? undefined : project}
        testId="action-sheet"
        footer={renaming ? (
          <SheetFooter>
            <Button
              variant="primary"
              data-testid="rename-save"
              disabled={renameSaving || !renameValue.trim() || (renameRefusal?.owned === true && renameRefusal.name === renameValue.trim())}
              onClick={() => void handleRenameSave()}
              type="button"
            >
              {renameSaving ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" data-testid="rename-back" onClick={cancelRename} type="button">
              Cancel
            </Button>
          </SheetFooter>
        ) : undefined}
      >
        {error ? (
          <div className="pb-3">
            <Notice tone="danger" action={errorRecoveryAction(error)}>{error}</Notice>
          </div>
        ) : null}

        {copyRecovery !== null ? (
          <div className="mb-4 space-y-3" data-testid="copy-recovery">
            <Notice tone="danger">Couldn’t copy. Select the path below and copy it yourself.</Notice>
            <label className="block text-meta text-muted-foreground" htmlFor="copy-recovery-value">
              Session path
            </label>
            <Textarea
              id="copy-recovery-value"
              ref={recoveryInput}
              readOnly
              rows={3}
              value={copyRecovery}
              className="w-full resize-none rounded-lg bg-surface-2 font-mono text-code [overflow-wrap:anywhere]"
            />
            <Button type="button" variant="outline" className="w-full"
              onClick={() => { recoveryInput.current?.focus(); recoveryInput.current?.select(); }}>
              Select text
            </Button>
          </div>
        ) : null}

        {renaming ? (
          <div className="space-y-2 pb-2">
            <label htmlFor="rename-session-name" className="block text-meta text-muted-foreground">
              Name
            </label>
            <Input
              id="rename-session-name"
              autoFocus
              className="h-11 rounded-lg border border-transparent bg-surface-2 px-4 text-body focus-visible:border-control focus-visible:ring-0 md:text-body dark:bg-surface-2"
              data-testid="rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // IME candidate confirmation and held keys are not rename submissions.
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.repeat) return;
                  void handleRenameSave();
                }
                if (e.key === "Escape") cancelRename();
              }}
            />
            {renameRefusal ? (
              <Notice
                tone={renameRefusal.owned ? "warning" : "danger"}
                testId="rename-error"
                action={renameRefusal.owned ? { label: "Close on computer", onClick: () => setCloseOnComputerOpen(true) } : errorRecoveryAction(renameRefusal.message)}
              >
                {renameRefusal.message}
              </Notice>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Same words and relative order as the chat's ⋯ menu and the drawer's row menu; Pin, Duplicate and Stop exist only where a list row is. */}
            <RowGroup>
              <Row
                testId="action-change-model"
                onClick={() => { clearCopy(); setModelPickerOpen(true); }}
                disabled={busy}
                leading={<SparklesIcon />}
                title="Model & thinking"
              />
              <Row
                testId="action-rename"
                onClick={() => {
                  if (session) setRenameValue((session.title as string) ?? "");
                  setError(null);
                  clearCopy();
                  setRenaming(true);
                }}
                disabled={busy}
                leading={<PencilIcon />}
                title="Rename"
              />
              <Row
                testId="action-pin"
                onClick={handlePinToggle}
                disabled={busy}
                leading={session && isPinned(session.path) ? <PinOffIcon /> : <PinIcon />}
                title={session && isPinned(session.path) ? "Unpin" : "Pin"}
              />
              <Row
                testId="action-duplicate"
                onClick={() => void handleDuplicate()}
                disabled={busy}
                leading={<CopyPlusIcon />}
                title={duplicating ? "Duplicating…" : "Duplicate"}
              />
              {session && !isOnLaptop(session) && !isPhoneMode() ? (
                <Row
                  testId="action-open-on-computer"
                  onClick={() => void handleOpenOnComputer()}
                  disabled={busy || working}
                  leading={<MonitorIcon />}
                  title={openingOnComputer ? "Opening on computer…" : "Open on computer"}
                  subtitle={working ? "Available when the reply finishes" : undefined}
                />
              ) : null}
              {session && isOnLaptop(session) ? (
                <Row
                  testId="action-close-on-computer"
                  onClick={() => { clearCopy(); setCloseOnComputerOpen(true); }}
                  disabled={busy}
                  leading={<MonitorOffIcon />}
                  title="Close on computer"
                  subtitle="Only when idle. History is kept."
                />
              ) : null}
              <Row
                testId="action-copy-path"
                disabled={busy}
                onClick={() => void handleCopyPath()}
                leading={<CopyIcon />}
                title="Copy path"
              />
              {working && stop ? (
                <Row
                  testId="action-stop"
                  onClick={() => void handleStop()}
                  disabled={busy || stop.capability === false}
                  leading={<SquareIcon />}
                  title={stopping ? "Stopping…" : "Stop"}
                  subtitle={stop.capability === false ? "Can’t be stopped from here" : undefined}
                />
              ) : null}
            </RowGroup>
            <PluginMenuItems variant="sheet" views={pluginMenu.views} onAction={pluginMenu.onAction} onClose={closeSheet} />
            {/* Destructive last; the computer may still refuse, and the row then returns. */}
            {session && !isOnLaptop(session) ? (
              <RowGroup>
                <Row
                  testId="action-delete"
                  onClick={() => { deleteSessionWithUndo({ path: session.path, title: sessionTitle(session) }, onChanged); closeSheet(); }}
                  disabled={busy || working}
                  destructive
                  leading={<Trash2Icon />}
                  title="Delete"
                  subtitle={working ? "Available when the reply finishes" : undefined}
                />
              </RowGroup>
            ) : null}
          </div>
        )}
      </BottomSheet>
      {session ? (
        <CloseOnLaptopDialog
          open={closeOnComputerOpen}
          onOpenChange={setCloseOnComputerOpen}
          sessionPath={session.path}
          title={title}
          project={project ?? null}
          onClosed={() => {
            onChanged();
            closeSheet();
          }}
        />
      ) : null}

      <ModelPicker
        open={modelPickerOpen}
        onOpenChange={setModelPickerOpen}
        sessionPath={session?.path ?? null}
        onChanged={() => {
          onChanged();
          closeSheet();
        }}
      />
    </>
  );
}
