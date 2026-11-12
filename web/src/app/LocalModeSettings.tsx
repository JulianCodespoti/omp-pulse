import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  BatteryIcon,
  CheckIcon,
  FolderIcon,
  MonitorIcon,
  PackageIcon,
  PlusIcon,
  PointerIcon,
  RotateCwIcon,
  SettingsIcon,
  SmartphoneIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { startVisibleInterval } from "@/runtime/visible-interval";

import {
  formatDownloadSize,
  getOmpLocal,
  parseLocalAccess,
  parseLocalState,
  readLocalState,
  switchComputer,
} from "../platform/local-mode";
import type {
  LocalAccess,
  LocalAccessKind,
  LocalMode,
  LocalState,
  OmpLocalBridge,
} from "../platform/local-mode";
import { Notice } from "./ui/Notice";
import { Row, RowGroup } from "./ui/Row";
import { Segmented } from "./ui/Segmented";
import { ConfirmSheet } from "./ui/Sheet";
import { StatusDot, StatusRing } from "./ui/Status";
import { ErrorNotice } from "./ui/ErrorNotice";
import { computerName } from "./session-format";

type Tone = "ok" | "busy" | "error" | "idle";

export type LocalRuntime = {
  bridge: OmpLocalBridge;
  state: LocalState;
  access: LocalAccess | null;
  onPhone: boolean;
  switching: boolean;
  preparing: boolean;
  select: (next: LocalMode) => void;
  tone: Tone;
  status: string;
  /** The Run on row's value: where omp runs, or that it is switching. */
  summary: string;
  /** Opens the one-scan "connect your computer" page; the Settings stack owns it. */
  connect: () => void;
  /** Re-reads the native state now, e.g. right after saving the address. */
  refresh: () => void;
};

/**
 * The Android app's on-phone omp runtime: where omp runs, what it may touch,
 * and which model providers it is signed in to. Null unless the native
 * `OmpLocal` bridge is present and answers this page, so a browser shows
 * none of it. A device that cannot run omp locally still gets the computer
 * address; only the phone/computer choice needs `supported`.
 */
export function useLocalMode(onConnect: () => void): LocalRuntime | null {
  const [bridge] = useState(getOmpLocal);
  const [state, setState] = useState(() => (bridge ? readLocalState(bridge) : null));
  // The mode the user asked for while the runtime is still being prepared.
  const [pending, setPending] = useState<LocalMode | null>(null);
  const [access, setAccess] = useState<LocalAccess | null>(null);

  // The native side owns install/start progress; poll it while Settings is open.
  // Each tick is a synchronous JS-bridge call; parsing it into a fresh object
  // re-rendered Settings twice a second even when nothing changed, so only
  // parse and set when the raw JSON differs. Visible-only: the hidden ticks
  // it used to skip now never fire, and showing Settings re-reads at once.
  useEffect(() => {
    if (!bridge) return;
    let lastState: string | null = null;
    let lastAccess: string | null = null;
    const poll = () => {
      const rawState = bridge.state();
      if (rawState !== lastState) {
        lastState = rawState;
        setState(parseLocalState(rawState));
      }
      if (typeof bridge.access === "function") {
        const rawAccess = bridge.access();
        if (rawAccess !== lastAccess) {
          lastAccess = rawAccess;
          setAccess(parseLocalAccess(rawAccess));
        }
      }
    };
    poll();
    return startVisibleInterval(poll, 500, { tickOnShow: true });
  }, [bridge]);

  // Switching to the phone is two steps: prepare() installs and starts the
  // runtime, and only once it is ready does the mode flip (which reloads).
  useEffect(() => {
    if (bridge && pending === "phone" && state?.phase === "ready") bridge.setMode("phone");
    if (state?.phase === "error") setPending(null);
  }, [bridge, pending, state?.phase]);

  if (!bridge || !state) return null;

  const onPhone = state.mode === "phone";
  const switching = pending !== null;
  const preparing =
    pending === "phone" &&
    (state.phase === "installing" || state.phase === "starting" || state.phase === "idle");
  const [tone, status]: [Tone, string] =
    state.phase === "error" && state.error
      ? ["error", state.error]
      : preparing
        ? [
            "busy",
            `${state.message || "Preparing"}${state.progress >= 0 ? ` · ${state.progress}%` : "\u2026"}`,
          ]
        : onPhone
          ? ["ok", "Running on this phone"]
          : ["idle", "Running on your computer"];
  return {
    bridge,
    state,
    access,
    onPhone,
    switching,
    preparing,
    tone,
    status,
    summary: preparing ? "Preparing\u2026" : onPhone ? "This phone" : "Computer",
    connect: onConnect,
    refresh: () => setState(readLocalState(bridge)),
    select: (next) => {
      if (switching || (next === state.mode && state.phase !== "error")) return;
      // Computer mode with no address would load nothing: connect one first,
      // which also switches and pairs in the same step.
      if (next === "laptop" && !state.laptopUrl) {
        onConnect();
        return;
      }
      setPending(next);
      if (next === "laptop") bridge.setMode("laptop");
      else {
        bridge.prepare();
        setState(readLocalState(bridge));
      }
    },
  };
}

/** Settings › Run on. */
export function RunOnSettings({ local }: { local: LocalRuntime }): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {local.state.supported ? (
          <Segmented
            aria-label="Run on"
            testId="run-on"
            options={[
              { value: "laptop", label: "Computer", disabled: local.switching && local.onPhone },
              { value: "phone", label: "This phone", disabled: local.switching && !local.onPhone },
            ]}
            value={local.preparing ? "phone" : local.state.mode}
            onChange={local.select}
          />
        ) : null}
        {local.tone === "error" ? (
          <ErrorNotice
            message="Phone setup couldn't finish."
            details={local.state.error}
            action={local.state.supported ? { label: "Retry setup", icon: RotateCwIcon, onClick: () => local.select("phone") } : undefined}
          />
        ) : <StatusLine tone={local.tone}>{local.status}</StatusLine>}
        {local.preparing && local.state.progress >= 0 ? (
          <div className="h-0.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full bg-foreground transition-[width] duration-300"
              style={{ width: `${local.state.progress}%` }}
            />
          </div>
        ) : null}
      </div>
      <Computers local={local} />
    </div>
  );
}

/**
 * Every computer this phone has connected to. A tap switches to it (each
 * keeps its own pairing, so nothing is asked again); the one in use is
 * ticked; the trailing button forgets one. Adding another is the one-scan page.
 */
function Computers({ local }: { local: LocalRuntime }): JSX.Element {
  const { bridge, state } = local;
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = state.computers ?? [];
  const inUse = (url: string) => state.mode === "laptop" && url === state.laptopUrl;
  const use = (url: string) => {
    if (inUse(url) || local.switching) return;
    setError(switchComputer(bridge, url));
  };
  // The saved values are normalized https://host[:port]/app/ URLs.
  const forgetName = forgetting ? computerName(new URL(forgetting).hostname) : "";
  const fact = local.onPhone
    ? "Your computer can stay off."
    : state.supported && state.downloadBytes > 0
      ? `Switching to this phone downloads ${formatDownloadSize(state.downloadBytes)} once.`
      : "omp runs on the computer ticked above.";
  return (
    <div className="flex flex-col gap-2">
      <RowGroup inset title="Computers" testId="computers" footer={fact}>
        {list.map((url) => {
          const { host, hostname } = new URL(url);
          const name = computerName(hostname);
          return (
            // The row switches; the button beside it forgets. Two controls, so
            // neither is nested in the other.
            <div key={url} className="flex items-stretch">
              <Row
                className="min-w-0 flex-1"
                leading={<MonitorIcon />}
                title={name}
                subtitle={host}
                trailing={inUse(url) ? <CheckIcon aria-label="In use" className="size-5 text-foreground" /> : undefined}
                // aria-current without Row's `selected`, whose fill reads as a press.
                aria-current={inUse(url) ? "true" : undefined}
                onClick={() => use(url)}
                testId="computer-row"
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-12 shrink-0 self-center text-muted-foreground"
                aria-label={`Forget ${name}`}
                onClick={() => setForgetting(url)}
                data-testid="forget-computer-button"
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          );
        })}
        <Row
          leading={<PlusIcon />}
          title={list.length ? "Add a computer" : "Connect your computer"}
          subtitle={list.length ? undefined : "Scan a code, nothing to type"}
          chevron
          onClick={local.connect}
          testId="add-computer"
        />
      </RowGroup>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <ConfirmSheet
        open={forgetting !== null}
        onOpenChange={(open) => { if (!open) setForgetting(null); }}
        title={`Forget ${forgetName}?`}
        description="This phone stops connecting to it. Scan its code again to add it back."
        confirmLabel="Forget"
        tone="danger"
        onConfirm={() => {
          if (forgetting) bridge.forgetComputer(forgetting);
          setForgetting(null);
          local.refresh();
        }}
        testId="forget-computer"
      />
    </div>
  );
}

// Notifications are not here: Settings already has its own Notifications row.
const ACCESS_ROWS: readonly { kind: LocalAccessKind; label: string; hint: string; icon: ReactNode }[] = [
  { kind: "storage", label: "Files and photos", hint: "Read and write shared storage", icon: <FolderIcon /> },
  { kind: "install", label: "Install apps", hint: "Open the installer for APKs", icon: <PackageIcon /> },
  { kind: "accessibility", label: "Control the screen", hint: "Tap, type and read other apps", icon: <PointerIcon /> },
  { kind: "battery", label: "Run in the background", hint: "Android won\u2019t pause omp", icon: <BatteryIcon /> },
];

/** Settings › Phone access: what the on-phone agent may touch. */
export function PhoneAccessSettings({ local }: { local: LocalRuntime }): JSX.Element {
  const { bridge, state } = local;
  // Older shells have no switch: they always gave the agent its phone tools.
  const canToggle = typeof bridge.setPhoneTools === "function" && typeof state.phoneTools === "boolean";
  const phoneTools = state.phoneTools !== false;
  const reach = phoneTools
    ? "The agent can read your files, install apps (you confirm each one) and use other apps for you."
    : "With phone tools off, the agent can only use your files.";
  return (
    <div className="flex flex-col gap-6">
      {canToggle ? (
        <RowGroup
          inset
          title="Agent"
          footer={`${reach} Phone tools use your phone\u2019s apps, screen and files through the android command, and apply to new chats.`}
        >
          <Row
            leading={<SmartphoneIcon />}
            title="Phone tools for the agent"
            testId="phone-tools"
            trailing={
              <span className="-mr-1 flex size-12 shrink-0 items-center justify-center">
                <Switch
                  checked={phoneTools}
                  onCheckedChange={(checked) => {
                    bridge.setPhoneTools?.(checked);
                    local.refresh();
                  }}
                  aria-label="Phone tools for the agent"
                />
              </span>
            }
          />
        </RowGroup>
      ) : null}
      <RowGroup
        inset
        title="Android permissions"
        footer={
          local.access?.accessibility
            ? undefined
            : "Android requires your approval in App info before this app can control the screen."
        }
      >
        {ACCESS_ROWS.map((row) => (
          <Row
            key={row.kind}
            leading={row.icon}
            title={row.label}
            subtitle={row.hint}
            testId={`access-${row.kind}`}
            trailing={local.access?.[row.kind] ? (
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                <CheckIcon className="size-4 text-success" aria-hidden />
                Allowed
              </span>
            ) : "Allow"}
            onClick={!local.access?.[row.kind] ? () => bridge.grant(row.kind) : undefined}
          />
        ))}
        {!local.access?.accessibility && typeof bridge.openAppSettings === "function" ? (
          <Row leading={<SettingsIcon />} title="Open app settings" chevron onClick={() => bridge.openAppSettings?.()} />
        ) : null}
      </RowGroup>
    </div>
  );
}

function StatusLine({ tone, children }: { tone: Tone; children: ReactNode }): JSX.Element {
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-meta",
        tone === "error" ? "text-danger" : "text-muted-foreground",
      )}
      aria-live="polite"
    >
      {tone === "idle" ? null : (
        <span className="flex h-[1.125rem] shrink-0 items-center">
          {tone === "busy" ? <StatusRing /> : <StatusDot tone={tone === "ok" ? "success" : "danger"} />}
        </span>
      )}
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}
