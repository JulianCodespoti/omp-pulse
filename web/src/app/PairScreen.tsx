import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { ArrowLeftIcon, CircleHelpIcon, KeyboardIcon, QrCodeIcon, RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { readPairingToken, writePairingToken } from "@/platform/browser-storage";
import { syncNativeNotificationToken } from "@/platform/native-notifications";
import { AuthError, DaemonApi, ForbiddenError } from "@/runtime/rpc-client";
import { connectLaptop, getOmpLocal, leaveComputer } from "@/platform/local-mode";

import { useBackLayer } from "./back-layer";
import { ConnectComputer } from "./ConnectComputer";
import { PairColumn, PairHeader } from "./PairSplash";
import { defaultDeviceName, isPairingLink, pairingCodeFrom } from "./pairing-link";
import { canScanQr, QrScanner } from "./QrScanner";
import { humanizeDaemonError } from "./ui/OwnedBySession";
import { ErrorNotice } from "./ui/ErrorNotice";
import { BottomSheet } from "./ui/Sheet";
import { CopyButton } from "./parts/CopyButton";

const FIELD = "h-12 rounded-md border border-control bg-surface-1 px-4 text-body md:text-body";

// The code behind this credential is already spent, so the only way forward is
// another hand-off. Saying so keeps the retry from looking like a second
// pairing attempt the computer would refuse.
const NATIVE_SYNC_ERROR =
  "Couldn\u2019t finish pairing. This code is already used; try again without a new code.";

const WRONG_CODE = "That code is wrong or expired. Get a new one on your computer.";

/** The repair variant sits in a Settings page, which already supplies the frame and the title. */
function RepairColumn({ children, testId }: { children: ReactNode; testId?: string }): JSX.Element {
  return <div data-testid={testId} className="flex flex-col gap-6">{children}</div>;
}

export function PairScreen({
  initialCode,
  autoConnect = false,
  repair = false,
  onConnected,
  beforePair,
  retainCredential,
}: {
  initialCode: string;
  /** The phone app scanned this code itself: redeem it without a second tap. */
  autoConnect?: boolean;
  /**
   * Re-pairing a phone that is already set up, from inside Settings: no
   * first-run hero or tips, and none of the Android per-computer flow (Back
   * there leaves the computer, which a repair must not do).
   */
  repair?: boolean;
  onConnected: (token: string) => void;
  beforePair?: () => Promise<void>;
  retainCredential?: (credential: string) => Promise<void>;
}) {
  const Column = repair ? RepairColumn : PairColumn;
  // A link that carried a code lands straight on the filled form.
  const [mode, setMode] = useState<"start" | "enter" | "scan">(initialCode ? "enter" : "start");
  const [code, setCode] = useState(initialCode);
  const [pairingHelp, setPairingHelp] = useState(false);
  const [name, setName] = useState(() => defaultDeviceName(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unacknowledged, setUnacknowledged] = useState<string | null>(null);
  const [preservationFailed, setPreservationFailed] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const scannable = canScanQr();
  const connecting = useRef(false);
  // In the Android app, this page belongs to one computer.
  const [native] = useState(() => (repair ? null : getOmpLocal()));
  // System Back leaves the computer too, like the arrow.
  useBackLayer(Boolean(native), { base: true, onBack: () => native && leaveComputer(native) });

  /**
   * A pairing link for a DIFFERENT computer goes through the one connect
   * route (ConnectComputer): switch to it and pair there. Redeeming its code
   * here would pair with the wrong machine. True when that took over.
   */
  function switchesComputer(text: string): boolean {
    const link = text.trim();
    if (!native || !isPairingLink(link) || new URL(link).origin === window.location.origin) return false;
    const refusal = connectLaptop(native, link);
    if (refusal) setError(refusal);
    return true;
  }

  async function connect(entered: string) {
    if (switchesComputer(entered)) return;
    const pairCode = pairingCodeFrom(entered) ?? entered.trim();
    if (connecting.current || (!unacknowledged && (!pairCode || !name.trim()))) return;
    connecting.current = true;
    setBusy(true);
    setError(null);
    setPreservationFailed(false);
    let pending = unacknowledged;
    const priorCredential = readPairingToken();
    let preserving = false;
    try {
      if (pending) {
        await retainCredential?.(pending);
        if (!active.current || readPairingToken() !== priorCredential) return;
        writePairingToken(pending);
        await syncNativeNotificationToken(pending);
        if (readPairingToken() !== pending) return;
        setUnacknowledged(null);
        setCode("");
        onConnected(pending);
        return;
      }
      // Fail before consuming a one-use code if this browser cannot retain it.
      const probe = "omp-pulse-pairing-storage-check";
      localStorage.setItem(probe, "1");
      if (localStorage.getItem(probe) !== "1")
        throw new Error("Turn on site storage for this app, then try again.");
      localStorage.removeItem(probe);
      preserving = true;
      await beforePair?.();
      preserving = false;
      if (!active.current) return;
      const data = await new DaemonApi("").fetchJson<{ token: string }>("/api/pair", {
        method: "POST",
        body: JSON.stringify({ code: pairCode, name: name.trim() }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!active.current || readPairingToken() !== priorCredential) return;
      if (typeof data.token !== "string" || !data.token)
        throw new Error("Your computer didn\u2019t send a pairing. Try again.");
      // Keep the spent code's credential through every acknowledgement retry.
      pending = data.token;
      setUnacknowledged(data.token);
      await retainCredential?.(data.token);
      if (!active.current || readPairingToken() !== priorCredential) return;
      writePairingToken(data.token);
      await syncNativeNotificationToken(data.token);
      if (readPairingToken() !== data.token) return;
      setCode("");
      onConnected(data.token);
    } catch (cause) {
      if (pending) {
        setError(NATIVE_SYNC_ERROR);
        return;
      }
      if (preserving) {
        setPreservationFailed(true);
        setError("Couldn't preserve your saved work. Pairing hasn't changed. Retry when device storage is available.");
        return;
      }
      // A refused code is almost always a typo or an expired one: say so and
      // say how to get a new one, rather than a bare "Authentication failed".
      setError(
        cause instanceof AuthError || cause instanceof ForbiddenError
          ? WRONG_CODE
          : humanizeDaemonError(cause),
      );
    } finally {
      setBusy(false);
      connecting.current = false;
    }
  }

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoConnect || !initialCode || autoStarted.current) return;
    autoStarted.current = true;
    void connect(initialCode);
    // Once, on arrival; `connect` reads the latest state itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (mode === "scan") {
    return (
      <QrScanner
        hint="Point the camera at the QR code from omp-pulse pair."
        onCancel={() => setMode("enter")}
        onScan={(text) => {
          const scanned = pairingCodeFrom(text);
          if (!scanned) return false;
          if (switchesComputer(text)) return true;
          setCode(scanned);
          if (unacknowledged) return false;
          setMode("enter");
          void connect(scanned);
          return true;
        }}
      />
    );
  }

  // In the Android app an unpaired computer shows the same connect flow as
  // Settings › Run on (scan once, it pairs), not this page's older code form.
  // A code that arrived with the page (#pair=…&connect=1) is redeemed by the
  // effect above while this shows.
  if (native && !unacknowledged && !error) {
    return (
      <PairColumn testId="pair-screen">
        <header className="flex flex-col gap-6 motion-safe:animate-fade-up">
          <Button variant="ghost" size="icon" aria-label="Back" data-testid="pair-back" className="-ml-3 -mb-4" onClick={() => leaveComputer(native)}>
            <ArrowLeftIcon className="size-5" />
          </Button>
          <h1 className="text-large-title font-semibold text-balance">{busy ? "Connecting\u2026" : "Connect your computer"}</h1>
        </header>
        {busy ? null : <ConnectComputer bridge={native} />}
      </PairColumn>
    );
  }

  const invalid = error !== null;
  return (
    // Top-aligned, not centred: a centred column jumped up when the error
    // appeared, moving every control under the thumb that just tapped Connect.
    <Column testId="pair-screen">
      <header className="flex flex-col gap-6 motion-safe:animate-fade-up">
        {native ? (
          // The way back out: an unpaired computer used to be a dead end.
          <Button variant="ghost" size="icon" aria-label="Back" data-testid="pair-back" className="-ml-3 -mb-4" onClick={() => leaveComputer(native)}>
            <ArrowLeftIcon className="size-5" />
          </Button>
        ) : null}
        {repair ? null : <PairHeader />}
        <div className="flex flex-col gap-2">
          {repair ? null : <h1 className="text-large-title font-semibold text-balance">Connect to your computer</h1>}
          <p className="text-body text-muted-foreground">
            Run <code className="font-mono text-code text-foreground">omp-pulse pair</code> on your computer, then {mode === "enter" || !scannable ? "enter" : "scan"} the code it shows.{repair ? " Your saved work is kept." : ""}
          </p>
        </div>
      </header>
      {mode === "start" ? (
        <div className={cn("flex flex-col gap-3", !repair && "mt-auto")}>
          {scannable ? (
            <Button variant="primary" className="w-full" onClick={() => setMode("scan")}>
              <QrCodeIcon data-icon="inline-start" />
              Scan QR code
            </Button>
          ) : null}
          <Button variant={scannable ? "secondary" : "primary"} className="w-full" onClick={() => setMode("enter")}>
            <KeyboardIcon data-icon="inline-start" />
            Enter code
          </Button>
          {repair ? null : (
            <p className="pt-2 text-center text-meta text-muted-foreground">
              Have a phone that’s already connected? Use Settings › Computer › Pair another device.
            </p>
          )}
        </div>
      ) : (
        <form
          className="flex flex-col gap-5 motion-safe:animate-fade-in"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(code);
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="pairing-code" className="text-meta font-medium">
              Pairing code
            </Label>
            <Input
              id="pairing-code"
              autoCapitalize="none"
              autoComplete="one-time-code"
              autoCorrect="off"
              spellCheck={false}
              className={FIELD}
              value={code}
              maxLength={2048}
              disabled={busy || Boolean(unacknowledged)}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? "pairing-code-error" : undefined}
              onChange={(event) => {
                setCode(event.target.value);
                setError(null);
              }}
              placeholder="Paste the code or link"
              required
            />
            {error ? (
              <div id="pairing-code-error">
                <ErrorNotice message={error}
                  onRetry={preservationFailed ? () => void connect(code) : undefined}
                  action={!unacknowledged && !preservationFailed ? { label: "Pairing help", icon: CircleHelpIcon, onClick: () => setPairingHelp(true) } : undefined} />
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="device-name" className="text-meta font-medium">
              Device name
            </Label>
            <Input
              id="device-name"
              className={FIELD}
              value={name}
              maxLength={80}
              disabled={busy || Boolean(unacknowledged)}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div className="flex flex-col gap-3 pt-1">
            <Button
              variant="primary"
              className="w-full"
              type="submit"
              disabled={busy || (!unacknowledged && (!code.trim() || !name.trim()))}
            >
              {busy ? (
                <Spinner data-icon="inline-start" label={null} />
              ) : unacknowledged ? (
                <RotateCwIcon data-icon="inline-start" />
              ) : null}
              {busy ? (unacknowledged ? "Finishing\u2026" : repair ? "Repairing\u2026" : "Connecting\u2026") : unacknowledged ? "Try again" : repair ? "Repair pairing" : "Connect"}
            </Button>
            {scannable ? (
              <Button variant="ghost" className="w-full" disabled={busy || Boolean(unacknowledged)} onClick={() => setMode("scan")}>
                <QrCodeIcon data-icon="inline-start" />
                Scan QR code instead
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <BottomSheet open={pairingHelp} onOpenChange={setPairingHelp} title="Get a new pairing code">
        <div className="space-y-3 pb-2 text-meta">
          <p>Run this on the computer hosting omp-pulse. Codes expire in five minutes and work once.</p>
          <div className="flex min-w-0 items-center gap-3">
            <code className="min-w-0 flex-1 select-text break-words font-mono [overflow-wrap:anywhere]">omp-pulse pair</code>
            <CopyButton text="omp-pulse pair" label="Copy pairing command" className="size-[48px]" />
          </div>
          {repair ? null : (
            <details className="text-muted-foreground">
              <summary className="min-h-12 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">Another way</summary>
              <p>On a connected device, use Settings → Computer → Pair another device. Copying the command alone does not create a code.</p>
            </details>
          )}
        </div>
      </BottomSheet>
    </Column>
  );
}
