import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryIcon, LinkIcon, ScanLineIcon } from "lucide-react";

import { showToast } from "@/app/Notices";
import { Notice } from "@/app/ui/Notice";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { Row, RowGroup } from "@/app/ui/Row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi } from "@/runtime/rpc-client";
import { getOmpLocal } from "@/platform/local-mode";
import { BottomSheet } from "@/app/ui/Sheet";

const LAST_LINK_KEY = "omp-collab-last-link";

function loadLastLink(): string {
  try {
    return localStorage.getItem(LAST_LINK_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastLink(link: string) {
  try {
    if (link) localStorage.setItem(LAST_LINK_KEY, link);
  } catch {
    // ignore
  }
}

function hasBarcodeDetector(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessionPath: string | null;
};

export function CollabConnectSheet({ open, onOpenChange, sessionPath }: Props) {
  const [link, setLink] = useState("");
  const [lastLink, setLastLink] = useState<string>(() => loadLastLink());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cameraDenied, setCameraDenied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<unknown>(null);
  const scanTimerRef = useRef<number | null>(null);
  const scanEpoch = useRef(0);
  const scanPending = useRef(false);
  const viewRef = useRef({ open, sessionPath, onOpenChange });
  viewRef.current = { open, sessionPath, onOpenChange };
  const attachEpoch = useRef(0);
  const attachPending = useRef(false);

  const canScan = hasBarcodeDetector();

  useEffect(() => {
    if (open) {
      setLastLink(loadLastLink());
      setError(null);
      setScanError(null);
      // do not auto-start camera
    } else {
      stopScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stopScan = useCallback(() => {
    scanEpoch.current++;
    scanPending.current = false;
    detectorRef.current = null;
    setPreview(null);
    if (scanTimerRef.current !== null) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  }, []);

  // Invalidate pending permission/play/detection before a new view owns it.
  useLayoutEffect(() => () => stopScan(), [open, sessionPath, stopScan]);

  // The video is conditional on scanning, so it does not exist until the
  // accepted stream renders this preview. Attach only after that commit.
  useEffect(() => {
    const video = videoRef.current;
    if (!preview || !video || !viewRef.current.open) return;
    const epoch = scanEpoch.current;
    video.srcObject = preview;
    void (async () => {
      try { await video.play(); }
      catch {
        if (scanEpoch.current !== epoch) return;
        stopScan();
        setScanError("Couldn't start the camera.");
      }
    })();
    return () => { video.srcObject = null; };
  }, [preview, stopScan]);

  const cancelAttach = useCallback(() => {
    attachEpoch.current++;
    attachPending.current = false;
    setBusy(false);
  }, []);

  useLayoutEffect(() => {
    setError(null);
    return cancelAttach;
  }, [open, sessionPath, cancelAttach]);

  // All entry points share one request owner. A stale acknowledgement must
  // neither save a link nor close a later visit to this sheet.
  const performAttach = useCallback(async (target?: string) => {
    if (!viewRef.current.open || attachPending.current) return;
    const path = viewRef.current.sessionPath;
    if (!path) { setError("Open a session first."); return; }
    attachPending.current = true;
    const epoch = ++attachEpoch.current;
    const isCurrent = () => attachEpoch.current === epoch && viewRef.current.open && viewRef.current.sessionPath === path;
    stopScan();
    setBusy(true);
    setError(null);
    try {
      await new DaemonApi(readPairingToken() ?? "").collabAttach(path, target);
      if (!isCurrent()) return;
      if (target) { saveLastLink(target); setLastLink(target); }
      showToast("Live updates connected", "success");
      viewRef.current.onOpenChange(false);
    } catch (error) {
      if (isCurrent()) setError(error);
    } finally {
      if (isCurrent()) { attachPending.current = false; setBusy(false); }
    }
  }, [stopScan]);

  const startScan = useCallback(async () => {
    if (!canScan || !open || scanPending.current || streamRef.current || attachPending.current) return;
    cancelAttach();
    scanPending.current = true;
    const epoch = ++scanEpoch.current;
    const isCurrent = () => scanEpoch.current === epoch && viewRef.current.open && viewRef.current.sessionPath === sessionPath;
    setScanError(null);
    setCameraDenied(false);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      if (!isCurrent()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      if (!isCurrent()) return;
      // @ts-expect-error BarcodeDetector is not in lib.dom yet
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      detectorRef.current = detector;
      setPreview(stream);
      setScanning(true);
      scanTimerRef.current = window.setInterval(async () => {
        if (!isCurrent() || !videoRef.current || !detectorRef.current) return;
        try {
          // @ts-expect-error
          const codes = await detectorRef.current.detect(videoRef.current);
          if (!isCurrent()) return;
          if (Array.isArray(codes) && codes.length > 0) {
            const raw = codes[0]?.rawValue ?? codes[0]?.rawValue ?? "";
            if (typeof raw === "string" && raw.trim()) {
              const found = raw.trim();
              setLink(found);
              stopScan();
              if (sessionPath) await performAttach(found);
            }
          }
        } catch {
          // ignore per-frame errors
        }
      }, 400);
    } catch (error) {
      if (isCurrent()) {
        stopScan();
        setCameraDenied(error instanceof DOMException && error.name === "NotAllowedError");
        setScanError("Couldn't open the camera. You can paste a sharing link instead.");
      }
    } finally {
      if (scanEpoch.current === epoch) scanPending.current = false;
    }
  }, [canScan, cancelAttach, open, performAttach, sessionPath, stopScan]);

  const handleAttach = useCallback(async () => {
    const target = link.trim();
    if (!target) { setError("Paste the /collab link from your computer."); return; }
    await performAttach(target);
  }, [link, performAttach]);

  // Only the explicit Ask action omits a link. The daemon owns adoption
  // and keeps its session/write ownership checks authoritative.
  const handleAskComputer = useCallback(() => performAttach(), [performAttach]);
  const handleReconnect = useCallback(async () => {
    if (lastLink) await performAttach(lastLink);
  }, [lastLink, performAttach]);

  const native = getOmpLocal();

  return (
    <BottomSheet open={open} onOpenChange={(value) => {
      if (!value) { stopScan(); cancelAttach(); }
      onOpenChange(value);
    }} title="Connect live updates">
      <div className="flex flex-col gap-4">
        <p className="text-ui text-muted-foreground">
          Your computer has this session open but isn’t sharing it. Ask it to share, or paste its /collab link.
        </p>
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => void handleAskComputer()}
          type="button"
          variant="primary"
        >
          {busy ? "Asking your computer…" : "Ask your computer to share"}
        </Button>
        <RowGroup>
          {lastLink ? (
            <Row
              leading={<HistoryIcon className="size-5" aria-hidden />}
              title="Reconnect"
              subtitle={<span className="block truncate">{lastLink}</span>}
              disabled={busy}
              onClick={() => void handleReconnect()}
            />
          ) : null}
          <Row
            leading={<LinkIcon className="size-5" aria-hidden />}
            title={
              <Input
                id="collab-link"
                ref={linkRef}
                aria-label="Collab link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleAttach();
                }}
                placeholder="Paste a /collab link"
                className="h-11 border-0 bg-transparent px-0 text-ui shadow-none focus-visible:ring-0 dark:bg-transparent"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            }
            trailing={
              <Button size="sm" variant="ghost" className="text-primary-text" onClick={() => void handleAttach()} disabled={busy || !link.trim()}>
                Connect
              </Button>
            }
          />
          {canScan && !scanning ? (
            <Row
              leading={<ScanLineIcon className="size-5" aria-hidden />}
              title="Scan QR code"
              disabled={busy}
              onClick={() => void startScan()}
            />
          ) : null}
        </RowGroup>
        {scanning ? (
          <div className="flex flex-col gap-2">
            <div className="overflow-hidden rounded-lg bg-black">
              <video ref={videoRef} className="h-[220px] w-full object-cover" playsInline muted />
            </div>
            <Button className="w-full" onClick={stopScan}>
              Stop scanning
            </Button>
          </div>
        ) : null}
        {scanError ? <Notice tone="danger" action={cameraDenied && native?.openAppSettings
          ? { label: "Open app settings", onClick: () => native.openAppSettings?.() }
          : { label: "Paste link", onClick: () => linkRef.current?.focus() }}>{scanError}</Notice> : null}
        {error !== null ? <Notice tone="danger" action={errorRecoveryAction(error) ?? { label: "Paste link", onClick: () => linkRef.current?.focus() }}>{humanizeDaemonError(error)}</Notice> : null}
      </div>
    </BottomSheet>
  );
}
