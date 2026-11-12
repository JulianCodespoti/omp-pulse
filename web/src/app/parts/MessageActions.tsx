"use client";

import { useScrimDismiss } from "@/app/hooks/use-scrim-dismiss";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";

import type { UiMessage } from "@/domain/messages";
import { showBanner, showToast } from "@/app/Notices";
import { useLongPress } from "@/app/hooks/use-long-press";
import { useBackLayer } from "@/app/back-layer";
import { haptic } from "@/platform/haptic";
import { speak, speechAvailable, stopSpeaking, useSpeaking } from "@/platform/speech";
import { cn } from "@/lib/utils";
import {
  DaemonApi,
  sendPromptDurably,
  isOwnershipError,
} from "@/runtime/rpc-client";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { loadMessageImages } from "@/runtime/message-images";
import { fetchWithDeadline } from "@/runtime/request";
import { EditResendSheet } from "@/app/chat/EditResendSheet";
import { ConfirmSheet } from "@/app/ui/Sheet";
import {
  CopyIcon,
  MessageSquareQuoteIcon,
  FileCodeIcon,
  GitBranchIcon,
  PencilIcon,
  RotateCcwIcon,
  ShareIcon,
  TextSelectIcon,
  UndoIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react";
import { seedDraft } from "../composer/use-draft";
import { readPairingToken } from "@/platform/browser-storage";
import { shortModel } from "../session-format";
import { copyText } from "@/platform/clipboard";

function markdownForMessage(message: UiMessage): string {
  let out = message.text ?? "";
  for (const part of message.parts) {
    if (part.kind === "tool" && part.output) {
      const fenced = part.output.includes("```")
        ? `\n\n---\n${part.name}\n\n${part.output}\n---`
        : `\n\n\`\`\`${part.name}\n${part.output}\n\`\`\``;
      out += fenced;
    }
  }
  return out;
}

async function writeClipboard(text: string): Promise<boolean> {
  return text ? copyText(text) : false;
}

/**
 * Whether a press at the given viewport point lands on real, non-whitespace text of `target`.
 *
 * Used to hand a long press back to the platform so it can select. It measures the
 * pressed element's own text rectangles rather than asking `caretRangeFromPoint`, which
 * snaps to the nearest text: it answered "text" for blank space beside a short last line,
 * and for a glyph under an overlay it returned an unrelated node. The padding around the
 * words, the gaps in an assistant turn and any non-text area stay a press on the message.
 */
function pressIsOnText(x: number, y: number, target: Element | null): boolean {
  if (typeof document === "undefined" || target === null) return false;
  // No slop: a text node's rects are whole line boxes, so a press just outside one is not on text.
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? "").trim() === "") continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
    }
  }
  return false;
}

/** The pressed message's visible box: the press target's own, else the row's first. */
function boxFor(target: Element, row: Element): HTMLElement | null {
  return target.closest<HTMLElement>("[data-message-box]") ?? row.querySelector<HTMLElement>("[data-message-box]");
}

/**
 * The assistant box a reply's ⋯ button belongs to: the last assistant box
 * before the footer holding the button. `window.event` is the click being
 * dispatched (Safari does not focus a tapped button, so activeElement alone
 * is not enough); the rows carry no message ids to look the box up by.
 */
function replyBox(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const clicked = window.event?.target;
  const source = clicked instanceof Element ? clicked : document.activeElement;
  const footer = source?.closest("[data-testid='turn-footer']");
  if (!footer) return null;
  const boxes = document.querySelectorAll<HTMLElement>(".is-assistant [data-message-box]");
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (boxes[i]!.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING) return boxes[i]!;
  }
  return null;
}

const EDGE = 8;
const GAP = 8;

/** Where the lifted box and the menu sit, in viewport pixels. */
type MenuLayout = {
  box: { top: number; left: number; width: number; height: number } | null;
  menu: { top: number; left: number };
  above: boolean;
};

export type MessageActionsOptions = {
  messages?: readonly UiMessage[];
  sessionPath?: string | null;
  onBranched?: (sessionPath: string) => void;
  onSendPrompt?: typeof sendPromptDurably;
  /** The newest user message may be edited in the composer and its turn replaced (domain/turn-redo.ts). */
  edit?: { messageId: string; disabled: boolean; onEdit: (message: UiMessage) => void };
};

export type MessageBindings = {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  style: React.CSSProperties;
};

// Message text is ALWAYS selectable. It used to be `none` unless this exact
// message had been put into a special "selectable" mode through the action
// sheet — a six-step detour (long-press, wait, sheet, tap "Select text", press
// again, drag) for what is one native gesture.
const SELECTABLE_STYLE: React.CSSProperties = {
  userSelect: "text",
  WebkitUserSelect: "text",
};

export function useMessageActions(options: MessageActionsOptions = {}): {
  bind: (message: UiMessage) => MessageBindings;
  /**
   * Open the action sheet without a long-press (assistant prose is all selectable text, so it has no blank point to press).
   * `detail` is an optional quiet line for the sheet header: the latest reply's duration and speed, one tap deep.
   */
  open: (message: UiMessage, detail?: string) => void;
  sheet: JSX.Element;
} {
  const { messages, sessionPath, onBranched, onSendPrompt, edit } = options;
  const token = readPairingToken() ?? "";

  const [active, setActive] = useState<UiMessage | null>(null);
  const [activeDetail, setActiveDetail] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const [lifted, setLifted] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);

  // Confirm in a sheet rather than window.confirm — keeps mobile sheet interaction.
  // Which action's ConfirmSheet is open; the action itself runs from its confirm.
  const [pendingConfirm, setPendingConfirm] = useState<"send" | "branch" | null>(null);
  const [busyAction, setBusyAction] = useState<"copy" | "send" | "branch" | null>(null);
  const busySend = busyAction === "send";
  const busyBranch = busyAction === "branch";
  const [editOpen, setEditOpen] = useState(false);
  const [editor, setEditor] = useState<{
    generation: number;
    mode: "resend" | "rewind";
    text: string;
    images: Pick<UiMessage, "parts" | "localAttachmentCount">;
    sourceEntryId: string | null;
    sessionPath: string | null;
  } | null>(null);
  const editGeneration = useRef(0);
  const editTimer = useRef<number | null>(null);
  const sessionRef = useRef(sessionPath ?? null);
  sessionRef.current = sessionPath ?? null;
  const actionGeneration = useRef(0);
  const actionPending = useRef(false);
  const actionView = useRef({ open, message: active, sessionPath: sessionPath ?? null });
  actionView.current = { open, message: active, sessionPath: sessionPath ?? null };
  const invalidateActions = useCallback(() => {
    actionGeneration.current++;
    actionPending.current = false;
    setBusyAction(null);
  }, []);
  const selectionCurrent = useCallback(() => Boolean(active) && actionView.current.open &&
    actionView.current.message === active && actionView.current.sessionPath === (sessionPath ?? null) &&
    (readPairingToken() ?? "") === token,
  [active, sessionPath, token]);
  const beginAction = useCallback((kind: "copy" | "send" | "branch") => {
    if (!selectionCurrent() || actionPending.current) return null;
    const generation = ++actionGeneration.current;
    actionPending.current = true;
    setBusyAction(kind);
    const current = () => generation === actionGeneration.current && selectionCurrent();
    return { current, finish: () => {
      if (!current()) return;
      actionPending.current = false;
      setBusyAction(null);
    } };
  }, [selectionCurrent]);
  const cancelEditTransition = useCallback(() => {
    editGeneration.current++;
    if (editTimer.current !== null) window.clearTimeout(editTimer.current);
    editTimer.current = null;
    setEditOpen(false);
    setEditor(null);
  }, []);
  const closeMenu = useCallback(() => {
    actionView.current.open = false;
    invalidateActions();
    cancelEditTransition();
    setOpen(false);
  }, [invalidateActions, cancelEditTransition]);
  const scrim = useScrimDismiss(closeMenu);
  useLayoutEffect(() => {
    invalidateActions();
    actionView.current = { open: false, message: null, sessionPath: sessionRef.current };
    cancelEditTransition();
    setOpen(false);
    setActive(null);
    return () => {
      actionView.current.open = false;
      invalidateActions();
      cancelEditTransition();
    };
  }, [sessionPath, token, cancelEditTransition, invalidateActions]);

  // Reset confirms when sheet closes or active changes.
  useEffect(() => {
    if (!open) { setPendingConfirm(null); setAnchor(null); }
  }, [open]);

  useEffect(() => {
    setPendingConfirm(null);
  }, [active?.id]);

  const fire = useCallback((msg: UiMessage, detail?: string, box?: HTMLElement | null) => {
    invalidateActions();
    cancelEditTransition();
    actionView.current = { open: true, message: msg, sessionPath: sessionRef.current };
    setActive(msg);
    setActiveDetail(detail);
    setAnchor(box ?? null);
    setOpen(true);
  }, [cancelEditTransition, invalidateActions]);
  // The ⋯ path: no press, so no haptic from the long-press hook.
  const openReply = useCallback((msg: UiMessage, detail?: string) => {
    haptic("medium");
    fire(msg, detail, replyBox());
  }, [fire]);

  // 700ms, not the 500ms default. Android begins its text-selection gesture at
  // ~500ms; firing at the same instant meant our sheet painted over the
  // selection and copying a snippet out of the transcript was impossible.
  // Waiting past that threshold lets the selection land, and the hook then
  // sees it and stands down.
  const longPress = useLongPress(undefined, { delay: 700 });

  // Bindings are cached per message OBJECT. Rows are memoized on
  // `bindings` identity, and a fresh object per call failed that check for
  // every row on every streamed frame. Messages are replaced, never mutated,
  // so a WeakMap keyed on the object hands back the same bindings until the
  // message itself changes — and releases them when the row is evicted.
  const bind = useMemo(() => {
    const cache = new WeakMap<UiMessage, MessageBindings>();
    return (message: UiMessage): MessageBindings => {
      const hit = cache.get(message);
      if (hit) return hit;
      const bindings: MessageBindings = {
        onPointerDown: (e: React.PointerEvent) => {
          const target = e.target as HTMLElement | null;
          if (
            target?.closest?.(
              'button, a, [role="button"], input, textarea, select',
            )
          )
            return;
          if (e.button !== 0) return;
          // A press that lands on actual TEXT belongs to the platform: long
          // press is how you select, and stealing it made copying a phrase out
          // of a reply impossible ("it prompts me to copy the whole thing").
          //
          // Checked synchronously from the hit point rather than by waiting to
          // see whether a selection appears. The WebView's selection timing is
          // not a contract and may not surface through the DOM Selection API at
          // all, so a timing race is not something to depend on. The hook keeps
          // a `selectionchange` abort as a second net.
          //
          // The sheet stays reachable: pressing a bubble's padding, the gaps in
          // an assistant turn, or any non-text area still opens it.
          if (pressIsOnText(e.clientX, e.clientY, target)) return;
          const box = boxFor(target ?? e.currentTarget, e.currentTarget);
          longPress.onPointerDown(e, () => fire(message, undefined, box));
        },
        onPointerMove: longPress.onPointerMove,
        onPointerUp: longPress.onPointerUp,
        onPointerCancel: longPress.onPointerCancel,
        onPointerLeave: longPress.onPointerLeave,
        onClick: (e: React.MouseEvent) => {
          if (longPress.shouldSuppressClick()) {
            e.preventDefault();
            e.stopPropagation();
            longPress.consumeFired();
            return;
          }
          if (message.role !== "user") return;
          // Message style → Bubbles: a tap on a bubble shows its info, as in a
          // messenger; the actions sheet stays on long-press.
          if ((e.target as Element).closest("[data-bubble-tap]")) return;
          const selection =
            typeof window !== "undefined" &&
            typeof window.getSelection === "function"
              ? (window.getSelection()?.toString() ?? "")
              : "";
          if (selection.trim()) return;
          haptic("light");
          fire(message, undefined, boxFor(e.target as Element, e.currentTarget));
        },
        style: SELECTABLE_STYLE,
      };
      cache.set(message, bindings);
      return bindings;
    };
  }, [fire, longPress]);

  const copyAndClose = useCallback(async (text: string, success: string) => {
    const attempt = beginAction("copy");
    if (!attempt) return;
    try {
      const ok = await writeClipboard(text);
      if (!attempt.current()) return;
      closeMenu();
      showToast(ok ? success : "Couldn't copy", ok ? "success" : "error");
    } catch {
      if (attempt.current()) { closeMenu(); showToast("Couldn't copy", "error"); }
    } finally { attempt.finish(); }
  }, [beginAction, closeMenu]);
  const handleCopyText = useCallback(async () => {
    if (active) await copyAndClose(active.text, "Copied");
  }, [active, copyAndClose]);
  const handleCopyMarkdown = useCallback(async () => {
    if (!active || !selectionCurrent() || actionPending.current) return;
    await copyAndClose(markdownForMessage(active), "Copied as markdown");
  }, [active, copyAndClose, selectionCurrent]);

  const handleCopyRequest = useCallback(async () => {
    if (!active || !selectionCurrent() || actionPending.current) return;
    let reqText: string | null = null;
    if (messages && messages.length > 0) {
      const idx = messages.findIndex((m) => m.id === active.id);
      if (idx > 0) {
        for (let i = idx - 1; i >= 0; i--) {
          const m = messages[i];
          if (!m) continue;
          if (m.role === "user") {
            reqText = m.text;
            break;
          }
        }
      } else if (idx === -1) {
        // Active not in supplied array (e.g. streaming) — scan backwards for last user.
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m && m.role === "user") {
            reqText = m.text;
            break;
          }
        }
      }
    }
    if (!reqText) {
      showToast("No prompt found before this reply", "warn");
      return;
    }
    await copyAndClose(reqText, "Copied prompt");
  }, [active, messages, copyAndClose, selectionCurrent]);

  const startEditor = useCallback((mode: "resend" | "rewind") => {
    if (!active || !selectionCurrent() || actionPending.current) return;
    invalidateActions();
    actionView.current.open = false;
    cancelEditTransition();
    const intent = {
      generation: editGeneration.current,
      mode,
      text: active.text ?? "",
      images: active,
      sourceEntryId: active.sourceEntryId ?? null,
      sessionPath: sessionPath ?? null,
    };
    setEditor(intent);
    setOpen(false);
    editTimer.current = window.setTimeout(() => {
      if (editGeneration.current !== intent.generation || sessionRef.current !== intent.sessionPath ||
          (readPairingToken() ?? "") !== token) return;
      editTimer.current = null;
      setEditOpen(true);
    }, 120);
  }, [active, sessionPath, token, cancelEditTransition, selectionCurrent, invalidateActions]);
  const handleEditResend = useCallback(() => startEditor("resend"), [startEditor]);
  const handleEditRewind = useCallback(() => startEditor("rewind"), [startEditor]);
  const performSend = useCallback(
    async (message: UiMessage) => {
      const attempt = beginAction("send");
      if (!attempt) return;
      try {
        const trimmed = message.text.trim();
        // Deadline: a stalled link left the resend spinner running forever.
        const images = await loadMessageImages(message, (path) => fetchWithDeadline(path, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }));
        if (!attempt.current()) return;
        if (!trimmed && images.length === 0) { showToast("Nothing to send", "warn"); return; }
        if (!sessionPath) { showToast("No session", "error"); return; }
        await (onSendPrompt ?? sendPromptDurably)(sessionPath, trimmed, images, {
          token,
          onSaved: () => {
            if (!attempt.current()) return;
            // Further recovery belongs to this saved command in the outbox,
            // not another confirmation that could create a new command ID.
            closeMenu();
            setPendingConfirm(null);
          },
        });
      } catch (e) {
        if (!attempt.current()) return;
        if (isOwnershipError(e)) showBanner(humanizeDaemonError(e), "warn");
        else showToast(humanizeDaemonError(e), "error");
      } finally { attempt.finish(); }
    },
    [onSendPrompt, sessionPath, token, beginAction, closeMenu],
  );

  const armConfirm = useCallback((action: "send" | "branch") => {
    if (!active || !selectionCurrent() || actionPending.current) return;
    setPendingConfirm(action);
  }, [active, selectionCurrent]);

  const handleSendAgain = useCallback(async () => {
    if (!active || !selectionCurrent() || actionPending.current) return;
    await performSend(active);
  }, [active, performSend, selectionCurrent]);

  const handleBranch = useCallback(async () => {
    if (!active || !selectionCurrent() || actionPending.current) return;
    const entryId = active.sourceEntryId;
    if (!entryId) {
      showToast("Cannot branch: missing entry id", "error");
      return;
    }
    if (!sessionPath) {
      showToast("No session", "error");
      return;
    }
    const attempt = beginAction("branch");
    if (!attempt) return;
    try {
      const api = new DaemonApi(token);
      // The daemon now branches directly from the same raw file-entry ids
      // carried by the transcript. Text matching is ambiguous for repeats.
      const result = await api.branch(sessionPath, entryId);
      if (!attempt.current()) return;
      if (result.cancelled) {
        showToast("Branch cancelled", "warn");
        return;
      }
      const { sessionPath: next, text: branchedText } = result;
      seedDraft(next, branchedText);
      closeMenu();
      setPendingConfirm(null);
      if (onBranched) onBranched(next);
      else {
        // Fallback: try to open via hash navigation if caller did not wire onBranched.
        try {
          window.location.hash = `#s=${encodeURIComponent(next)}`;
        } catch {
          // ignore
        }
      }
    } catch (e) {
      if (!attempt.current()) return;
      if (isOwnershipError(e)) {
        // The raw daemon message is the guard boilerplate WITH pid and
        // command line; the humanizer strips those and prefers the reason
        // automatic sharing failed (reported as "it just says this
        // conversation is held on my desktop" while the laptop showed its
        // collab box).
        showBanner(humanizeDaemonError(e), "warn");
      } else {
        showToast(humanizeDaemonError(e), "error");
      }
    } finally {
      attempt.finish();
    }
  }, [active, onBranched, sessionPath, token, selectionCurrent, beginAction, closeMenu]);

  const isUser = active?.role === "user";
  const busy = busyAction !== null;
  // Speed lives in the turn footer's metrics; the menu names only the model.
  const model = active?.role === "assistant" && active.model ? shortModel(active.model) : "";
  const description = [model || null, activeDetail ?? null].filter(Boolean).join(" · ");
  const speaking = useSpeaking();
  const canSelect = Boolean(anchor?.isConnected);

  const handleSelectText = () => {
    const box = anchor;
    closeMenu();
    // After the close commits: it restores focus, which would drop a selection made now.
    window.setTimeout(() => {
      if (!box?.isConnected) return;
      const range = document.createRange();
      range.selectNodeContents(box);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, 0);
  };
  const handleSpeak = () => {
    if (!active) return;
    if (speaking) stopSpeaking();
    else speak(active.text);
    closeMenu();
  };
  const handleShare = async () => {
    if (!active) return;
    const text = active.text;
    closeMenu();
    if (typeof navigator.share === "function") {
      try { await navigator.share({ text }); } catch (e) {
        if (!(e instanceof Error && e.name === "AbortError")) showToast("Couldn't share", "error");
      }
      return;
    }
    const ok = await writeClipboard(text);
    showToast(ok ? "Copied" : "Couldn't copy", ok ? "success" : "error");
  };

  const items: { key: string; icon: JSX.Element; label: string; onClick: () => void; disabled?: boolean }[] = [
    { key: "copy", icon: <CopyIcon aria-hidden />, label: "Copy text", onClick: () => void handleCopyText(), disabled: busy },
    { key: "markdown", icon: <FileCodeIcon aria-hidden />, label: "Copy as markdown", onClick: () => void handleCopyMarkdown(), disabled: busy },
    ...(isUser ? [] : [{ key: "prompt", icon: <MessageSquareQuoteIcon aria-hidden />, label: "Copy prompt", onClick: () => void handleCopyRequest(), disabled: busy }]),
    ...(canSelect ? [{ key: "select", icon: <TextSelectIcon aria-hidden />, label: "Select text", onClick: handleSelectText }] : []),
    ...(isUser ? [
      // The newest message has ONE Edit: it replaces the turn (rewind in place, or on a
      // branch when the desktop owns the session). "Edit & resend" and "Edit & rewind from
      // here" stay for older messages, where they send as a new message / branch from there.
      ...(edit && active?.id === edit.messageId
        ? [{ key: "edit-turn", icon: <PencilIcon aria-hidden />, label: "Edit", onClick: () => { closeMenu(); edit.onEdit(active); }, disabled: busy || edit.disabled }]
        : [
          { key: "edit", icon: <PencilIcon aria-hidden />, label: "Edit & resend", onClick: handleEditResend, disabled: busy },
          { key: "rewind", icon: <UndoIcon aria-hidden />, label: "Edit & rewind from here", onClick: handleEditRewind, disabled: busy },
        ]),
      { key: "again", icon: <RotateCcwIcon aria-hidden />, label: "Send again", onClick: () => armConfirm("send"), disabled: busy },
      { key: "branch", icon: <GitBranchIcon aria-hidden />, label: "Branch from here", onClick: () => armConfirm("branch"), disabled: busy },
    ] : []),
    ...(!isUser && active && speechAvailable()
      ? [{ key: "speak", icon: speaking ? <SquareIcon aria-hidden /> : <Volume2Icon aria-hidden />, label: speaking ? "Stop reading aloud" : "Read aloud", onClick: handleSpeak }]
      : []),
    { key: "share", icon: <ShareIcon aria-hidden />, label: "Share", onClick: () => void handleShare() },
  ];

  // System Back and Escape close the menu before the chat behind it.
  useBackLayer(open, { onBack: closeMenu });

  // The lifted box is a picture of the pressed one: the original stays put
  // under the scrim, so the transcript's scroller, containment and stacking
  // contexts never have to be fought to raise it.
  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!open || !anchor?.isConnected || !holder) return;
    const clone = anchor.cloneNode(true) as HTMLElement;
    for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("[id],[data-testid],[data-message-box]")]) {
      node.removeAttribute("id");
      node.removeAttribute("data-testid");
      node.removeAttribute("data-message-box");
    }
    clone.setAttribute("inert", "");
    holder.replaceChildren(clone);
    return () => holder.replaceChildren();
  }, [open, anchor]);

  // Menu below the message, above it near the bottom, the message itself
  // nudged when neither fits; always inside the viewport.
  useLayoutEffect(() => {
    const card = menuRef.current;
    if (!open || !card) { setLayout(null); return; }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = card.offsetWidth;
    const mh = card.offsetHeight;
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    if (!rect) {
      setLayout({ box: null, menu: { top: Math.max(EDGE, (vh - mh) / 2), left: Math.max(EDGE, (vw - mw) / 2) }, above: false });
      return;
    }
    const height = Math.min(rect.height, Math.max(96, vh - mh - GAP - 2 * EDGE));
    let top = rect.top;
    let menuTop: number;
    let above = false;
    if (top >= EDGE && top + height + GAP + mh <= vh - EDGE) menuTop = top + height + GAP;
    else if (top >= EDGE + GAP + mh && top + height <= vh - EDGE) { menuTop = top - GAP - mh; above = true; }
    else {
      top = Math.max(EDGE, Math.min(top, vh - EDGE - height - GAP - mh));
      menuTop = top + height + GAP;
    }
    const left = Math.min(Math.max(isUser ? rect.right - mw : rect.left, EDGE), vw - mw - EDGE);
    setLayout({ box: { top, left: rect.left, width: rect.width, height }, menu: { top: menuTop, left }, above });
  }, [open, anchor, isUser, items.length, description]);

  useEffect(() => {
    if (!layout) return;
    const frame = requestAnimationFrame(() => setLifted(true));
    return () => { cancelAnimationFrame(frame); setLifted(false); };
  }, [layout]);

  // Focus enters the menu and returns to where it was; a rotation or resize
  // would leave the measured layout wrong, so it closes instead.
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("resize", closeMenu);
      if (prior instanceof HTMLElement && prior !== document.body && prior.isConnected) prior.focus({ preventScroll: true });
    };
  }, [open, closeMenu]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(e.key)) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const back = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : back ? (at <= 0 ? rows.length - 1 : at - 1) : (at + 1) % rows.length;
    rows[next]!.focus();
  };

  const sheet = (
    <>
      {open && typeof document !== "undefined" ? createPortal(
        <>
          <button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            {...scrim}
            className={cn("fixed inset-0 z-sheet cursor-default touch-none bg-black/50 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none", lifted ? "opacity-100" : "opacity-0")}
          />
          {anchor && active ? (
            <div
              ref={holderRef}
              aria-hidden
              data-testid="message-lift"
              className={cn(
                "group pointer-events-none fixed z-sheet overflow-hidden rounded-xl bg-background shadow-[var(--shadow-float)] transition-transform duration-200 ease-out motion-reduce:transition-none",
                isUser ? "is-user" : "is-assistant",
                !layout?.box && "opacity-0",
              )}
              style={layout?.box
                ? { ...layout.box, transform: lifted ? "scale(1.02)" : "scale(1)" }
                : { top: 0, left: 0 }}
            />
          ) : null}
          <div
            ref={menuRef}
            onKeyDown={onMenuKeyDown}
            data-testid="message-menu"
            className={cn(
              "fixed z-sheet w-64 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-xl bg-surface-1 text-foreground shadow-[var(--shadow-float)] transition-[opacity,transform] duration-150 motion-reduce:transition-none",
              lifted ? "scale-100 opacity-100" : "scale-95 opacity-0",
            )}
            style={{
              top: layout?.menu.top ?? 0,
              left: layout?.menu.left ?? 0,
              maxHeight: `calc(100dvh - ${2 * EDGE}px)`,
              transformOrigin: `${isUser ? "right" : "left"} ${layout?.above ? "bottom" : "top"}`,
            }}
          >
            {description ? (
              <p data-testid="sheet-description" className="px-4 pb-1 pt-3 text-caption text-muted-foreground">{description}</p>
            ) : null}
            <div role="menu" aria-label="Message actions" className="py-1">
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={item.onClick}
                  className="flex h-12 w-full items-center gap-3 px-4 text-left text-body outline-none active:bg-surface-3 focus-visible:bg-surface-3 disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
                >
                  {item.icon}
                  <span className="min-w-0 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>,
        document.body,
      ) : null}
      {isUser ? (
        <>
          {/* Dialogs of their own, above the menu: its layer stays beneath them
              on the back stack, so Back closes the confirm first. */}
          <ConfirmSheet
            open={pendingConfirm === "send"}
            onOpenChange={(next) => { if (!next) setPendingConfirm(null); }}
            title="Send this message again?"
            description="The same text and photos are sent to this session as a new prompt."
            confirmLabel="Send"
            tone="primary"
            onConfirm={() => void handleSendAgain()}
            busy={busySend}
            busyLabel="Sending…"
          />
          <ConfirmSheet
            open={pendingConfirm === "branch"}
            onOpenChange={(next) => { if (!next) setPendingConfirm(null); }}
            title="Branch from this turn?"
            description="A new session opens, branched from this turn."
            confirmLabel="Branch"
            tone="primary"
            onConfirm={() => void handleBranch()}
            busy={busyBranch}
            busyLabel="Branching…"
          />
        </>
      ) : null}

      <EditResendSheet
        key={editor?.generation ?? "closed"}
        open={editOpen}
        onOpenChange={(next) => {
          if (editor?.generation !== editGeneration.current) return;
          if (!next) cancelEditTransition();
          else setEditOpen(true);
        }}
        initialText={editor?.text ?? ""}
        initialImages={editor?.images}
        sessionPath={editor?.sessionPath ?? null}
        rewind={editor?.mode === "rewind"}
        branchFromEntryId={editor?.mode === "rewind" ? editor.sourceEntryId : null}
        onBranched={onBranched}
      />
    </>
  );

  return { bind, open: openReply, sheet };
}
