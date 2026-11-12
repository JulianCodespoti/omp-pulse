import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi, type DesktopAgentFollowUpTarget } from "@/runtime/rpc-client";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { ErrorNotice } from "@/app/ui/ErrorNotice";
import { CopyButton } from "@/app/parts/CopyButton";

type Phase = "checking" | "ready" | "unavailable" | "sending" | "handoff" | "uncertain";

/** This action addresses one captured native desktop agent, not the main composer. */
export function DesktopAgentReply({ sessionPath, target, name, isCurrent, onBackToAgents }: {
  sessionPath: string;
  target: DesktopAgentFollowUpTarget;
  name: string;
  isCurrent: () => boolean;
  onBackToAgents?: () => void;
}): JSX.Element {
  const credential = readPairingToken();
  const [phase, setPhase] = useState<Phase>("checking");
  const [text, setText] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const sending = useRef(false);
  const operation = useRef<object | null>(null);
  const alive = useRef(false);
  const currentGuard = useRef(isCurrent);
  currentGuard.current = isCurrent;
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const request = new AbortController();
    operation.current = null;
    sending.current = false;
    setPhase("checking");
    setReason(null);
    setText("");
    void new DaemonApi(credential).getDesktopAgentFollowUp(sessionPath, target, request.signal).then(result => {
      if (request.signal.aborted || !alive.current || !currentGuard.current() || readPairingToken() !== credential) return;
      setPhase(result.available ? "ready" : "unavailable");
      setReason(result.reason ?? null);
    }, error => {
      if (request.signal.aborted || !alive.current || !currentGuard.current() || readPairingToken() !== credential) return;
      setPhase("unavailable");
      setReason(humanizeDaemonError(error));
    });
    return () => request.abort();
  }, [credential, sessionPath, target]);

  async function send(): Promise<void> {
    if (phase !== "ready" || sending.current || !text.trim() || !currentGuard.current() || readPairingToken() !== credential) return;
    sending.current = true; // React state cannot fence two taps in one turn.
    const ticket = {};
    operation.current = ticket;
    setPhase("sending");
    setReason(null);
    try {
      await new DaemonApi(credential).sendDesktopAgentFollowUp(sessionPath, target, text);
      if (operation.current !== ticket || !alive.current || !currentGuard.current() || readPairingToken() !== credential) return;
      setPhase("handoff");
    } catch (error: unknown) {
      if (operation.current !== ticket || !alive.current || !currentGuard.current() || readPairingToken() !== credential) return;
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      const refused = typeof status === "number" && status < 500;
      setPhase(refused ? "unavailable" : "uncertain");
      setReason(humanizeDaemonError(error));
    } finally {
      if (operation.current === ticket) sending.current = false;
    }
  }

  const status = phase === "checking" ? "Checking direct reply availability…"
    : phase === "sending" ? "Sending follow-up…"
    : phase === "handoff" ? "Handed to the desktop connection. Check the agent conversation for its response."
    : phase === "uncertain" ? "Delivery is unconfirmed. Your follow-up is kept; check the desktop before sending again."
    : phase === "unavailable" ? reason ?? "Direct reply is unavailable for this connection."
    : "This goes directly to the selected agent, using its conversation context.";
  return <form className="space-y-2" data-testid="desktop-agent-reply" onSubmit={event => { event.preventDefault(); void send(); }}>
    <p className="text-meta font-medium">Reply to {name}</p>
    <Textarea aria-label={`Follow-up to ${name}`} value={text} disabled={phase !== "ready"} onChange={event => setText(event.currentTarget.value)} placeholder="Send a follow-up to this agent…" />
    {phase !== "unavailable" ? <p role="status" className="text-meta text-muted-foreground">{status}</p> : null}
    {phase === "uncertain" && reason ? <p className="text-meta text-danger">{reason}</p> : null}
    {phase === "unavailable" ? <ErrorNotice message={status} action={errorRecoveryAction(reason) ?? (!text && onBackToAgents ? { label: "Back to agents", onClick: onBackToAgents } : undefined)} /> : null}
    {(phase === "uncertain" || phase === "unavailable") && text ? <CopyButton text={text} label="Copy follow-up" showLabel /> : null}
    <Button type="submit" variant="primary" className="w-full" data-testid="desktop-agent-reply-send" disabled={phase !== "ready" || !text.trim()}>Send to agent</Button>
    {phase === "handoff" ? <Button type="button" variant="ghost" className="w-full" onClick={() => { setText(""); setPhase("ready"); }}>Write another follow-up</Button> : null}
  </form>;
}
