import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";

import { Notice } from "./ui/Notice";
import { Row, RowGroup } from "./ui/Row";
import { StatusDot } from "./ui/Status";
import { humanizeDaemonError } from "./ui/OwnedBySession";
import { Button } from "@/components/ui/button";
import type { OmpSessionSummary } from "@/domain/protocol";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi } from "@/runtime/rpc-client";
import type { CommandReceiptState } from "@/runtime/api-types";
import { deliveryFailed } from "@/runtime/receipt-outcome";
import type {
  ClientDiagnostics,
  OmpSessionController,
} from "@/runtime/omp-session-controller";
import { showToast } from "./Notices";

interface HealthSnapshot {
  observedAt: number;
  releaseId: string;
  protocolVersion: number;
  minClientProtocolVersion: number;
  credentials: {
    environmentKeys: string[];
    brokerEnvironmentConfigured: boolean;
    effectiveSource: string | null;
  };
  session: null | {
    controlRoute: string;
    childRunning: boolean;
    receipts: {
      commandIdHash: string;
      state: string;
      updatedAt: number;
      code?: string;
    }[];
  };
}

function ageLabel(timestamp: number | null | undefined, now: number): string | null {
  if (!timestamp) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`;
}

interface HealthSelection {
  selected: OmpSessionSummary | undefined;
  sessionPath: string | null;
  sessionOpen: boolean;
  connection: string;
  sessionsUpdatedAt: number | null;
  queuedCount: number;
  cachedAt: number | null;
  model: string | null;
  provider: string | null;
}

// Retain only diagnostic facts, not a store snapshot that pins an old transcript.
function captureSelection(controller: OmpSessionController): HealthSelection {
  const state = controller.getStore().getState();
  const selected = state.sessions.find(
    (session) => session.path === state.sessionPath,
  );
  const rawModel = state.collabState?.model;
  const model =
    rawModel !== null && typeof rawModel === "object"
      ? (rawModel as Record<string, unknown>)
      : null;
  return {
    selected,
    sessionPath: state.sessionPath,
    sessionOpen: state.sessionPath !== null,
    connection: state.connection,
    sessionsUpdatedAt: state.sessionsUpdatedAt,
    queuedCount: state.queuedCount,
    cachedAt: state.staleHistory?.savedAt ?? null,
    model:
      typeof model?.id === "string"
        ? model.id
        : typeof selected?.model === "string"
          ? selected.model
          : null,
    provider: typeof model?.provider === "string" ? model.provider : null,
  };
}

/**
 * One read of the computer's health plus this phone's own connection facts.
 * Diagnostics and Technical details each hold one; the read is cheap and
 * never spawns an agent (src/server/http.rs `health`).
 */
function useHealth(controller: OmpSessionController) {
  const api = useMemo(() => new DaemonApi(readPairingToken()), []);
  const [server, setServer] = useState<HealthSnapshot | null>(null);
  const [sample, setSample] = useState(() => captureSelection(controller));
  const [sampleAt, setSampleAt] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<ClientDiagnostics | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError(null);
      setSample(captureSelection(controller));
      setSampleAt(Date.now());
      try {
        const session = controller.getStore().getState().sessionPath;
        const query = session ? `?${new URLSearchParams({ session })}` : "";
        const deadline = AbortSignal.timeout(10_000);
        const health = await api.fetchJson<HealthSnapshot>(`/api/health${query}`, {
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
        if (signal?.aborted) return;
        setServer(health);
      } catch (cause) {
        if (signal?.aborted) return;
        setServer(null);
        setError(humanizeDaemonError(cause));
      } finally {
        if (!signal?.aborted) {
          setClient(controller.getDiagnostics());
          setBusy(false);
        }
      }
    },
    [api, controller],
  );

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);

  return { server, sample, sampleAt, busy, error, client, refresh };
}

/**
 * Diagnostics in plain words: is the computer reachable, how fresh is what
 * this phone shows, is anything waiting to send. The mechanism behind each
 * answer is one row deeper, under Technical details.
 */
export function HealthPanel({
  controller,
  notifications,
  onNotifications,
  onTechnicalDetails,
  onOpenSession,
}: {
  controller: OmpSessionController;
  /** Notification state as Settings already words it ("On", "Off", …). */
  notifications: string;
  /** Opens the Notifications page: the one place that state is changed. */
  onNotifications: () => void;
  onTechnicalDetails: () => void;
  onOpenSession: (path: string) => void;
}): JSX.Element {
  const { server, sample, sampleAt, busy, error, client, refresh } = useHealth(controller);
  const latestProblem = server?.session?.receipts.findLast(
    (receipt) => receipt.state === "uncertain" ||
      deliveryFailed({ state: receipt.state as CommandReceiptState, code: receipt.code }),
  );
  const connection: { tone: "success" | "warning" | "danger" | null; text: string } =
    error
      ? { tone: "danger", text: "Can\u2019t reach" }
      : busy && !server
        ? { tone: null, text: "Checking\u2026" }
        : sample.sessionOpen && sample.connection !== "open"
          ? { tone: "warning", text: "Reconnecting\u2026" }
          : { tone: "success", text: "Connected" };
  const lastUpdate = ageLabel(
    Math.max(client?.lastFrameAt ?? 0, client?.heartbeatAt ?? 0, sample.sessionsUpdatedAt ?? 0),
    sampleAt,
  );
  const releaseId = import.meta.env.VITE_RELEASE_ID || "dev";

  function downloadSnapshot() {
    const snapshot = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      clientReleaseId: releaseId,
      client,
      server,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pulse-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Diagnostics downloaded", "success");
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-6"
      aria-label="Diagnostics"
      data-testid="connection-health"
    >
      {error ? (
        <Notice tone="danger" action={{ label: "Check again", onClick: () => void refresh() }}>
          {error}
        </Notice>
      ) : latestProblem ? (
        <Notice tone="warning" action={sample.sessionPath ? {
          label: "View message",
          onClick: () => { if (sample.sessionPath) onOpenSession(sample.sessionPath); },
        } : undefined}>
          {latestProblem.state === "uncertain"
            ? "Delivery of your last message is unconfirmed."
            : "Your last message didn\u2019t go through."}
        </Notice>
      ) : null}
      <RowGroup inset footer={`Checked ${new Date(sampleAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}>
        <Row
          title="Connection"
          trailing={
            <span className="flex items-center gap-2" role="status">
              {connection.tone ? <StatusDot tone={connection.tone} /> : null}
              {connection.text}
              {/* One retry control: on error the Notice above owns it. */}
              {error ? null : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-mr-2 text-muted-foreground"
                  aria-label="Check again"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  {busy ? <Spinner size={16} label={null} /> : <RefreshCwIcon />}
                </Button>
              )}
            </span>
          }
        />
        <Row title="Last update" trailing={lastUpdate ?? "Not yet"} />
        <Row
          title="Messages waiting to send"
          trailing={sample.queuedCount === 0 ? "None" : String(sample.queuedCount)}
        />
        <Row title="Notifications" trailing={notifications} chevron onClick={onNotifications} testId="diagnostics-notifications" />
      </RowGroup>
      <RowGroup inset footer="The download leaves out messages, attachments, credentials and folder paths.">
        <Row
          title="Technical details"
          chevron
          onClick={onTechnicalDetails}
          testId="diagnostics-technical"
        />
        <Row
          title="Download diagnostics"
          onClick={!client || busy ? undefined : downloadSnapshot}
          disabled={!client || busy}
        />
      </RowGroup>
    </section>
  );
}

const ROUTE_LABEL: Record<string, string> = {
  "desktop-relay": "Computer app relay",
  "daemon-child": "Agent run by omp-pulse",
  unestablished: "Chosen when sending",
};

/**
 * The mechanism behind Diagnostics: socket timings, the control route,
 * activity evidence, credential overrides and recent command receipts. This
 * is the one place those words are allowed.
 */
export function HealthDetails({ controller }: { controller: OmpSessionController }): JSX.Element {
  const { server, sample, sampleAt, busy, error, client, refresh } = useHealth(controller);
  const selected = sample.selected;
  const route = server?.session?.controlRoute;
  const rows: { label: string; value: string | null }[] = [
    { label: "Conversation stream", value: sample.sessionOpen ? sample.connection : "No chat open" },
    { label: "Session list refreshed", value: ageLabel(sample.sessionsUpdatedAt, sampleAt) },
    {
      label: "Control route",
      value: server
        ? route
          ? (ROUTE_LABEL[route] ?? route)
          : "No chat open"
        : busy
          ? "Checking\u2026"
          : null,
    },
    { label: "Last received frame", value: ageLabel(client?.lastFrameAt, sampleAt) },
    { label: "Socket heartbeat", value: ageLabel(client?.heartbeatAt, sampleAt) },
    {
      label: "Activity evidence",
      value: selected?.activitySource
        ? `${selected.activitySource}${selected.activityStale ? " · stale" : ""}`
        : null,
    },
    { label: "Activity observed", value: ageLabel(selected?.activityObservedAt, sampleAt) },
    { label: "Model", value: sample.model },
    { label: "Provider", value: sample.provider },
    { label: "Outbox", value: `${sample.queuedCount} command${sample.queuedCount === 1 ? "" : "s"}` },
    {
      label: "Cached conversation",
      value: sample.cachedAt !== null ? `Offline copy · ${ageLabel(sample.cachedAt, sampleAt) ?? "saved"}` : "None",
    },
    { label: "Credential source", value: server?.credentials.effectiveSource ?? null },
    {
      label: "Protocol",
      value: client
        ? `${client.protocolVersion}${client.serverProtocolVersion !== null ? ` · computer ${client.serverProtocolVersion}` : ""}`
        : null,
    },
  ];
  const observed = rows.filter((row) => row.value !== null);
  const missing = rows.filter((row) => row.value === null).map((row) => row.label);

  return (
    <section className="flex min-w-0 flex-col gap-6" aria-label="Technical details" data-testid="diagnostics-details">
      {error ? (
        <Notice tone="danger" action={{ label: "Check again", onClick: () => void refresh() }}>
          {error}
        </Notice>
      ) : null}
      <RowGroup
        inset
        footer={
          missing.length
            ? `Not observed yet: ${missing.join(", ").toLowerCase()}.`
            : undefined
        }
      >
        {observed.map((row) => (
          <Row
            key={row.label}
            title={row.label}
            trailing={<span className="block break-words first-letter:uppercase">{row.value}</span>}
          />
        ))}
      </RowGroup>
      {server?.session?.receipts.length ? (
        <RowGroup inset title="Recent command receipts" footer="Identifiers are redacted hashes.">
          {server.session.receipts.slice(-4).map((receipt) => (
            <Row
              key={receipt.commandIdHash}
              title={
                <code className="block truncate font-mono text-code">
                  {receipt.commandIdHash.slice(0, 12)}
                </code>
              }
              subtitle={`${ageLabel(receipt.updatedAt, sampleAt) ?? ""}${receipt.code ? ` · ${receipt.code}` : ""}` || undefined}
              trailing={<span className="first-letter:uppercase">{receipt.state}</span>}
            />
          ))}
        </RowGroup>
      ) : null}
      {server?.credentials.environmentKeys.length ? (
        <RowGroup
          inset
          title="Credential overrides"
          footer={
            <>
              If this phone and your computer behave differently, check these
              first. Values are never shown.
              {server.credentials.brokerEnvironmentConfigured
                ? " Your computer also signs in to model providers through a sign-in service."
                : ""}
            </>
          }
        >
          {server.credentials.environmentKeys.map((key) => (
            <Row
              key={key}
              title={
                // Wrap at underscores only; a key never splits mid-word.
                <code className="font-mono text-code">
                  {key.split("_").map((part, i) => (
                    <span key={i}>
                      {i ? <>_<wbr /></> : null}
                      {part}
                    </span>
                  ))}
                </code>
              }
            />
          ))}
        </RowGroup>
      ) : server?.credentials.brokerEnvironmentConfigured ? (
        <p className="px-4 text-meta text-muted-foreground">
          Your computer signs in to model providers through a sign-in service.
        </p>
      ) : null}
    </section>
  );
}
