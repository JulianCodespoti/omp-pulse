import { PuzzleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { argvLine, type PluginInfo, type PluginOptionInfo } from "../../domain/plugins";
import { pluginHost } from "../../runtime/plugin-host";
import { showErrorToast } from "../Notices";
import { openPluginPage } from "../nav/panels";
import { EmptyState } from "../ui/EmptyState";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Notice } from "../ui/Notice";
import { Row, RowGroup, RowSkeleton, RowTile } from "../ui/Row";
import { Segmented } from "../ui/Segmented";
import { usePluginHost } from "./use-plugin-host";

const SLOT_LABEL: Record<string, string> = {
  "composer.status": "Above the message box",
  "composer.actions": "Message box plus menu",
  drawer: "Side drawer",
  page: "Its own page",
  workspace: "A tab in the chat's workspace",
  "session.row": "Chat list rows",
  "session.menu": "Conversation menus",
  "transcript.tool": "Tool call cards",
  "transcript.message": "Extension message cards",
};

// Only what a tap lets a plugin do; `session.read` is a "Sees" line, not an action.
// The CLI prints the same words (src/bin/omp-pulse/plugin.rs `permission_text`).
const PERMISSION_LABEL: Record<string, string> = {
  "session.compose": "Put text in the message box",
  "session.prompt": "Send messages to the conversation (skills and prompt templates too)",
  "session.bash": "Run any shell command it chooses on this computer, in the conversation's folder",
  "session.rpc": "Read the whole conversation and change it (settings, rewind, fork, compact)",
};

function statusBadge(plugin: PluginInfo, stopped: boolean): { label: string; tone: string; dot: string } {
  if (stopped) return { label: "Stopped", tone: "bg-warning-tint text-warning", dot: "bg-warning" };
  switch (plugin.status) {
    case "enabled":
      return { label: "On", tone: "border border-hairline bg-surface-2 text-foreground", dot: "bg-success" };
    case "disabled":
      return { label: "Off", tone: "border border-hairline bg-surface-2 text-muted-foreground", dot: "bg-muted-foreground" };
    case "needs_review":
      return { label: plugin.changed ? "Updated" : "Review", tone: "bg-warning-tint text-warning", dot: "bg-warning" };
    case "invalid":
      return { label: "Invalid", tone: "bg-danger-tint text-danger", dot: "bg-danger" };
  }
}

/** Shown wherever plugins are held back by the crash guard; one tap starts them again. */
export function PluginsHaltedNotice(): JSX.Element {
  return (
    <Notice tone="warning" action={{ label: "Start plugins", onClick: () => pluginHost.resume() }}>
      Plugins were stopped because the app did not finish starting last time.
    </Notice>
  );
}

/** Settings › Plugins: what is installed on the computer, what each one does, and the on/off switch. */
export function PluginsSettings(): JSX.Element {
  const { catalog, catalogError, runtimes, haltedAfterCrash } = usePluginHost();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    void pluginHost.refresh();
  }, []);

  // Resolves to whether the call succeeded; a failure is already shown as a toast.
  const track = (id: string, work: Promise<void>): Promise<boolean> => {
    setPending((ids) => new Set(ids).add(id));
    return work
      .then(() => true, (error: unknown) => {
        showErrorToast(error);
        return false;
      })
      .finally(() => {
        setPending((ids) => {
          const next = new Set(ids);
          next.delete(id);
          return next;
        });
      });
  };
  const decide = (id: string, enabled: boolean, hash?: string): void => void track(id, pluginHost.setEnabled(id, enabled, hash));

  let body: JSX.Element;
  if (catalog === null) {
    body = catalogError ? (
      <ErrorNotice message={catalogError} onRetry={() => void pluginHost.refresh()} />
    ) : (
      <RowGroup inset>
        <RowSkeleton leading />
        <RowSkeleton leading />
      </RowGroup>
    );
  } else if (catalogError) {
    body = <ErrorNotice message={catalogError} onRetry={() => void pluginHost.refresh()} />;
  } else if (catalog.length === 0) {
    body = (
      <EmptyState
        testId="plugins-empty"
        icon={<PuzzleIcon />}
        title="No plugins yet"
        description="Plugins are folders on the computer running omp-pulse. Add one there with omp-pulse plugin link <folder>."
      />
    );
  } else {
    body = (
      <>
        {haltedAfterCrash ? <PluginsHaltedNotice /> : null}
        {catalog.map((plugin) => {
          const busy = pending.has(plugin.id);
          const failure = runtimes[plugin.id]?.state === "failed" ? runtimes[plugin.id]?.error : undefined;
          const valid = plugin.status !== "invalid";
          const canEnable = plugin.status === "needs_review" || plugin.status === "disabled";
          const stopped = failure !== undefined && plugin.status === "enabled";
          const badge = statusBadge(plugin, stopped);
          const subtitle = stopped
            ? "Stopped on this phone"
            : plugin.status === "needs_review"
              ? plugin.changed
                ? "Changed since you turned it on. Review it again"
                : "New. Review it before turning it on"
              : plugin.status === "invalid"
                ? `Cannot load: ${plugin.error ?? "unknown error"}`
                : undefined;
          const hasActions = canEnable || plugin.status === "enabled";
          return (
            <div key={plugin.id} data-testid="plugin-row" data-plugin={plugin.id} data-status={plugin.status} data-changed={plugin.status === "needs_review" && plugin.changed ? "true" : undefined} className="flex min-w-0 flex-col gap-2.5">
              <RowGroup inset>
                <Row
                  leadingSize="tile"
                  leading={
                    <RowTile size="md" tone="page">
                      <PuzzleIcon
                        aria-hidden
                        className={cn(
                          "size-4.5",
                          plugin.status === "enabled" && !stopped
                            ? "text-primary-text"
                            : plugin.status === "invalid"
                              ? "text-danger"
                              : plugin.status === "needs_review" || stopped
                                ? "text-warning"
                                : "text-muted-foreground",
                        )}
                      />
                    </RowTile>
                  }
                  title={
                    <span className="inline-flex max-w-full items-baseline gap-1.5">
                      <span className="truncate font-medium">{plugin.name}</span>
                      {plugin.version ? <span className="shrink-0 font-mono text-code text-muted-foreground">{plugin.version}</span> : null}
                    </span>
                  }
                  subtitle={subtitle}
                  trailing={
                    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-code font-medium", badge.tone)}>
                      <span aria-hidden className={cn("size-1.5 rounded-full", badge.dot)} />
                      {badge.label}
                    </span>
                  }
                />
                {valid ? (
                  <div className="flex min-w-0 flex-col gap-3 px-4 py-3.5 text-meta text-muted-foreground">
                    {plugin.description ? <p className="break-words text-ui text-foreground/90">{plugin.description}</p> : null}
                    <p>
                      <span className="font-medium text-foreground">Shows: </span>
                      {plugin.slots.map((slot) => SLOT_LABEL[slot] ?? slot).join(", ")}
                    </p>
                    <div>
                      <span className="font-medium text-foreground">Runs on the computer: </span>
                      {plugin.sources.length === 0 ? (
                        "Runs no commands on the computer"
                      ) : (
                        <ul className="mt-1.5 flex flex-col gap-1.5">
                          {plugin.sources.map((source) => (
                            <li key={source.id} className="min-w-0 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5">
                              <code className="break-words font-mono text-code text-foreground [overflow-wrap:anywhere]">{argvLine(source.command)}</code>{" "}
                              <span className="whitespace-nowrap text-code text-muted-foreground">· every {source.intervalS} s</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {plugin.warnings.length > 0 ? (
                      <ul data-testid="plugin-review-warnings" className="flex flex-col gap-1 border-l-2 border-warning pl-3 text-warning">
                        {plugin.warnings.map((warning) => (
                          <li key={warning} className="break-words">{warning}</li>
                        ))}
                      </ul>
                    ) : null}
                    {plugin.slots.some((slot) => slot === "session.row" || slot === "session.menu") || plugin.permissions.includes("session.read") || plugin.tools.length > 0 || plugin.messages.length > 0 ? (
                      <div data-testid="plugin-review-sees">
                        <span className="font-medium text-foreground">Sees: </span>
                        <ul className="mt-1 flex flex-col gap-1">
                          {plugin.slots.some((slot) => slot === "session.row" || slot === "session.menu") ? <li>Conversation titles, folders and models</li> : null}
                          {plugin.permissions.includes("session.read") ? <li>The open conversation&apos;s title, folder and model</li> : null}
                          {plugin.tools.length > 0 ? <li>Calls to tools matching {plugin.tools.join(", ")}: arguments and output</li> : null}
                          {plugin.messages.length > 0 ? <li>Extension messages of type {plugin.messages.join(", ")}</li> : null}
                        </ul>
                      </div>
                    ) : null}
                    {plugin.permissions.some((permission) => permission !== "session.read") ? (
                      <div data-testid="plugin-review-can">
                        <span className="font-medium text-foreground">Can, when you tap: </span>
                        <ul className="mt-1 flex flex-col gap-1">
                          {plugin.permissions.filter((permission) => permission !== "session.read").map((permission) => (
                            <li key={permission}>{PERMISSION_LABEL[permission] ?? permission}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {plugin.actions.length > 0 ? (
                      <div data-testid="plugin-review-actions">
                        <span className="font-medium text-foreground">On a tap, may run on the computer: </span>
                        <ul className="mt-1.5 flex flex-col gap-1.5">
                          {plugin.actions.map((action) => (
                            <li key={action.id} className="min-w-0 rounded-md border border-hairline bg-surface-2 px-2.5 py-1.5">
                              <span className="text-foreground">{action.label}: </span>
                              <code className="break-words font-mono text-code text-foreground [overflow-wrap:anywhere]">{argvLine(action.command)}</code>
                              {action.argPattern ? <span className="text-code text-muted-foreground"> ({"{arg}"} must match <code className="break-words font-mono text-foreground [overflow-wrap:anywhere]">{action.argPattern}</code>)</span> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {valid && plugin.options.length > 0 ? (
                  <div className="flex min-w-0 flex-col divide-y divide-hairline">
                    <h3 className="bg-surface-2/50 px-4 py-2 text-meta font-medium text-muted-foreground">Options</h3>
                    {plugin.options.map((option) => (
                      <OptionControl
                        key={option.id}
                        option={option}
                        value={plugin.optionValues[option.id] ?? option.default}
                        disabled={busy}
                        onSave={(value) => track(plugin.id, pluginHost.setOptions(plugin.id, { [option.id]: value }))}
                      />
                    ))}
                  </div>
                ) : null}
                {hasActions ? (
                  <div className="flex flex-wrap gap-2 bg-surface-2/40 px-4 py-3">
                    {canEnable ? (
                      <Button className="min-h-11 rounded-md px-4" data-testid="plugin-enable" disabled={busy} onClick={() => decide(plugin.id, true, plugin.hash)}>
                        Turn on
                      </Button>
                    ) : null}
                    {plugin.status === "enabled" ? (
                      <Button variant="secondary" className="min-h-11 rounded-md px-4" data-testid="plugin-disable" disabled={busy} onClick={() => decide(plugin.id, false)}>
                        Turn off
                      </Button>
                    ) : null}
                    {plugin.status === "enabled" && plugin.slots.includes("page") ? (
                      <Button variant="secondary" className="min-h-11 rounded-md px-4" data-testid="plugin-open" disabled={busy} onClick={() => openPluginPage(plugin.id)}>
                        Open
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </RowGroup>
              {failure ? (
                <Notice
                  tone="warning"
                  action={plugin.status === "enabled" ? { label: "Restart", onClick: () => pluginHost.restart(plugin.id) } : undefined}
                >
                  {failure}
                </Notice>
              ) : null}
            </div>
          );
        })}
      </>
    );
  }

  return (
    <div data-testid="plugins-settings" className="flex min-w-0 flex-col gap-6">
      {body}
    </div>
  );
}

/** One plugin option, edited in place. Text saves on blur or Enter; the rest save on change. */
function OptionControl({ option, value, disabled, onSave }: {
  option: PluginOptionInfo;
  value: boolean | string;
  disabled: boolean;
  onSave: (value: boolean | string) => Promise<boolean>;
}): JSX.Element {
  if (option.type === "bool") {
    return (
      <Row
        testId="plugin-option"
        data-option={option.id}
        title={option.label}
        trailing={
          <span className="-mr-1 flex size-12 shrink-0 items-center justify-center">
            <Switch checked={value === true} disabled={disabled} onCheckedChange={(checked) => onSave(checked)} aria-label={option.label} />
          </span>
        }
      />
    );
  }
  if (option.type === "choice") {
    // Segmented holds two to five peers; a longer list is a column of rows.
    return option.choices.length <= 4 ? (
      <div data-testid="plugin-option" data-option={option.id} className="flex min-w-0 flex-col gap-2 px-4 py-3">
        <span className="text-ui text-foreground">{option.label}</span>
        <Segmented
          aria-label={option.label}
          variant="card"
          className="bg-surface-2"
          options={option.choices.map((choice) => ({ value: choice, label: choice, disabled }))}
          value={String(value)}
          onChange={onSave}
        />
      </div>
    ) : (
      <div data-testid="plugin-option" data-option={option.id} className="flex min-w-0 flex-col">
        <span className="px-4 pt-3 text-ui text-foreground">{option.label}</span>
        {option.choices.map((choice) => (
          <Row key={choice} title={choice} selected={choice === value} disabled={disabled} onClick={() => choice !== value && onSave(choice)} />
        ))}
      </div>
    );
  }
  return <TextOption option={option} value={String(value)} disabled={disabled} onSave={onSave} />;
}

function TextOption({ option, value, disabled, onSave }: {
  option: PluginOptionInfo;
  value: string;
  disabled: boolean;
  onSave: (value: string) => Promise<boolean>;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  // The text being posted right now, so Enter then blur does not post twice.
  const saving = useRef<string | null>(null);
  // The saved value is the truth: follow it after a save or a refresh.
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft === value || draft === saving.current) return;
    saving.current = draft;
    void onSave(draft).then((saved) => {
      saving.current = null;
      // A rejected save leaves the stored value; show it, not the unsaved text.
      if (!saved) setDraft(value);
    });
  };
  return (
    <div data-testid="plugin-option" data-option={option.id} className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <span className="text-ui text-foreground">{option.label}</span>
      <Input
        aria-label={option.label}
        value={draft}
        maxLength={200}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </div>
  );
}
