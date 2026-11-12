"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo, useRef, useState, type JSX } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { readPairingToken } from "../../platform/browser-storage";
import type { ModelInfo } from "../../runtime/api-types";
import type { OmpStoreApi, SessionModel } from "../../runtime/omp-store";
import { DaemonApi } from "../../runtime/rpc-client";
import { useBackLayer } from "../back-layer";
import { shortModel } from "../session-format";
import { modelKey, rememberRecentModel, useModelCatalogue } from "../sessions/ModelPicker";
import {
  findSessionModel,
  levelAfterModelSwitch,
  modelChipLabel,
  thinkingButtonLabel,
  thinkingChoices,
} from "../sessions/thinking-levels";
import { useStoreValue } from "../store-hooks";
import { contextFill } from "../ui/ContextMeter";
import { ContextRing } from "../ui/ContextRing";
import { ProviderLogo } from "../ui/ProviderLogo";

// 36px chip; the pseudo-element stretches the hit area to 44px.
const CHIP = "press-bounce relative inline-flex h-9 min-w-9 shrink-0 items-center gap-1.5 rounded-full px-2 text-ui font-medium outline-none after:absolute after:-inset-y-1 after:inset-x-0 focus-visible:ring-2 focus-visible:ring-ring";
// The popover lists the models in use lately, not the whole catalogue: "All models…" is the rest.
const POPOVER_MODELS = 5;

/**
 * The model chip ("GPT 6 Astra · High") and its lightweight popover: recent
 * models, the thinking level, and a way into the full picker. Selecting goes
 * through the same RPCs and store patch as ModelPicker, so the two agree.
 */
export function ModelChip({
  store,
  sessionPath,
  fallbackModel,
  onOpenModelPicker,
  onModelChanged,
}: {
  store: OmpStoreApi;
  sessionPath: string | null;
  /** The listing row's model, for a cold open before the session state arrives. */
  fallbackModel?: string | null;
  onOpenModelPicker?: () => void;
  /** After a model switch the daemon accepted, so the transcript can show it. */
  onModelChanged?: () => void;
}): JSX.Element | null {
  const held = useStoreValue(store, (s) => s.sessionModel);
  const model = held?.model ?? fallbackModel ?? undefined;
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  // The catalogue is read only while the popover is open.
  const catalogue = useModelCatalogue(sessionPath, open);
  useBackLayer(open, { onBack: () => setOpen(false) });

  const info = useMemo(() => findSessionModel(catalogue.models, model, held?.provider), [catalogue.models, model, held?.provider]);
  const shown = useMemo(() => {
    const byKey = new Map(catalogue.models.map((m) => [modelKey(m), m]));
    const picked: ModelInfo[] = [];
    // One row per name: the same model through two providers read as a
    // duplicate here; the full picker (All models…) tells them apart.
    const names = new Set<string>();
    const add = (entry: ModelInfo | undefined) => {
      if (!entry || picked.includes(entry) || names.has(shortModel(entry.id))) return;
      names.add(shortModel(entry.id));
      picked.push(entry);
    };
    add(info);
    for (const key of catalogue.recent) add(byKey.get(key));
    // No history at all: the catalogue's own order is the best guess.
    for (const entry of catalogue.models) if (picked.length < POPOVER_MODELS) add(entry);
    return picked.slice(0, POPOVER_MODELS);
  }, [catalogue.models, catalogue.recent, info]);

  if (!model || !onOpenModelPicker) return null;
  const choices = thinkingChoices(info);
  const level = held?.thinkingLevel && held.thinkingLevel !== "inherit" ? held.thinkingLevel : held?.effectiveThinkingLevel ?? "";
  const label = modelChipLabel(model, level);

  // INVARIANT: a result only patches the store while its conversation is still
  // the open one; a slow answer must not rename the chip of a chat opened since.
  const apply = (request: (api: DaemonApi, path: string) => Promise<void>, patch: Partial<SessionModel>, remember?: string): void => {
    if (!sessionPath || pending.current) return;
    const path = sessionPath;
    pending.current = true;
    setFailed(false);
    request(new DaemonApi(readPairingToken()), path).then(
      () => {
        if (store.getState().sessionPath !== path) return;
        store.getState().setSessionModel(patch);
        if (remember) { rememberRecentModel(remember); onModelChanged?.(); }
      },
      () => setFailed(true),
    ).finally(() => { pending.current = false; });
  };
  const chooseModel = (next: ModelInfo): void => {
    if (info && modelKey(next) === modelKey(info)) return;
    apply(
      (api, path) => api.setModel(path, next.provider, next.id),
      { model: next.id, provider: next.provider, thinkingLevel: levelAfterModelSwitch(next, held?.thinkingLevel), contextWindow: next.contextWindow },
      modelKey(next),
    );
  };
  const chooseLevel = (next: string): void => {
    if (next === held?.thinkingLevel) return;
    apply((api, path) => api.setThinkingLevel(path, next), { thinkingLevel: next });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-testid="composer-model"
            data-level={level || undefined}
            aria-label={`Model: ${label}. Change model`}
            title={failed ? "Couldn’t change the model" : undefined}
            className={cn(CHIP, "min-w-0 shrink text-foreground", failed && "text-danger")}
          />
        }
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={10} className="w-72" data-testid="composer-model-menu">
        {catalogue.loading && shown.length === 0 ? (
          <p className="px-3 py-3 text-meta text-muted-foreground" role="status">Loading models…</p>
        ) : null}
        {shown.map((entry) => (
          <DropdownMenuItem
            key={modelKey(entry)}
            data-testid="composer-model-option"
            data-model={entry.id}
            onClick={() => chooseModel(entry)}
          >
            <ProviderLogo model={entry.id} provider={entry.provider} className="size-5" />
            <span className="min-w-0 flex-1 truncate">{shortModel(entry.id)}</span>
            {entry === info ? <CheckIcon aria-hidden className="size-5 shrink-0" /> : null}
          </DropdownMenuItem>
        ))}
        {choices.length > 0 ? (
          <div role="group" aria-label="Thinking" data-testid="composer-thinking" data-level={level} className="px-1 pb-1 pt-2">
            {/* A plain label: Base UI's GroupLabel throws outside a Menu.Group, and these pills are not menu items. */}
            <p className="px-2 pb-1.5 text-meta text-muted-foreground">Thinking</p>
            <div className="flex flex-wrap gap-1.5">
              {choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  data-testid="composer-thinking-option"
                  data-value={choice}
                  aria-pressed={choice === held?.thinkingLevel}
                  onClick={() => chooseLevel(choice)}
                  className={cn(
                    "press-bounce relative h-9 rounded-full px-3.5 text-meta font-medium outline-none after:absolute after:-inset-y-1 after:inset-x-0 focus-visible:ring-2 focus-visible:ring-ring",
                    choice === held?.thinkingLevel ? "bg-foreground text-background" : "bg-surface-3 text-foreground",
                  )}
                >
                  {thinkingButtonLabel(choice)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <DropdownMenuItem data-testid="composer-model-all" onClick={onOpenModelPicker} className="mt-1 text-muted-foreground">
          <span className="flex-1">All models…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The context ring: how full the window is. Tap for Usage, which holds the numbers behind it. */
export function ContextChip({ percent, onOpen }: { percent: number | null | undefined; onOpen?: () => void }): JSX.Element | null {
  if (percent == null || !onOpen) return null;
  const rounded = Math.round(percent);
  return (
    <button
      type="button"
      data-testid="composer-context"
      aria-label={`Context ${rounded}% full. Open usage`}
      onClick={onOpen}
      // A ring and a short figure can be under 44px wide; the hit area grows sideways too.
      className={cn(CHIP, "shrink-0 text-meta after:-inset-x-1", contextFill(rounded).tone)}
    >
      <ContextRing percent={rounded} compact />
      <span className="tabular-nums @max-[25.5rem]:hidden">{rounded}%</span>
    </button>
  );
}
