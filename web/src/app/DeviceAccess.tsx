import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ChevronDownIcon, ChevronUpIcon, CopyIcon, MonitorIcon, PlusIcon, SmartphoneIcon, TabletIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readPairingToken } from "@/platform/browser-storage";
import { copyText } from "@/platform/clipboard";
import { DaemonApi } from "@/runtime/rpc-client";
import { startVisibleInterval } from "@/runtime/visible-interval";
import { showToast } from "./Notices";
import { pairingLink } from "./pairing-link";
import { QrCode } from "./QrCode";
import { Notice } from "./ui/Notice";
import { daemonErrorCause, humanizeDaemonError } from "./ui/OwnedBySession";
import { errorRecoveryAction } from "./ui/error-recovery";
import { Row, RowGroup, RowSkeleton } from "./ui/Row";
import { Segmented } from "./ui/Segmented";
import { ConfirmSheet } from "./ui/Sheet";

export type DeviceRole = "admin" | "control" | "read";
export interface PairedDevice {
  id: string;
  name: string;
  role: DeviceRole;
  createdAt?: number;
  lastSeenAt?: number;
  revokedAt?: number | null;
}

// One role vocabulary, shared by the device rows and the Access choice.
const ROLE_LABEL: Record<DeviceRole, string> = {
  admin: "Admin",
  control: "Control",
  read: "Read only",
};
const ROLE_DETAIL: Record<DeviceRole, string> = {
  admin: "Can read and control sessions, pair more devices and remove access.",
  control: "Can read and control sessions, but can\u2019t manage other devices.",
  read: "Can read conversations and follow live updates, but can\u2019t send, stop or change anything.",
};
const ROLE_OPTIONS = (["read", "control", "admin"] as const).map((value) => ({
  value,
  label: ROLE_LABEL[value],
}));

/** "Used 5m ago" granularity: seconds and exact clock times are noise here. */
function usedLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Used just now";
  if (minutes < 60) return `Used ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Used ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `Used ${days}d ago`;
  return `Used ${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/**
 * The devices paired with this computer. An administrator sees every device,
 * can remove access and reaches "Pair another device"; anyone else sees only
 * this phone.
 */
export function DeviceAccess({ onPairAnother }: { onPairAnother: () => void }): JSX.Element {
  const api = useMemo(() => new DaemonApi(readPairingToken()), []);
  const [current, setCurrent] = useState<PairedDevice | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [revokeTarget, setRevokeTarget] = useState<PairedDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(Date.now);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const own = await api.fetchJson<{ device: PairedDevice }>("/api/device", {
        signal: AbortSignal.timeout(10_000),
      });
      setCurrent(own.device);
      if (own.device.role === "admin") {
        const list = await api.fetchJson<{ devices: PairedDevice[] }>(
          "/api/devices",
          { signal: AbortSignal.timeout(10_000) },
        );
        // The owner credential is not a registry entry, so the list would
        // otherwise leave out the device you are looking from.
        setDevices(
          list.devices.some((device) => device.id === own.device.id)
            ? list.devices
            : [own.device, ...list.devices],
        );
      } else {
        setDevices([own.device]);
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke() {
    if (!revokeTarget || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.fetchJson(
        `/api/devices/${encodeURIComponent(revokeTarget.id)}`,
        { method: "DELETE", signal: AbortSignal.timeout(10_000) },
      );
      setRevokeTarget(null);
      showToast("Removed access", "success");
      await load();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  const active = devices.filter((device) => !device.revokedAt);
  const revoked = devices.filter((device) => device.revokedAt);
  // Only an administrator manages access.
  const isAdmin = current?.role === "admin";

  function deviceRow(device: PairedDevice) {
    const self = device.id === current?.id;
    // The owner credential is the computer itself (the daemon's own
    // administration token), not a paired phone.
    const owner = device.id === "owner";
    // This phone leaves through Unpair on the Settings root, which also wipes
    // what it keeps; a second path here would be the same act worded twice.
    const removable = isAdmin && !device.revokedAt && !owner && !self;
    return (
      <Row
        key={device.id}
        className={device.revokedAt ? "opacity-60" : undefined}
        testId="paired-device"
        data-device-id={device.id}
        leading={owner ? <MonitorIcon /> : /ipad|tablet/i.test(device.name) ? <TabletIcon /> : <SmartphoneIcon />}
        title={owner ? "This computer" : device.name}
        subtitle={[
          self && !owner ? "This phone" : null,
          ROLE_LABEL[device.role],
          device.lastSeenAt && !self ? usedLabel(device.lastSeenAt, now) : null,
        ].filter(Boolean).join(" · ")}
        // The word is the affordance; red lives only in the confirmation.
        trailing={removable ? "Remove" : undefined}
        onClick={
          removable
            ? () => {
                setError(null);
                setRevokeTarget(device);
              }
            : undefined
        }
        aria-label={removable ? `${device.name}, remove access` : undefined}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {error !== null && !revokeTarget ? (
        <Notice
          tone="danger"
          title="Couldn’t load devices."
          action={(daemonErrorCause(error) === "access" ? undefined : errorRecoveryAction(error)) ?? { label: "Try again", onClick: () => void load() }}
          testId="device-access-error"
        >
          {humanizeDaemonError(error)}
        </Notice>
      ) : null}
      <RowGroup
        inset
        title="Devices"
        headingId="device-access-heading"
        aria-labelledby="device-access-heading"
        data-testid="device-access"
        footer={
          current && !isAdmin
            ? ROLE_DETAIL[current.role]
            : "A removed device needs a new code to connect again."
        }
      >
        {loading && !current && !error ? (
          <div aria-busy="true" aria-label="Loading devices">
            <RowSkeleton leading subtitle />
          </div>
        ) : null}
        {active.map(deviceRow)}
      </RowGroup>
      {isAdmin ? (
        <RowGroup inset>
          <Row
            leading={<PlusIcon />}
            title="Pair another device"
            chevron
            onClick={onPairAnother}
            testId="pair-another-device"
          />
        </RowGroup>
      ) : null}
      {revoked.length ? (
        <RowGroup title="Removed" inset>{revoked.map(deviceRow)}</RowGroup>
      ) : null}

      <ConfirmSheet
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRevokeTarget(null);
        }}
        title={`Remove ${revokeTarget?.name ?? "this device"}?`}
        description="It loses access right away and needs a new code to connect again."
        confirmLabel="Remove"
        onConfirm={() => void revoke()}
        busy={busy}
        busyLabel="Removing…"
      >
        {error !== null ? <Notice tone="danger">{humanizeDaemonError(error)}</Notice> : null}
      </ConfirmSheet>
    </div>
  );
}

/**
 * Settings › Computer › Pair another device. The QR code of the pairing link
 * is the hero: the new phone scans it from its own pair screen. The raw code
 * (64 hex characters) is a fallback for typing, one disclosure away, so it
 * never competes with the QR or the link.
 */
export function PairAnotherDevice(): JSX.Element {
  const api = useMemo(() => new DaemonApi(readPairingToken()), []);
  const [name, setName] = useState("");
  const [role, setRole] = useState<DeviceRole>("control");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; role: DeviceRole; name: string } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (!pairing) return;
    return startVisibleInterval(() => setNow(Date.now()), 1000, { tickOnShow: true });
  }, [pairing]);

  async function createCode() {
    if (pending.current) return;
    pending.current = true;
    const issuedFor = { role, name: name.trim() };
    setBusy(true);
    setError(null);
    try {
      const result = await api.fetchJson<{ code: string; expiresAt: number }>(
        "/api/devices/pairing-codes",
        {
          method: "POST",
          body: JSON.stringify({ role: issuedFor.role, ...(issuedFor.name ? { name: issuedFor.name } : {}) }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      setNow(Date.now());
      setShowCode(false);
      // The code grants the submitted permissions, not a later picker value.
      setPairing({ ...result, ...issuedFor });
    } catch (cause) {
      setError(humanizeDaemonError(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    if (await copyText(value)) showToast(`Copied ${label}`, "success");
    else showToast("Couldn\u2019t copy. Select the code instead.", "error");
  }

  if (!pairing) {
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void createCode();
        }}
      >
        <div className="flex flex-col gap-2">
          <span className="px-4 text-meta font-medium text-muted-foreground" aria-hidden>
            Access
          </span>
          <Segmented
            aria-label="Access"
            options={ROLE_OPTIONS.map((option) => ({ ...option, disabled: busy }))}
            value={role}
            onChange={(next) => { if (!pending.current) setRole(next); }}
            testId="new-device-role"
          />
          <p className="px-4 text-meta text-muted-foreground" aria-live="polite">
            {ROLE_DETAIL[role]}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-device-name" className="px-4 text-meta font-medium text-muted-foreground">
            Name (optional)
          </Label>
          <Input
            id="new-device-name"
            className="h-12 rounded-md border border-control bg-surface-1 px-4 text-body md:text-body"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            placeholder="For example, work phone"
          />
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button variant="primary" className="w-full" type="submit" disabled={busy}>
          {busy ? "Creating code\u2026" : "Create pairing code"}
        </Button>
      </form>
    );
  }

  const secondsLeft = Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));
  const expired = secondsLeft === 0;
  const link = pairingLink(pairing.code);
  return (
    <div className="flex flex-col items-center gap-6 motion-safe:animate-fade-in">
      <QrCode
        value={link}
        label="Pairing QR code"
        className={`w-full max-w-60 transition-opacity duration-[var(--dur-base)] ${expired ? "opacity-20" : ""}`}
        testId="pairing-qr"
      />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-ui">On the new phone, tap Scan QR code, or open the link there.</p>
        <p className="text-meta text-muted-foreground tabular-nums" role="status">
          {[
            ROLE_LABEL[pairing.role],
            pairing.name || null,
            expired
              ? "Expired"
              : `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`,
          ].filter(Boolean).join(" · ")}
        </p>
      </div>
      {expired ? (
        <Button variant="primary" className="w-full" onClick={() => setPairing(null)}>
          Create another code
        </Button>
      ) : (
        <Button variant="primary" className="w-full" onClick={() => void copy(link, "pairing link")}>
          <CopyIcon data-icon="inline-start" />
          Copy pairing link
        </Button>
      )}
      {expired ? null : (
        <div className="flex w-full flex-col gap-2">
          <Button
            variant="ghost"
            className="w-full"
            aria-expanded={showCode}
            onClick={() => setShowCode((v) => !v)}
          >
            {showCode ? <ChevronUpIcon data-icon="inline-start" /> : <ChevronDownIcon data-icon="inline-start" />}
            Enter code instead
          </Button>
          {showCode ? (
            <div className="flex w-full items-start gap-2 rounded-md bg-surface-1 py-2 pl-4 pr-1 motion-safe:animate-fade-in">
              <span
                className="min-w-0 flex-1 select-all break-all py-1.5 text-ui tabular-nums text-muted-foreground"
                data-testid="pairing-code"
              >
                {pairing.code}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground"
                aria-label="Copy code"
                onClick={() => void copy(pairing.code, "code")}
              >
                <CopyIcon />
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
