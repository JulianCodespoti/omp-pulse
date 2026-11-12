"use client";

import type { JSX, ReactNode, Ref } from "react";
import {
  ArrowUpIcon,
  BookOpenIcon,
  CameraIcon,
  HistoryIcon,
  InfoIcon,
  ImageIcon,
  Maximize2Icon,
  Minimize2Icon,
  PlusIcon,
  SquareIcon,
  SquareSlashIcon,
  TerminalIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { AgentDiscussionReference } from "../../domain/agent-discussion";
import {
  appendAgentDraftReference,
  removeAgentDraftReference,
  replaceAgentDraftPrefix,
  validAgentDraftProjection,
  type AgentDraftProjection,
} from "../../domain/agent-draft-projection";
import {
  DEFAULT_SEND_MODE,
  deliveryForSend,
  sendModeChoiceVisible,
  stopAndSendAvailable,
  type PromptDelivery,
  type SendMode,
} from "../../domain/send-mode";
import { ContextChip, ModelChip } from "./ComposerChips";
import { DropdownMenu, DropdownMenuChoice, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useBackLayer } from "../back-layer";
import { HighlightedPromptInput } from "./HighlightedPromptInput";
import type { OmpStoreApi } from "../../runtime/omp-store";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Notice } from "../ui/Notice";
import { showToast } from "../Notices";
import { useLinkIndicator } from "../link-hooks";
import { humanizeDaemonError } from "../ui/OwnedBySession";
import { errorRecoveryAction } from "../ui/error-recovery";
import { Segmented } from "../ui/Segmented";
import { QueuedMessagesBar } from "../chat/QueuedMessagesBar";
import { useLongPress } from "../hooks/use-long-press";
import { useKeyboardInset } from "../hooks/use-keyboard-inset";
import type { OmpCommand } from "../commands/command-registry";
import { openPalette } from "../commands/palette";
import { haptic } from "../../platform/haptic";
import { readPairingToken } from "../../platform/browser-storage";
import { DaemonApi } from "../../runtime/rpc-client";
import {
  getAttachmentDraft,
  getAttachmentDraftSnapshot,
} from "../../runtime/attachment-draft";
import { assertNoPendingEdit, type QueuedPrompt } from "../../runtime/offline-queue";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import type { ExtensionEditorDraft } from "../../runtime/extension-feedback";

import { AttachmentStrip } from "./AttachmentStrip";
import { AgentReferenceRows } from "./AgentReferenceRows";
import { DictationBar } from "./DictationBar";
import { DictationNotice } from "./DictationNotice";
import { imagesTooLargeToSend, intakeFiles, MAX_IMAGES, PAYLOAD_TOO_LARGE_COPY } from "./image-intake";
import {
  hasCommandToken,
  isSlashListVisible,
  SlashPalette,
} from "./SlashPalette";
import { useDictation } from "./use-dictation";
import {
  getDraftNamespace,
  readDraft,
  removeDraft,
  restoreSavedDraft,
  restoredDraftText,
  seedDraft,
  useDraft,
} from "./use-draft";
import { VoiceButton } from "./VoiceButton";
import { composerAction, findCatalogueCommand, leadsWithCommand } from "../../domain/composer-route";
import { applyMention, mentionAtCaret, type MentionEntry } from "../../domain/file-mention";
import { stepPromptHistory } from "../../domain/prompt-history";
import { createEditStash } from "../../domain/turn-redo";
import { HistorySheet } from "./HistorySheet";
import { MentionPicker, useMentionEntries } from "./MentionPicker";
import { readPromptHistory, recordPromptHistory } from "./prompt-history-store";
import { usePromptKeywords } from "../../runtime/prompt-config";
import { applyModelMention, modelMentionAtCaret, type ModelMentionEntry } from "../../domain/model-mention";
import { ModelMentionPicker, useModelMentionEntries } from "./ModelMentionPicker";
import { insertSkill } from "../../domain/skill-insertion";
import { SkillPicker } from "./SkillPicker";
import { PluginMenuItems } from "../plugins/PluginMenuItems";
import { usePluginSlot } from "../plugins/use-plugin-host";

const COMPACT_COMMAND_ERROR = "Remove the agent reference or edit the full draft before running a command.";

export type ComposerDraftActions = {
  prepareAgentResponse: (sessionPath: string, context: AgentDiscussionReference) => string | null;
  /** Put a prompt back for editing, ahead of any draft. Never sends. Returns a problem or null. */
  placeForEdit: (sessionPath: string, text: string) => string | null;
  /** Edit chip: stash the draft and show the message in its place. Never sends. Returns a problem or null. */
  beginEdit: (sessionPath: string, text: string) => string | null;
  /** Edit chip ×: put the stashed draft back, text and agent references. */
  cancelEdit: (sessionPath: string) => void;
};

export interface ComposerProps {
  draftActionsRef?: Ref<ComposerDraftActions>;
  sessionPath: string | null;
  extensionDraft?: ExtensionEditorDraft | null;
  onConsumeExtensionDraft?: (id: string) => void;
  busy: boolean;
  sendAllowed?: boolean;
  stopAllowed?: boolean;
  commands?: OmpCommand[];
  /**
   * `onSaved` MUST be called once the prompt is durably queued; the composer
   * clears then rather than when the promise settles (which is after the
   * network). Implementations that never call it still work: the composer
   * clears on resolve.
   */
  onSend: (
    text: string,
    images: { data: string; mimeType: string }[],
    targetSessionPath: string | null,
    onSaved: () => Promise<boolean> | void,
    /** Set only while a turn runs: how the message joins it. */
    delivery?: PromptDelivery,
    /** The draft carries a live agent reference: never route it as a command or shell line. */
    agentReference?: boolean,
  ) => Promise<void> | void;
  onStop: () => void;
  /** Remembered Steer/Queue choice for sends while a turn runs. */
  sendMode?: SendMode;
  onSendModeChange?: (mode: SendMode) => void;
  /** Daemon-reported owner capabilities; `false` hides the option, `null` keeps it. */
  canQueue?: boolean | null;
  canInterrupt?: boolean | null;
  onPrewarm?: () => void;
  onRunCommand?: (cmd: OmpCommand, arg?: string) => void;
  onOpenPicker?: (picker: NonNullable<OmpCommand["picker"]>) => void;
  /** Whether the slash palette is showing, so ChatScreen can hide overlays under it. */
  onSlashOpenChange?: (open: boolean) => void;
  /** Opens the model picker (the queue stack's "choose a model" recovery). */
  onOpenModelPicker?: () => void;
  /** Feeds the model and thinking chips; without it the card has no chips. */
  store?: OmpStoreApi;
  /** The listing row's model, until the session state names one. */
  fallbackModel?: string | null;
  /** Context window fill (0-100) for the ring; null or absent hides it. */
  contextPercent?: number | null;
  /** Opens the session's usage and settings (the ring's tap). */
  onOpenUsage?: () => void;
  /** After the chip's model switch is accepted, so the transcript can show it. */
  onModelChanged?: () => void;
  /** Banners that sit on the composer (interruption, a waiting question, extension notices). They float with it, so it never covers them. */
  above?: ReactNode;
  /** With a controller the composer hosts the queue stack above its card. */
  controller?: OmpSessionController;
  /** Durable sends for this session that have no transcript bubble. */
  pendingSends?: readonly QueuedPrompt[];
  /** The stop request is in flight: the Stop button shows a spinner until the turn ends or it fails. */
  stopping?: boolean;
  /** Why this chat cannot be sent to from here, or null. */
  sendBlockedReason?: string | null;
}

/** What a dictation stop asked for, captured when the button was pressed. */
type VoiceIntent = { send: boolean; path: string | null; namespace: string };
/** The live composer of each open chat, so a late transcript reaches its own chat's editor. */
const dictationTargets = new Map<string, (words: string) => void>();

export function Composer({
  draftActionsRef,
  sessionPath,
  extensionDraft = null,
  onConsumeExtensionDraft,
  busy,
  sendAllowed = true,
  stopAllowed = true,
  commands,
  onSend,
  onStop,
  sendMode = DEFAULT_SEND_MODE,
  onSendModeChange,
  canQueue = null,
  canInterrupt = null,
  onPrewarm,
  onRunCommand,
  onOpenPicker,
  onSlashOpenChange,
  onOpenModelPicker,
  store,
  fallbackModel,
  contextPercent,
  onOpenUsage,
  onModelChanged,
  above,
  controller,
  pendingSends = [],
  stopping = false,
  sendBlockedReason = null,
}: ComposerProps): JSX.Element {
  const { text, setText, clearDraft, draftPath, flush: flushDraft, restoreText, remapReferences } = useDraft(sessionPath);
  const promptKeywords = usePromptKeywords(sessionPath);
  const persistenceNamespaceRef = useRef(getDraftNamespace());
  const draftRevision = useRef(0);
  const sessionPathRef = useRef(sessionPath);
  useLayoutEffect(() => {
    sessionPathRef.current = sessionPath;
    ++draftRevision.current;
  }, [sessionPath]);
  const textRef = useRef(text);
  const projectionRef = useRef<AgentDraftProjection | null>(null);
  const [projectionVersion, refreshProjection] = useState(0);
  const projection = validAgentDraftProjection(
    projectionRef.current, text, getDraftNamespace(), sessionPath,
  );
  const visibleText = projection?.prefix ?? text;
  useLayoutEffect(() => {
    textRef.current = text;
    // A foreign update/clear or new session ends this presentation permanently.
    // Never rediscover it later just because the raw bytes happen to match.
    if (!validAgentDraftProjection(projectionRef.current, text, getDraftNamespace(), sessionPath)) {
      projectionRef.current = null;
    }
  });
  const currentProjection = useCallback(() => {
    const current = validAgentDraftProjection(
      projectionRef.current, textRef.current, getDraftNamespace(), sessionPathRef.current,
    );
    if (!current && projectionRef.current) {
      projectionRef.current = null;
      refreshProjection((version) => version + 1);
    }
    return current;
  }, []);
  const getAttachmentOwner = useCallback(
    () => getAttachmentDraft(persistenceNamespaceRef.current, sessionPath),
    [sessionPath],
  );
  // Render stays inert even when React yields before committing this tree.
  // Subscription and event handlers always acquire the current keyed owner.
  const subscribeAttachments = useCallback(
    (listener: () => void) => getAttachmentOwner().subscribe(listener),
    [getAttachmentOwner],
  );
  const readAttachments = useCallback(
    () => getAttachmentDraftSnapshot(persistenceNamespaceRef.current, sessionPath),
    [sessionPath],
  );
  const attachmentState = useSyncExternalStore(
    subscribeAttachments, readAttachments, readAttachments,
  );
  const {
    images,
    loading: attachmentsLoading,
    sending: sendPending,
    cleanupPending,
    error: storedInlineError,
  } = attachmentState;
  const intakePending = attachmentState.pending > 0;
  const inlineError = imagesTooLargeToSend(images) ? PAYLOAD_TOO_LARGE_COPY : storedInlineError;
  const setInlineError = useCallback(
    (error: string | null) => getAttachmentOwner().setError(error),
    [getAttachmentOwner],
  );
  useLayoutEffect(() => getAttachmentOwner().attachTextEditor((expected) => {
    textRef.current = clearDraft(expected);
    currentProjection();
    return textRef.current;
  }), [getAttachmentOwner, clearDraft, currentProjection]);
  const setDraftText = useCallback(
    (value: string, nextProjection: AgentDraftProjection | null = null) => {
      ++draftRevision.current;
      projectionRef.current = nextProjection;
      refreshProjection((version) => version + 1);
      getAttachmentOwner().noteTextEdit();
      textRef.current = value;
      setText(value);
    },
    [getAttachmentOwner, setText],
  );

  const fileRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const prewarmLastRef = useRef(0);
  const editStash = useRef(createEditStash<{ text: string; projection: AgentDraftProjection | null }>());
  const [slashDismissed, setSlashDismissed] = useState(false);
  const handleSlashClose = useCallback(() => setSlashDismissed(true), []);
  // Where the caret is, for the `@` file picker; null while the field is blurred.
  const [caret, setCaret] = useState<number | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState<number | null>(null);
  const [mentionSelected, setMentionSelected] = useState(0);
  const mentionListId = useId();
  const [modelMentionDismissed, setModelMentionDismissed] = useState<number | null>(null);
  const [modelMentionSelected, setModelMentionSelected] = useState(0);
  useLayoutEffect(() => {
    setCaret(null);
    setMentionDismissed(null);
    setModelMentionDismissed(null);
  }, [sessionPath]);
  // Up/Down recall: which history entry the field shows. Any edit ends it,
  // because the field then no longer equals `shown`.
  const historyNav = useRef<{ index: number; shown: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const pluginActions = usePluginSlot("composer.actions", plusOpen);
  // Back and Escape close the floating "+" menu before the chat behind it.
  useBackLayer(plusOpen, { onBack: () => setPlusOpen(false) });
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const skillTarget = useRef<{ node: HTMLTextAreaElement; text: string; caret: number; revision: number; path: string | null; namespace: string } | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const getEditor = useCallback(() => composerRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]') ?? null, []);
  const getReferenceEditor = useCallback(() => sessionPathRef.current === sessionPath
    && getDraftNamespace() === persistenceNamespaceRef.current ? getEditor() : null,
  [getEditor, sessionPath]);
  const preparedSelection = useRef<{ node: HTMLTextAreaElement; start: number; end: number; direction: "forward" | "backward" | "none"; text: string } | null>(null);
  const preserveSelection = useCallback((nextText: string) => {
    const node = getEditor();
    preparedSelection.current = node ? { node, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, text: nextText } : null;
  }, [getEditor]);
  const setVisibleDraftText = useCallback((value: string) => {
    const current = currentProjection();
    // A queued event from a compact field cannot replace newer raw text with
    // its old visible prefix. Reveal the current raw draft and leave it intact.
    if (projection && !current) {
      refreshProjection((version) => version + 1);
      return null;
    }
    const next = current ? replaceAgentDraftPrefix(current, value) : null;
    const canonical = next?.text ?? value;
    setDraftText(canonical, next);
    return canonical;
  }, [currentProjection, projection, setDraftText]);
  const removeReference = useCallback((identity: string) => {
    const current = currentProjection();
    if (!current || !current.references.some((item) => item.identity === identity)) return;
    const next = removeAgentDraftReference(current, identity);
    const nextText = next?.text ?? current.prefix;
    preserveSelection(nextText);
    setDraftText(nextText, next);
    if (getAttachmentOwner().getSnapshot().error === COMPACT_COMMAND_ERROR) setInlineError(null);
  }, [currentProjection, getAttachmentOwner, preserveSelection, setDraftText, setInlineError]);
  const editFullDraft = useCallback(() => {
    if (!currentProjection()) return;
    preserveSelection(textRef.current);
    projectionRef.current = null;
    // Expansion changes only the view, not the send-cleanup text revision.
    refreshProjection((version) => version + 1);
    if (getAttachmentOwner().getSnapshot().error === COMPACT_COMMAND_ERROR) setInlineError(null);
  }, [currentProjection, getAttachmentOwner, preserveSelection, setInlineError]);
  useImperativeHandle(draftActionsRef, () => ({
    prepareAgentResponse(target, context) {
      if (!target || target !== sessionPathRef.current || getDraftNamespace() !== persistenceNamespaceRef.current || !context.text || !context.identity) return "The main session changed. Reopen this agent and try again.";
      const current = textRef.current;
      // Appending context to a `/` or `!` command would change the command's
      // arguments (or add a shell line) and could execute it through the
      // ordinary Send boundary.
      if (leadsWithCommand(current)) return "Your draft starts with a command. Finish or clear it before discussing this agent.";
      if (current.includes(context.identity)) return null;
      const next = appendAgentDraftReference(currentProjection(), current, getDraftNamespace(), target, context);
      preserveSelection(next.text);
      setDraftText(next.text, next);
      return null;
    },
    placeForEdit(target, payload) {
      if (target !== sessionPathRef.current || getDraftNamespace() !== persistenceNamespaceRef.current) return "The conversation changed. Open it again to edit this message.";
      const node = getEditor();
      if (node) setVisibleDraftText(node.value);
      const next = restoredDraftText(payload, textRef.current);
      setDraftText(next);
      requestAnimationFrame(() => {
        if (!node?.isConnected || node.value !== next || target !== sessionPathRef.current) return;
        node.focus();
        node.setSelectionRange(payload.length, payload.length);
      });
      return null;
    },
    beginEdit(target, payload) {
      if (target !== sessionPathRef.current || getDraftNamespace() !== persistenceNamespaceRef.current) return "The conversation changed. Open it again to edit this message.";
      const node = getEditor();
      if (node) setVisibleDraftText(node.value);
      editStash.current.hold(target, { text: textRef.current, projection: currentProjection() });
      setDraftText(payload);
      requestAnimationFrame(() => {
        if (!node?.isConnected || node.value !== payload || target !== sessionPathRef.current) return;
        node.focus();
        node.setSelectionRange(payload.length, payload.length);
      });
      return null;
    },
    cancelEdit(target) {
      const saved = editStash.current.take(target);
      if (!saved || target !== sessionPathRef.current || getDraftNamespace() !== persistenceNamespaceRef.current) return;
      setDraftText(saved.text, saved.projection);
    },
  }), [currentProjection, getEditor, preserveSelection, setDraftText, setVisibleDraftText]);
  useLayoutEffect(() => {
    const capture = () => {
      if (sessionPathRef.current !== sessionPath || getDraftNamespace() !== persistenceNamespaceRef.current) return;
      const node = getEditor();
      // Read native/IME text before React's next change event can replace it.
      if (node) setVisibleDraftText(node.value);
    };
    return getAttachmentOwner().attachTextRestorer((payload, recoveryId, references) => {
      if (sessionPathRef.current !== sessionPath || getDraftNamespace() !== persistenceNamespaceRef.current) {
        if (!sessionPath) throw new Error("Open the conversation to restore this message.");
        restoreSavedDraft(sessionPath, payload, persistenceNamespaceRef.current, recoveryId, references);
        return;
      }
      capture();
      projectionRef.current = null;
      getAttachmentOwner().noteTextEdit();
      textRef.current = restoreText(payload, recoveryId, textRef.current, references);
      refreshProjection(version => version + 1);
    }, capture, (imageIds, removedId) => {
      projectionRef.current = null;
      getAttachmentOwner().noteTextEdit();
      textRef.current = remapReferences(imageIds, removedId);
      refreshProjection(version => version + 1);
    });
  }, [getAttachmentOwner, getEditor, remapReferences, restoreText, sessionPath, setVisibleDraftText]);
  useLayoutEffect(() => {
    const selection = preparedSelection.current;
    preparedSelection.current = null;
    if (selection?.node.isConnected && selection.text === text) {
      selection.node.setSelectionRange(selection.start, selection.end, selection.direction);
    }
  }, [text, projectionVersion]);
  // Capture a specific editor visit before History starts a full-message read.
  // Even an edit-and-undo or an A→B→A visit obsoletes the pending insertion.
  const prepareHistoryInsert = useCallback(() => {
    const node = getReferenceEditor();
    if (!node) return null;
    const revision = draftRevision.current;
    const value = node.value;
    const target = sessionPathRef.current;
    const namespace = getDraftNamespace();
    return (payload: string) => {
      if (!mountedRef.current || revision !== draftRevision.current || target !== sessionPathRef.current
        || namespace !== getDraftNamespace() || node !== getReferenceEditor() || node.value !== value) return false;
      const next = restoredDraftText(payload, textRef.current);
      setDraftText(next);
      preparedSelection.current = { node, start: payload.length, end: payload.length, direction: "none", text: next };
      requestAnimationFrame(() => {
        if (!node.isConnected || node.value !== next || target !== sessionPathRef.current || namespace !== getDraftNamespace()) return;
        node.focus();
        node.setSelectionRange(payload.length, payload.length);
      });
      return true;
    };
  }, [getReferenceEditor, setDraftText]);

  const openSkillPicker = useCallback(() => {
    const node = getReferenceEditor();
    if (!node) return;
    skillTarget.current = { node, text: node.value, caret: node.selectionStart, revision: draftRevision.current, path: sessionPathRef.current, namespace: getDraftNamespace() };
    setSkillPickerOpen(true);
  }, [getReferenceEditor]);
  const pickSkill = useCallback((command: OmpCommand) => {
    const target = skillTarget.current;
    if (!target || target.node !== getReferenceEditor() || target.revision !== draftRevision.current
      || target.path !== sessionPathRef.current || target.namespace !== getDraftNamespace() || target.node.value !== target.text) {
      setSkillPickerOpen(false);
      return;
    }
    const next = insertSkill(target.text, target.caret, command.name);
    const canonical = setVisibleDraftText(next.text);
    if (canonical === null) return;
    skillTarget.current = { ...target, revision: draftRevision.current, text: next.text, caret: next.caret };
    preparedSelection.current = { node: target.node, start: next.caret, end: next.caret, direction: "none", text: canonical };
    setSkillPickerOpen(false);
  }, [getReferenceEditor, setVisibleDraftText]);
  const returnSkillFocus = useCallback(() => {
    const target = skillTarget.current;
    return target && target.path === sessionPathRef.current && target.namespace === getDraftNamespace()
      && target.revision === draftRevision.current
      && target.node === getReferenceEditor() && target.node.isConnected ? target.node : false;
  }, [getReferenceEditor]);

  /** Add words after the visible draft (dictation, a message taken back from the queue). */
  const appendToDraft = useCallback((addition: string, separator: string, focus: boolean) => {
    const current = currentProjection();
    const cur = current?.prefix ?? textRef.current;
    const next = !cur
      ? addition
      : cur.endsWith(" ") || cur.endsWith("\n")
        ? cur + addition
        : `${cur}${separator}${addition}`;
    const nextProjection = current ? replaceAgentDraftPrefix(current, next) : null;
    setDraftText(nextProjection?.text ?? next, nextProjection);
    if (!focus) return;
    const node = getEditor();
    const path = sessionPathRef.current;
    requestAnimationFrame(() => {
      if (node?.isConnected && node.value === next && path === sessionPathRef.current) {
        node.focus();
        try {
          node.setSelectionRange(next.length, next.length);
        } catch {
          // A detached or hidden field refuses selection; focus is enough.
        }
      }
    });
  }, [currentProjection, getEditor, setDraftText]);

  const [composing, setComposing] = useState(false);
  // ChatGPT's expanded composer: a long draft can take most of the screen instead of scrolling in 10rem.
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const keyboardInset = useKeyboardInset();
  useLayoutEffect(() => {
    const node = getEditor();
    // Measured only while compact: expanded, the field is at its tallest and says nothing about the draft.
    // shortcut: re-measured on edits only, not on rotation or text-size changes; the next keystroke fixes it.
    if (node && !expanded) setOverflowing(node.scrollHeight > node.clientHeight + 1);
  }, [expanded, getEditor, visibleText]);
  const reviewDraftId = useRef<string | null>(null);
  const extensionReady = sendAllowed && !composing && !attachmentsLoading
    && !sendPending && !intakePending && !cleanupPending
    && draftPath === sessionPath;
  const applyExtensionDraft = useCallback((mode: "append" | "replace" | "empty") => {
    if (!extensionDraft || !extensionReady || !sessionPath
      || sessionPathRef.current !== sessionPath
      || persistenceNamespaceRef.current !== getDraftNamespace()) return;
    const current = currentProjection();
    const attachment = getAttachmentOwner().getSnapshot();
    if (attachment.loading || attachment.sending || attachment.pending || attachment.cleanupPending) return;
    if (mode === "empty" && (textRef.current !== "" || readDraft(sessionPath) !== ""
      || attachment.images.length || current)) return;
    if (mode === "append") {
      const prefix = current?.prefix ?? textRef.current;
      const next = prefix ? `${prefix}\n\n${extensionDraft.text}` : extensionDraft.text;
      const projected = current ? replaceAgentDraftPrefix(current, next) : null;
      setDraftText(projected?.text ?? next, projected);
    } else {
      setDraftText(extensionDraft.text);
    }
    try {
      // Consumption follows the draft's durability barrier, never its debounce.
      flushDraft();
      onConsumeExtensionDraft?.(extensionDraft.id);
    } catch {
      setInlineError("Could not save the prepared text. Keep this conversation open and try again.");
    }
  }, [currentProjection, extensionDraft, extensionReady, flushDraft, getAttachmentOwner, onConsumeExtensionDraft, sessionPath, setDraftText, setInlineError]);
  useEffect(() => {
    if (!extensionDraft || !extensionReady || !sessionPath) return;
    try {
      // The editor can be empty while its debounce still retains the previous
      // text. Flush our deletion (or adopt another view's draft) before deciding
      // whether this is genuinely empty after composition/disabled input ends.
      flushDraft();
    } catch {
      setInlineError("Could not save the current draft. Prepared text is kept for review.");
      return;
    }
    if (textRef.current !== "" || readDraft(sessionPath) !== "" || images.length || currentProjection()) {
      reviewDraftId.current = extensionDraft.id;
      return;
    }
    if (reviewDraftId.current !== extensionDraft.id) applyExtensionDraft("empty");
  }, [applyExtensionDraft, currentProjection, extensionDraft, extensionReady, flushDraft, images.length, sessionPath, setInlineError, text]);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!sessionPath) return;
    const insert = (words: string) => appendToDraft(words, " ", true);
    dictationTargets.set(sessionPath, insert);
    return () => {
      if (dictationTargets.get(sessionPath) === insert) dictationTargets.delete(sessionPath);
    };
  }, [appendToDraft, sessionPath]);

  const credentialNamespace = getDraftNamespace();
  const dictationApi = useMemo(() => {
    try {
      return new DaemonApi(readPairingToken(), window.location.origin);
    } catch {
      return new DaemonApi("", window.location.origin);
    }
  }, [credentialNamespace]);

  const voiceIntentRef = useRef<VoiceIntent | null>(null);
  const handleSendRef = useRef<() => Promise<void>>(async () => {});
  const dictation = useDictation({
    daemonApi: dictationApi,
    scope: sessionPath,
    onTranscribed: useCallback(
      (words: string, origin: string | null) => {
        const intent = voiceIntentRef.current;
        voiceIntentRef.current = null;
        const path = intent ? intent.path : origin;
        const namespace = intent?.namespace ?? persistenceNamespaceRef.current;
        if (!mountedRef.current || path !== sessionPathRef.current || namespace !== getDraftNamespace()) {
          // The chat changed (or this composer was replaced by another chat's)
          // while the words were transcribing: they belong to the draft they
          // were spoken for, and are never sent elsewhere.
          if (!path) return;
          const live = namespace === getDraftNamespace() ? dictationTargets.get(path) : undefined;
          if (live) live(words);
          else seedDraft(path, restoredDraftText(words, readDraft(path, namespace)), namespace);
          return;
        }
        appendToDraft(words, " ", !intent?.send);
        // "Insert and send" uses the whole draft. Discovery may omit valid
        // templates; only a lone slash has no invocation to submit.
        if (intent?.send && textRef.current.trim() !== "/") {
          void handleSendRef.current();
        }
      },
      [appendToDraft],
    ),
    onError: () => {
      voiceIntentRef.current = null;
    },
  });
  const stopDictation = useCallback((send: boolean) => {
    voiceIntentRef.current = { send, path: sessionPathRef.current, namespace: getDraftNamespace() };
    dictation.stop();
  }, [dictation]);

  const compactCommand = !!projection && leadsWithCommand(visibleText);
  const slashVisible = isSlashListVisible(visibleText, commands);
  const showSlash =
    slashVisible && !slashDismissed && (commands?.length ?? 0) > 0;
  // The `@` token at the caret. Only one popover at a time: the slash list
  // needs a bare `/word`, a mention needs whitespace before `@`, and the
  // command warning below yields to an open file list.
  const rawMention = !showSlash && sessionPath && caret !== null && caret <= visibleText.length
    ? mentionAtCaret(visibleText, caret)
    : null;
  const mention = rawMention && rawMention.start !== mentionDismissed ? rawMention : null;
  const mentionListing = useMentionEntries(dictationApi, sessionPath, mention);
  const mentionEntries = mentionListing.entries;
  const showMention = !!mention && !!mentionEntries && mentionEntries.length > 0;
  const mentionOpen = rawMention !== null;
  useEffect(() => {
    if (!mentionOpen) setMentionDismissed(null);
  }, [mentionOpen]);
  const mentionKey = mention ? `${mention.start}:${mention.dir}:${mention.leaf}` : "";
  useEffect(() => {
    setMentionSelected(0);
  }, [mentionKey]);
  const rawModelMention = !showSlash && !rawMention && sessionPath && caret !== null && caret <= visibleText.length
    ? modelMentionAtCaret(visibleText, caret) : null;
  const modelMention = rawModelMention && rawModelMention.start !== modelMentionDismissed ? rawModelMention : null;
  const modelMentionEntries = useModelMentionEntries(dictationApi, sessionPath, modelMention);
  const showModelMention = !!modelMention && !!modelMentionEntries?.length;
  const modelMentionKey = modelMention ? `${sessionPath}:${modelMention.start}:${modelMention.query}` : "";
  useEffect(() => { setModelMentionSelected(0); }, [modelMentionKey]);
  const modelMentionOpen = rawModelMention !== null;
  useEffect(() => { if (!modelMentionOpen) setModelMentionDismissed(null); }, [modelMentionOpen]);
  // Mount the palette for the warning too. `showSlash` stays false there, so
  // Enter still sends and the arrow keys are not hijacked.
  const mountSlash =
    (showSlash || hasCommandToken(visibleText)) &&
    !slashDismissed &&
    !showMention &&
    !showModelMention &&
    (commands?.length ?? 0) > 0;
  useEffect(() => {
    onSlashOpenChange?.(mountSlash || showMention || showModelMention);
  }, [mountSlash, showMention, showModelMention, onSlashOpenChange]);

  useEffect(() => {
    if (!slashVisible) setSlashDismissed(false);
  }, [slashVisible]);

  // A catalogue is a discovery aid, not an exhaustive command validator.
  const blockedCommand = !projection && text.trim() === "/";

  // Dictation errors stay on screen until dismissed or the next recording:
  // the permission help is too long to read in a toast.
  const [dismissedDictationError, setDismissedDictationError] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (dictation.status === "recording" || dictation.status === "transcribing") setDismissedDictationError(null);
  }, [dictation.status]);
  const dictationError =
    (dictation.status === "error" || dictation.status === "denied") &&
    dictation.lastError &&
    dictation.lastError !== dismissedDictationError
      ? dictation.lastError
      : null;
  const dictating =
    dictation.status === "requesting" ||
    dictation.status === "recording" ||
    dictation.status === "transcribing";
  // A failed or cancelled transcription keeps its recording: offer Retry.
  const dictationNotice =
    dictationError ?? (dictation.status === "idle" && dictation.canRetry ? "Transcription cancelled." : null);
  const { discardRetry: discardDictationRetry } = dictation;

  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== "hidden") void getAttachmentOwner().sync();
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [getAttachmentOwner]);

  const maybePrewarm = useCallback(() => {
    if (!onPrewarm) return;
    if (!sessionPath) return;
    const now = Date.now();
    if (now - prewarmLastRef.current < 60_000) return;
    prewarmLastRef.current = now;
    onPrewarm();
  }, [onPrewarm, sessionPath]);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const node = e.currentTarget;
      setVisibleDraftText(node.value);
      setCaret(node.selectionStart === node.selectionEnd ? node.selectionStart : null);
      setInlineError(null);
    },
    [setVisibleDraftText, setInlineError],
  );
  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const node = e.currentTarget;
    setCaret(node.selectionStart === node.selectionEnd ? node.selectionStart : null);
  }, []);

  // One placeholder tile per file at once: decoding a batch of photos took
  // seconds with nothing on screen but a spinner on Send.
  const [pendingFiles, setPendingFiles] = useState<{ id: number; name: string; cancelled: boolean }[]>([]);
  const nextPhotoId = useRef(0);
  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const owner = getAttachmentOwner();
    const files = Array.from(fileList);
    const tiles = files.map((file) => ({ id: nextPhotoId.current++, name: file.name, cancelled: false }));
    setPendingFiles((pending) => [...pending, ...tiles]);
    const failures: string[] = [];
    await Promise.all(tiles.map(async (tile, index) => {
      const file = files[index];
      if (!file) return;
      try {
        await owner.addFiles([file], async (selected, count) => {
          if (tile.cancelled) return { images: [] };
          const result = await intakeFiles(selected, count);
          if (tile.cancelled) return { images: [] };
          if (result.error) failures.push(result.error);
          return { images: result.images };
        }, MAX_IMAGES);
      } finally {
        setPendingFiles((pending) => pending.filter((item) => item.id !== tile.id));
      }
    }));
    const firstFailure = failures[0];
    if (firstFailure) owner.setError(failures.length === 1 ? firstFailure :
      `${failures.length} of ${files.length} photos couldn’t be added. ${firstFailure}`);
  }, [getAttachmentOwner]);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const list = input.files;
      if (!list || list.length === 0) return;
      await addFiles(list);
      input.value = "";
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      let foreignFile = false;
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
          else if (f) foreignFile = true;
        }
      }
      // A pasted PDF or archive used to vanish without a word; only images can
      // be attached, and saying so is the whole fix.
      if (foreignFile && files.length === 0) showToast("Only images can be attached.", "warn");
      if (files.length > 0) {
        // Attaching the image must not eat the text. Copying a passage and a
        // screenshot together is one clipboard event, and preventDefault used
        // to cancel the whole paste, so the words were silently discarded and
        // only the picture arrived. Insert the text ourselves.
        e.preventDefault();
        const pastedText = e.clipboardData?.getData("text/plain") ?? "";
        if (pastedText) {
          const field = e.currentTarget;
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? start;
          const canonical = setVisibleDraftText(
            `${field.value.slice(0, start)}${pastedText}${field.value.slice(end)}`,
          );
          if (canonical !== null) preparedSelection.current = {
            node: field, start: start + pastedText.length, end: start + pastedText.length,
            direction: "none", text: canonical,
          };
        }
        await addFiles(files);
      }
    },
    [addFiles, setVisibleDraftText],
  );

  const handleRemoveImage = useCallback((idx: number) => {
    const owner = getAttachmentOwner();
    const removed = owner.removeImage(idx);
    if (!removed) return;
    showToast("Photo removed", "info", { label: "Undo", onClick: () => owner.restoreImage(idx, removed) }, { kind: "undo", durationMs: 5000 });
  }, [getAttachmentOwner]);

  const findCommand = useCallback(
    (rawName: string): OmpCommand | undefined => {
      return findCatalogueCommand(commands, rawName);
    },
    [commands],
  );

  const handleSlashPick = useCallback(
    async (name: string) => {
      const attachmentDraft = getAttachmentOwner();
      const draftText = textRef.current;
      const retry = attachmentDraft.retryCleanup();
      if (retry) { await retry; return; }
      try {
        if (attachmentDraft.path) await assertNoPendingEdit(attachmentDraft.path, attachmentDraft.namespace);
      } catch (error) {
        attachmentDraft.setError(humanizeDaemonError(error));
        return;
      }
      // Reservation reads may outlive this keyed composer or credential.
      if (!mountedRef.current || attachmentDraft.path !== sessionPathRef.current ||
        attachmentDraft.namespace !== getDraftNamespace() || textRef.current !== draftText) return;
      if (currentProjection()) {
        setInlineError(COMPACT_COMMAND_ERROR);
        return;
      }
      const cmd = findCommand(name);
      // Templates and skills stay editable in this draft, including photos.
      // Native command-name/alias precedence has already selected `cmd`.
      if (attachmentDraft.getSnapshot().images.length > 0 || cmd?.source === "prompt" || cmd?.source === "skill" || cmd?.source === "skills") {
        const next = `/${(cmd?.name ?? name).replace(/^\/+/, "")} `;
        setDraftText(next);
        setSlashDismissed(true);
        requestAnimationFrame(() => {
          const node = getReferenceEditor();
          if (!node || node.value !== next) return;
          node.focus();
          node.setSelectionRange(next.length, next.length);
        });
        return;
      }
      if (cmd?.shape === "pick" && cmd.picker) {
        onOpenPicker?.(cmd.picker);
        setDraftText("");
        setSlashDismissed(true);
        return;
      }
      if (cmd && onRunCommand) {
        onRunCommand(cmd);
        setDraftText("");
        setSlashDismissed(true);
        return;
      }
      // An unknown name, or no runner wired: put the command in the draft so
      // its arguments can follow.
      const commandName = cmd?.name ?? name;
      setDraftText(`${commandName.startsWith("/") ? commandName : `/${commandName}`} `);
      setSlashDismissed(false);
      requestAnimationFrame(() => getEditor()?.focus());
    },
    [currentProjection, findCommand, getAttachmentOwner, getEditor, getReferenceEditor, onOpenPicker, onRunCommand, setDraftText, setInlineError],
  );

  // The lease, tray and current text editor survive the App's keyed remount.
  // While a turn runs a plain send carries the remembered Steer/Queue mode;
  // `interrupt` comes only from the long-press sheet and is never remembered.
  const handleSend = useCallback(async (interrupt = false) => {
    if (!sendAllowed) return;
    const focusedEditor = getEditor();
    const restoreFocus = focusedEditor !== null && document.activeElement === focusedEditor;
    const attachmentDraft = getAttachmentOwner();
    const retry = attachmentDraft.retryCleanup();
    if (retry) { await retry; return; }
    try {
      if (attachmentDraft.path) await assertNoPendingEdit(attachmentDraft.path, attachmentDraft.namespace);
    } catch (error) {
      attachmentDraft.setError(humanizeDaemonError(error));
      return;
    }
    if (!mountedRef.current || attachmentDraft.path !== sessionPathRef.current ||
      attachmentDraft.namespace !== getDraftNamespace()) return;
    try { attachmentDraft.settleRecoveryText(); }
    catch (error) {
      attachmentDraft.setError(humanizeDaemonError(error));
      return;
    }
    const current = currentProjection();
    if (current && leadsWithCommand(current.prefix)) {
      setInlineError(COMPACT_COMMAND_ERROR);
      return;
    }
    const payloadText = textRef.current;
    if (!payloadText.trim() && !attachmentDraft.getSnapshot().images.length) return;
    if (imagesTooLargeToSend(attachmentDraft.getSnapshot().images)) {
      setInlineError(PAYLOAD_TOO_LARGE_COPY);
      return;
    }
    const sendPath = attachmentDraft.path;
    const namespace = attachmentDraft.namespace;
    const lease = attachmentDraft.beginSend(attachmentDraft.captureTextCleanup(
      payloadText,
      () => removeDraft(sendPath, namespace, payloadText),
      () => readDraft(sendPath, namespace),
    ));
    if (!lease) return;
    // Sending moves on from a failed dictation; its kept recording goes.
    discardDictationRetry();
    // The message is on its way: the next draft starts compact.
    setExpanded(false);
    let saved = false;
    const commit = () => {
      if (!saved) {
        saved = true;
        haptic("light");
        // Accepted, so it is history; a refused send is not.
        recordPromptHistory(payloadText, namespace);
        historyNav.current = null;
      }
      return lease.commit();
    };
    try {
      const delivery = interrupt ? "interrupt" : deliveryForSend(busy, sendMode, canQueue);
      await onSend(payloadText, lease.images.map(({ data, mimeType }) => ({ data, mimeType })), sendPath, commit, delivery, !!current?.references.length);
      await commit();
    } catch (error) {
      lease.fail(humanizeDaemonError(error));
    } finally {
      if (restoreFocus && focusedEditor?.isConnected &&
        (document.activeElement === document.body || document.activeElement === focusedEditor)) {
        focusedEditor.focus({ preventScroll: true });
      }
    }
  }, [busy, canQueue, currentProjection, discardDictationRetry, getAttachmentOwner, getEditor, onSend, sendAllowed, sendMode, setInlineError]);
  handleSendRef.current = handleSend;

  const handlePromptSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!sendAllowed) return;
      // An explicit tap submits the draft, even if discovery has suggestions.
      // Only the keyboard palette owns Enter; a lone slash has no invocation.
      if (!getAttachmentOwner().getSnapshot().cleanupPending && !currentProjection() && blockedCommand) return;
      await handleSend();
    },
    [blockedCommand, currentProjection, getAttachmentOwner, handleSend, sendAllowed],
  );

  const pickMention = useCallback((entry: MentionEntry) => {
    if (!mention) return;
    const next = applyMention(visibleText, mention, entry);
    const canonical = setVisibleDraftText(next.text);
    if (canonical === null) return;
    const node = getEditor();
    if (node) {
      preparedSelection.current = { node, start: next.caret, end: next.caret, direction: "none", text: canonical };
      requestAnimationFrame(() => {
        if (node.isConnected) node.focus();
      });
    }
    setCaret(next.caret);
    setMentionSelected(0);
  }, [getEditor, mention, setVisibleDraftText, visibleText]);

  const pickModelMention = useCallback((entry: ModelMentionEntry) => {
    if (!modelMention) return;
    const next = applyModelMention(visibleText, modelMention, entry);
    const canonical = setVisibleDraftText(next.text);
    if (canonical === null) return;
    const node = getEditor();
    if (node) {
      preparedSelection.current = { node, start: next.caret, end: next.caret, direction: "none", text: canonical };
      requestAnimationFrame(() => {
        if (node.isConnected && node.value === next.text) node.focus();
      });
    }
    setCaret(next.caret);
    setModelMentionSelected(0);
  }, [getEditor, modelMention, setVisibleDraftText, visibleText]);

  /**
   * Up/Down through prompts this device sent, as in the TUI: Up starts only
   * from an empty field, and only from its first line (last line for Down),
   * so arrows still move the caret inside a multi-line prompt. Down past the
   * newest entry returns to the empty field.
   */
  const recallHistory = useCallback((node: HTMLTextAreaElement, direction: "older" | "newer"): boolean => {
    const value = node.value;
    const nav = historyNav.current;
    const navigating = nav !== null && value === nav.shown;
    if (!navigating) historyNav.current = null;
    if (node.selectionStart !== node.selectionEnd) return false;
    const edge = direction === "older"
      ? !value.slice(0, node.selectionStart).includes("\n")
      : !value.slice(node.selectionEnd).includes("\n");
    if (!edge || (!navigating && (direction === "newer" || value !== ""))) return false;
    const list = readPromptHistory(persistenceNamespaceRef.current);
    const next = stepPromptHistory(navigating ? nav.index : -1, list.length, direction);
    if (next === null) return false;
    const shown = next === -1 ? "" : (list[next]?.text ?? "");
    historyNav.current = next === -1 ? null : { index: next, shown };
    setDraftText(shown);
    preparedSelection.current = { node, start: shown.length, end: shown.length, direction: "none", text: shown };
    return true;
  }, [setDraftText]);

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
      if (showModelMention && modelMention && modelMentionEntries) {
        const last = modelMentionEntries.length - 1;
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plain) {
          e.preventDefault();
          setModelMentionSelected(index => e.key === "ArrowDown" ? Math.min(index + 1, last) : Math.max(index - 1, 0));
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && plain) {
          e.preventDefault();
          const entry = modelMentionEntries[Math.min(modelMentionSelected, last)];
          if (entry && !e.repeat) pickModelMention(entry);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setModelMentionDismissed(modelMention.start);
          return;
        }
      }
      if (showMention && mention && mentionEntries) {
        const last = mentionEntries.length - 1;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const down = e.key === "ArrowDown";
          setMentionSelected((i) => (down ? Math.min(i + 1, last) : Math.max(i - 1, 0)));
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && plain) {
          // Preventing default also stops PromptInputTextarea's submit.
          e.preventDefault();
          const entry = mentionEntries[Math.min(mentionSelected, last)];
          if (entry && !e.repeat) pickMention(entry);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionDismissed(mention.start);
          return;
        }
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && plain && !projection
        && recallHistory(e.currentTarget, e.key === "ArrowUp" ? "older" : "newer")) {
        e.preventDefault();
        // The slash palette moves its highlight from a window listener; a
        // recalled `/cmd` is history being browsed, not a palette move.
        e.stopPropagation();
        return;
      }
      if (showSlash && e.key === "Enter" && !e.shiftKey) {
        // Suppress the newline and the form submit, but let the event keep
        // travelling: the palette picks the highlighted command from a
        // listener on `window`. This used to call stopPropagation as well,
        // which killed the native event at the React root, so Enter did
        // nothing whatsoever — no pick and no send — and only a tap worked.
        e.preventDefault();
        // Except a builtin typed out in full: Enter runs it, as in the TUI,
        // instead of a pick opening its subcommand list (`/session` printed
        // nothing and showed a menu). Pickers and argument sheets still win.
        const typed = /^\/([^\s/]+)$/.exec(visibleText.trim())?.[1];
        const exact = typed ? findCatalogueCommand(commands, typed) : undefined;
        if (!e.repeat && exact?.source === "builtin" && (exact.shape === "drill" || exact.shape === "prompt")) {
          e.stopPropagation();
          void handleSend();
          return;
        }
      }
      if (e.key === "Escape" && showSlash) {
        e.preventDefault();
        setSlashDismissed(true);
      }
      if (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace") {
        maybePrewarm();
      }
    },
    [commands, handleSend, maybePrewarm, mention, mentionEntries, mentionSelected, pickMention, modelMention, modelMentionEntries, modelMentionSelected, pickModelMention, projection, recallHistory, showMention, showModelMention, showSlash, visibleText],
  );

  // Browsing commands must not become a persisted "/" draft. The existing
  // palette has its own search field; typed slash commands still work inline.
  const openCommands = useCallback(() => openPalette(null, "/"), []);


  const hasContent = text.trim().length > 0 || images.length > 0;
  const action = composerAction(text, commands, images.length > 0 || intakePending, !!projection?.references.length);
  const sendable = hasContent || intakePending || cleanupPending;
  // The one action slot: Send whenever there is something to send, Stop when
  // a turn runs and the box is empty.
  const stopVisible = busy && stopAllowed;
  const stopOnly = stopVisible && !(sendable && sendAllowed);
  const [focused, setFocused] = useState(false);
  const linkKind = useLinkIndicator().kind;
  const linkDown = linkKind === "unreachable" || linkKind === "offline" || linkKind === "daemon-down";
  // Steer | Queue only matters when there is a running turn to join; it
  // arrives with focus (the keyboard), not under the thumb on the first keystroke.
  const modeContext = { running: busy, hasContent, canQueue, canInterrupt };
  const showSendModes = action.label === "Send" && !dictating && sendAllowed && sendModeChoiceVisible({ ...modeContext, focused });
  const canStopAndSend = action.label === "Send" && stopAllowed && sendAllowed && stopAndSendAvailable(modeContext);
  const [stopAndSendOpen, setStopAndSendOpen] = useState(false);
  const sendPress = useLongPress(() => setStopAndSendOpen(true));
  const sendRef = useRef<HTMLButtonElement | null>(null);
  const sendDisabled = !sendAllowed || !sendable || attachmentsLoading || intakePending
    || (!cleanupPending && blockedCommand) || sendPending;
  const formRef = useRef<HTMLFormElement | null>(null);

  // Keep --composer-clearance reflecting the real height so the toast stack
  // (fixed bottom: calc(var(--composer-clearance)+safe-area)) never paints
  // over the composer. Uses the max(96, innerHeight-top+16) contract,
  // observed via ResizeObserver + viewport changes.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    // Writing a custom property on <html> invalidates style for the whole
    // document, and visualViewport scroll fires per frame while the keyboard
    // animates; only write when the clearance actually changed.
    let written = -1;
    let height = -1;
    const update = () => {
      const rect = el.getBoundingClientRect();
      // The card's own height: what the transcript and the jump-to-latest
      // button, which end where it starts floating, must clear.
      const own = Math.ceil(rect.height);
      if (own !== height) {
        height = own;
        document.documentElement.style.setProperty("--composer-height", `${own}px`);
      }
      const value = Math.max(96, Math.ceil(window.innerHeight - rect.top + 16));
      if (value === written) return;
      written = value;
      document.documentElement.style.setProperty(
        "--composer-clearance",
        `${value}px`,
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
    };
  }, []);


  return (
    // The anchor takes no height: the composer floats over the transcript
    // (which pads itself by --composer-clearance) instead of reserving a strip.
    <div className="relative h-0 shrink-0">
    <div
      ref={composerRef}
      className="absolute inset-x-0 bottom-0 z-raised mx-auto w-full max-w-[48rem] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-1"
    >
      {/* Scrim: solid page colour behind the banners and the composer, fading in over its top 40px (ChatGPT's).
          The old "no backdrop band" stance avoided a translucent black fade smudging the reply; text
          scrolling under the pills and the Down button is the worse failure. Styled in styles.css. */}
      <div aria-hidden className="composer-scrim pointer-events-none absolute inset-x-0 bottom-0 top-0 -z-10" />
      {above ? <div className="-mx-3 flex flex-col pt-2">{above}</div> : null}
      {extensionDraft ? <details key={extensionDraft.id} className="mb-2 rounded-md bg-surface-2 px-3 py-2 text-meta" data-testid="extension-editor-draft">
        <summary className="min-h-12 cursor-pointer py-3 leading-6 text-muted-foreground">Extension prepared {extensionDraft.text === "" ? "an editor clear" : "text"} · Review</summary>
        <p className="mt-2 text-muted-foreground">Your draft is kept unless you choose to replace it. Photos stay attached. Nothing is sent.</p>
        {extensionDraft.text !== "" ? <pre className="my-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans">{extensionDraft.text}</pre> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {extensionDraft.text !== "" ? <Button type="button" size="sm" className="min-h-12" variant="secondary" disabled={!extensionReady} onClick={() => applyExtensionDraft("append")}>Add to draft</Button> : null}
          <Button type="button" size="sm" className="min-h-12" variant="ghost" disabled={!extensionReady} onClick={() => applyExtensionDraft("replace")}>{extensionDraft.text === "" ? "Clear my text" : "Replace my text"}</Button>
          <Button type="button" size="sm" className="min-h-12" variant="ghost" onClick={() => {
            try { onConsumeExtensionDraft?.(extensionDraft.id); }
            catch { setInlineError("Could not save your dismissal. Try again before closing this conversation."); }
          }}>Dismiss prepared text</Button>
        </div>
      </details> : null}
      {inlineError ? (
        <Notice
          tone="danger"
          className="mb-2"
          action={/no images found|try a jpeg or png/i.test(inlineError) && !intakePending
            ? { label: "Choose image", onClick: () => fileRef.current?.click() }
            : /fewer photos|remove one to add another/i.test(inlineError) && images.length
              ? { label: "Review images", onClick: () => formRef.current?.querySelector<HTMLButtonElement>('[data-testid="attachment-remove"]')?.focus() }
              : inlineError === COMPACT_COMMAND_ERROR ? { label: "Edit full draft", onClick: editFullDraft }
                : errorRecoveryAction(inlineError, onOpenModelPicker)}
          onDismiss={() => setInlineError(null)}
          testId="composer-error"
        >
          {inlineError}
        </Notice>
      ) : null}
      {dictationNotice ? (
        <DictationNotice
          dictation={dictation}
          message={dictationNotice}
          className="mb-2"
          onDismiss={() => {
            setDismissedDictationError(dictationNotice);
            discardDictationRetry();
          }}
        />
      ) : null}
      {compactCommand && !inlineError ? <Notice tone="warning" className="mb-2" testId="compact-reference-command-warning" action={{ label: "Edit full draft", onClick: editFullDraft }}>{COMPACT_COMMAND_ERROR}</Notice> : null}

      {mention && mentionEntries !== null ? (
        <MentionPicker id={mentionListId} entries={mentionEntries} selected={Math.min(mentionSelected, mentionEntries.length - 1)} onPick={pickMention} truncated={mentionListing.truncated} error={mentionListing.error} />
      ) : null}
      {showModelMention && modelMentionEntries ? (
        <ModelMentionPicker entries={modelMentionEntries} selected={Math.min(modelMentionSelected, modelMentionEntries.length - 1)} onPick={pickModelMention} />
      ) : null}

      {mountSlash ? (
        <SlashPalette
          commands={commands}
          onClose={handleSlashClose}
          onPick={handleSlashPick}
          text={visibleText}
        />
      ) : null}

      {controller ? (
        <QueuedMessagesBar controller={controller} pending={pendingSends} onChooseModel={onOpenModelPicker} />
      ) : null}

      <input
        accept="image/*"
        multiple
        onChange={handleFileChange}
        ref={fileRef}
        className="hidden"
        type="file"
      />
      <input
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        ref={cameraRef}
        className="hidden"
        type="file"
      />

      {sendBlockedReason ? (
        <p data-testid="composer-send-blocked" className="mb-1.5 flex items-start gap-1.5 px-2 text-meta text-muted-foreground">
          <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{sendBlockedReason}</span>
        </p>
      ) : null}
      {showSendModes ? (
        <Segmented
          aria-label="When to send"
          testId="send-mode"
          options={SEND_MODE_OPTIONS}
          value={sendMode}
          onChange={(mode) => onSendModeChange?.(mode)}
          // Compact 32px track; each segment's hit area still reaches 44px.
          className="mb-1.5 h-8 w-fit [&>button]:px-4 [&>button]:after:-inset-y-1.5"
        />
      ) : null}

      {/* ChatGPT's composer: one rounded surface, no border or ring, two rows.
          The field on top; below it the + menu, the model chip, the context
          ring, then mic and the round Send/Stop. Focus and a running turn
          change nothing about the surface. */}
      <form
        ref={formRef}
        onSubmit={handlePromptSubmit}
        onFocus={() => {
          setFocused(true);
          // A dead link is known before the message is finished, not after it fails.
          controller?.noteUserActivity();
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
        data-testid="composer-card"
        // `@container`: the chips drop words by the card's width in rem, so a
        // smaller system font (which shrinks rem) keeps them.
        className="@container flex flex-col rounded-[calc(28px*var(--radius-scale,1))] bg-surface-2 shadow-[var(--shadow-float)]"
      >
        {images.length > 0 || pendingFiles.length > 0 ? (
          <div className="px-3 pt-3" data-testid="composer-attachments">
            <AttachmentStrip images={images} pendingFiles={pendingFiles} onCancelPending={(id) => {
              const tile = pendingFiles.find((item) => item.id === id);
              if (tile) tile.cancelled = true;
              setPendingFiles((pending) => pending.filter((item) => item.id !== id));
            }} onRemove={handleRemoveImage} />
          </div>
        ) : null}
        <AgentReferenceRows
          key={`${persistenceNamespaceRef.current}:${sessionPath ?? ""}`}
          references={projection?.references ?? []}
          onRemove={removeReference}
          onEditFullDraft={editFullDraft}
          getEditor={getReferenceEditor}
        />
        {action.description ? <p role="status" data-testid="composer-action" className="px-4 pt-2.5 text-meta text-muted-foreground">
          <strong>{action.label === "Run" ? "Run command. " : ""}</strong>{action.description}
        </p> : null}
        <div className={cn("relative px-2 pt-1.5", (overflowing || expanded) && "pr-10")}>
          <HighlightedPromptInput
            keywords={promptKeywords}
            className="block max-h-40 min-h-11 min-w-0 px-2 py-[0.6875rem] text-body caret-primary placeholder:text-tertiary transition-[min-height,max-height] duration-[200ms] ease-[var(--ease-position)] motion-reduce:transition-none"
            // About 60% of what the reader can see: dvh already drops an Android keyboard, the inset drops iOS's.
            style={expanded ? { minHeight: `calc((100dvh - ${keyboardInset}px) * 0.6)`, maxHeight: `calc((100dvh - ${keyboardInset}px) * 0.6)` } : undefined}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={showMention ? mentionListId : showModelMention ? "model-mention-list" : undefined}
            aria-activedescendant={showMention ? `${mentionListId}-${Math.min(mentionSelected, mentionEntries!.length - 1)}` : showModelMention ? `model-mention-list-${Math.min(modelMentionSelected, (modelMentionEntries?.length ?? 1) - 1)}` : undefined}
            data-composer-input=""
            data-testid="composer-input"
            onChange={handleInput}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onFocus={maybePrewarm}
            onBlur={() => setCaret(null)}
            onSelect={handleSelect}
            onKeyDown={handleTextareaKeyDown}
            onPaste={handlePaste}
            // Offline the box says what happens to a message, so sending
            // without a connection never feels like shouting into a void.
            placeholder={sendBlockedReason ? "Can’t send from here" : linkDown ? "Message omp (sent when online)" : "Message omp"}
            rows={1}
            value={visibleText}
          />
          {overflowing || expanded ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              // Keep the field focused (and the keyboard up) through the tap.
              onPointerDown={(event) => event.preventDefault()}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse composer" : "Expand composer"}
              data-testid="composer-expand"
              className="press-bounce absolute right-2.5 top-2 flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none after:absolute after:-inset-1.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? <Minimize2Icon aria-hidden className="size-4" /> : <Maximize2Icon aria-hidden className="size-4" />}
            </button>
          ) : null}
        </div>
        {/* The toolbar. While dictating, the recording bar owns this row and is
            the only send. 16px text: Android zooms into any smaller focused field. */}
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          {dictating ? (
            <div className="min-w-0 flex-1">
              <DictationBar
                dictation={dictation}
                onInsert={() => stopDictation(false)}
                onInsertAndSend={() => stopDictation(true)}
              />
            </div>
          ) : (
            <>
              <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="More actions"
                      data-testid="composer-plus-btn"
                      className="shrink-0 rounded-full text-foreground"
                    />
                  }
                >
                  <PlusIcon aria-hidden className="size-6" strokeWidth={1.75} />
                </DropdownMenuTrigger>
                {/* Items close the menu as they run, so a sheet they open is the only layer up. */}
                <DropdownMenuContent side="top" align="start" sideOffset={10} className="w-72" data-testid="composer-plus-sheet">
                  <DropdownMenuItem data-testid="composer-add-image" onClick={() => fileRef.current?.click()}>
                    <ImageIcon aria-hidden className="size-5" />Add image
                  </DropdownMenuItem>
                  <DropdownMenuItem data-testid="composer-take-photo" onClick={() => cameraRef.current?.click()}>
                    <CameraIcon aria-hidden className="size-5" />Take photo
                  </DropdownMenuItem>
                  {/* The touch route to prompt history; a hardware keyboard has Up. */}
                  <DropdownMenuItem data-testid="composer-history" onClick={() => setHistoryOpen(true)}>
                    <HistoryIcon aria-hidden className="size-5" />History
                  </DropdownMenuItem>
                  <DropdownMenuItem data-testid="composer-insert-skill" onClick={openSkillPicker}>
                    <BookOpenIcon aria-hidden className="size-5" />Insert skill
                  </DropdownMenuItem>
                  <DropdownMenuItem data-testid="composer-commands" onClick={openCommands}>
                    <SquareSlashIcon aria-hidden className="size-5" />Commands
                  </DropdownMenuItem>
                  <PluginMenuItems variant="dropdown" views={pluginActions.views} onAction={pluginActions.onAction} onClose={() => setPlusOpen(false)} />
                </DropdownMenuContent>
              </DropdownMenu>
              {store ? <ModelChip store={store} sessionPath={sessionPath} fallbackModel={fallbackModel} onOpenModelPicker={onOpenModelPicker} onModelChanged={onModelChanged} /> : null}
              <ContextChip percent={contextPercent} onOpen={onOpenUsage} />
              <span className="min-w-0 flex-1" />
              <VoiceButton dictation={dictation} />
              {stopVisible ? (
                // Stopping is not destructive: a neutral control, as in Paseo. With a draft
                // Send holds the slot and Stop sits beside it, so a running agent can be
                // stopped without clearing what was typed.
                <Button
                  type="button"
                  variant={stopOnly ? "primary" : "secondary"}
                  className={cn(
                    "rounded-full",
                    stopOnly ? "animate-[send-in_var(--dur-base)_var(--ease-spring)_both]" : "relative !size-9 bg-surface-3 after:absolute after:-inset-1 after:content-['']",
                  )}
                  size="icon"
                  aria-label={stopping ? "Stopping" : "Stop"}
                  aria-busy={stopping}
                  disabled={stopping}
                  data-testid="composer-stop-btn"
                  // Keep the field focused (and the keyboard up) through the tap.
                  onPointerDown={(event) => event.preventDefault()}
                  // The haptic is fired where the stop is owned (ChatScreen).
                  onClick={onStop}
                >
                  {stopping ? (
                    <Spinner size={16} label={null} />
                  ) : (
                    <SquareIcon aria-hidden className={cn("size-3.5 fill-current", stopOnly ? "text-primary-foreground" : "text-foreground")} />
                  )}
                </Button>
              ) : null}
              {!stopOnly ? (
                <Button
                  type="submit"
                  variant={sendDisabled ? "secondary" : "primary"}
                  // Something to send: the filled accent circle grows in (0.85 → 1).
                  // The animation restarts each time this class is re-added.
                  className={cn("rounded-full", !sendDisabled && "animate-[send-in_var(--dur-base)_var(--ease-spring)_both]")}
                  size={action.label === "Run" ? "sm" : "icon"}
                  aria-label={intakePending ? "Preparing images" : cleanupPending ? "Retry saved draft cleanup" : action.label}
                  aria-busy={intakePending || sendPending}
                  data-testid="composer-send-btn"
                  ref={sendRef}
                  disabled={sendDisabled}
                  // Long-press is wired only where a send option exists, so an
                  // ordinary hold elsewhere can never swallow the tap.
                  {...(canStopAndSend ? {
                    "aria-haspopup": "menu" as const,
                    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); sendPress.onPointerDown(e); },
                    onPointerMove: sendPress.onPointerMove,
                    onPointerUp: sendPress.onPointerUp,
                    onPointerCancel: sendPress.onPointerCancel,
                    onPointerLeave: sendPress.onPointerLeave,
                    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
                    onClick: (e: React.MouseEvent) => {
                      // The release after a long-press is not a send.
                      if (sendPress.shouldSuppressClick()) {
                        e.preventDefault();
                        sendPress.consumeFired();
                      }
                    },
                  } : { onPointerDown: (e: React.PointerEvent) => e.preventDefault() })}
                >
                  {sendPending || intakePending ? (
                    <Spinner size={20} label={null} />
                  ) : action.label === "Run" ? (
                    <><TerminalIcon aria-hidden className="size-4" />Run</>
                  ) : (
                    <ArrowUpIcon aria-hidden className="size-5" />
                  )}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </form>
      {/* A bubble off the Send button it was held on; the row says what stopping costs before the reader commits. */}
      <DropdownMenu open={stopAndSendOpen} onOpenChange={setStopAndSendOpen}>
        <DropdownMenuContent anchor={sendRef} side="top" align="end" sideOffset={10} data-testid="stop-and-send-sheet">
          <DropdownMenuChoice
            data-testid="stop-and-send"
            icon={<SquareIcon className="!size-4 fill-current" />}
            title="Stop and send"
            subtitle="Ends this reply, then sends yours"
            onClick={() => {
              void handleSend(true);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <HistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        api={dictationApi}
        sessionPath={sessionPath}
        prepareInsert={prepareHistoryInsert}
      />
      <SkillPicker open={skillPickerOpen} onOpenChange={setSkillPickerOpen} commands={commands} onPick={pickSkill} returnFocus={returnSkillFocus} />
    </div>
    </div>
  );
}

const SEND_MODE_OPTIONS = [
  { value: "steer", label: "Send now" },
  { value: "queue", label: "After this reply" },
] as const satisfies readonly { value: SendMode; label: string }[];
