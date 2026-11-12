import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Minimize2Icon, SettingsIcon, SparklesIcon } from "lucide-react";

import { Notice } from "@/app/ui/Notice";
import { EmptyState } from "@/app/ui/EmptyState";
import { Row, RowGroup } from "@/app/ui/Row";
import { Segmented } from "@/app/ui/Segmented";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi, isOwnershipError } from "@/runtime/rpc-client";
import type { SessionState } from "@/runtime/api-types";
import { parseSessionModel, type SessionModel } from "@/runtime/omp-store";
import { compactionPending, getCompactionOperation } from "@/runtime/compaction";
import { BottomSheet, SheetLoading } from "@/app/ui/Sheet";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction, type RecoveryAction } from "@/app/ui/error-recovery";
import { ContextRing } from "@/app/ui/ContextRing";
import { formatTokens } from "@/app/ui/ContextMeter";
import { shortModel } from "@/app/session-format";
import { openSwitcher } from "@/app/nav/panels";
import { showToast } from "@/app/Notices";
import { hasNativeNotificationControls, readNativeChatNotifications, writeNativeChatNotifications } from "@/platform/native-notifications";

type Option = { value: string; label: string };
// omp's steering and follow-up queues both drain these two ways.
const DELIVERY_OPTIONS: readonly Option[] = [
  { value: "all", label: "All at once" },
  { value: "one-at-a-time", label: "One by one" },
];
const INTERRUPT_OPTIONS: readonly Option[] = [
  { value: "immediate", label: "Interrupt" },
  { value: "wait", label: "Wait for step" },
];
/** Longest the sheet shows "Loading settings…" before offering Retry. */
const SETTINGS_WAIT_MS = 12_000;

type ChoiceFieldProps = {
  testId: string;
  label: string;
  help?: string;
  options: readonly Option[];
  /** Null or an unknown value: the session did not report it, so no segment is shown selected. */
  value: string | null | undefined;
  onChange: (value: string) => void;
  disabled: boolean;
  /** Set on your computer: the values show, the controls do not move. */
  readOnly: boolean;
};

/** A setting with a few named values: an inline Segmented under its label, as in Appearance. */
function ChoiceField({ testId, label, help, options, value, onChange, disabled, readOnly }: ChoiceFieldProps) {
  const known = options.some((option) => option.value === value);
  const locked = disabled || readOnly || !known;
  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <span className="text-ui text-foreground">{label}</span>
      <Segmented
        aria-label={label}
        testId={testId}
        className="bg-background"
        options={options.map((option) => ({ ...option, disabled: locked }))}
        value={value ?? ""}
        onChange={onChange}
      />
      {known ? (help ? <span className="text-meta text-muted-foreground">{help}</span> : null) : <span className="text-meta text-muted-foreground">Not reported for this session.</span>}
    </div>
  );
}

/**
 * This chat's notifications (Android only). The native dialog this replaced offered
 * per-chat switches when opened from a chat; this is the one place they live now.
 * A chat with no override reads the global value, so the switch is honest either way.
 */
function ChatNotificationsRow({ sessionPath }: { sessionPath: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!hasNativeNotificationControls()) return;
    let live = true;
    readNativeChatNotifications(sessionPath).then((prefs) => { if (live) setEnabled(prefs.enabled); }, () => {});
    return () => { live = false; };
  }, [sessionPath]);
  if (enabled === null) return null;
  return (
    <SwitchRow id="chat-notifications" label="Notifications" help="For this chat only">
      <Switch
        id="chat-notifications"
        data-testid="chat-notifications-switch"
        checked={enabled}
        onCheckedChange={(checked) => {
          setEnabled(checked);
          writeNativeChatNotifications(sessionPath, { enabled: checked }).then(
            (prefs) => setEnabled(prefs.enabled),
            () => { setEnabled(!checked); showToast("Couldn’t change this chat’s notifications.", "error"); },
          );
        }}
      />
    </SwitchRow>
  );
}

function SwitchRow({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <Row
      title={<label htmlFor={id}>{label}</label>}
      subtitle={help}
      trailing={children}
    />
  );
}

type SettingsData = SessionState & {
  autoRetryEnabled?: boolean;
  autoCompactionEnabled?: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessionPath: string | null;
  /** Project (cwd basename) these settings belong to; the sheet subtitle (sheets-1). */
  project?: string | null;
  onNeedCollab?: () => void;
  onStateChanged?: (state: Partial<SessionModel>) => void;
  /** Plan mode as the chat shows it; the switch mirrors it. */
  planMode?: boolean;
  /**
   * Turn plan mode on or off for this sheet's session and show the reply in
   * the chat. Throws the daemon's error, so `mutate` renders ownership and
   * refusals like every other row.
   */
  onSetPlanMode?: (enabled: boolean) => Promise<unknown>;
  /** Opens the model and thinking picker (closes this sheet first). */
  onOpenModelPicker?: () => void;
};

export function SessionSettingsSheet({ open, onOpenChange, sessionPath, project, onNeedCollab, onStateChanged, planMode, onSetPlanMode, onOpenModelPicker }: Props) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOwned, setIsOwned] = useState(false);
  const [ownershipInfo, setOwnershipInfo] = useState<string | null>(null);
  const [mutating, setMutating] = useState<string | null>(null);
  const [compactConfirm, setCompactConfirm] = useState(false);
  const token = readPairingToken() ?? "";
  const compactOperation = useMemo(() => getCompactionOperation(token, sessionPath ?? ""), [token, sessionPath]);
  const subscribeCompact = useCallback((listener: () => void) => open ? compactOperation.subscribe(listener) : () => {}, [open, compactOperation]);
  const compactSnapshot = useSyncExternalStore(subscribeCompact, compactOperation.getSnapshot);
  const compactBusy = compactionPending(compactSnapshot.phase);
  const generation = useRef(0);
  const pending = useRef(false);
  const visit = useMemo(() => ({ open, sessionPath, token }), [open, sessionPath, token]);
  const view = useRef(visit);
  view.current = visit;
  const mounted = useRef(false);
  const stateChanged = useRef(onStateChanged);
  stateChanged.current = onStateChanged;
  const invalidate = useCallback(() => {
    generation.current++;
    pending.current = false;
    setMutating(null);
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    invalidate();
    setData(null);
    setError(null);
    setIsOwned(false);
    setOwnershipInfo(null);
    setCompactConfirm(false);
    setLoading(Boolean(open && sessionPath));
    return () => { mounted.current = false; invalidate(); };
  }, [open, sessionPath, token, invalidate]);
  const ownsView = useCallback(() => mounted.current && view.current === visit && visit.open &&
    Boolean(visit.sessionPath) && (readPairingToken() ?? "") === visit.token, [visit]);
  const beginMutation = useCallback(() => {
    if (!ownsView() || pending.current || compactionPending(compactOperation.getSnapshot().phase)) return null;
    const attempt = ++generation.current;
    pending.current = true;
    const current = () => generation.current === attempt && ownsView();
    return { current, finish: () => {
      if (!current()) return;
      pending.current = false;
      setMutating(null);
    } };
  }, [ownsView, compactOperation]);

  useEffect(() => {
    if (!ownsView() || !compactSnapshot.state) return;
    setData(compactSnapshot.state as SettingsData);
    stateChanged.current?.(parseSessionModel(compactSnapshot.state));
  }, [compactSnapshot, ownsView]);

  const load = useCallback(async () => {
    if (!ownsView() || !sessionPath || pending.current) return;
    const attempt = ++generation.current;
    const current = () => generation.current === attempt && ownsView();
    setLoading(true);
    setError(null);
    setIsOwned(false);
    setOwnershipInfo(null);
    setCompactConfirm(false);
    // A session whose agent is still starting (or stuck starting) can hold
    // `get_state` open; the sheet must never spin indefinitely. Past the
    // bound this read is abandoned (a late answer is ignored) and Retry
    // starts a fresh one.
    const bound = window.setTimeout(() => {
      if (!current()) return;
      generation.current++;
      setLoading(false);
      setError("Your computer didn’t answer. The session may still be starting.");
    }, SETTINGS_WAIT_MS);
    try {
      const state = await new DaemonApi(readPairingToken() ?? "").getState(sessionPath);
      if (!current()) return;
      setData(state as SettingsData);
      compactOperation.observe(state);
      stateChanged.current?.(parseSessionModel(state));
    } catch (e) {
      if (!current()) return;
      if (isOwnershipError(e)) {
        setIsOwned(true);
        setData(null);
      } else {
        setError(humanizeDaemonError(e));
      }
    } finally {
      window.clearTimeout(bound);
      if (current()) setLoading(false);
    }
  }, [ownsView, sessionPath, compactOperation]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (key: string, fn: () => Promise<void>, patch?: Partial<SessionModel>) => {
      if (!sessionPath) return;
      const attempt = beginMutation();
      if (!attempt) return;
      setMutating(key);
      setOwnershipInfo(null);
      setError(null);
      try {
        await fn();
        if (!attempt.current()) return;
        if (patch) stateChanged.current?.(patch);
        // refresh state after mutation
        const token = readPairingToken() ?? "";
        const api = new DaemonApi(token);
        const state = await api.getState(sessionPath);
        if (!attempt.current()) return;
        setData(state as SettingsData);
        stateChanged.current?.(parseSessionModel(state));
      } catch (e) {
        if (!attempt.current()) return;
        if (isOwnershipError(e)) {
          setOwnershipInfo(humanizeDaemonError(e));
        } else {
          setError(humanizeDaemonError(e));
        }
      } finally {
        attempt.finish();
      }
    },
    [sessionPath, beginMutation],
  );

  const handleCompact = useCallback(async () => {
    if (!sessionPath || !ownsView() || pending.current || !compactConfirm) return;
    const attempt = beginMutation();
    if (!attempt) return;
    // The outcome Notice reports progress from here; the question is answered.
    setCompactConfirm(false);
    setOwnershipInfo(null);
    setError(null);
    try {
      const outcome = await compactOperation.run(parseSessionModel(data).ctxPercent ?? null, undefined, data ?? undefined);
      if (!attempt.current()) return;
      if (outcome.kind === "failed") {
        if (isOwnershipError(outcome.error)) setOwnershipInfo(humanizeDaemonError(outcome.error));
        else setError(humanizeDaemonError(outcome.error));
      }
    } finally {
      attempt.finish();
    }
  }, [compactConfirm, sessionPath, ownsView, beginMutation, compactOperation, data]);

  // Recovery actions navigate away (a settings page, the sharing sheet), so this
  // sheet closes first: a sheet opened over it would stack.
  const leaving = (action: RecoveryAction | undefined): RecoveryAction | undefined =>
    action && { ...action, onClick: () => { onOpenChange(false); action.onClick(); } };

  let body: React.ReactNode;
  if (loading) body = <SheetLoading label="Loading settings…" />;
  else if (isOwned && !data)
    body = (
      <EmptyState
        title="Settings are on your computer"
        description="This session is open on your computer, so its settings can only be changed there."
        icon={<SettingsIcon />}
        action={leaving(errorRecoveryAction("session_owned_by_terminal"))}
      />
    );
  else if (!data)
    body = (
      <Notice tone="danger" title="Couldn’t load settings." action={sessionPath ? leaving(errorRecoveryAction(error)) ?? { label: "Retry", onClick: () => void load() } : { label: "Choose session", onClick: openSwitcher }}>
        {error ?? "Open a session first."}
      </Notice>
    );
  else {
    const busy = mutating !== null || compactBusy;
    const api = () => new DaemonApi(readPairingToken() ?? "");
    const readOnly = data.settingsReadOnly === true;
    const model = parseSessionModel(data);
    const thinking = model.thinkingLevel ?? model.effectiveThinkingLevel;
    const context = data.contextUsage;
    const contextPercent = typeof context?.percent === "number" && Number.isFinite(context.percent) ? context.percent : null;
    // The values are omp's own (set_steering_mode, set_follow_up_mode, set_interrupt_mode); only the words are ours.
    const messageChoices: readonly Omit<ChoiceFieldProps, "disabled" | "readOnly">[] = [
      {
        testId: "setting-steering",
        label: "Messages sent while it works",
        help: "When you send several before it picks them up.",
        options: DELIVERY_OPTIONS,
        value: data.steeringMode,
        onChange: (v) => void mutate("steering", () => api().setSteeringMode(sessionPath!, v as "all" | "one-at-a-time")),
      },
      {
        testId: "setting-follow-up",
        label: "Messages queued for after it finishes",
        options: DELIVERY_OPTIONS,
        value: data.followUpMode,
        onChange: (v) => void mutate("followUp", () => api().setFollowUpMode(sessionPath!, v as "all" | "one-at-a-time")),
      },
      {
        testId: "setting-interrupt",
        label: "When you send a message mid-task",
        help: "Interrupt asks running tools to step aside. Wait lets the current step finish.",
        options: INTERRUPT_OPTIONS,
        value: data.interruptMode,
        onChange: (v) => void mutate("interrupt", () => api().setInterruptMode(sessionPath!, v as "immediate" | "wait")),
      },
    ];
    body = (
      <div className="space-y-4">
        {ownershipInfo ? (
          <Notice tone="warning" action={onNeedCollab ? { label: "Connect with /collab", onClick: onNeedCollab } : leaving(errorRecoveryAction(ownershipInfo))}>{ownershipInfo}</Notice>
        ) : null}
        {error ? <Notice tone="danger" action={leaving(errorRecoveryAction(error))} onDismiss={() => setError(null)}>{error}</Notice> : null}
        {compactSnapshot.phase ? (
          <Notice tone={compactSnapshot.phase.kind === "done" ? "success" : compactSnapshot.phase.kind === "failed" ? "danger" : "info"} testId="settings-compact-outcome">
            {compactSnapshot.phase.kind === "done" ? (
              compactSnapshot.phase.reply !== null && typeof compactSnapshot.phase.reply === "object" && "tokensBefore" in compactSnapshot.phase.reply
                ? `Compacted. ${String(compactSnapshot.phase.reply.tokensBefore)} tokens before.`
                : "Compacted."
            ) : compactSnapshot.phase.kind === "refused" ? compactSnapshot.phase.text
              : compactSnapshot.phase.kind === "uncertain" ? "Checking whether compaction finished…"
                : compactSnapshot.phase.kind === "running" ? "Compacting context…" : humanizeDaemonError(compactSnapshot.phase.error)}
          </Notice>
        ) : null}

        <RowGroup title="Model & thinking">
          <Row
            testId="settings-model"
            leading={<SparklesIcon />}
            title={shortModel(model.model) || "Model not reported"}
            subtitle={[model.provider, thinking ? `Thinking ${thinking}` : ""].filter(Boolean).join(" · ") || undefined}
            chevron={Boolean(onOpenModelPicker)}
            onClick={onOpenModelPicker ? () => { onOpenChange(false); onOpenModelPicker(); } : undefined}
          />
        </RowGroup>

        <RowGroup title="Context" footer="Compacting summarises older messages to free up space.">
          {contextPercent !== null ? (
            <div className="flex items-center gap-4 px-4 py-3" data-testid="settings-context">
              <ContextRing percent={contextPercent} />
              <span className="flex min-w-0 flex-col">
                <span className="text-ui font-medium text-foreground">
                  {contextPercent >= 90 ? "Nearly full" : contextPercent >= 70 ? "Filling up" : "Plenty of room"}
                </span>
                <span className="text-meta tabular-nums text-muted-foreground">
                  {context?.tokens !== undefined && context.contextWindow
                    ? `${formatTokens(context.tokens)} of ${formatTokens(context.contextWindow)} tokens`
                    : "Of the model’s context window"}
                </span>
              </span>
            </div>
          ) : (
            <p className="px-4 py-3 text-meta text-muted-foreground" data-testid="settings-context">Context use isn’t reported yet.</p>
          )}
          {/* Confirmed in place: a sheet over this sheet is the stacking the design rules forbid. */}
          {compactConfirm ? (
            <div className="flex flex-col gap-3 px-4 py-3" data-testid="settings-compact-confirm">
              <span className="flex flex-col gap-0.5">
                <span className="text-ui text-foreground">Compact this chat?</span>
                <span className="text-meta text-muted-foreground">Older messages become a summary. This can’t be undone.</span>
              </span>
              <span className="flex gap-2">
                <Button variant="secondary" className="min-h-11 flex-1" onClick={() => setCompactConfirm(false)} disabled={compactBusy}>Cancel</Button>
                <Button variant="danger" className="min-h-11 flex-1" onClick={() => void handleCompact()} disabled={busy}>Compact</Button>
              </span>
            </div>
          ) : (
            <Row leading={<Minimize2Icon />} title="Compact now" onClick={() => setCompactConfirm(true)} disabled={busy} />
          )}
        </RowGroup>

        <RowGroup title="Messages" footer={readOnly ? "These are set on your computer." : undefined}>
          {messageChoices.map((choice) => (
            <ChoiceField key={choice.testId} {...choice} disabled={busy} readOnly={readOnly} />
          ))}
        </RowGroup>

        <RowGroup title="Behaviour">
          {onSetPlanMode ? (
            <SwitchRow id="plan-mode" label="Plan mode" help="Plan first; nothing changes until you approve">
              <Switch
                id="plan-mode"
                data-testid="plan-mode-switch"
                checked={Boolean(planMode)}
                onCheckedChange={(checked) => void mutate("plan", async () => { await onSetPlanMode(checked); })}
                disabled={busy}
              />
            </SwitchRow>
          ) : null}
          <SwitchRow id="fast-mode" label="Fast mode" help="Faster service tier; same model and thinking">
            <Switch
              id="fast-mode"
              checked={Boolean(data.fastModeEnabled)}
              onCheckedChange={(checked) => void mutate("fast", () => api().setFastMode(sessionPath!, checked), { fastMode: checked })}
              disabled={busy}
            />
          </SwitchRow>
          {/* Only models with a flex or low-priority tier have `/slow`. */}
          {data.slowModeSupported === true ? (
            <SwitchRow id="slow-mode" label="Slow mode" help={data.slowModeScope === "global" ? "Cheaper, slower replies · all chats" : "Cheaper, slower replies"}>
              <Switch
                id="slow-mode"
                checked={data.slowModeEnabled === true}
                onCheckedChange={(checked) => void mutate("slow", async () => { await api().rpc(sessionPath!, "set_slow_mode", { enabled: checked }); })}
                disabled={busy}
              />
            </SwitchRow>
          ) : null}
          <SwitchRow id="auto-compact" label="Auto-compaction" help="Summarises automatically when the window fills">
            <Switch
              id="auto-compact"
              checked={Boolean(data.autoCompactionEnabled)}
              onCheckedChange={(checked) => void mutate("autoCompact", () => api().setAutoCompaction(sessionPath!, checked))}
              disabled={busy}
            />
          </SwitchRow>
          {/* A session that does not report auto-retry cannot show its state
              truthfully, so the switch is left out rather than shown greyed. */}
          {typeof data.autoRetryEnabled === "boolean" ? (
            <SwitchRow id="auto-retry" label="Auto-retry" help="Retries failed requests automatically">
              <Switch
                id="auto-retry"
                checked={data.autoRetryEnabled}
                onCheckedChange={(checked) => void mutate("autoRetry", () => api().setAutoRetry(sessionPath!, checked))}
                disabled={busy}
              />
            </SwitchRow>
          ) : null}
          {sessionPath ? <ChatNotificationsRow sessionPath={sessionPath} /> : null}
        </RowGroup>
      </div>
    );
  }

  return (
    <BottomSheet open={open} onOpenChange={(next) => {
      if (!next) { view.current.open = false; invalidate(); }
      onOpenChange(next);
    }} title="Session settings" description={project ?? undefined} testId="session-settings-sheet">
      {body}
    </BottomSheet>
  );
}
