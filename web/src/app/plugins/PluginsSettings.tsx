import { PuzzleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { argvLine, type PluginInfo, type PluginOptionInfo } from "../../domain/plugins";
import { pluginHost } from "../../runtime/plugin-host";
import { showErrorToast } from "../Notices";
import { openPluginPage } from "../nav/panels";
import { EmptyState } from "../ui/EmptyState";
import { ErrorNotice } from "../ui/ErrorNotice";
import { Notice } from "../ui/Notice";
import { Row, RowGroup, RowSkeleton } from "../ui/Row";
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

function statusLine(plugin: PluginInfo): string {
  switch (plugin.status) {
    case "enabled":
      return "On";
    case "disabled":
      return "Off";
    case "needs_review":
      return plugin.changed ? "Changed since you turned it on. Review it again" : "New. Review it before turning it on";
    case "invalid":
      return `Cannot load: ${plugin.error ?? "unknown error"}`;
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
          // On, but its script was stopped on this phone: say so rather than "On".
          const subtitle = failure !== undefined && plugin.status === "enabled" ? "Stopped on this phone" : statusLine(plugin);
          return (
            <div key={plugin.id} data-testid="plugin-row" data-plugin={plugin.id} data-status={plugin.status} data-changed={plugin.status === "needs_review" && plugin.changed ? "true" : undefined} className="flex min-w-0 flex-col gap-2">
              <RowGroup inset>
                <Row
                  leading={<PuzzleIcon />}
                  title={plugin.version ? `${plugin.name} ${plugin.version}` : plugin.name}
                  subtitle={subtitle}
                />
                {valid ? (
                  <div className="flex min-w-0 flex-col gap-2 px-4 py-3 text-meta text-muted-foreground">
                    {plugin.description ? <p className="break-words">{plugin.description}</p> : null}
                    <p>
                      <span className="font-medium text-foreground">Shows: </span>
                      {plugin.slots.map((slot) => SLOT_LABEL[slot] ?? slot).join(", ")}
                    </p>
                    <div>
                      <span className="font-medium text-foreground">Runs on the computer: </span>
                      {plugin.sources.length === 0 ? (
                        "Runs no commands on the computer"
                      ) : (
                        <ul className="mt-1 flex flex-col gap-1">
                          {plugin.sources.map((source) => (
                            <li key={source.id} className="min-w-0">
                              <code className="break-all font-mono text-foreground">{argvLine(source.command)}</code>{" "}
                              every {source.intervalS} s
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {plugin.warnings.length > 0 ? (
                      <ul data-testid="plugin-review-warnings" className="flex flex-col gap-1 text-warning">
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
                        <ul className="mt-1 flex flex-col gap-1">
                          {plugin.actions.map((action) => (
                            <li key={action.id} className="min-w-0">
                              {action.label}:{" "}
                              <code className="break-all font-mono text-foreground">{argvLine(action.command)}</code>
                              {action.argPattern ? <> ({"{arg}"} must match <code className="break-all font-mono text-foreground">{action.argPattern}</code>)</> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {valid && plugin.options.length > 0 ? (
                  <>
                    <h3 className="px-4 pt-3 text-meta font-medium text-muted-foreground">Options</h3>
                    {plugin.options.map((option) => (
                      <OptionControl
                        key={option.id}
                        option={option}
                        value={plugin.optionValues[option.id] ?? option.default}
                        disabled={busy}
                        onSave={(value) => track(plugin.id, pluginHost.setOptions(plugin.id, { [option.id]: value }))}
                      />
                    ))}
                  </>
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
              <div className="flex flex-wrap gap-2">
                {canEnable ? (
                  <Button data-testid="plugin-enable" disabled={busy} onClick={() => decide(plugin.id, true, plugin.hash)}>
                    Turn on
                  </Button>
                ) : null}
                {plugin.status === "enabled" ? (
                  <Button variant="outline" data-testid="plugin-disable" disabled={busy} onClick={() => decide(plugin.id, false)}>
                    Turn off
                  </Button>
                ) : null}
                {plugin.status === "enabled" && plugin.slots.includes("page") ? (
                  <Button variant="outline" data-testid="plugin-open" disabled={busy} onClick={() => openPluginPage(plugin.id)}>
                    Open
                  </Button>
                ) : null}
              </div>
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
          className="bg-background"
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
