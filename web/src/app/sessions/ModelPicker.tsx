import { BoxIcon, CheckIcon, PlusIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ContextMeter } from "../ui/ContextMeter";
import { Switch } from "@/components/ui/switch";
import { BottomSheet, SheetSearch } from "../ui/Sheet";
import { Notice } from "../ui/Notice";
import { Row, RowGroup, RowSkeleton } from "../ui/Row";
import { Segmented } from "../ui/Segmented";
import { daemonErrorCause, humanizeDaemonError } from "../ui/OwnedBySession";
import { errorRecoveryAction } from "../ui/error-recovery";
import { openSettingsPage } from "../nav/panels";
import { shortModel } from "../session-format";
import { ProviderLogo } from "../ui/ProviderLogo";
import { readPairingToken } from "../../platform/browser-storage";
import { DaemonApi, isOwnershipError } from "../../runtime/rpc-client";
import { parsePassiveSessionModel, rememberContextWindows, type SessionModel } from "../../runtime/omp-store";
import type { ModelInfo } from "../../runtime/api-types";
import { compareByRelease } from "./model-order";
import { levelAfterModelSwitch, thinkingButtonLabel, thinkingChoices } from "./thinking-levels";
import { ScreenActivityContext } from "../nav/screen-activity";

const RECENT_KEY = "omp-recent-models";
// How long the catalogue may load before the sheet admits it is stuck. The
// request itself is untouched; this only stops the loading rows from
// standing in forever with no way out.
const LOAD_PATIENCE_MS = 6_000;

export function modelKey(model: ModelInfo): string { return `${model.provider}/${model.id}`; }
function normalize(id: string): string {
  return id.split("/").at(-1)!.toLowerCase().replace(/[-_]?20\d{6}$/, "").replace(/[-_](latest|preview|stable)$/, "").replace(/[^a-z0-9]/g, "");
}
function isCurrent(model: ModelInfo, current: SessionModel): boolean {
  if (!current.model) return false;
  const slash = current.model.indexOf("/");
  const provider = current.provider || (slash > 0 ? current.model.slice(0, slash) : "");
  return (!provider || provider === model.provider) && (normalize(model.id) === normalize(current.model) || (!!model.name && normalize(model.name) === normalize(current.model)));
}
function modelLabelKey(model: ModelInfo): string { return `${model.provider}\u0000${shortModel(model.name || model.id)}`; }
function recentKeys(): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  } catch { return []; }
}
/** Local most-recently-used fallback for when the computer reports no model history. */
export function rememberRecentModel(key: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...recentKeys().filter((value) => value !== key)].slice(0, 5))); } catch { /* Storage may be unavailable in a private WebView. */ }
}

/** "200K", "1M": context windows are always round thousands or millions. */
export function formatContextWindow(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.max(1, Math.round(tokens / 1000))}K`;
}

export type ModelChoice = { model: ModelInfo; thinkingLevel: string };

export type ModelCatalogue = {
  models: ModelInfo[];
  /** `provider/id` keys, most recently used first. */
  recent: string[];
  loading: boolean;
  /** Still loading after LOAD_PATIENCE_MS: the sheet stops pretending it is about to answer. */
  stalled: boolean;
  error: unknown;
  /** Ask again after a failed or stalled load. */
  retry: () => void;
};

const EMPTY_CATALOGUE: Omit<ModelCatalogue, "retry"> = { models: [], recent: [], loading: false, stalled: false, error: null };

/**
 * The model catalogue as seen from `sessionPath`. The daemon answers it from a
 * short-lived child in that session's cwd (project model config lives there),
 * so any listed session works, including one the computer has open. Without a
 * session there is nothing to ask: the catalogue stays empty.
 */
export function useModelCatalogue(sessionPath: string | null, enabled: boolean): ModelCatalogue {
  const active = useContext(ScreenActivityContext);
  const [catalogue, setCatalogue] = useState<Omit<ModelCatalogue, "retry">>(EMPTY_CATALOGUE);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || !active) return;
    if (!sessionPath) { setCatalogue(EMPTY_CATALOGUE); return; }
    setCatalogue({ ...EMPTY_CATALOGUE, loading: true });
    let cancelled = false;
    const api = new DaemonApi(readPairingToken());
    void Promise.all([
      api.getAvailableModels(sessionPath).then(
        (models) => {
          // The catalogue knows every model's window: remember them all so the
          // header can show how full ANY conversation is.
          rememberContextWindows(models);
          return { models, error: null as unknown };
        },
        (error: unknown) => ({ models: [] as ModelInfo[], error }),
      ),
      api.getRecentModels().catch(() => [] as string[]),
    ]).then(([result, recent]) => {
      if (!cancelled) setCatalogue({ models: result.models, error: result.error, recent: recent.length ? recent : recentKeys(), loading: false, stalled: false });
    });
    return () => { cancelled = true; };
    // Returning from connection/provider setup is a new read, not a new draft.
    // Ordinary renders and opening the already-enabled draft picker stay deduped.
  }, [active, enabled, sessionPath, attempt]);
  useEffect(() => {
    if (!active || !catalogue.loading) return;
    const timer = window.setTimeout(() => setCatalogue((previous) => (previous.loading ? { ...previous, stalled: true } : previous)), LOAD_PATIENCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, catalogue.loading, attempt]);
  return useMemo(() => ({ ...catalogue, retry }), [catalogue, retry]);
}

type Group = { key: string; title: string; models: ModelInfo[]; byProvider: boolean };

// Brand casing for the providers omp ships; anything else is title-cased
// from its id ("my-proxy" → "My Proxy").
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  google: "Google",
  "google-vertex": "Google Vertex",
  "github-copilot": "GitHub Copilot",
  "google-gemini-cli": "Gemini",
  "google-antigravity": "Antigravity",
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai": "Azure OpenAI",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  xai: "xAI",
  groq: "Groq",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  cerebras: "Cerebras",
  zai: "Z.ai",
  ollama: "Ollama",
};

// Brand words inside ids omp may add later ("chatgpt-web", "opencode-zen").
const BRAND_WORD: Record<string, string> = { chatgpt: "ChatGPT", opencode: "OpenCode", openai: "OpenAI", github: "GitHub", xai: "xAI" };

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider.split(/[-_\s]+/).filter(Boolean).map((word) => BRAND_WORD[word.toLowerCase()] ?? word[0].toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Current first, then omp's own most-recently-used order (the list the
 * terminal selector opens on), then every provider alphabetically with its
 * models newest release first. Catalogue order is oldest-first, which buried
 * the current models under 2024 releases. Each model appears once.
 */
function groupModels(models: readonly ModelInfo[], recent: readonly string[], selected: ModelInfo | undefined, query: string): Group[] {
  const search = query.trim().toLowerCase();
  // The provider's display name too: people type "GitHub Copilot", not "github-copilot".
  const visible = models.filter((model) => !search || `${shortModel(model.name || model.id)} ${model.id} ${model.provider} ${providerLabel(model.provider)}`.toLowerCase().includes(search));
  const groups: Group[] = [];
  if (selected && visible.includes(selected)) groups.push({ key: "current", title: "Current", models: [selected], byProvider: false });
  const recentModels = recent
    .map((key) => visible.find((model) => model !== selected && modelKey(model) === key))
    .filter((model): model is ModelInfo => !!model);
  if (recentModels.length) groups.push({ key: "recent", title: "Recent", models: recentModels, byProvider: false });
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of visible) {
    if (model === selected || recentModels.includes(model)) continue;
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  for (const provider of [...byProvider.keys()].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)))) {
    groups.push({ key: `provider:${provider}`, title: providerLabel(provider), models: byProvider.get(provider)!.sort(compareByRelease), byProvider: true });
  }
  return groups;
}

// Group titles stay pinned while their rows scroll under them.
const STICKY_TITLE = "[&>h2]:sticky [&>h2]:top-0 [&>h2]:z-raised [&>h2]:bg-surface-1 [&>h2]:pt-2";

const SHORT_LEVEL: Record<string, string> = { minimal: "Min", medium: "Med", xhigh: "XHigh" };

function ModelSheet({
  open,
  onOpenChange,
  models,
  recent,
  loading,
  stalled,
  onRetry,
  selected,
  thinkingLevel,
  effectiveThinkingLevel,
  disabled,
  notice,
  empty,
  onSelectModel,
  onSelectLevel,
  usage,
  trailingFooter,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: readonly ModelInfo[];
  recent: readonly string[];
  loading: boolean;
  /** Loading has outlasted LOAD_PATIENCE_MS. */
  stalled: boolean;
  /** Ask for the catalogue again (a stalled or failed load). */
  onRetry: () => void;
  selected: ModelInfo | undefined;
  thinkingLevel: string | undefined;
  effectiveThinkingLevel?: string;
  disabled: boolean;
  notice?: ReactNode;
  /** Shown instead of the list when there is no catalogue at all. */
  empty: ReactNode;
  onSelectModel: (model: ModelInfo) => void;
  onSelectLevel: (level: string) => void;
  /** The open session's context fill; absent for an unsaved choice. */
  usage?: { percent: number; windowTokens?: number };
  trailingFooter?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);
  // Hold the open height while a search narrows the list: a sheet that shrinks
  // under each keystroke moves the field the reader is typing in.
  const listRef = useRef<HTMLDivElement>(null);
  const [heldHeight, setHeldHeight] = useState<number | null>(null);
  const searching = query.trim() !== "";
  useLayoutEffect(() => {
    if (!searching) setHeldHeight(null);
    else if (heldHeight === null && listRef.current) setHeldHeight(listRef.current.offsetHeight);
  }, [searching, heldHeight]);
  const groups = useMemo(() => groupModels(models, recent, selected, query), [models, recent, selected, query]);
  // Detect ambiguity against the whole catalogue so narrowing the search does
  // not make the exact version disappear from the one remaining result.
  const ambiguous = useMemo(() => {
    const ids = new Map<string, Set<string>>();
    for (const model of models) {
      const key = modelLabelKey(model);
      const versions = ids.get(key) ?? new Set<string>();
      versions.add(model.id);
      ids.set(key, versions);
    }
    return new Set([...ids].filter(([, versions]) => versions.size > 1).map(([key]) => key));
  }, [models]);
  // Reasoning controls belong to the model: offer exactly its ladder.
  const levels = useMemo(() => thinkingChoices(selected), [selected]);

  let body: ReactNode;
  if (loading && stalled && models.length === 0) {
    // A stuck catalogue gets words and a way out.
    body = (
      <Notice tone="info" action={{ label: "Retry", icon: RotateCwIcon, onClick: onRetry }} testId="model-load-failed">
        Models are taking longer than usual.
      </Notice>
    );
  } else if (loading) {
    body = <RowGroup>{[0, 1, 2, 3].map((index) => <RowSkeleton key={index} subtitle />)}</RowGroup>;
  } else if (models.length === 0) {
    body = empty;
  } else if (groups.length === 0) {
    body = (
      <Notice tone="info" icon={SearchIcon} action={{ label: "Clear search", onClick: () => setQuery("") }}>
        No matching models.
      </Notice>
    );
  } else {
    body = groups.map((group) => (
      <RowGroup key={group.key} title={group.title} className={STICKY_TITLE} testId={`model-group-${group.key}`}>
        {group.models.map((model) => {
          const key = modelKey(model);
          const name = shortModel(model.name || model.id);
          const checked = model === selected;
          const context = formatContextWindow(model.contextWindow);
          // Under a provider title the provider is already said; Current and
          // Recent mix providers, so their rows name it.
          const facts = [
            group.byProvider ? null : <span key="provider" data-testid="model-provider">{providerLabel(model.provider)}</span>,
            context ? `${context} context` : null,
            ambiguous.has(modelLabelKey(model)) ? <span key="id" data-testid="model-exact-id">{model.id}</span> : null,
          ].filter((fact) => fact !== null);
          return (
            <Row
              key={key}
              testId="model-item"
              data-model={key}
              data-current={checked ? "true" : undefined}
              aria-pressed={checked}
              aria-label={`${name} · ${key}`}
              disabled={disabled}
              onClick={() => onSelectModel(model)}
              // The maker, not the host: one provider group (Kilo, Zenmux, Copilot) mixes many makers.
              leading={<ProviderLogo model={model.id} provider={model.provider} className="size-5" />}
              title={<span data-testid="model-name">{name}</span>}
              subtitle={facts.length ? facts.map((fact, index) => <Fragment key={index}>{index > 0 ? " · " : ""}{fact}</Fragment>) : undefined}
              trailing={checked ? <CheckIcon data-testid="model-current-check" aria-hidden className="size-5 text-primary-text" /> : null}
            />
          );
        })}
      </RowGroup>
    ));
  }

  const selectedContext = formatContextWindow(selected?.contextWindow);
  const windowTokens = usage?.windowTokens ?? selected?.contextWindow;
  const footer = selected || trailingFooter ? (
    <div className="space-y-3">
      {levels.length > 0 ? (
        <div className="space-y-1.5">
          <p aria-hidden className="text-meta text-muted-foreground">Thinking</p>
          <Segmented
            aria-label="Thinking"
            testId="model-thinking"
            // Six efforts plus Off leave ~50px a segment on a phone: full words
            // would be cut, so long ladders show short ones and keep the full
            // word for screen readers.
            className={levels.length > 5 ? "[&>button]:px-1" : undefined}
            options={levels.map((level) => ({
              value: level,
              disabled,
              label: levels.length > 5 && SHORT_LEVEL[level] ? (
                <>
                  <span aria-hidden>{SHORT_LEVEL[level]}</span>
                  <span className="sr-only">{thinkingButtonLabel(level)}</span>
                </>
              ) : thinkingButtonLabel(level),
            }))}
            value={thinkingLevel && levels.includes(thinkingLevel) ? thinkingLevel : ""}
            onChange={onSelectLevel}
          />
          {thinkingLevel === "auto" ? (
            <p data-testid="model-auto-effort" className="text-meta text-muted-foreground">
              Auto chooses effort each turn{effectiveThinkingLevel ? ` · current effort: ${thinkingButtonLabel(effectiveThinkingLevel)}` : ""}.
            </p>
          ) : null}
        </div>
      ) : null}
      {selected?.thinking?.requiresEffort && levels.length > 0 ? (
        <p className="text-meta text-muted-foreground">This model always thinks. Off uses its lowest effort.</p>
      ) : null}
      {selected && levels.length === 0 ? (
        <p data-testid="model-no-thinking" className="text-meta text-muted-foreground">No thinking levels for {shortModel(selected.name || selected.id)}.</p>
      ) : null}
      {usage ? (
        <ContextMeter
          testId="model-context"
          size="full"
          percent={usage.percent}
          windowTokens={windowTokens}
          usedTokens={windowTokens ? Math.round((usage.percent / 100) * windowTokens) : undefined}
        />
      ) : null}
      {(!usage && selectedContext) || trailingFooter ? (
        <div className="flex min-h-11 items-center justify-between gap-3">
          <p data-testid="model-facts" className="min-w-0 text-meta text-muted-foreground">{!usage && selectedContext ? `Context · ${selectedContext}` : ""}</p>
          {trailingFooter}
        </div>
      ) : null}
    </div>
  ) : undefined;

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      testId="model-picker"
      title="Model"
      subHeader={models.length > 0 ? (
        <div className="px-4 pb-3">
          <SheetSearch value={query} onChange={setQuery} placeholder="Search models" testId="model-search" />
        </div>
      ) : undefined}
      footer={footer}
    >
      <div ref={listRef} className="space-y-4" aria-label="Available models" style={heldHeight !== null ? { minHeight: heldHeight } : undefined}>
        {notice}
        {body}
        {!loading && models.length > 0 ? (
          <RowGroup>
            <Row leading={<PlusIcon aria-hidden />} title="Add a provider" chevron onClick={() => openProviders(onOpenChange)} testId="model-add-provider" />
          </RowGroup>
        ) : null}
      </div>
    </BottomSheet>
  );
}

type SessionProps = {
  /** The session whose model this changes, through the session's own set-model path. */
  sessionPath: string | null;
  currentModelHint?: string | null;
  sessionModelHint?: SessionModel | null;
  onStateChanged?: (state: Partial<SessionModel>) => void;
  onChanged?: (model: string) => void;
  draft?: undefined;
};

type DraftProps = {
  /** An unsaved choice (new session): nothing is applied, the choice is returned. */
  draft: {
    catalogue: ModelCatalogue;
    value: ModelChoice | null;
    onChange: (choice: ModelChoice) => void;
  };
  sessionPath?: undefined;
};

type Props = { open: boolean; onOpenChange: (open: boolean) => void } & (SessionProps | DraftProps);

export function ModelPicker(props: Props) {
  if (props.draft) return <DraftModelPicker open={props.open} onOpenChange={props.onOpenChange} {...props.draft} />;
  return <SessionModelPicker {...props} />;
}

export function ModelLoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = daemonErrorCause(error) === "provider-auth"
    ? "Provider sign-in needed."
    : humanizeDaemonError(error);
  return (
    <Notice tone="danger" action={errorRecoveryAction(error) ?? { label: "Retry", icon: RotateCwIcon, onClick: onRetry }} testId="model-load-failed">
      {message}
    </Notice>
  );
}

/** Providers are added in Settings; a picker with nothing to pick must lead there. */
function openProviders(onOpenChange: (open: boolean) => void): void {
  onOpenChange(false);
  openSettingsPage("providers");
}

function NoModels({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <Notice tone="info" icon={BoxIcon} action={{ label: "Add a provider", icon: PlusIcon, onClick: () => openProviders(onOpenChange) }}>
      No models available.
    </Notice>
  );
}

function DraftModelPicker({
  open,
  onOpenChange,
  catalogue,
  value,
  onChange,
}: { open: boolean; onOpenChange: (open: boolean) => void } & DraftProps["draft"]) {
  const selectedKey = value ? modelKey(value.model) : null;
  const selected = useMemo(() => catalogue.models.find((model) => modelKey(model) === selectedKey), [catalogue.models, selectedKey]);
  return (
    <ModelSheet
      open={open}
      onOpenChange={onOpenChange}
      models={catalogue.models}
      recent={catalogue.recent}
      loading={catalogue.loading}
      stalled={catalogue.stalled}
      onRetry={catalogue.retry}
      selected={selected}
      thinkingLevel={value?.thinkingLevel}
      disabled={false}
      empty={catalogue.error ? <ModelLoadFailure error={catalogue.error} onRetry={catalogue.retry} /> : (
        <NoModels onOpenChange={onOpenChange} />
      )}
      onSelectModel={(model) => onChange({ model, thinkingLevel: levelAfterModelSwitch(model, value?.thinkingLevel) })}
      onSelectLevel={(level) => { if (selected) onChange({ model: selected, thinkingLevel: level }); }}
    />
  );
}

function SessionModelPicker({ open, onOpenChange, sessionPath, currentModelHint, sessionModelHint, onStateChanged, onChanged }: { open: boolean; onOpenChange: (open: boolean) => void } & SessionProps) {
  const catalogue = useModelCatalogue(sessionPath, open);
  const [current, setCurrent] = useState<SessionModel>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ownedByState, setOwnedByState] = useState(false);
  const mutationEpoch = useRef(0);
  const mutationPending = useRef(false);
  const propsRef = useRef({ sessionPath, open, currentModelHint, sessionModelHint, onStateChanged, onChanged });
  propsRef.current = { sessionPath, open, currentModelHint, sessionModelHint, onStateChanged, onChanged };

  const cancelMutation = useCallback(() => {
    mutationEpoch.current++;
    mutationPending.current = false;
    setBusy(false);
  }, []);
  useLayoutEffect(() => {
    cancelMutation();
    return cancelMutation;
  }, [open, sessionPath, cancelMutation]);

  useEffect(() => {
    if (!open || !sessionPath) return;
    const hint = propsRef.current;
    setCurrent({ model: hint.currentModelHint ?? undefined, ...hint.sessionModelHint });
    setError(null);
    setOwnedByState(false);
    let cancelled = false;
    const api = new DaemonApi(readPairingToken());
    void api.getState(sessionPath, { peek: true }).then((state) => {
      if (cancelled) return;
      const parsed = parsePassiveSessionModel(state, propsRef.current.sessionModelHint ?? undefined);
      setCurrent((previous) => ({ ...previous, ...parsed }));
      propsRef.current.onStateChanged?.(parsed);
    }).catch((e: unknown) => {
      if (!cancelled && isOwnershipError(e)) setOwnedByState(true);
    });
    return () => { cancelled = true; };
  }, [open, sessionPath]);

  useEffect(() => {
    if (open && sessionModelHint) setCurrent((previous) => ({ ...previous, ...sessionModelHint }));
  }, [open, sessionModelHint]);

  // Tell the store the window of the model in use: an idle session's state
  // has only its name.
  useEffect(() => {
    const active = catalogue.models.find((model) => isCurrent(model, propsRef.current.sessionModelHint ?? {}));
    if (active?.contextWindow) propsRef.current.onStateChanged?.({ contextWindow: active.contextWindow });
  }, [catalogue.models]);

  // The catalogue lists one model under several providers, and an idle session
  // may know only the bare model name. Exactly ONE row is the current model:
  // the first match in catalogue order (an exact provider match is the only
  // match at all, so it still wins).
  // An exact id (and provider, when known) beats the loose match: dated
  // releases of one model ("…-20240620" / "…-20241022") normalize to the same
  // name, and taking the first loose match marked the wrong release current.
  const currentModel = useMemo(() => {
    const models = catalogue.models;
    const exact = models.find((model) => !!current.model && isCurrent(model, current) && model.id.toLowerCase() === current.model.slice(current.model.lastIndexOf("/") + 1).toLowerCase());
    return exact ?? models.find((model) => isCurrent(model, current));
  }, [catalogue.models, current]);
  const owned = ownedByState || (catalogue.error !== null && isOwnershipError(catalogue.error));
  const unavailable = busy || catalogue.loading || owned || !sessionPath;

  async function mutate(action: (api: DaemonApi, path: string) => Promise<void>, patch: Partial<SessionModel>): Promise<void> {
    if (!sessionPath || !propsRef.current.open || unavailable || mutationPending.current) return;
    const path = sessionPath;
    mutationPending.current = true;
    const epoch = ++mutationEpoch.current;
    const isCurrentMutation = () => mutationEpoch.current === epoch && propsRef.current.open && propsRef.current.sessionPath === path;
    const api = new DaemonApi(readPairingToken());
    setBusy(true);
    setError(null);
    try {
      await action(api, path);
      // An old chat or a closed/reopened picker cannot own this completion.
      if (!isCurrentMutation()) return;
      setCurrent((previous) => ({ ...previous, ...patch }));
      propsRef.current.onStateChanged?.(patch);
      if (patch.model) {
        const key = `${patch.provider}/${patch.model}`;
        rememberRecentModel(key);
        propsRef.current.onChanged?.(key);
      }
      const state = await api.getState(path, { peek: true }).catch(() => null);
      // INVARIANT: a file snapshot never overrides what was just acknowledged. An
      // idle session's peek is read from the session file, and omp has not
      // flushed the change it just made there: adopting that snapshot reverted
      // the choice the reader had just confirmed (pill and sheet snapped back
      // to the previous model). parsePassiveSessionModel lets only a live
      // answer replace known values.
      if (state && isCurrentMutation()) {
        const actual = parsePassiveSessionModel(state, { ...propsRef.current.sessionModelHint, ...patch });
        setCurrent((previous) => ({ ...previous, ...actual }));
        propsRef.current.onStateChanged?.(actual);
      }
    } catch (e: unknown) {
      if (!isCurrentMutation()) return;
      if (isOwnershipError(e)) setOwnedByState(true);
      setError(e);
    } finally {
      if (isCurrentMutation()) { mutationPending.current = false; setBusy(false); }
    }
  }

  const catalogueError = catalogue.error !== null && !owned ? humanizeDaemonError(catalogue.error) : null;
  const fallback = current.modelFallback;
  const notice = (
    <>
      {owned ? (
        <Notice tone="info" action={errorRecoveryAction("session_owned_by_terminal")}>Controlled on your computer.</Notice>
      ) : error || catalogueError && catalogue.models.length > 0 ? (
        <Notice tone="danger" title={catalogueError && !error ? "Couldn’t load models." : "Couldn’t change the model."} action={errorRecoveryAction(error ?? catalogue.error) ?? (catalogueError ? { label: "Retry", icon: RotateCwIcon, onClick: catalogue.retry } : undefined)}>{error ? humanizeDaemonError(error) : catalogueError}</Notice>
      ) : null}
      {fallback ? (
        <Notice tone="info" title="Automatic model fallback" testId="model-fallback">
          <span className="break-words">{fallback.from} → {fallback.to}{fallback.reason ? ` — ${fallback.reason}` : ""}</span>
        </Notice>
      ) : null}
    </>
  );

  return (
    <ModelSheet
      open={open}
      onOpenChange={(value) => {
        if (!value) cancelMutation();
        onOpenChange(value);
      }}
      models={catalogue.models}
      recent={catalogue.recent}
      loading={catalogue.loading}
      stalled={catalogue.stalled}
      onRetry={catalogue.retry}
      selected={currentModel}
      thinkingLevel={current.thinkingLevel}
      effectiveThinkingLevel={current.effectiveThinkingLevel}
      disabled={unavailable}
      notice={notice}
      empty={owned || error ? null : catalogue.error ? (
        <ModelLoadFailure error={catalogue.error} onRetry={catalogue.retry} />
      ) : <NoModels onOpenChange={onOpenChange} />}
      onSelectModel={(model) => void mutate((api, path) => api.setModel(path, model.provider, model.id), { model: model.id, provider: model.provider, thinkingLevel: levelAfterModelSwitch(model, current.thinkingLevel) })}
      onSelectLevel={(level) => void mutate((api, path) => api.setThinkingLevel(path, level), { thinkingLevel: level })}
      usage={current.ctxPercent == null ? undefined : { percent: current.ctxPercent, windowTokens: current.contextWindow }}
      trailingFooter={current.fastMode === undefined ? null : (
        <label className="flex shrink-0 items-center gap-3 text-meta text-muted-foreground">
          {current.fastMode && current.fastModeActive === false ? <span data-testid="fast-mode-inactive">Not available for this model</span> : "Fast mode"}
          <Switch aria-label="Fast mode" checked={current.fastMode} disabled={unavailable} onCheckedChange={(enabled) => void mutate((api, path) => api.setFastMode(path, enabled), { fastMode: enabled })} />
        </label>
      )}
    />
  );
}
