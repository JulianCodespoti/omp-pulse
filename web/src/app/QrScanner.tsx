import { useEffect, useRef, useState, type JSX } from "react";
import { ArrowLeftIcon, KeyboardIcon, SettingsIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getOmpLocal } from "@/platform/local-mode";
import { isNativeShell } from "@/platform/native-shell";

import { useBackLayer } from "./back-layer";

type Decode = (video: HTMLVideoElement) => Promise<string | null>;

type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<{ rawValue?: string }[]> };
type BarcodeDetectorClass = {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

/** The camera can be opened at all: a secure context with media devices. */
export function canScanQr(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/**
 * The platform detector where it reads QR codes (Chromium and Android
 * WebView with Play services), otherwise jsQR on a downscaled frame. jsQR is
 * imported only on that path so the common case downloads nothing extra.
 */
async function createDecoder(): Promise<Decode> {
  const Detector = (window as Window & { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (Detector) {
    try {
      const formats = (await Detector.getSupportedFormats?.()) ?? ["qr_code"];
      if (formats.includes("qr_code")) {
        const detector = new Detector({ formats: ["qr_code"] });
        return async (video) => (await detector.detect(video))[0]?.rawValue?.trim() || null;
      }
    } catch {
      // A detector that cannot list or build falls through to jsQR.
    }
  }
  // Dynamic on purpose: a separate chunk fetched only on platforms without a
  // QR-capable BarcodeDetector, not a module every launch should download.
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    if (!context || !video.videoWidth) return null;
    // ~640px is plenty for a code that fills the frame, and keeps each pass
    // well under the scan interval on a phone CPU.
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" })?.data.trim() || null;
  };
}

function cameraError(cause: unknown): string {
  const name = cause instanceof DOMException || cause instanceof Error ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access is blocked.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera is available.";
  return "Couldn\u2019t start the camera.";
}

/**
 * Full-screen camera view that reports each decoded QR text to `onScan`.
 * `onScan` returns false when the text is not what the caller wants; the
 * scanner then says so and keeps looking instead of closing.
 */
export function QrScanner({
  onScan,
  onCancel,
  hint,
}: {
  onScan: (text: string) => boolean;
  onCancel: () => void;
  hint: string;
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  const [live, setLive] = useState(false);
  // Back closes the camera before it leaves whatever opened it.
  useBackLayer(true, { onBack: onCancel });

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let lastRejected = "";
    const stopStream = () => {
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
    };
    void (async () => {
      try {
        const [media, decode] = await Promise.all([
          // Without a size the WebView hands back 640x480, which object-cover
          // then blows up across a 1080p+ screen: the preview looked blurry
          // and small codes decoded slowly. Ask for 1080p and continuous focus.
          navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: "environment",
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
            },
            audio: false,
          }).then((media) => {
            // Acquisition can finish after Back or a decoder failure. Claim it
            // immediately, rather than waiting for both startup tasks to finish.
            if (stopped) {
              for (const track of media.getTracks()) track.stop();
            } else {
              stream = media;
            }
            return media;
          }),
          createDecoder(),
        ]);
        const video = videoRef.current;
        if (stopped || !video) {
          stopStream();
          return;
        }
        video.srcObject = media;
        await video.play();
        const tick = async () => {
          if (stopped) return;
          try {
            const text = await decode(video);
            if (stopped) return;
            if (text && text !== lastRejected) {
              if (onScanRef.current(text)) return;
              // Same wrong code on every frame: say it once, keep scanning.
              lastRejected = text;
              setRejected(true);
            }
          } catch {
            // A frame that cannot be read (not ready, mid-resize) is skipped.
          }
          timer = window.setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch (cause) {
        stopStream();
        if (!stopped) {
          stopped = true;
          setError(cameraError(cause));
          const name = cause instanceof Error || cause instanceof DOMException ? cause.name : "";
          setPermissionBlocked(name === "NotAllowedError" || name === "SecurityError");
        }
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stopStream();
    };
  }, []);
  const canOpenPermissions = permissionBlocked && typeof getOmpLocal()?.openAppSettings === "function";

  return (
    <div className="fixed inset-0 z-overlay flex flex-col bg-background" data-testid="qr-scanner">
      {/* Hidden until the first camera frame: before it, Android WebView paints
          its stock grey video placeholder (a play glyph) for about a second.
          A blank poster removes the glyph; the fade covers the rest. */}
      <video
        ref={videoRef}
        className={`absolute inset-0 size-full object-cover transition-opacity duration-(--dur-slow) ${live ? "opacity-100" : "opacity-0"}`}
        poster="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        onPlaying={() => setLive(true)}
        muted
        playsInline
        aria-hidden
      />
      <div className="relative flex items-center gap-2 px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Button variant="ghost" size="icon" aria-label="Back" onClick={onCancel}>
          <ArrowLeftIcon />
        </Button>
        <span className="text-title font-medium">Scan QR code</span>
      </div>
      <div className="relative flex flex-1 items-center justify-center px-8">
        {/* The frame is guidance only: the decoder reads the whole picture. */}
        <div className="aspect-square w-full max-w-64 rounded-xl border-2 border-foreground/80 shadow-[0_0_0_100vmax_oklch(0_0_0/0.45)]" aria-hidden />
      </div>
      <div className="relative flex flex-col gap-3 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <p className="text-center text-ui text-foreground" role="status">
          {error ?? (rejected ? "That isn\u2019t a pairing code. Scan the one your computer shows." : hint)}
        </p>
        {canOpenPermissions ? (
          <Button variant="primary" className="min-h-[48px] w-full" onClick={() => getOmpLocal()?.openAppSettings?.()}>
            <SettingsIcon aria-hidden data-icon="inline-start" />
            Camera settings
          </Button>
        ) : permissionBlocked ? (
          <details className="text-meta text-muted-foreground">
            <summary className="min-h-[48px] cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">Camera permissions</summary>
            <p>{isNativeShell() ? "This version cannot open permissions directly. Open Android Settings → Apps → omp-pulse → Permissions and allow Camera." : "Allow Camera in this site's browser permissions. If device settings also block it, allow camera access for this browser in system settings."}</p>
          </details>
        ) : null}
        <Button variant={canOpenPermissions ? "secondary" : "primary"} className="min-h-[48px] w-full" onClick={onCancel}>
          <KeyboardIcon data-icon="inline-start" />
          Enter code instead
        </Button>
      </div>
    </div>
  );
}
