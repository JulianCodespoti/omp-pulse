import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { ArrowLeftIcon, BatteryIcon, BellIcon, MonitorIcon, SmartphoneIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { startVisibleInterval } from "@/runtime/visible-interval";

import { formatDownloadSize, parseComputerStatuses, readLocalAccess, readLocalState, switchComputer } from "../platform/local-mode";
import type { ComputerStatus, LocalAccess, LocalAccessKind, LocalState, OmpLocalBridge } from "../platform/local-mode";
import { useBackLayer } from "./back-layer";
import { ConnectComputer } from "./ConnectComputer";
import { bridgeSignInTransport, ProviderSignIn } from "./ProviderSignIn";
import { computerName } from "./session-format";
import { ErrorNotice } from "./ui/ErrorNotice";
import { ListRow, ListSection } from "./ui/GroupedList";

type Step = "welcome" | "laptop" | "preparing" | "model" | "extras";

const PREVIOUS: Record<Exclude<Step, "welcome">, Step> = {
  laptop: "welcome",
  preparing: "welcome",
  model: "welcome",
  extras: "model",
};

const PRIMARY = "pressable h-12 w-full rounded-lg text-ui font-medium";
// Secondary actions are tonal (surface-3), not muted ghost text.
const SECONDARY = "pressable h-12 w-full rounded-lg bg-surface-3 text-ui font-medium text-foreground hover:bg-surface-3";
const FIELD = "h-12 rounded-lg border border-border bg-card px-4 text-body md:text-body";

/**
 * Bundled run-location chooser, on first run or after stopping phone mode.
 * With no daemon behind it, this screen talks only to the `OmpLocal` bridge.
 * Choosing a mode restarts the app into that mode's URL.
 */
export function Onboarding({ bridge }: { bridge: OmpLocalBridge }): JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [state, setState] = useState(() => readLocalState(bridge));
  // Phone mode was stopped, not never set up: the runtime, chats and sign-ins
  // are already here, so resuming skips model and permission setup. Captured
  // once; a fresh install becomes `installed` midway and must keep its steps.
  const [resuming] = useState(() => state?.supported === true && state.installed);

  const back = () => {
    if (step !== "welcome") setStep(PREVIOUS[step]);
  };
  // System Back walks the same steps as the on-screen arrow; on the first
  // step it falls through to the shell, which leaves the app.
  useBackLayer(step !== "welcome", { base: true, onBack: back });

  // Only the steps that show runtime progress need it live.
  useEffect(() => {
    if (step !== "preparing") return;
    return startVisibleInterval(() => setState(readLocalState(bridge)), 500, { tickOnShow: true });
  }, [bridge, step]);

  useEffect(() => {
    if (step !== "preparing" || state?.phase !== "ready") return;
    // Restarts the app into the on-phone daemon's page.
    if (resuming) bridge.setMode("phone");
    else setStep("model");
  }, [bridge, resuming, step, state?.phase]);

  const runHere = () => {
    bridge.prepare();
    setState(readLocalState(bridge));
    setStep("preparing");
  };

  return (
    // Top-aligned like the pair screen, so a step's error never shifts the
    // controls under the thumb; the step's action sits at the bottom.
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-7 bg-background px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(3rem,calc(env(safe-area-inset-top)+2rem))]">
      {step === "welcome" ? (
        <Welcome bridge={bridge} state={state} resuming={resuming} onPhone={runHere} onLaptop={() => setStep("laptop")} />
      ) : step === "laptop" ? (
        <ConnectLaptop bridge={bridge} onBack={back} />
      ) : step === "preparing" ? (
        <Preparing state={state} resuming={resuming} onRetry={runHere} onBack={back} />
      ) : step === "model" ? (
        <ConnectModel bridge={bridge} onBack={back} onDone={() => setStep("extras")} />
      ) : (
        <Extras bridge={bridge} onBack={back} />
      )}
    </main>
  );
}

function Welcome({
  bridge,
  state,
  resuming,
  onPhone,
  onLaptop,
}: {
  bridge: OmpLocalBridge;
  state: LocalState | null;
  resuming: boolean;
  onPhone: () => void;
  onLaptop: () => void;
}): JSX.Element {
  const supported = state?.supported === true;
  const download = !resuming && state && state.downloadBytes > 0 ? formatDownloadSize(state.downloadBytes) : null;
  // Only the stopped-phone screen offers computers the phone already knows;
  // a first run has nothing to continue.
  const saved = resuming ? (state?.computers ?? []) : [];
  return (
    <>
      <Header
        title={resuming ? "Phone mode is off" : "Your coding agent, on your phone"}
        lead={
          resuming
            ? saved.length > 0
              ? "omp isn't running on this phone. Your conversations, files and sign-ins are still here. Run on this phone to pick up where you left off, or continue on a computer you've connected."
              : "omp isn't running on this phone. Your conversations, files and sign-ins are still here. Run on this phone to pick up where you left off, or connect to a computer."
            : supported
              ? "Run omp right here, or connect to a computer you already use."
              : "This phone can't run omp itself, but it can connect to your computer."
        }
      />
      {saved.length > 0 ? <SavedComputers bridge={bridge} urls={saved} /> : null}
      <div className="mt-auto flex flex-col gap-2">
        {supported ? (
          <>
            <Button variant="primary" className={PRIMARY} onClick={onPhone} data-testid="onboarding-phone">
              <SmartphoneIcon data-icon="inline-start" />
              Run on this phone
            </Button>
            {download ? (
              <p className="pb-2 text-center text-caption text-muted-foreground">
                One-time {download} download
              </p>
            ) : null}
            <Button variant="ghost" className={SECONDARY} onClick={onLaptop} data-testid="onboarding-laptop">
              <MonitorIcon data-icon="inline-start" />
              {saved.length > 0 ? "Connect another computer" : "Connect a computer"}
            </Button>
          </>
        ) : (
          <Button variant="primary" className={PRIMARY} onClick={onLaptop} data-testid="onboarding-laptop">
            <MonitorIcon data-icon="inline-start" />
            Connect a computer
          </Button>
        )}
      </div>
    </>
  );
}

const STATUS_LABEL: Record<ComputerStatus, string> = { checking: "Checking…", online: "Online", offline: "Offline" };

/**
 * The computers this phone is already paired with, each with whether it
 * answers right now. The check is advisory: an offline computer stays
 * selectable (it may be back by the time you tap), and nothing is chosen
 * until you tap one. The native check runs only while this list is on screen
 * and visible, and is cancelled on hide and unmount.
 */
function SavedComputers({ bridge, urls }: { bridge: OmpLocalBridge; urls: string[] }): JSX.Element {
  // Raw JSON: an unchanged answer is the same string, so React skips the render.
  const [raw, setRaw] = useState("{}");
  const statuses = useMemo(() => parseComputerStatuses(raw), [raw]);
  const [refusal, setRefusal] = useState<{ url: string; message: string } | null>(null);
  const switched = useRef(false);

  useEffect(() => {
    const poll = () => setRaw(bridge.computerStatus(true));
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      bridge.computerStatus(false);
      setRaw("{}");
    };
    document.addEventListener("visibilitychange", onHidden);
    if (document.visibilityState !== "hidden") poll();
    const stop = startVisibleInterval(poll, 1000, { tickOnShow: true });
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onHidden);
      bridge.computerStatus(false);
    };
  }, [bridge]);

  const choose = (url: string) => {
    // The shell restarts onto the computer; a second tap must not restart again.
    if (switched.current) return;
    const message = switchComputer(bridge, url);
    if (message === null) switched.current = true;
    setRefusal(message === null ? null : { url, message });
  };

  return (
    <div className="flex flex-col gap-2">
      <ListSection title="Your computers" data-testid="onboarding-computer-list">
        {urls.map((url, index) => {
          const { host, hostname } = new URL(url);
          const name = computerName(hostname);
          const status = statuses[url] ?? "checking";
          return (
            <ListRow
              key={url}
              icon={<MonitorIcon />}
              label={name}
              detail={host}
              value={
                <span
                  className={status === "online" ? "text-success" : undefined}
                  data-testid={`onboarding-computer-status-${index}`}
                  data-status={status}
                >
                  {STATUS_LABEL[status]}
                </span>
              }
              chevron
              onClick={() => choose(url)}
              data-testid={`onboarding-computer-${index}`}
            />
          );
        })}
      </ListSection>
      {refusal ? (
        <ErrorNotice
          message={refusal.message}
          onRetry={() => choose(refusal.url)}
          testId="onboarding-computer-error"
        />
      ) : null}
    </div>
  );
}

function ConnectLaptop({ bridge, onBack }: { bridge: OmpLocalBridge; onBack: () => void }): JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-7">
      <Header onBack={onBack} title="Connect your computer" lead="One scan connects and pairs this phone." />
      <ConnectComputer bridge={bridge} />
    </div>
  );
}

function Preparing({
  state,
  resuming,
  onRetry,
  onBack,
}: {
  state: LocalState | null;
  resuming: boolean;
  onRetry: () => void;
  onBack: () => void;
}): JSX.Element {
  const failed = state?.phase === "error";
  const progress = state && state.progress >= 0 ? state.progress : null;
  return (
    <>
      {/* The progress number is this step's hero, so its title steps down. */}
      <Header
        onBack={onBack}
        title={resuming ? "Starting omp" : "Setting up omp"}
        lead={resuming ? "Starting omp on this phone." : "The first time takes a few minutes."}
        compact
      />
      {failed ? (
        <ErrorNotice message={state?.error || "omp could not start on this phone."} />
      ) : (
        <div className="flex flex-col gap-3" aria-live="polite">
          {/* The one number this screen is about. */}
          <span className="text-large-title font-semibold tabular-nums tracking-tight">
            {progress !== null ? `${progress}%` : <Spinner className="size-8 text-muted-foreground" />}
          </span>
          <div className="h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
          <p className="text-meta text-muted-foreground">{state?.message || "Preparing…"}</p>
        </div>
      )}
      {failed ? (
        <Button className={`${PRIMARY} mt-auto`} onClick={onRetry} data-testid="onboarding-retry">
          Try again
        </Button>
      ) : null}
    </>
  );
}

function ConnectModel({
  bridge,
  onBack,
  onDone,
}: {
  bridge: OmpLocalBridge;
  onBack: () => void;
  onDone: () => void;
}): JSX.Element {
  const [signedIn, setSignedIn] = useState(false);
  const transport = useMemo(() => bridgeSignInTransport(bridge), [bridge]);
  return (
    <>
      <Header onBack={onBack} title="Connect a model" lead="Sign in with an account you already have." />
      <ProviderSignIn transport={transport} active onStatus={setSignedIn} />
      <div className="mt-auto">
        {signedIn ? (
          <Button variant="primary" className={PRIMARY} onClick={onDone} data-testid="onboarding-continue">
            Continue
          </Button>
        ) : (
          <Button variant="ghost" className={SECONDARY} onClick={onDone} data-testid="onboarding-skip">
            Skip for now
          </Button>
        )}
      </div>
    </>
  );
}

const EXTRAS: readonly { kind: LocalAccessKind; icon: ReactNode; label: string; detail: string }[] = [
  { kind: "notifications", icon: <BellIcon />, label: "Notifications", detail: "Know when a reply is ready" },
  { kind: "battery", icon: <BatteryIcon />, label: "Run in the background", detail: "Android won't pause omp" },
];

function Extras({ bridge, onBack }: { bridge: OmpLocalBridge; onBack: () => void }): JSX.Element {
  const [access, setAccess] = useState<LocalAccess | null>(() => readLocalAccess(bridge));
  const [starting, setStarting] = useState(false);

  // Each grant leaves for a system screen or prompt; re-read when it returns
  // (the show itself re-reads) and while visible, never while away.
  useEffect(() => {
    return startVisibleInterval(() => setAccess(readLocalAccess(bridge)), 1000, { tickOnShow: true });
  }, [bridge]);

  return (
    <>
      <Header onBack={onBack} title="Ready to start" lead="Two optional extras. You can change them later in Settings." />
      {access ? (
        <ListSection>
          {EXTRAS.map((row) => (
            <ListRow
              key={row.kind}
              icon={row.icon}
              label={row.label}
              detail={row.detail}
              value={access[row.kind] ? "On" : undefined}
              chevron={!access[row.kind]}
              onClick={access[row.kind] ? undefined : () => bridge.grant(row.kind)}
              data-testid={`onboarding-access-${row.kind}`}
            />
          ))}
        </ListSection>
      ) : null}
      <Button
        className={`${PRIMARY} mt-auto`}
        disabled={starting}
        onClick={() => {
          setStarting(true);
          // Restarts the app into the on-phone daemon's page.
          bridge.setMode("phone");
        }}
        data-testid="onboarding-start"
      >
        {starting ? <Spinner data-icon="inline-start" /> : null}
        {starting ? "Starting…" : "Start"}
      </Button>
    </>
  );
}

function Header({
  title,
  lead,
  onBack,
  compact = false,
}: {
  title: string;
  lead: string;
  onBack?: () => void;
  /** A step whose hero is something else (a progress number) uses the screen-title size. */
  compact?: boolean;
}): JSX.Element {
  return (
    <header className="flex flex-col gap-4 motion-safe:animate-fade-up">
      {onBack ? (
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="pressable -ml-3 flex size-12 items-center justify-center rounded-full text-muted-foreground active:bg-surface-3"
        >
          <ArrowLeftIcon aria-hidden className="size-5" />
        </button>
      ) : (
        <div className="h-12" aria-hidden />
      )}
      <div className="flex flex-col gap-2">
        <h1 className={`${compact ? "text-title" : "text-large-title"} font-semibold tracking-tight text-balance`}>{title}</h1>
        <p className="text-body text-muted-foreground">{lead}</p>
      </div>
    </header>
  );
}
