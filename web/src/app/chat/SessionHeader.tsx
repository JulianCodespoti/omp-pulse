import {
  CopyIcon,
  EllipsisVerticalIcon,
  GaugeIcon,
  LayoutGridIcon,
  MenuIcon,
  MonitorIcon,
  MonitorOffIcon,
  PencilIcon,
  RefreshCwIcon,
  Share2Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuChoice,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { readPairingToken } from "../../platform/browser-storage";
import { ClipboardAttempt } from "../../platform/clipboard";
import type { OmpSessionSummary } from "../../domain/protocol";
import { DaemonApi } from "../../runtime/rpc-client";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { startVisibleInterval } from "../../runtime/visible-interval";
import { contextWindowFor, parsePassiveSessionModel, rememberContextWindows, type ConnectionState, type OmpStoreApi } from "../../runtime/omp-store";
import { useBackLayer } from "../back-layer";
import { openSwitcher } from "../nav/panels";
import { NeedsYouDot } from "../sessions/NeedsYouDot";
import { shareConversation } from "../share-conversation";
import { showToast } from "../Notices";
import { sessionTitle } from "../session-format";
import { useStoreValue } from "../store-hooks";
import { PluginMenuItems } from "../plugins/PluginMenuItems";
import { toPluginSession } from "../plugins/session-info";
import { usePluginKey } from "../plugins/use-plugin-host";
import type { SessionTracking } from "./session-tracking";
import { ContextMeter, formatTokens } from "../ui/ContextMeter";

/** Models whose window was already requested this run: one catalogue call each. */
const askedWindows = new Set<string>();

export interface SessionHeaderProps {
  sessionPath: string | null;
  store: OmpStoreApi;
  /** This chat's resolved summary (listed row, else its own fetched row); null while unknown. */
  summary?: OmpSessionSummary | null;
  connection: ConnectionState;
  /** Lets the ≡ button show when another chat needs you. */
  controller?: OmpSessionController;
  onRename: () => void;
  onOpenModelPicker: () => void;
  onOpenSessionSettings: () => void;
  /** Present only while your computer does not already have this conversation. */
  onOpenOnComputer?: () => void;
  /** A handoff is in flight, or a phone reply is still streaming. */
  openOnComputerDisabled?: boolean;
  /** Present only while this session is verified in a pane on your computer. */
  onCloseOnComputer?: () => void;
  closeOnComputerDisabled?: boolean;
  onReload: () => void;
  /** Model label for the sheet's Model row ("Opus 5.5 · high"); empty while unknown. */
  modelLabel?: string;
  /** Context window fill, 0-100; null while unknown. */
  contextPercent?: number | null;
  contextTokens?: number;
  contextWindow?: number;
  /** Whole-session spend, formatted ("$4.76"); null while unknown. */
  cost?: string | null;
  onOpenUsage?: () => void;
  /** Badges on the workspace button; absent hides the button. */
  tracking?: SessionTracking;
  onOpenWorkspace?: () => void;
  onNewChat: () => void;
  /** The folder this chat runs in; the heading's second line. */
  project?: string | null;
  /** Goal/plan chips shown under the pills. */
  children?: ReactNode;
}

/**
 * The chat's floating chrome: a round drawer button and a pill of workspace,
 * new chat and ⋮, over the transcript with nothing behind them (no title, no
 * bar). ⋮ opens a floating menu with everything about this session. The
 * workspace pages sit beside the chat in a drawer from the right (swipe, or
 * the grid button; SessionPager).
 */
export function SessionHeader({
  sessionPath,
  store,
  summary: summaryProp = null,
  connection,
  controller,
  onRename,
  onOpenModelPicker,
  onOpenSessionSettings,
  onOpenOnComputer,
  openOnComputerDisabled,
  onCloseOnComputer,
  closeOnComputerDisabled,
  onReload,
  modelLabel = "",
  contextPercent = null,
  contextTokens,
  contextWindow,
  cost = null,
  onOpenUsage,
  tracking,
  onOpenWorkspace,
  onNewChat,
  project,
  children,
}: SessionHeaderProps): JSX.Element {
  // Read from the store, not a prop snapshot: a rename seen in the transcript
  // patches the listing row and the title follows at once.
  const listedSummary = useStoreValue(store, (s) => s.sessions.find((row) => row.path === sessionPath) ?? null);
  // A chat missing from the listing (an old or filtered session) still has
  // its own fetched row from the chat screen; the listing row wins when both
  // exist because it is the one patched live.
  const summary = listedSummary ?? summaryProp;
  // Before the listing arrives (a deep-linked or notification boot) the title
  // comes from the session's own state, else the line stays empty: a generic
  // word in the title slot reads as the conversation's name.
  const [peekedName, setPeekedName] = useState<{ path: string; name: string } | null>(null);
  const title = summary ? sessionTitle(summary) : peekedName?.path === sessionPath ? peekedName.name : "";

  const [actionsOpen, setActionsOpen] = useState(false);
  // Retained only while the menu is open, and only for a conversation we have a row for.
  const pluginContext = useMemo(() => (summary ? { session: toPluginSession(summary) } : null), [summary]);
  const pluginMenu = usePluginKey("session.menu", actionsOpen && summary ? summary.path : null, pluginContext);
  const [pathCopy] = useState(() => new ClipboardAttempt());
  useLayoutEffect(() => () => pathCopy.cancel(), [pathCopy, sessionPath]);

  useEffect(() => {
    if (!sessionPath) return;
    let cancelled = false;
    const path = sessionPath;
    const api = new DaemonApi(readPairingToken());
    async function fetchState(): Promise<void> {
      try {
        // Passive peek never boots a child just because the phone viewed a chat.
        const before = store.getState().sessionModel;
        const state = await api.getState(path, { peek: true });
        if (cancelled || store.getState().sessionPath !== path) return;
        const name = state.sessionName?.trim();
        if (name) setPeekedName({ path, name });
        const current = store.getState();
        if (current.sessionModel === before) current.setSessionModel(
          parsePassiveSessionModel(state, before, current.sessionModelProvenance),
          state.source === "file" ? "file" : "live",
        );
      } catch {
        // Offline or owned by your computer: preserve the last known model.
      }
    }
    void fetchState();
    // Visible-only; `onVis` refetches on show.
    const stopPolling = startVisibleInterval(() => void fetchState(), 30_000);
    const onVis = (): void => { if (document.visibilityState === "visible") void fetchState(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [sessionPath, connection, store]);

  // An idle session's state names its model but not the window, and the window
  // is what turns a turn's prompt size into a percentage. Ask the catalogue
  // once per model per app run (the answer is cached across runs).
  const windowKnown = useStoreValue(store, (state) => state.sessionModel?.contextWindow !== undefined || contextWindowFor(state.sessionModel?.model) !== undefined);
  const modelName = useStoreValue(store, (state) => state.sessionModel?.model);
  useEffect(() => {
    if (!sessionPath || !modelName || windowKnown || connection !== "open" || askedWindows.has(modelName)) return;
    askedWindows.add(modelName);
    const path = sessionPath;
    new DaemonApi(readPairingToken())
      .getAvailableModels(path)
      .then((models) => {
        rememberContextWindows(models);
        const learned = contextWindowFor(modelName);
        const current = store.getState();
        // A late catalogue must not replace a newer window or attach the old
        // model's window to the model the reader selected while it was pending.
        if (learned !== undefined && current.sessionPath === path && current.sessionModel?.model === modelName && current.sessionModel.contextWindow === undefined) {
          current.setSessionModel({ contextWindow: learned });
        }
      })
      .catch(() => askedWindows.delete(modelName));
  }, [sessionPath, modelName, windowKnown, connection, store]);

  // Base UI closes the menu itself when an item is chosen; Back and Escape
  // close it before the chat behind it leaves.
  useBackLayer(actionsOpen, { onBack: () => setActionsOpen(false) });

  const copyPath = async (): Promise<void> => {
    if (!sessionPath || pathCopy.busy) return;
    const copied = await pathCopy.run(sessionPath);
    // null: superseded by a newer attempt or a session switch.
    if (copied === null || store.getState().sessionPath !== sessionPath) return;
    showToast(copied ? "Copied path" : "Couldn’t copy the path.", copied ? "success" : "warn");
  };

  const needsYouHint = useId();
  const percent = contextPercent === null ? null : Math.round(contextPercent);
  const usageWords = [
    percent !== null ? `context ${percent}% used` : null,
    cost ? `${cost} spent` : null,
  ].filter(Boolean).join(", ");
  const badge = tracking ? workspaceBadge(tracking) : null;

  // ChatGPT's pills, measured: #303030 fill with a 1px ring ~10% lighter, so
  // they never melt into a user bubble or code block scrolling behind them.
  const pill = "flex items-center rounded-full bg-surface-2 ring-1 ring-inset ring-white/10 pointer-events-auto";
  const pillBtn = "relative size-11 shrink-0 rounded-full text-foreground transition-transform duration-[var(--dur-fast)] active:scale-[0.94] motion-reduce:transition-none";

  return (
    // Absolutely over the transcript (ChatScreen's <main> is the positioned
    // parent): no bar, no fade, so the conversation shows between and behind
    // the pills. The wrapper ignores pointer events; only the pills take taps.
    // The transcript's top padding starts its first line clear of them.
    <div className="pointer-events-none absolute inset-x-0 top-0 z-sticky pt-[env(safe-area-inset-top)]">
      {/* ChatGPT's top fade, held solid under the title. It used to reach full opacity only at the very
          top edge, so scrolled text showed through at 20-60% and the title read as part of a message
          ("Fix double retries on…test"). The band is now opaque for the header row and clears over the
          32px below it, which is what keeps content from colliding with the heading while it still
          fades out of view. */}
      <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-[calc(env(safe-area-inset-top)+5.5rem)] bg-background" style={{ maskImage: "linear-gradient(to top, #0000 0%, #0000001a 8%, #00000066 16%, #000000d9 28%, #000 36%, #000 100%)" }} />
      <header className="relative flex h-14 items-center justify-between gap-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]">
        <Button
          aria-label="Open sessions"
          aria-describedby={needsYouHint}
          data-testid="session-back"
          className={cn(pill, pillBtn, "size-12")}
          onClick={openSwitcher}
          size="icon"
          type="button"
          variant="ghost"
        >
          <MenuIcon className="size-[22px]" strokeWidth={1.9} aria-hidden />
          {controller ? <NeedsYouDot controller={controller} currentPath={sessionPath} hintId={needsYouHint} /> : null}
        </Button>
        {/* The title, the way ChatGPT and DeepSeek show it: what this chat is,
            and the folder it runs in, which is the thing that tells two chats
            apart. The pills used to be the only header, so a chat with messages
            named neither. */}
        <h1 data-testid="chat-heading" className="pointer-events-none min-w-0 flex-1 px-1 text-center">
          <span className="block truncate text-ui font-semibold text-foreground">
            {title || (
              <>
                {/* A blank line keeps the title's height; "Chat" read as the conversation's name. */}
                <span aria-hidden>&nbsp;</span>
                <span className="sr-only">Conversation</span>
              </>
            )}
          </span>
          {project ? <span data-testid="chat-heading-project" className="mt-0.5 block truncate text-caption font-normal text-muted-foreground">{project}</span> : null}
        </h1>
        <div className={pill}>
          {onOpenWorkspace ? (
            <Button
              aria-label={`Workspace: agents, tasks, changes, files and terminal${badge ? `, ${badge.words}` : ""}`}
              data-testid="open-workspace"
              className={pillBtn}
              onClick={onOpenWorkspace}
              size="icon"
              type="button"
              variant="ghost"
            >
              <LayoutGridIcon className="size-5" strokeWidth={1.9} aria-hidden />
              {badge ? (
                <span
                  aria-hidden
                  data-testid="workspace-badge"
                  data-tone={badge.tone}
                  className={cn(
                    "absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6875rem] font-semibold leading-none tabular-nums ring-2 ring-surface-2",
                    BADGE_TONE[badge.tone],
                  )}
                >
                  {badge.text}
                </span>
              ) : null}
            </Button>
          ) : null}
          <Button aria-label="New chat" data-testid="session-new-chat" className={pillBtn} onClick={onNewChat} size="icon" type="button" variant="ghost">
            <SquarePenIcon className="size-5" strokeWidth={1.9} aria-hidden />
          </Button>
          <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  data-testid="session-actions"
                  title={title || undefined}
                  aria-label={`Session actions${usageWords ? `, ${usageWords}` : ""}`}
                  className={pillBtn}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <EllipsisVerticalIcon className="size-5" strokeWidth={1.9} aria-hidden />
                </Button>
              }
            />
            {/* testid kept from the old sheet: suites scope their row lookups to it. */}
            <DropdownMenuContent
              align="end"
              sideOffset={8}
              data-testid="session-actions-sheet"
            >
              {/* One vocabulary with the session list's action sheet and the drawer's row menu: same words, same relative order. */}
              <DropdownMenuChoice data-testid="session-model" disabled={!sessionPath} onClick={onOpenModelPicker} icon={<SparklesIcon />} title="Model & thinking" subtitle={modelLabel || "Choose a model"} />
              {/* Usage shows the numbers (context, spend, limits); Session settings holds the controls. */}
              {onOpenUsage ? (
                <DropdownMenuChoice
                  data-testid="session-usage"
                  onClick={onOpenUsage}
                  icon={<GaugeIcon />}
                  title="Usage"
                  subtitle={percent !== null || cost ? (
                    <span className="flex min-w-0 items-center gap-2">
                      {percent !== null ? <ContextMeter percent={percent} size="row" showLabel={false} /> : null}
                      <span className="truncate tabular-nums">
                        {[
                          percent !== null
                            ? contextTokens !== undefined && contextWindow !== undefined
                              ? `${formatTokens(contextTokens)} of ${formatTokens(contextWindow)} context`
                              : `${percent}% context`
                            : null,
                          cost,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  ) : undefined}
                />
              ) : null}
              <DropdownMenuChoice data-testid="session-settings" disabled={!sessionPath} onClick={onOpenSessionSettings} icon={<SlidersHorizontalIcon />} title="Session settings" />
              <DropdownMenuSeparator className="my-1.5" />
              <DropdownMenuChoice data-testid="session-rename" disabled={!sessionPath} onClick={onRename} icon={<PencilIcon />} title="Rename" />
              {onOpenOnComputer ? <DropdownMenuChoice data-testid="session-open-on-computer" disabled={openOnComputerDisabled} onClick={onOpenOnComputer} icon={<MonitorIcon />} title="Open on computer" /> : null}
              {onCloseOnComputer ? <DropdownMenuChoice data-testid="session-close-on-computer" disabled={closeOnComputerDisabled} onClick={onCloseOnComputer} icon={<MonitorOffIcon />} title="Close on computer" /> : null}
              <DropdownMenuChoice data-testid="session-copy-path" disabled={!sessionPath} onClick={copyPath} icon={<CopyIcon />} title="Copy path" />
              <DropdownMenuChoice data-testid="session-share" disabled={!sessionPath} onClick={() => void shareConversation(store.getState().messages, title || "Conversation")} icon={<Share2Icon />} title="Share conversation" />
              <DropdownMenuChoice data-testid="session-reload" onClick={onReload} icon={<RefreshCwIcon />} title="Reload" />
              <PluginMenuItems variant="dropdown" views={pluginMenu.views} onAction={pluginMenu.onAction} onClose={() => setActionsOpen(false)} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {/* Goal/plan chips ride under the pills on their own surface; an empty
          render collapses the wrapper. */}
      <div className="pointer-events-auto mx-3 rounded-xl bg-surface-2 empty:hidden">{children}</div>
    </div>
  );
}

type Badge = { text: string; tone: "neutral" | "running" | "warning"; words: string };

const BADGE_TONE = {
  neutral: "bg-surface-3 text-foreground",
  running: "bg-running text-background",
  warning: "bg-warning text-warning-foreground",
} as const;

/** The one number on the workspace button: what needs you, else what is working, else what is left. */
function workspaceBadge(tracking: SessionTracking): Badge | null {
  const { working, needsYou } = tracking.agents;
  if (needsYou > 0) return { text: String(needsYou), tone: "warning", words: `${needsYou} ${needsYou === 1 ? "agent needs" : "agents need"} you` };
  if (working > 0) return { text: String(working), tone: "running", words: `${working} ${working === 1 ? "agent" : "agents"} working` };
  if (tracking.tasksLeft > 0) return { text: String(tracking.tasksLeft), tone: "neutral", words: `${tracking.tasksDone} of ${tracking.tasksTotal} tasks done` };
  return null;
}
