"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  ArrowLeftIcon,
  BotIcon,
  FileDiffIcon,
  FolderIcon,
  InboxIcon,
  ListTodoIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquareTerminalIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

import type { OmpSessionSummary } from "../../domain/protocol";
import { useBackLayer } from "../back-layer";
import { openNewSession, openSettings, openWorkspace, type WorkspaceTab } from "../nav/panels";
import { activeTime, projectLabel, relativeTime, sessionTitle } from "../session-format";
import { sessionStatus } from "../session-status";
import { EmptyState } from "../ui/EmptyState";
import { Row, RowGroup, RowSkeleton } from "../ui/Row";
import { BottomSheet, SheetSearch } from "../ui/Sheet";
import { SessionStatusGlyph } from "../ui/Status";
import { liveStateFor, type OmpCommand } from "./command-registry";
import { groupCommands, sourceLabel } from "./command-order";
import { CommandRow, displayDescription } from "./CommandRow";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The open chat's slash commands; empty outside a chat. */
  commands: OmpCommand[];
  live: { model?: string; contextPercent?: number; agentWorking: boolean };
  onRun: (cmd: OmpCommand, subcommandName?: string) => void;
  /** Open already drilled into this command (a typed `/cmd` with subcommands). */
  initialDrill?: OmpCommand | null;
  /** Text the search field starts with. */
  initialQuery?: string;
  /** Sessions to jump to; the Sessions group needs both of these. */
  sessions?: readonly OmpSessionSummary[];
  onOpenSession?: (path: string) => void;
  /** Searches the whole archive on the daemon; `sessions` holds only the loaded pages. */
  searchSessions?: (q: string, limit: number, signal: AbortSignal) => Promise<readonly OmpSessionSummary[]>;
  /** False until the first listing lands (a chat opened from a notification). */
  sessionsLoaded?: boolean;
  currentPath?: string | null;
  /** The workspace panels exist only inside a chat. */
  inChat?: boolean;
}

const RECENT_SESSIONS = 5;
const MATCHING_SESSIONS = 8;
const SEARCH_DEBOUNCE_MS = 200;

const PANELS: readonly { tab: WorkspaceTab; label: string; keywords: string; icon: ReactNode }[] = [
  { tab: "changes", label: "Changes", keywords: "diff git review", icon: <FileDiffIcon /> },
  { tab: "files", label: "Files", keywords: "folder browse open", icon: <FolderIcon /> },
  { tab: "agents", label: "Agents", keywords: "subagents tasks running", icon: <BotIcon /> },
  { tab: "tasks", label: "Tasks", keywords: "todo plan timeline history", icon: <ListTodoIcon /> },
  { tab: "terminal", label: "Terminal", keywords: "bash shell command run", icon: <SquareTerminalIcon /> },
];

const ACTIONS: readonly { id: string; label: string; keywords: string; icon: ReactNode; run: () => void }[] = [
  { id: "new-session", label: "New session", keywords: "start create chat", icon: <PlusIcon />, run: openNewSession },
  { id: "settings", label: "Settings", keywords: "preferences notifications pairing devices", icon: <SettingsIcon />, run: openSettings },
];

// Slash groups sit beside the Panels group, whose "Files" and "Tasks" rows
// are not commands; say which list a command group belongs to.
function commandGroupTitle(source: string): string {
  const lower = source.toLowerCase();
  if (lower === "builtin") return "Commands";
  if (lower === "tasks") return "Task commands";
  if (lower === "file") return "File commands";
  return sourceLabel(source);
}

/**
 * The global palette: jump to a session, open a workspace panel, start a
 * session or open Settings, and run the open chat's slash commands, all from
 * one search field. Row-based, like every list.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  live,
  onRun,
  initialDrill,
  initialQuery = "",
  sessions,
  searchSessions,
  onOpenSession,
  sessionsLoaded = true,
  currentPath = null,
  inChat = false,
}: CommandPaletteProps): JSX.Element {
  const [drill, setDrill] = useState<OmpCommand | null>(null);
  const [query, setQuery] = useState(initialQuery);
  // Keep the input responsive while the list filters. Deferred
  // value lets the character appear before the 125-item filter runs under
  // 4x throttle.
  const deferredQuery = useDeferredValue(query);
  const typed = deferredQuery.trim().toLowerCase();
  // A leading "/" asks for commands only, as it does in the composer.
  const slashOnly = typed.startsWith("/");
  const q = slashOnly ? typed.slice(1) : typed;

  useEffect(() => {
    if (!open) {
      setDrill(null);
      setQuery("");
      return;
    }
    setQuery(initialQuery);
    if (initialDrill) setDrill(initialDrill);
  }, [open, initialDrill, initialQuery]);

  useEffect(() => {
    if (drill) setQuery("");
  }, [drill]);

  // Back from a drilled command returns to the list, like its leading arrow.
  useBackLayer(open && drill !== null, { onBack: () => setDrill(null) });

  // Precompute lowercased haystacks once per commands array so the per-key
  // filter does not allocate new lowercased strings for 125 items.
  const indexed = useMemo(() => {
    return commands.map((c) => ({
      cmd: c,
      lowerName: c.name.toLowerCase(),
      lowerAliases: c.aliases?.map((a) => a.toLowerCase()) ?? [],
      lowerDesc: c.description?.toLowerCase() ?? "",
      lowerHint: c.hint?.toLowerCase() ?? "",
    }));
  }, [commands]);

  const commandGroups = useMemo(() => {
    if (drill) return [];
    const filtered = !q
      ? commands
      : indexed.filter(({ lowerName, lowerAliases, lowerDesc, lowerHint, cmd }) => {
          if (lowerName.includes(q)) return true;
          if (lowerAliases.some((a) => a.includes(q))) return true;
          // PARITY-06: also match what the command does, not just its name.
          if (lowerDesc.includes(q)) return true;
          if (lowerHint.includes(q)) return true;
          return cmd.subcommands?.some((s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q))) ?? false;
        }).map(({ cmd }) => cmd);
    // No synthetic rows. /plan and /goal used to be injected here when the
    // catalogue omitted them, but omp omits them because they are TUI-only
    // (`handleTui`, no text `handle`): rpc mode cannot run them, so a tap sent
    // the literal "/plan" to the model as an ordinary message.
    // Same grouping and order as the inline slash palette (command-order.ts).
    return groupCommands(filtered);
  }, [commands, indexed, q, drill]);

  // Daemon matches for the typed text, kept with the query they answer so a
  // stale reply never shows under a newer query. A failed search just leaves
  // the loaded rows: the palette stays usable offline.
  const [remote, setRemote] = useState<{ q: string; rows: readonly OmpSessionSummary[] } | null>(null);
  const remoteWanted = open && !drill && !slashOnly && q !== "" && searchSessions !== undefined && onOpenSession !== undefined;
  useEffect(() => {
    if (!remoteWanted || !searchSessions) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      searchSessions(q, MATCHING_SESSIONS, abort.signal).then(
        (rows) => { if (!abort.signal.aborted) setRemote({ q, rows }); },
        () => undefined,
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [remoteWanted, searchSessions, q]);

  const sessionRows = useMemo(() => {
    if (drill || slashOnly || !sessions || !onOpenSession) return [];
    const ordered = [...sessions].sort((a, b) => activeTime(b) - activeTime(a));
    if (!q) return ordered.filter((s) => s.path !== currentPath).slice(0, RECENT_SESSIONS);
    const local = ordered.filter((s) => sessionTitle(s).toLowerCase().includes(q) || projectLabel(s).toLowerCase().includes(q));
    const seen = new Set(local.map((s) => s.path));
    const older = remote?.q === q ? remote.rows.filter((s) => !seen.has(s.path)) : [];
    return [...local, ...older].slice(0, MATCHING_SESSIONS);
  }, [sessions, onOpenSession, currentPath, q, drill, slashOnly, remote]);
  const sessionsPending = !sessionsLoaded && !drill && !slashOnly && !q && onOpenSession !== undefined && sessionRows.length === 0;

  const matches = (label: string, keywords: string) => !q || label.toLowerCase().includes(q) || keywords.includes(q);
  const panelRows = drill || slashOnly || !inChat ? [] : PANELS.filter((p) => matches(p.label, p.keywords));
  const actionRows = drill || slashOnly ? [] : ACTIONS.filter((a) => matches(a.label, a.keywords));
  const empty = !sessionsPending && sessionRows.length === 0 && panelRows.length === 0 && actionRows.length === 0 && commandGroups.length === 0;

  const handleSelectCommand = (cmd: OmpCommand) => {
    if (cmd.shape === "drill") {
      setDrill(cmd);
      return;
    }
    onRun(cmd);
    onOpenChange(false);
  };

  const handleSelectSub = (sub: { name: string; description?: string; usage?: string }) => {
    if (!drill) return;
    onRun(drill, sub.name);
    onOpenChange(false);
  };

  // Sheets stack above panels and pushed screens, so the palette must leave
  // as its destination arrives or it would cover it.
  const go = (run: () => void) => {
    onOpenChange(false);
    run();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && drill) {
      e.preventDefault();
      e.stopPropagation();
      setDrill(null);
    }
  };

  return (
    <BottomSheet
      open={open}
      onOpenChange={(v) => {
        if (!v && drill) {
          setDrill(null);
          return;
        }
        onOpenChange(v);
      }}
      title={drill ? `/${drill.name}` : "Search"}
      // Subtitle only when it adds something: the drilled command's purpose.
      description={drill ? displayDescription(drill.description) : undefined}
      testId="command-palette"
      leading={
        drill ? (
          <Button aria-label="Back" size="icon" variant="ghost" onClick={() => setDrill(null)}>
            <ArrowLeftIcon className="size-5" />
          </Button>
        ) : undefined
      }
      subHeader={
        drill ? undefined : (
          <div className="px-4 pb-1">
            <SheetSearch value={query} onChange={setQuery} placeholder={inChat ? "Search sessions, panels and commands" : "Search sessions and actions"} />
          </div>
        )
      }
    >
      <div onKeyDown={handleKeyDown} className="flex flex-col gap-4">
        {drill ? (
          drill.subcommands && drill.subcommands.length > 0 ? (
            <RowGroup>
              {drill.subcommands.map((sub) => (
                <CommandRow
                  key={sub.name}
                  onClick={() => handleSelectSub(sub)}
                  title={`/${drill.name} ${sub.name}`}
                  description={displayDescription(sub.description) ?? sub.usage}
                  source={drill.source}
                />
              ))}
            </RowGroup>
          ) : (
            <EmptyState icon={<InboxIcon />} title="No subcommands" />
          )
        ) : empty ? (
          <EmptyState icon={<SearchIcon />} title="No results" description={q ? `Nothing matches “${deferredQuery.trim()}”.` : undefined} />
        ) : (
          <>
            {sessionsPending ? (
              <RowGroup title="Sessions" aria-busy="true" aria-label="Loading sessions">
                <RowSkeleton leading subtitle />
                <RowSkeleton leading subtitle />
              </RowGroup>
            ) : null}
            {sessionRows.length > 0 ? (
              <RowGroup title="Sessions" testId="palette-sessions">
                {sessionRows.map((session) => {
                  const state = sessionStatus(session);
                  return (
                    <Row
                      key={session.path}
                      testId="palette-session"
                      leading={state === "idle" ? undefined : <SessionStatusGlyph state={state} />}
                      title={sessionTitle(session)}
                      subtitle={[projectLabel(session), relativeTime(activeTime(session))].filter(Boolean).join(" · ")}
                      selected={session.path === currentPath}
                      onClick={() => go(() => onOpenSession?.(session.path))}
                    />
                  );
                })}
              </RowGroup>
            ) : null}
            {panelRows.length > 0 ? (
              <RowGroup title="Panels" testId="palette-panels">
                {panelRows.map((panel) => (
                  <Row
                    key={panel.tab}
                    testId="palette-panel"
                    leading={panel.icon}
                    title={panel.label}
                    onClick={() => go(() => openWorkspace(panel.tab))}
                  />
                ))}
              </RowGroup>
            ) : null}
            {actionRows.length > 0 ? (
              <RowGroup title="Actions" testId="palette-actions">
                {actionRows.map((action) => (
                  <Row
                    key={action.id}
                    testId="palette-action"
                    leading={action.icon}
                    title={action.label}
                    onClick={() => go(action.run)}
                  />
                ))}
              </RowGroup>
            ) : null}
            {commandGroups.map(([source, cmds]) => (
              <RowGroup key={source} title={commandGroupTitle(source)}>
                {cmds.map((cmd) => (
                  <CommandRow
                    key={cmd.name}
                    onClick={() => handleSelectCommand(cmd)}
                    title={`/${cmd.name}`}
                    aliases={cmd.aliases && cmd.aliases.length > 0 ? cmd.aliases.map((a) => `/${a.replace(/^\/+/, "")}`).join(" ") : undefined}
                    description={displayDescription(cmd.description)}
                    detail={liveStateFor(cmd.name, live)}
                    drill={cmd.shape === "drill"}
                    source={source}
                  />
                ))}
              </RowGroup>
            ))}
          </>
        )}
      </div>
    </BottomSheet>
  );
}
