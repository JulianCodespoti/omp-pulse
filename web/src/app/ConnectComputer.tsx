import { useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CopyIcon, KeyboardIcon, QrCodeIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import { connectLaptop } from "../platform/local-mode";
import type { OmpLocalBridge } from "../platform/local-mode";
import { isPairingLink } from "./pairing-link";
import { canScanQr, QrScanner } from "./QrScanner";
import { ErrorNotice } from "./ui/ErrorNotice";

const PAIR_COMMAND = "omp-pulse pair";

/**
 * Connecting this phone to a computer in one scan. `omp-pulse pair` on the
 * computer shows a QR code of `https://<computer>/app/#pair=CODE`; scanning
 * it saves the address, switches to computer mode and pairs, with nothing
 * typed. Pasting the same link does the same. This is the ONLY way a computer
 * is added (the pair screen's scanner routes here too): a typed address, then
 * a second screen for the code, was the old way and is gone.
 */
export function ConnectComputer({ bridge }: { bridge: OmpLocalBridge }): JSX.Element {
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(() => !canScanQr());
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const submit = (value: string): boolean => {
    const trimmed = value.trim();
    const refusal = isPairingLink(trimmed)
      ? connectLaptop(bridge, trimmed)
      : "That isn\u2019t a pairing link. Copy the link omp-pulse pair prints, or scan its code.";
    setError(refusal);
    setBusy(!refusal);
    return !refusal;
  };

  if (scanning) {
    // Portaled: inside a sheet, a transformed ancestor would confine the
    // scanner's `fixed inset-0` to the sheet instead of the screen.
    return createPortal(
      <QrScanner
        hint={`Point the camera at the code from ${PAIR_COMMAND} on your computer.`}
        onCancel={() => {
          setScanning(false);
          setTyping(true);
        }}
        onScan={(scanned) => {
          // Not a pairing link: keep looking (the scanner says so).
          if (!isPairingLink(scanned.trim())) return false;
          setScanning(false);
          submit(scanned);
          return true;
        }}
      />,
      document.body,
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="connect-computer">
      <ol className="flex flex-col gap-3 text-ui text-muted-foreground">
        <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>1. On your computer, run</span>
          <button
            type="button"
            className="press-bounce inline-flex min-h-11 items-center gap-2 rounded-full bg-surface-2 px-3 font-mono text-code text-foreground"
            aria-label={`Copy ${PAIR_COMMAND}`}
            onClick={() => {
              void navigator.clipboard?.writeText(PAIR_COMMAND).then(() => setCopied(true), () => undefined);
            }}
          >
            {PAIR_COMMAND}
            {copied ? <CheckIcon aria-hidden className="size-3.5 text-success" /> : <CopyIcon aria-hidden className="size-3.5 text-muted-foreground" />}
          </button>
        </li>
        <li>2. Scan the code it shows. That&rsquo;s it.</li>
      </ol>
      {error ? <ErrorNotice message={error} /> : null}
      {typing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit(text);
          }}
        >
          <Input
            aria-label="Pairing link"
            placeholder="Paste the link it prints"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            className="h-12 rounded-full border border-hairline bg-surface-1 px-4 text-body md:text-body"
            value={text}
            disabled={busy}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            data-testid="connect-computer-link"
          />
          <Button type="submit" variant="primary" className="w-full" disabled={busy || !text.trim()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? "Connecting\u2026" : "Connect"}
          </Button>
        </form>
      ) : null}
      {canScanQr() ? (
        <div className="flex flex-col gap-2">
          {typing ? null : (
            <Button variant="primary" className="w-full" disabled={busy} onClick={() => setScanning(true)} data-testid="connect-computer-scan">
              {busy ? <Spinner data-icon="inline-start" /> : <QrCodeIcon data-icon="inline-start" />}
              {busy ? "Connecting\u2026" : "Scan code"}
            </Button>
          )}
          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            disabled={busy}
            onClick={() => {
              setTyping((now) => !now);
              setError(null);
            }}
          >
            {typing ? <QrCodeIcon data-icon="inline-start" /> : <KeyboardIcon data-icon="inline-start" />}
            {typing ? "Scan the code instead" : "Paste the link instead"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
