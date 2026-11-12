import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import {
  ArrowDownToLineIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CornerUpLeftIcon,
  EllipsisIcon,
  GitBranchIcon,
  GitForkIcon,
  ListChecksIcon,
  LocateFixedIcon,
  PlusIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { fetchWithDeadline } from "@/runtime/request";

import { showToast } from "@/app/Notices";
import { closePanels, openSettingsPage } from "@/app/nav/panels";
import { Chip } from "@/app/ui/Chip";
import { EmptyState } from "@/app/ui/EmptyState";
import { Notice } from "@/app/ui/Notice";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { Row, RowGroup, RowSkeleton } from "@/app/ui/Row";
import { BottomSheet, ConfirmSheet } from "@/app/ui/Sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi } from "@/runtime/rpc-client";
import { selectSessionCapability, selectSessionTurn } from "@/runtime/omp-store";
import { formatCost } from "../../domain/usage-meter";
import { parseTodoPhases, type UiMessage, type UiTodoPhase } from "../../domain/messages";
import { findCurrent, readTargets } from "../chat/message-navigation";
import { seedDraft } from "../composer/use-draft";
import { CARD_FORM, CARD_INPUT } from "./card-field";
import { shortModel } from "../session-format";
import { formatDuration } from "./format";
import { appendTodo, applyTodoAction, todoActionLabel, todoActions, todoCommand, todoTargetError, type TodoAction } from "./todo-edit";
import { latestTodos, todoProgress } from "./todo-state";
import { useWorkspaceHost } from "./workspace-host";
import { prefersReducedMotion } from "../../platform/appearance";

const TRIGGER_PX = 320;
/** Longest label the inline editor takes; it shows on a one-line caption. */
const LABEL_MAX = 48;
// omp answers a `/todo` it could not apply with printed text, not an error.
const NOT_APPLIED = /^(no task|usage:|unknown \/todo|failed)/i;

/** What a turn cost and produced (src/sessions/jsonl.rs `TurnStats`); absent fields are unknown. */
type TurnStats = {
  at: number | null;
  lastAt: number | null;
  replies: number;
  tools: number;
  outputTokens: number;
  tps: number | null;
  cost: number;
  model: string | null;
  stop: string | null;
};

type ResumeTarget = { id: string; text: string };

type TreeRow = {
  id: string;
  text: string;
  connector: string | null;
  active: boolean;
  current: boolean;
  stats: TurnStats;
  /** The user's name for this point, when given (`tree_label`). */
  label?: string;
  resumeTargets: ResumeTarget[];
} & ({ kind: "user"; answer: null } | { kind: "ask"; answer: string });

type Turn = { text: string; entryId?: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseTreeRows(raw: unknown): TreeRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TreeRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || typeof o.text !== "string") return null;
    if (o.kind !== undefined && o.kind !== "user" && o.kind !== "ask") return null;
    if (o.kind === "ask" && typeof o.answer !== "string") return null;
    const resumeTargets: ResumeTarget[] = [];
    const seenTargets = new Set<string>();
    for (const raw of Array.isArray(o.resumeTargets) ? o.resumeTargets : []) {
      if (!raw || typeof raw !== "object") continue;
      const target = raw as Record<string, unknown>;
      if (typeof target.id !== "string" || !target.id || target.id === o.id ||
          typeof target.text !== "string" || seenTargets.has(target.id)) continue;
      seenTargets.add(target.id);
      resumeTargets.push({ id: target.id, text: target.text });
    }
    out.push({
      id: o.id,
      text: o.text,
      ...(o.kind === "ask" ? { kind: "ask" as const, answer: String(o.answer) } : { kind: "user" as const, answer: null }),
      connector: typeof o.connector === "string" ? o.connector : null,
      active: Boolean(o.active),
      current: Boolean(o.current),
      resumeTargets,
      // An older daemon sends no stats: every figure reads as unknown.
      stats: {
        at: num(o.at),
        lastAt: num(o.lastAt),
        replies: num(o.replies) ?? 0,
        tools: num(o.tools) ?? 0,
        outputTokens: num(o.outputTokens) ?? 0,
        tps: num(o.tps),
        cost: num(o.cost) ?? 0,
        model: typeof o.model === "string" ? o.model : null,
        stop: typeof o.stop === "string" ? o.stop : null,
      },
      ...(typeof o.label === "string" && o.label.trim() ? { label: o.label.trim() } : {}),
    });
  }
  return out;
}

function readTranscriptPosition(): { currentId: string | null; order: string[] } {
  const scroller = document.querySelector(".chat-scroll");
  if (!(scroller instanceof HTMLElement)) return { currentId: null, order: [] };
  const order = Array.from(scroller.querySelectorAll<HTMLElement>("[data-entry-id]"))
    .map((element) => element.dataset.entryId)
    .filter((id): id is string => Boolean(id));
  const targets = readTargets(scroller, order);
  const current = findCurrent(scroller, targets);
  return {
    // At transcript top the first row can sit below the sticky header, so it
    // is outside findCurrent's anchor epsilon. It is still the only sensible
    // viewport cursor, and keeps top landing from falling through to newest.
    currentId: current?.entryId ?? targets[0]?.entryId ?? null,
    // The transcript's DOM order is returned alongside, because the entry the
    // reader is looking at usually has NO timeline row: the tree carries user
    // turns and question decisions, not most assistant and tool output.
    // Matching on equality alone therefore missed, and the landing
    // fell through to the newest row. The order lets the landing resolve to
    // the nearest row at or BEFORE the reader instead.
    order,
  };
}

const TODO_ICON: Record<string, { Icon: typeof CircleIcon; tone: string; label: string }> = {
  completed: { Icon: CircleCheckIcon, tone: "text-success", label: "Done" },
  in_progress: { Icon: CircleDotIcon, tone: "text-running", label: "In progress" },
  blocked: { Icon: CirclePauseIcon, tone: "text-warning", label: "Blocked" },
  abandoned: { Icon: CircleSlashIcon, tone: "text-tertiary", label: "Dropped" },
  pending: { Icon: CircleIcon, tone: "text-tertiary", label: "To do" },
};

const isClosed = (status: string) => status === "completed" || status === "abandoned";

/** Board editing through omp's `/todo` verbs; absent when there is no conversation to edit. */
type TodoEditor = {
  busy: boolean;
  onAct: (action: TodoAction, phase: number, task: number, content: string) => void;
};

/** "Add a task" for the board: `/todo append`, the last phase or a new one. */
function TodoAddRow({ busy, onAdd }: { busy: boolean; onAdd: (text: string) => Promise<boolean> }): JSX.Element {
  const [draft, setDraft] = useState("");
  return (
    <form
      className={CARD_FORM}
      onSubmit={(event) => {
        event.preventDefault();
        const text = draft.trim();
        if (text) void onAdd(text).then((added) => { if (added) setDraft(""); });
      }}
    >
      <Input
        aria-label="New task"
        className={CARD_INPUT}
        data-testid="todo-add-input"
        disabled={busy}
        enterKeyHint="done"
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Add a task"
        value={draft}
      />
      <Button type="submit" variant={draft.trim() ? "primary" : "secondary"} size="icon" className="shrink-0" aria-label="Add task" data-testid="todo-add" disabled={busy || !draft.trim()}>
        {busy ? <Spinner size={20} label={null} /> : <PlusIcon aria-hidden className="size-5" />}
      </Button>
    </form>
  );
}

/**
 * The agent's plan as one card: a progress bar and the task being worked as
 * the summary, the phases one tap deep. A finished phase folds to a single
 * line ("✓ Setup · 3/3") so the open work is what fills the card; the phase
 * being worked stays open. A finished plan starts folded. With an editor, a
 * task tap offers what it can still become (Start/Done/Drop/Remove).
 */
function PlanCard({ phases, editor, children }: { phases: readonly UiTodoPhase[]; editor: TodoEditor | null; children?: JSX.Element | null }): JSX.Element | null {
  const progress = todoProgress(phases);
  const finished = progress !== null && progress.done >= progress.total;
  const [open, setOpen] = useState(!finished);
  const [openPhases, setOpenPhases] = useState<ReadonlySet<number>>(() => new Set());
  /** `phase:task` whose actions are showing. */
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  if (!progress) return null;
  const now = phases.flatMap((phase) => phase.tasks).find((task) => task.status === "in_progress");
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <section className="overflow-hidden rounded-xl bg-surface-1" data-testid="todo-list">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-col gap-2 px-4 py-3 text-left outline-none focus-visible:bg-surface-2"
      >
        <span className="flex items-baseline gap-2 text-meta">
          <span className="text-ui font-medium text-foreground">Plan</span>
          <span className="flex-1 tabular-nums text-muted-foreground">{progress.done} of {progress.total} done{percent < 100 ? ` · ${percent}%` : ""}</span>
          <ChevronDownIcon aria-hidden className={cn("size-4 self-center text-muted-foreground transition-transform duration-[var(--dur-fast)]", open && "rotate-180")} />
        </span>
        <span aria-hidden className="h-1 overflow-hidden rounded-full bg-surface-3">
          <span className={cn("block h-full rounded-full transition-[width] duration-500", finished ? "bg-success" : "bg-running")} style={{ width: `${percent}%` }} />
        </span>
        {now ? (
          <span className="flex min-w-0 items-center gap-2 text-ui">
            <CircleDotIcon aria-hidden className="size-4 shrink-0 text-running" />
            <span className="min-w-0 truncate text-foreground">{now.content}</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col pb-1">
          {phases.map((phase, index) => {
            // A `/todo rm` can empty a phase; an empty phase is not shown.
            if (phase.tasks.length === 0) return null;
            const done = phase.tasks.filter((task) => isClosed(task.status)).length;
            const complete = phase.tasks.length > 0 && done === phase.tasks.length;
            const expanded = !complete || openPhases.has(index);
            const toggle = () =>
              setOpenPhases((prev) => {
                const next = new Set(prev);
                if (!next.delete(index)) next.add(index);
                return next;
              });
            return (
              <div key={`${index}:${phase.name}`}>
                {phase.name || complete ? (
                  <button
                    type="button"
                    onClick={complete ? toggle : undefined}
                    aria-expanded={complete ? expanded : undefined}
                    disabled={!complete}
                    className="flex min-h-10 w-full items-center gap-2 px-4 pt-2 text-left text-meta text-muted-foreground outline-none disabled:cursor-default focus-visible:bg-surface-2"
                  >
                    {complete ? <CircleCheckIcon aria-hidden className="size-4 text-success" /> : null}
                    <span className="min-w-0 flex-1 truncate font-medium">{phase.name || "Done"}</span>
                    <span className="tabular-nums">{done}/{phase.tasks.length}</span>
                  </button>
                ) : null}
                {expanded
                  ? phase.tasks.map((task, taskIndex) => {
                      const icon = TODO_ICON[task.status] ?? TODO_ICON.pending!;
                      const key = `${index}:${taskIndex}`;
                      const actionsOpen = editor !== null && expandedTask === key;
                      const body = (
                        <>
                          <icon.Icon role="img" aria-label={icon.label} className={cn("mt-0.5 size-4 shrink-0", icon.tone)} />
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className={cn("break-words text-ui", isClosed(task.status) ? "text-muted-foreground" : "text-foreground", task.status === "abandoned" && "line-through")}>
                              {task.content}
                            </span>
                            {task.status === "blocked" ? <span className="break-words text-meta text-warning">Blocked{task.blocker ? `: ${task.blocker}` : ""}</span> : null}
                            {task.notes ? <span className="break-words text-meta text-muted-foreground">{task.notes}</span> : null}
                          </span>
                        </>
                      );
                      return (
                        <div key={taskIndex} data-testid="todo-task" data-status={task.status}>
                          {editor ? (
                            <button
                              type="button"
                              aria-expanded={actionsOpen}
                              disabled={editor.busy}
                              onClick={() => setExpandedTask(actionsOpen ? null : key)}
                              className="pressable mx-1 flex w-[calc(100%-0.5rem)] min-w-0 items-start gap-3 rounded-xl px-3 py-2 text-left outline-none focus-visible:bg-surface-2 disabled:opacity-60"
                            >
                              {body}
                            </button>
                          ) : (
                            <div className="mx-1 flex min-w-0 items-start gap-3 px-3 py-2">{body}</div>
                          )}
                          {actionsOpen ? (
                            <div className="flex flex-wrap gap-2 pb-2 pl-11 pr-4" data-testid="todo-actions">
                              {todoActions(task.status).map((action) => (
                                <Chip
                                  key={action}
                                  size="md"
                                  tone={action === "rm" ? "danger" : "neutral"}
                                  disabled={editor.busy}
                                  testId={`todo-action-${action}`}
                                  onClick={() => {
                                    setExpandedTask(null);
                                    editor.onAct(action, index, taskIndex, task.content);
                                  }}
                                >
                                  {todoActionLabel(action, task.status)}
                                </Chip>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  : null}
              </div>
            );
          })}
          {children ? <div className="px-4 pb-2 pt-2">{children}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "Today", "Yesterday" or "Mon 13 Oct": the day a turn was sent. */
function dayLabel(at: number): string {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : dayFormat.format(day);
}

/**
 * The facts under a turn's prompt, quietest last: when it was sent, how long
 * the agent worked, how fast it wrote, how many tools it ran and what it
 * cost. Unknown figures are left out, never shown as zero.
 */
function turnFacts(stats: TurnStats): string[] {
  const facts: string[] = [];
  if (stats.at !== null) facts.push(clock.format(stats.at));
  if (stats.at !== null && stats.lastAt !== null && stats.replies > 0 && stats.lastAt > stats.at) facts.push(formatDuration(stats.lastAt - stats.at));
  if (stats.tps !== null) facts.push(`${Math.round(stats.tps)} tok/s`);
  if (stats.tools > 0) facts.push(stats.tools === 1 ? "1 tool" : `${stats.tools} tools`);
  const cost = formatCost(stats.cost);
  if (cost) facts.push(cost);
  return facts;
}

type RowMark = "current" | "viewed" | "branch" | "failed" | "plain";

const DOT: Record<RowMark, string> = {
  current: "size-3 bg-primary ring-4 ring-primary/20",
  viewed: "size-2.5 bg-foreground",
  failed: "size-2.5 bg-danger",
  branch: "size-2.5 border-2 border-tertiary bg-background",
  plain: "size-2 bg-muted-foreground/60",
};

/**
 * One turn on the timeline rail: a dot on a continuous line (accent for the
 * newest turn, hollow off the current branch, red when the turn failed or was
 * stopped), the prompt, its owner label and its facts. Tap jumps the chat to
 * the turn; the trailing ⋯ holds everything else (Go here, Rewind, label).
 */
function TimelineRow({
  id,
  text,
  answer,
  label,
  tag,
  facts,
  mark,
  model,
  pending,
  busy,
  note,
  onJump,
  onActions,
}: {
  id: string;
  text: string;
  answer?: string;
  /** The exception worth naming ("Viewing", "Latest", "Other branch", "Stopped"); empty for an ordinary turn. */
  label: string;
  /** The user's name for this point (`tree_label`). */
  tag?: string;
  facts: string[];
  mark: RowMark;
  model: string | null;
  /** This row's action (rewind, Go here, label) is in flight. */
  pending: boolean;
  busy: boolean;
  note: { text: string; tone: "muted" | "danger" } | null;
  onJump: () => void;
  onActions: (() => void) | null;
}): JSX.Element {
  const viewed = mark === "viewed";
  const dim = mark === "branch";
  return (
    <div
      data-slot="row"
      data-timeline-row-id={id}
      data-timeline-viewed={viewed ? "true" : undefined}
      className={cn("relative flex min-w-0 flex-col rounded-lg transition-colors duration-[var(--dur-fast)]", viewed && "bg-surface-2")}
    >
      {/* The rail: one line through every row, the dot on the first text line. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-[15px] w-px bg-hairline" />
      <span aria-hidden className={cn("pointer-events-none absolute left-4 top-[19px] -translate-x-1/2 rounded-full", DOT[mark])} />
      <div className="flex min-w-0 items-start gap-1 pr-1">
        <button
          type="button"
          onClick={onJump}
          className="flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-1 py-2.5 pl-9 pr-1 text-left outline-none pressable focus-visible:bg-surface-2"
          aria-label={viewed ? `Viewing: ${text.slice(0, 60)}` : text.slice(0, 60)}
          aria-current={viewed ? "location" : undefined}
        >
          {/* `line-clamp-2` needs `display:-webkit-box`; `block` would override it. */}
          <span className={cn("line-clamp-2 break-words text-ui", dim ? "text-muted-foreground" : "text-foreground", viewed && "font-medium")}>{text}</span>
          {answer !== undefined ? (
            <span className="line-clamp-2 whitespace-pre-wrap break-words text-meta text-muted-foreground" data-testid="timeline-decision-answer">Answered: {answer}</span>
          ) : null}
          {label || tag || facts.length > 0 || model ? (
            // One line, most telling first: the label never truncates, the
            // facts fade off the end before they wrap into a second line.
            <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-meta tabular-nums text-muted-foreground" data-testid="turn-facts">
              {label ? (
                <span className={cn("inline-flex shrink-0 items-center gap-1 font-medium", mark === "failed" ? "text-danger" : mark === "current" ? "text-primary-text" : "text-foreground")}>
                  {mark === "branch" ? <GitBranchIcon aria-hidden className="size-3.5" /> : null}
                  {label}
                </span>
              ) : null}
              {tag ? (
                <span data-testid="timeline-row-label" className="inline-flex min-w-0 max-w-[50%] shrink-0 items-center gap-1 text-primary-text">
                  {label ? <span className="text-muted-foreground">·</span> : null}
                  <TagIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{tag}</span>
                </span>
              ) : null}
              {facts.length > 0 || model ? (
                <span className="min-w-0 truncate">
                  {label || tag ? "· " : ""}
                  {[...facts, ...(model ? [shortModel(model)] : [])].join(" · ")}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
        {onActions ? (
          // One quiet ⋯ per row: a labelled button on every row repeated
          // itself down the list and squeezed the prompts; the actions sheet
          // names each choice.
          <Button
            variant="ghost"
            size="icon"
            className="mt-1 shrink-0 size-12 text-tertiary"
            disabled={busy}
            onClick={onActions}
            aria-label={`Actions for ${text.slice(0, 40)}`}
            data-testid="timeline-row-menu"
          >
            {pending ? <Spinner size={16} label={null} /> : <EllipsisIcon aria-hidden className="size-4" />}
          </Button>
        ) : null}
      </div>
      {note ? (
        <p role="status" className={cn("pb-2.5 pl-9 pr-4 text-meta", note.tone === "danger" ? "text-danger" : "text-muted-foreground")}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A row's mark and its one label: only the exceptions are named. The row
 * being read keeps its exception after "Viewing" ("Viewing · stopped"), so
 * landing on a failed turn still says it failed.
 */
function rowMark(row: TreeRow, viewed: boolean): { mark: RowMark; label: string } {
  const failed = row.stats.stop === "error" || row.stats.stop === "aborted";
  const exception = failed
    ? row.stats.stop === "error" ? "Failed" : "Stopped"
    : row.current ? "Latest"
    : row.active ? ""
    : row.connector === "last" ? "End of branch" : "Other branch";
  if (viewed) return { mark: "viewed", label: exception ? `Viewing · ${exception.toLowerCase()}` : "Viewing" };
  const mark: RowMark = failed ? "failed" : row.current ? "current" : row.active ? "plain" : "branch";
  return { mark, label: exception };
}

const NO_MESSAGES: readonly UiMessage[] = [];
const noSubscribe = () => () => {};

export function TasksTab({ sessionPath, active, focused }: { sessionPath: string; active: boolean; focused: boolean }): JSX.Element {
  const host = useWorkspaceHost();
  const store = host?.controller.getStore() ?? null;
  const messages = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store ? store.getState().messages : NO_MESSAGES),
    () => (store ? store.getState().messages : NO_MESSAGES),
  );
  const moveRestriction = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => {
      if (!store) return null;
      const state = store.getState();
      if (selectSessionCapability(state, sessionPath, "settings") === false) return "This session cannot be changed from this device.";
      if (selectSessionTurn(state, sessionPath) === "running") return "Stop the agent before moving to another point.";
      return null;
    },
    () => null,
  );
  // The board is derived from the loaded transcript. `/todo` edits live in the
  // session, not the transcript, so the session's real board replaces it, but
  // only while the transcript's board is the one it replaced: the agent's
  // next todo call is newer and wins.
  const transcriptTodos = useMemo(() => latestTodos(messages), [messages]);
  const transcriptTodosKey = useMemo(() => JSON.stringify(transcriptTodos ?? null), [transcriptTodos]);
  const [liveTodos, setLiveTodos] = useState<{ session: string; base: string; phases: UiTodoPhase[] } | null>(null);
  const phases = liveTodos && liveTodos.session === sessionPath && liveTodos.base === transcriptTodosKey
    ? liveTodos.phases
    : transcriptTodos;
  const boardBase = useRef(transcriptTodosKey);
  boardBase.current = transcriptTodosKey;
  const [todoBusy, setTodoBusy] = useState(false);
  const [todoError, setTodoError] = useState<string | null>(null);
  const [todoRefresh, setTodoRefresh] = useState(0);
  // One visit owns its board requests: a reply landing after the tab left or
  // moved to another chat must not touch the new view.
  const todoVisit = useRef(0);

  const [treeRows, setTreeRows] = useState<TreeRow[] | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  /** Row whose action (rewind, Go here, label) is in flight; every row waits for it. */
  const [branchingId, setBranchingId] = useState<string | null>(null);
  /** Inline result of the last row action, under the row it was for. */
  const [rewindNote, setRewindNote] = useState<{ id: string; text: string; tone: "muted" | "danger" } | null>(null);
  /** Row whose rewind ConfirmSheet is open. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** Row whose actions sheet is open. */
  const [actionsId, setActionsId] = useState<string | null>(null);
  /** A move never starts until the user chooses whether to keep a summary. */
  const [movingId, setMovingId] = useState<string | null>(null);
  /** The actions sheet is editing that row's label; the text so far. */
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  /** "Labeled" chip: only labelled rows. Offered only while some row has a label. */
  const [labeledOnly, setLabeledOnly] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  /** Every turn in the session, loaded or not (`/api/tree` `total`). */
  const [total, setTotal] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const prevCountRef = useRef(0);
  // Captured before the fetch; the viewport cursor belongs to the transcript, not the server's active row.
  const transcriptPositionRef = useRef<{ currentId: string | null; order: string[] }>({ currentId: null, order: [] });
  const landingDoneRef = useRef(false);
  const suppressPagingRef = useRef(false);
  // One fence for every row action (rewind, Go here, label): one may run at a
  // time, and leaving the tab or switching chat discards its completion.
  const branchGeneration = useRef(0);
  const branchPending = useRef(false);
  const readGeneration = useRef(0);
  const pageGeneration = useRef(0);
  const pagePending = useRef(false);
  // The chat the shown rows were read for. A revisit of that chat re-reads
  // without blanking them: each look used to replay the skeleton over a list
  // that was already there, and drop a reader who had paged back to the top.
  const loadedFor = useRef<string | null>(null);
  const treeRowsRef = useRef(treeRows);
  treeRowsRef.current = treeRows;
  const view = useRef({ active, sessionPath });
  view.current = { active, sessionPath };

  const getViewport = useCallback(
    () => rootRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null,
    [],
  );

  const invalidate = useCallback(() => {
    readGeneration.current++;
    pageGeneration.current++;
    pagePending.current = false;
    branchGeneration.current++;
    branchPending.current = false;
    setBranchingId(null);
    setConfirmingId(null);
    setActionsId(null);
    setLabelDraft(null);
    setMovingId(null);
  }, []);

  const load = useCallback(async () => {
    const request = ++readGeneration.current;
    const quiet = loadedFor.current === sessionPath;
    pageGeneration.current++;
    pagePending.current = false;
    const current = () => request === readGeneration.current && view.current.active && view.current.sessionPath === sessionPath;
    setLoadingEarlier(false);
    setError(null);
    setPageError(null);
    setRewindNote(null);
    anchorRef.current = null;
    if (!quiet) {
      loadedFor.current = null;
      setTreeRows(null);
      setTurns([]);
      setLoading(true);
      setLabeledOnly(false);
      setNextBefore(null);
      setTotal(null);
      prevCountRef.current = 0;
    }
    try {
      const headers = { Authorization: `Bearer ${readPairingToken()}` };
      const resTree = await fetchWithDeadline(`/api/tree?${new URLSearchParams({ session: sessionPath, limit: "100" })}`, { headers });
      if (!current()) return;
      if (resTree.status === 401 || resTree.status === 403) throw new Error("Authentication failed");
      const bodyTree = (await resTree.json()) as { ok: boolean; rows?: unknown; nextBefore?: string | null; total?: unknown };
      if (!current()) return;
      // A tree that can't be read falls back to the flat turn list (no paging),
      // silently: the fallback is the feature, not something to report.
      const rows = resTree.ok && bodyTree.ok !== false ? parseTreeRows(bodyTree.rows) : null;
      if (rows !== null) {
        // Rows older than the fresh page that the reader already paged in stay;
        // the fresh page replaces everything from its first row on. A first row
        // that is not among them means the tree moved: take the fresh page whole.
        const prior = quiet ? treeRowsRef.current : null;
        const first = rows[0];
        const at = prior && first ? prior.findIndex((row) => row.id === first.id) : -1;
        const merged = prior && at >= 0 ? [...prior.slice(0, at), ...rows] : rows;
        setTreeRows(merged);
        if (at < 0) setNextBefore(bodyTree.nextBefore ?? null);
        setTotal(num(bodyTree.total));
        prevCountRef.current = merged.length;
        loadedFor.current = sessionPath;
        return;
      }
      const res = await fetchWithDeadline(`/api/turns?${new URLSearchParams({ session: sessionPath, limit: "50" })}`, { headers });
      if (!current()) return;
      if (res.status === 401 || res.status === 403) throw new Error("Authentication failed");
      const body = (await res.json()) as { ok: boolean; turns?: unknown[]; error?: string };
      if (!current()) return;
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      const parsed: Turn[] = [];
      for (const t of Array.isArray(body.turns) ? body.turns : []) {
        if (typeof t === "string") {
          if (t.trim()) parsed.push({ text: t });
          continue;
        }
        if (!t || typeof t !== "object") continue;
        const o = t as Record<string, unknown>;
        const text = typeof o.text === "string" ? o.text : "";
        if (!text.trim()) continue;
        const id = typeof o.id === "string" ? o.id : typeof o.entryId === "string" ? o.entryId : undefined;
        parsed.push(id ? { text, entryId: id } : { text });
      }
      setTreeRows(null);
      setNextBefore(null);
      setTurns(parsed);
      prevCountRef.current = parsed.length;
      loadedFor.current = sessionPath;
    } catch (e) {
      // A failed re-read keeps what is shown; only a first read reports it.
      if (current() && !quiet) setError(humanizeDaemonError(e));
    } finally {
      if (current()) setLoading(false);
    }
  }, [sessionPath]);

  // Each visit re-reads (new turns arrive between looks) and lands on where
  // the reader is in the chat.
  useLayoutEffect(() => {
    invalidate();
    if (!active) return;
    transcriptPositionRef.current = readTranscriptPosition();
    landingDoneRef.current = false;
    setViewedId(null);
    void load();
    return invalidate;
  }, [active, sessionPath, load, invalidate]);

  // Binds a board update to the chat it was made for: a reply after a chat
  // switch lands on the chat it changed, never on the one now open. `null`
  // returns that chat to the transcript's board.
  const boardSetter = useCallback((session: string) => {
    const base = boardBase.current;
    return (next: UiTodoPhase[] | null) =>
      setLiveTodos((prev) => (next ? { session, base, phases: next } : prev?.session === session ? null : prev));
  }, []);

  // The transcript only holds the agent's own todo calls; edits made with
  // `/todo` (here or in the terminal) live in the session. A live session
  // answers with its real board; `peek` never boots an agent just to look.
  useEffect(() => {
    const visit = ++todoVisit.current;
    setTodoBusy(false);
    setTodoError(null);
    if (!active) return;
    const change = boardSetter(sessionPath);
    void new DaemonApi(readPairingToken() ?? "").getState(sessionPath, { peek: true }).then((state) => {
      const live = parseTodoPhases("todo", { phases: state.todoPhases });
      if (todoVisit.current === visit && live) change(live);
    }, () => {});
  }, [active, sessionPath, boardSetter, todoRefresh]);

  const runTodo = async (command: string, optimistic: UiTodoPhase[]): Promise<boolean> => {
    if (todoBusy) return false;
    const visit = todoVisit.current;
    const before = phases ? [...phases] : null;
    const change = boardSetter(sessionPath);
    setTodoBusy(true);
    setTodoError(null);
    change(optimistic);
    try {
      const api = new DaemonApi(readPairingToken() ?? "");
      const printed = (await api.runCommand(sessionPath, command)).output.trim();
      const state = await api.getState(sessionPath);
      change(parseTodoPhases("todo", { phases: state.todoPhases }) ?? before);
      if (todoVisit.current !== visit) return false;
      if (NOT_APPLIED.test(printed)) {
        setTodoError(printed);
        return false;
      }
      return true;
    } catch (e) {
      change(before);
      if (todoVisit.current === visit) setTodoError(humanizeDaemonError(e));
      return false;
    } finally {
      if (todoVisit.current === visit) setTodoBusy(false);
    }
  };

  const todoEditor: TodoEditor = {
    busy: todoBusy,
    onAct: (action, phase, task, content) => {
      const target = { phase, task };
      const error = todoTargetError(phases ?? [], target, content);
      if (error) {
        setTodoError(error);
        return;
      }
      void runTodo(todoCommand(action, content), applyTodoAction(phases ?? [], action, target));
    },
  };
  const addTodo = (text: string) => runTodo(todoCommand("append", text), appendTodo(phases ?? [], text));

  const jump = (entryId: string) => {
    closePanels();
    host?.jumpTo(entryId);
  };

  // Claim the row-action fence. Returns the staleness check, or null when the
  // tab cannot start one (not shown, another action pending).
  const beginRowAction = useCallback((entryId: string) => {
    if (!view.current.active || branchPending.current) return null;
    if (view.current.sessionPath !== sessionPath) return null;
    if (store && store.getState().sessionPath !== sessionPath) return null;
    const request = ++branchGeneration.current;
    branchPending.current = true;
    setBranchingId(entryId);
    setRewindNote(null);
    return () => request === branchGeneration.current && view.current.active && view.current.sessionPath === sessionPath
      && (!store || store.getState().sessionPath === sessionPath);
  }, [sessionPath, store]);

  const endRowAction = useCallback(() => {
    branchPending.current = false;
    setBranchingId(null);
  }, []);

  // Rewind confirms in a ConfirmSheet, never window.confirm: in the Android
  // WebView that draws a system dialog captioned with the origin.
  const handleBranch = useCallback(
    async (entryId: string) => {
      const current = beginRowAction(entryId);
      if (!current) return;
      // The confirm sheet stays open (busy) until the request settles.
      try {
        // /api/tree and the file-based branch endpoint share raw entry ids.
        // Text and page-relative positions are ambiguous for repeated prompts.
        const result = await new DaemonApi(readPairingToken()).branch(sessionPath, entryId);
        if (!current()) return;
        if (result.cancelled) {
          setRewindNote({ id: entryId, text: "Rewind cancelled.", tone: "muted" });
          return;
        }
        // omp hands back the text of the message you rewound to so the editor
        // can restore it for you to amend and resend.
        seedDraft(result.sessionPath, result.text);
        host?.onBranched(result.sessionPath);
        closePanels();
      } catch (e) {
        if (current()) setRewindNote({ id: entryId, text: humanizeDaemonError(e), tone: "danger" });
      } finally {
        if (current()) {
          endRowAction();
          setConfirmingId(null);
        }
      }
    },
    [sessionPath, host, beginRowAction, endRowAction],
  );

  // Summary selection and native question dialogs are preparation only. Refresh
  // the conversation after a committed move, never after cancel or abort.
  const handleGoHere = useCallback(
    async (entryId: string, summarize: boolean) => {
      const rowId = treeRows?.find(row => row.id === entryId || row.resumeTargets.some(target => target.id === entryId))?.id ?? entryId;
      const current = beginRowAction(rowId);
      if (!current) return;
      if (moveRestriction) {
        setRewindNote({ id: rowId, text: moveRestriction, tone: "danger" });
        endRowAction();
        return;
      }
      setActionsId(null);
      setMovingId(null);
      try {
        const result = await new DaemonApi(readPairingToken()).treeGoto(sessionPath, entryId, { summarize });
        if (!current()) return;
        if (result.cancelled || result.aborted) {
          setRewindNote({ id: rowId, text: result.error || "Nothing changed.", tone: result.error ? "danger" : "muted" });
          return;
        }
        host?.onMovedHere?.(sessionPath, result.editorText, result.askReanswerCommitted);
        closePanels();
      } catch (e) {
        if (current()) setRewindNote({ id: rowId, text: humanizeDaemonError(e), tone: "danger" });
      } finally {
        if (current()) endRowAction();
      }
    },
    [sessionPath, host, beginRowAction, endRowAction, moveRestriction, treeRows],
  );

  // Save (or with null/blank, remove) a row's label; the row updates from the
  // daemon's answer, not from what was typed.
  const saveLabel = useCallback(
    async (entryId: string, label: string | null) => {
      const current = beginRowAction(entryId);
      if (!current) return;
      try {
        const saved = await new DaemonApi(readPairingToken()).treeLabel(sessionPath, entryId, label);
        if (!current()) return;
        setTreeRows((prev) => prev?.map((row) => (row.id === entryId ? { ...row, label: saved ?? undefined } : row)) ?? prev);
        setActionsId(null);
        setLabelDraft(null);
      } catch (e) {
        if (current()) setRewindNote({ id: entryId, text: humanizeDaemonError(e), tone: "danger" });
      } finally {
        if (current()) endRowAction();
      }
    },
    [sessionPath, beginRowAction, endRowAction],
  );

  useLayoutEffect(() => {
    if (!active || loading || landingDoneRef.current) return;
    const rows = treeRows
      ? treeRows.map((row) => ({ id: row.id, entryId: row.id as string | undefined }))
      : turns.map((turn, index) => ({ id: turn.entryId ?? `flat-${index}`, entryId: turn.entryId }));
    if (rows.length === 0) return;
    const viewport = getViewport();
    if (!viewport) return;

    const { currentId, order } = transcriptPositionRef.current;
    // Prefer an exact row for the viewed entry; otherwise the row that CONTAINS
    // the reader, which is the last user turn at or before their position.
    let landing = currentId ? rows.find((row) => row.entryId === currentId) : undefined;
    if (!landing && currentId) {
      const rank: Record<string, number> = {};
      for (let i = 0; i < order.length; i++) rank[order[i] as string] = i;
      const at = rank[currentId];
      if (at !== undefined) {
        let bestRank = -1;
        for (const row of rows) {
          const r = row.entryId ? rank[row.entryId] : undefined;
          if (r !== undefined && r <= at && r > bestRank) {
            bestRank = r;
            landing = row;
          }
        }
      }
    }
    // Nothing resolvable means the reader is somewhere the window does not
    // cover, and the newest row is the right place for that, never the oldest.
    landing ??= rows[rows.length - 1]!;
    const target = landing;
    const element = Array.from(viewport.querySelectorAll<HTMLElement>("[data-timeline-row-id]")).find(
      (row) => row.dataset.timelineRowId === target.id,
    );
    if (!element) return;
    // Set the landing offset before paint. Unlike a scroll event, this does not
    // feed the near-top pager, so landing on an early row cannot fetch by itself.
    const delta = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    suppressPagingRef.current = true;
    viewport.scrollTop = Math.min(maxScrollTop, Math.max(0, viewport.scrollTop + delta - 16));
    window.requestAnimationFrame(() => {
      suppressPagingRef.current = false;
    });
    setViewedId(target.id);
    landingDoneRef.current = true;
  }, [active, loading, treeRows, turns, getViewport]);

  const loadEarlier = useCallback(async () => {
    if (!view.current.active || !nextBefore || pagePending.current || loadingEarlier || loading) return;
    const parent = readGeneration.current;
    const request = ++pageGeneration.current;
    pagePending.current = true;
    const current = () => parent === readGeneration.current && request === pageGeneration.current && view.current.active && view.current.sessionPath === sessionPath;
    const viewport = getViewport();
    anchorRef.current = viewport && viewport.scrollHeight > viewport.clientHeight ? { height: viewport.scrollHeight, top: viewport.scrollTop } : null;
    setLoadingEarlier(true);
    setPageError(null);
    try {
      const res = await fetchWithDeadline(`/api/tree?${new URLSearchParams({ session: sessionPath, limit: "40", before: nextBefore })}`, {
        headers: { Authorization: `Bearer ${readPairingToken()}` },
      });
      if (!current()) return;
      if (res.status === 401 || res.status === 403) throw new Error("Authentication failed");
      const body = (await res.json()) as { ok: boolean; rows?: unknown; nextBefore?: string | null; error?: string };
      if (!current()) return;
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      const rows = parseTreeRows(body.rows);
      if (rows === null) {
        setNextBefore(null);
        return;
      }
      if (rows.length > 0) setTreeRows((prev) => (prev ? [...rows, ...prev] : rows));
      setNextBefore(body.nextBefore ?? null);
    } catch (e) {
      if (current()) setPageError(humanizeDaemonError(e));
    } finally {
      if (current()) {
        pagePending.current = false;
        setLoadingEarlier(false);
      }
    }
  }, [sessionPath, nextBefore, loadingEarlier, loading, getViewport]);

  useEffect(() => {
    if (!active || treeRows === null || nextBefore === null) return;
    const viewport = getViewport();
    if (!viewport) return;
    const onScroll = () => {
      if (suppressPagingRef.current || loadingEarlier || loading) return;
      if (viewport.scrollHeight <= viewport.clientHeight) return;
      if (viewport.scrollTop <= TRIGGER_PX) void loadEarlier();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [active, treeRows, nextBefore, loadingEarlier, loading, getViewport, loadEarlier]);

  // Re-anchor after prepending — content-visibility:auto rows report estimated
  // height until laid out, so scrollHeight settles over several frames
  // (copied from web/src/app/LoadEarlier.tsx).
  useLayoutEffect(() => {
    const count = treeRows?.length ?? 0;
    const grew = count > prevCountRef.current;
    prevCountRef.current = count;
    const viewport = getViewport();
    const previous = anchorRef.current;
    if (!grew || !viewport || !previous) return;
    anchorRef.current = null;
    let frame = 0;
    let frames = 0;
    let settledFrames = 0;
    let lastHeight = Number.NaN;
    const restore = () => {
      viewport.scrollTop = viewport.scrollHeight - previous.height + previous.top;
    };
    const settle = () => {
      restore();
      const height = viewport.scrollHeight;
      settledFrames = height === lastHeight ? settledFrames + 1 : 0;
      lastHeight = height;
      frames += 1;
      if (settledFrames >= 2 || frames >= 24) return;
      frame = window.requestAnimationFrame(settle);
    };
    restore();
    frame = window.requestAnimationFrame(settle);
    return () => window.cancelAnimationFrame(frame);
  }, [treeRows?.length, getViewport]);

  const askRewind = (id: string) => {
    setActionsId(null);
    setRewindNote(null);
    setConfirmingId(id);
  };
  const openActions = (id: string) => {
    setRewindNote(null);
    setLabelDraft(null);
    setActionsId(id);
  };
  const noteFor = (id: string) => (rewindNote?.id === id ? rewindNote : null);
  const hasTodo = todoProgress(phases) !== null;
  const isEmpty = treeRows ? treeRows.length === 0 : turns.length === 0;
  // The chip exists only while there is something to filter to; removing the
  // last label therefore also turns the filter off.
  const hasLabels = treeRows?.some((row) => row.label) ?? false;
  const filterOn = labeledOnly && hasLabels;
  const visibleRows = treeRows && filterOn ? treeRows.filter((row) => row.label) : treeRows;
  // Labels need the tree; the flat fallback offers Go here and Rewind only.
  const actionRow = actionsId ? treeRows?.find((row) => row.id === actionsId) ?? null : null;
  const actionText = actionRow?.text ?? turns.find((turn) => turn.entryId === actionsId)?.text ?? "";
  const actionNote = actionsId ? noteFor(actionsId) : null;
  const moveRow = movingId ? treeRows?.find(row => row.id === movingId || row.resumeTargets.some(target => target.id === movingId)) ?? null : null;

  // The timeline's own traversal: jump the list (not the chat) to the turn
  // being read or the newest one.
  const scrollToRow = (id: string) => {
    const element = getViewport()?.querySelector<HTMLElement>(`[data-timeline-row-id="${CSS.escape(id)}"]`);
    element?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };
  const latestId = treeRows?.find((row) => row.current)?.id ?? null;
  // Work and spend on the current branch, over the turns loaded so far.
  const branch = treeRows?.filter((row) => row.active) ?? [];
  const workedMs = branch.reduce((sum, row) => {
    const { at, lastAt, replies } = row.stats;
    return at !== null && lastAt !== null && replies > 0 && lastAt > at ? sum + (lastAt - at) : sum;
  }, 0);
  const spent = formatCost(branch.reduce((sum, row) => sum + row.stats.cost, 0));
  const entryCount = total ?? treeRows?.length ?? turns.length;

  let timeline: JSX.Element | null;
  if (loading) {
    timeline = (
      <div aria-busy className="-mx-4 flex flex-col" data-testid="timeline-loading">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    );
  } else if (error) {
    timeline = (
      <Notice tone="danger" title="Couldn’t load the timeline." action={errorRecoveryAction(error) ?? { label: "Retry", onClick: () => void load() }}>
        {error}
      </Notice>
    );
  } else if (isEmpty) {
    timeline = hasTodo ? <p className="text-meta text-muted-foreground">No turns yet.</p> : null;
  } else if (treeRows) {
    let lastDay = "";
    timeline = (
      <section aria-label="Timeline" className="flex flex-col">
        {/* One quiet bar that stays put while the list scrolls: how much
            happened, and the two places worth jumping back to. */}
        <div className="sticky top-0 z-raised -mx-4 flex min-h-12 items-center bg-background/95 pl-4 pr-1 backdrop-blur" data-testid="timeline-summary">
          <span className="min-w-0 flex-1 truncate text-meta tabular-nums text-muted-foreground">
            <span className="font-medium text-foreground">Timeline</span>
            {` · ${entryCount === 1 ? "1 entry" : `${entryCount} entries`}`}
            {workedMs > 0 ? ` · ${formatDuration(workedMs)} worked` : ""}
            {spent ? ` · ${spent}` : ""}
          </span>
          {viewedId && viewedId !== latestId ? (
            <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={() => scrollToRow(viewedId)} aria-label="Show the turn you’re reading" title="Viewing" data-testid="timeline-to-viewing">
              <LocateFixedIcon aria-hidden className="size-5" />
            </Button>
          ) : null}
          {latestId ? (
            <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={() => scrollToRow(latestId)} aria-label="Show the newest turn" title="Latest" data-testid="timeline-to-latest">
              <ArrowDownToLineIcon aria-hidden className="size-5" />
            </Button>
          ) : null}
          {hasLabels ? (
            <Chip
              size="md"
              selected={filterOn}
              leading={<TagIcon aria-hidden />}
              onClick={() => setLabeledOnly(!filterOn)}
              testId="timeline-labeled-filter"
              aria-label={filterOn ? "Show every turn" : "Show labelled turns only"}
              className="mr-1"
            >
              Labeled
            </Chip>
          ) : null}
        </div>
        {nextBefore !== null ? (
          <div className="flex justify-center">
            {loadingEarlier ? (
              <span className="flex min-h-11 items-center gap-2 text-meta text-muted-foreground" aria-live="polite">
                <Spinner size={16} label={null} />
                Loading…
              </span>
            ) : (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void loadEarlier()} aria-label="Load earlier turns" data-testid="timeline-load-earlier">
                Load earlier
              </Button>
            )}
          </div>
        ) : null}
        {(visibleRows ?? []).map((row, index, rows) => {
          const viewed = viewedId === row.id;
          const { mark, label } = rowMark(row, viewed);
          // A day header wherever the day changes down the list, so a long
          // session reads in days rather than as one undifferentiated run.
          const day = row.stats.at !== null ? dayLabel(row.stats.at) : "";
          const header = day && day !== lastDay ? day : null;
          if (day) lastDay = day;
          // The model is named where it changes, not repeated down the rail.
          const model = row.stats.model && row.stats.model !== rows[index - 1]?.stats.model ? row.stats.model : null;
          return (
            <div key={row.id} className="flex flex-col">
              {header ? (
                <h3 className="relative pb-1 pl-9 pt-3 text-meta font-medium text-muted-foreground" data-testid="timeline-day">
                  {/* The rail runs on through the day header. */}
                  <span aria-hidden className="pointer-events-none absolute inset-y-0 left-[15px] w-px bg-hairline" />
                  {header}
                </h3>
              ) : null}
              <TimelineRow
                id={row.id}
                text={row.text}
                answer={row.kind === "ask" ? row.answer : undefined}
                label={label}
                tag={row.label}
                facts={row.kind === "ask" ? ["Decision"] : turnFacts(row.stats)}
                mark={mark}
                model={model}
                pending={branchingId === row.id}
                busy={branchingId !== null}
                note={noteFor(row.id)}
                onJump={() => {
                  // The chat shows the active branch only (branch-view.ts),
                  // so jumping to an off-branch turn found nothing and the
                  // tap did nothing. Point at the explicit continuation choices.
                  if (!row.active) {
                    showToast(row.kind === "ask" ? "That decision is on another branch. Use ⋯ → Re-answer to continue from it." : "That turn is on another branch. Use ⋯ to continue after an answer or edit the prompt.");
                    return;
                  }
                  jump(row.id);
                }}
                onActions={() => openActions(row.id)}
              />
            </div>
          );
        })}
      </section>
    );
  } else {
    timeline = (
      <RowGroup title="Timeline">
        {turns.map((t, idx) => {
          const rowId = t.entryId ?? `flat-${idx}`;
          const viewed = viewedId === rowId;
          const entryId = t.entryId;
          return (
            <TimelineRow
              key={rowId}
              id={rowId}
              text={t.text}
              label={viewed ? "Viewing" : ""}
              facts={[]}
              mark={viewed ? "viewed" : "plain"}
              model={null}
              pending={branchingId === rowId}
              busy={branchingId !== null}
              note={noteFor(rowId)}
              onJump={() => jump(entryId ?? t.text)}
              onActions={entryId ? () => openActions(entryId) : null}
            />
          );
        })}
      </RowGroup>
    );
  }

  return (
    <div ref={rootRef} data-testid="tasks-tab" className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-4 pb-6 pt-3">
          {todoError ? <Notice tone="danger" action={/reopen tasks/i.test(todoError) ? { label: "Refresh tasks", onClick: () => setTodoRefresh((value) => value + 1) } : /distinct name/i.test(todoError) ? { label: "Open chat", onClick: closePanels } : errorRecoveryAction(todoError)} onDismiss={() => setTodoError(null)}>{todoError}</Notice> : null}
          {phases && hasTodo ? (
            <PlanCard phases={phases} editor={todoEditor}>
              <TodoAddRow busy={todoBusy} onAdd={addTodo} />
            </PlanCard>
          ) : (
            <TodoAddRow busy={todoBusy} onAdd={addTodo} />
          )}
          {pageError ? <Notice tone="danger" action={errorRecoveryAction(pageError)} onDismiss={() => setPageError(null)}>{pageError}</Notice> : null}
          {!hasTodo && !loading && !error && isEmpty ? (
            <EmptyState
              icon={<ListChecksIcon />}
              title="No tasks yet"
              description="The agent’s todo list and every message you send show up here."
            />
          ) : (
            // Keyed on loading so the timeline that replaces the skeleton fades in.
            <div key={loading ? "loading" : "ready"} className="motion-safe:animate-fade-in">{timeline}</div>
          )}
        </div>
      </ScrollArea>
      <BottomSheet
        open={focused && actionsId !== null}
        onOpenChange={(next) => { if (!next) { setActionsId(null); setLabelDraft(null); } }}
        title={labelDraft !== null ? (actionRow?.label ? "Edit label" : "Add label") : actionRow?.kind === "ask" ? "Decision" : "Turn"}
        description={actionRow?.kind === "ask" ? undefined : actionText ? actionText.slice(0, 80) : undefined}
        testId="timeline-row-actions"
      >
        {actionNote?.tone === "danger" ? <Notice tone="danger" className="mb-3" action={/stop the agent/i.test(actionNote.text) ? { label: "Open chat", onClick: closePanels } : errorRecoveryAction(actionNote.text)}>{actionNote.text}</Notice> : null}
        {actionRow?.kind === "ask" && labelDraft === null ? (
          <div className="mb-3 space-y-2 text-ui">
            <p className="whitespace-pre-wrap break-words">{actionRow.text}</p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">Answered: {actionRow.answer}</p>
            <p className="text-meta text-muted-foreground">Re-answer to continue from this decision. The original answer stays on its own branch.</p>
          </div>
        ) : null}
        {moveRestriction && labelDraft === null ? <Notice tone="warning" className="mb-3" action={/stop the agent/i.test(moveRestriction) ? { label: "Open chat", onClick: closePanels } : { label: "Device access", onClick: () => openSettingsPage("computer") }}>{moveRestriction}</Notice> : null}
        {actionsId && labelDraft !== null ? (
          <form
            className="flex min-w-0 items-center gap-2 pb-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveLabel(actionsId, labelDraft);
            }}
          >
            <Input
              data-testid="timeline-label-input"
              aria-label="Label"
              placeholder="Label"
              autoFocus
              maxLength={LABEL_MAX}
              value={labelDraft}
              disabled={branchingId !== null}
              onChange={(event) => setLabelDraft(event.target.value)}
              className="h-11 min-w-0 flex-1 rounded-md border-0 bg-surface-2 px-3 text-ui shadow-none placeholder:text-muted-foreground"
            />
            <Button type="submit" variant="primary" className="shrink-0" disabled={branchingId !== null}>
              {branchingId === actionsId ? <Spinner size={16} label={null} /> : null}
              Save
            </Button>
          </form>
        ) : actionsId ? (
          <RowGroup>
            <Row
              leading={<CornerUpLeftIcon />}
              title={actionRow?.kind === "ask" ? "Re-answer" : "Edit this prompt"}
              subtitle={actionRow?.kind === "ask" ? "Answer differently and continue from this decision" : "Put this prompt back in the composer; keep later replies on their branch"}
              disabled={branchingId !== null || moveRestriction !== null}
              onClick={() => { setMovingId(actionsId); setActionsId(null); }}
              testId={actionRow?.kind === "ask" ? "timeline-reanswer" : "timeline-go-here"}
            />
            {actionRow?.resumeTargets.map((target, index, targets) => (
              <Row
                key={target.id}
                leading={<GitBranchIcon />}
                title={targets.length > 1 ? `Continue after answer ${index + 1}` : "Continue after answer"}
                subtitle={target.text}
                disabled={branchingId !== null || moveRestriction !== null}
                onClick={() => { setMovingId(target.id); setActionsId(null); }}
                testId="timeline-resume-answer"
              />
            ))}
            {actionRow?.kind !== "ask" ? (
            <Row
              leading={<GitForkIcon />}
              title="Rewind into a new chat"
              subtitle="This message goes back in the composer to edit"
              disabled={branchingId !== null}
              onClick={() => askRewind(actionsId)}
              testId="timeline-rewind-new"
            />
            ) : null}
            {actionRow ? (
              <Row
                leading={<TagIcon />}
                title={actionRow.label ? "Edit label" : "Add label"}
                disabled={branchingId !== null}
                onClick={() => setLabelDraft(actionRow.label ?? "")}
                testId="timeline-label"
              />
            ) : null}
            {actionRow?.label ? (
              <Row
                leading={<XIcon />}
                title="Remove label"
                destructive
                disabled={branchingId !== null}
                onClick={() => void saveLabel(actionsId, null)}
                testId="timeline-label-remove"
              />
            ) : null}
          </RowGroup>
        ) : null}
      </BottomSheet>
      <BottomSheet
        open={focused && movingId !== null}
        onOpenChange={(next) => { if (!next) setMovingId(null); }}
        title={moveRow && moveRow.id !== movingId ? "Continue after this answer?" : moveRow?.kind === "ask" ? "Re-answer this decision?" : "Edit this prompt?"}
        description="Keep useful findings from the branch you’re leaving?"
        testId="timeline-move-options"
      >
        {moveRestriction ? <p className="mb-3 text-meta text-muted-foreground">{moveRestriction}</p> : null}
        <RowGroup>
          <Row
            title="Summarize branch"
            subtitle="OMP carries a summary into the next turn"
            disabled={branchingId !== null || moveRestriction !== null}
            onClick={() => { if (movingId) void handleGoHere(movingId, true); }}
            testId="timeline-move-summarize"
          />
          <Row
            title="Without summary"
            subtitle="Continue using only the history at this point"
            disabled={branchingId !== null || moveRestriction !== null}
            onClick={() => { if (movingId) void handleGoHere(movingId, false); }}
            testId="timeline-move-no-summary"
          />
          <Row title="Cancel" onClick={() => setMovingId(null)} testId="timeline-move-cancel" />
        </RowGroup>
      </BottomSheet>
      <ConfirmSheet
        open={focused && confirmingId !== null}
        onOpenChange={(next) => { if (!next) setConfirmingId(null); }}
        title="Rewind to this turn?"
        description="A new branch starts from here, with this message back in the composer to edit."
        confirmLabel="Rewind"
        tone="danger"
        onConfirm={() => { if (confirmingId) void handleBranch(confirmingId); }}
        busy={branchingId !== null}
        busyLabel="Rewinding…"
      />
    </div>
  );
}
