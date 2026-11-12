"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DaemonApi } from "../../runtime/rpc-client";
import { readPairingToken } from "../../platform/browser-storage";
import { humanizeDaemonError } from "../ui/OwnedBySession";

// ─── Helpers ────────────────────────────────────────────────────────────

function canRecord(): boolean {
  if (typeof window === "undefined") return false;
  // MediaRecorder and getUserMedia require HTTPS (secure context).
  // The app is served over a Tailscale HTTPS name, so this normally holds —
  // but when it does not we report unsupported with a reason rather than
  // failing at tap time.
  const secure = (window as unknown as { isSecureContext?: boolean }).isSecureContext !== false;
  // In practice `isSecureContext` is true on https + localhost. Guard strictly:
  // only claim unsupported when it is explicitly false.
  if ((window as unknown as { isSecureContext?: boolean }).isSecureContext === false) return false;
  void secure;
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function unsupportedReason(): string {
  if (typeof window !== "undefined" && (window as unknown as { isSecureContext?: boolean }).isSecureContext === false) {
    return "Voice input needs an HTTPS address; this page is not a secure context.";
  }
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return "Voice input not supported in this browser.";
  }
  return "Voice input unavailable.";
}

function releaseTracks(stream: MediaStream | null): void {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}

// Peak RMS below this is considered silence (mic captured no sound).
const SILENT_THRESHOLD = 0.02;

/** How long POST /api/transcribe may take: a fixed allowance plus the audio itself. */
export function transcribeDeadlineMs(audioMs: number): number {
  return 30_000 + Math.max(0, Math.round(audioMs));
}

/** One finished recording, kept after a failure or cancel so Retry needs no new speech. */
interface Take {
  blob: Blob;
  audioMs: number;
  scope: string | null;
}

class TranscribeDeadlineError extends Error {}

// ─── Public types ───────────────────────────────────────────────────────

export type DictationStatus =
  | "unsupported"
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "denied"
  | "error";

export interface UseDictationOptions {
  /** When omitted the hook creates one from the stored pairing token. */
  daemonApi?: DaemonApi;
  /**
   * Where the transcript belongs (the composer's session). Captured when a
   * recording starts and handed back with its transcript; a kept recording is
   * dropped once the scope changes.
   */
  scope?: string | null;
  /** Called with the trimmed transcript and the scope its recording started in. */
  onTranscribed: (text: string, scope: string | null) => void;
  onError?: (message: string) => void;
}

export interface UseDictationReturn {
  status: DictationStatus;
  /** Human reason when status === "unsupported". */
  reason: string | null;
  /** Human error when status === "denied" or "error". */
  error: string | null;
  /** Last error, persists for UI toast even after status transitions. Alias of error for now but surfaced as lastError per spec. */
  lastError: string | null;
  /** Original failure, retained for recovery routing before humanization. */
  recoveryError?: unknown;
  /** Milliseconds since recording started. */
  elapsedMs: number;
  /** Milliseconds remaining until the 120s auto-stop. */
  remainingMs: number;
  /** True when the mic can actually be used right now. */
  canRecord: boolean;
  /** Live input level 0..1 while recording (driven by AnalyserNode). */
  level: number;
  /** True when the last completed recording never exceeded the noise floor. */
  silent: boolean;
  /** A failed or cancelled transcription kept its recording for this scope. */
  canRetry: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
  /** Transcribe the kept recording again, without speaking again. */
  retry: () => void;
  /** Forget the kept recording. */
  discardRetry: () => void;
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function useDictation(options: UseDictationOptions): UseDictationReturn {
  const { onTranscribed, onError, scope = null } = options;
  // Read at start() and on Retry; the transcript keeps the scope it started in.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const apiRef = useRef<DaemonApi | null>(options.daemonApi ?? null);
  if (!apiRef.current) {
    try {
      const token = readPairingToken();
      apiRef.current = new DaemonApi(token, window.location.origin);
    } catch {
      apiRef.current = new DaemonApi("", window.location.origin);
    }
  } else if (options.daemonApi && options.daemonApi !== apiRef.current) {
    apiRef.current = options.daemonApi;
  }

  const onTranscribedRef = useRef(onTranscribed);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTranscribedRef.current = onTranscribed;
  }, [onTranscribed]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const initialStatus: DictationStatus = canRecord() ? "idle" : "unsupported";
  const initialReason = initialStatus === "unsupported" ? unsupportedReason() : null;

  const [status, setStatus] = useState<DictationStatus>(initialStatus);
  const [reason, setReason] = useState<string | null>(initialReason);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<unknown>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);
  const [canRetry, setCanRetry] = useState(false);

  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const requestRef = useRef(0);
  const chunksRef = useRef<BlobPart[]>([]);
  const startAtRef = useRef<number>(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  // The recording now being uploaded, the one kept for Retry, the request's
  // abort switch, and the scope the current recording started in.
  const takeRef = useRef<Take | null>(null);
  const keptRef = useRef<Take | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startScopeRef = useRef<string | null>(null);

  // Audio analyser refs — same MediaStream as recorder, no second getUserMedia.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakRef = useRef<number>(0);

  const clearTimers = useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  const teardownAudio = useCallback(() => {
    if (rafRef.current !== null) {
      try {
        window.cancelAnimationFrame(rafRef.current);
      } catch {
        // ignore
      }
      rafRef.current = null;
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      // ignore
    }
    sourceRef.current = null;
    analyserRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx) {
      try {
        // Closing frees the mic indicator on Android; must happen on every exit path.
        void ctx.close();
      } catch {
        // ignore
      }
    }
  }, []);

  const cleanupRecording = useCallback(() => {
    clearTimers();
    teardownAudio();
    const rec = recorderRef.current;
    const stream = streamRef.current;
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    // ALWAYS release the microphone: stop every track in a finally-equivalent
    // path, including on error, unmount and cancel. A phone that keeps the mic
    // light on after a failed dictation is unacceptable.
    releaseTracks(stream);
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // ignore — we already released the tracks
      }
    }
  }, [clearTimers, teardownAudio]);

  useEffect(() => {
    // If the secure-context check flips (e.g. after a navigation), reflect it.
    if (!canRecord() && statusRef.current !== "unsupported") {
      setStatus("unsupported");
      setReason(unsupportedReason());
    }
    return () => {
      // Unmount — release mic and audio context unconditionally. Opening
      // another chat remounts the composer: a recording the user already
      // stopped still transcribes, and its text goes to the chat it started
      // in (the caller's onTranscribed handles a view that is gone). A
      // recording still running is discarded.
      const stopped = statusRef.current === "transcribing" && recorderRef.current === null;
      if (!stopped) {
        requestRef.current++;
        abortRef.current?.abort();
      }
      keptRef.current = null;
      clearTimers();
      teardownAudio();
      releaseTracks(streamRef.current);
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
      recorderRef.current = null;
      streamRef.current = null;
    };
  }, [clearTimers, teardownAudio]);

  const transcribeBlob = useCallback(
    async (take: Take, request: number) => {
      if (request !== requestRef.current) return;
      const api = apiRef.current;
      if (!api) {
        const msg = "Transcription is not available. Try again.";
        setStatus("error");
        setError(msg);
        setLastError(msg);
        onErrorRef.current?.(msg);
        return;
      }
      // Guard empty blob before upload — never post nothing.
      if (take.blob.size === 0) {
        const msg = "No audio captured. Try again.";
        setStatus("error");
        setError(msg);
        setLastError(msg);
        onErrorRef.current?.(msg);
        return;
      }
      takeRef.current = take;
      keptRef.current = null;
      setCanRetry(false);
      statusRef.current = "transcribing";
      setStatus("transcribing");
      setError(null);
      setRecoveryError(null);
      const controller = new AbortController();
      abortRef.current = controller;
      // The request helper times out reads only; an upload gets its own
      // deadline, long enough for the daemon to decode this much audio.
      // Racing the abort also ends a transport that ignores the signal.
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      const timer = window.setTimeout(
        () => controller.abort(new TranscribeDeadlineError("deadline")),
        transcribeDeadlineMs(take.audioMs),
      );
      try {
        // Daemon contract — src/server/http.rs:1715-1740 transcribe handler:
        //   let Some(b64) = body.get("audio").and_then(|v| v.as_str()) else { BAD_REQUEST "audio (base64) required" };
        //   let mime = body.get("mime").and_then(|v| v.as_str()).unwrap_or("audio/webm");
        //   let audio = STANDARD.decode(b64) ...
        //   match state.asr.transcribe(&audio, mime).await { Ok(t) => ok(json!({"ok":true,"text":t.text,"ms":..., "audioMs":..., "model":...})), Err(e) => ok(json!({"ok":false,"error":e})) }
        // So we POST JSON { audio: base64(STANDARD), mime } to POST /api/transcribe
        // and read { ok, text } — match exactly; do NOT guess multipart/raw.
        const text = await Promise.race([api.transcribe(take.blob, controller.signal), aborted]);
        if (request !== requestRef.current) return;
        takeRef.current = null;
        const trimmed = text.trim();
        statusRef.current = trimmed ? "idle" : "error";
        if (trimmed) {
          onTranscribedRef.current(trimmed, take.scope);
          setStatus("idle");
          setError(null);
          setLastError(null);
          setSilent(false);
        } else {
          const msg = "Did not catch that. Try again.";
          setStatus("error");
          setError(msg);
          setLastError(msg);
          onErrorRef.current?.(msg);
        }
      } catch (err) {
        if (request !== requestRef.current) return;
        takeRef.current = null;
        statusRef.current = "error";
        setRecoveryError(err);
        // The recording is fine; only its transcription failed. Keep it so
        // Retry can send it again without the user speaking again.
        keptRef.current = take;
        setCanRetry(true);
        // Raw daemon/exception text is never shown; the shared humaniser turns
        // the daemon's structured error (model missing, decode failure) into words.
        const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
        const msg = err instanceof TranscribeDeadlineError
          ? "Couldn't transcribe in time."
          : /network|fetch/i.test(raw)
            ? "Couldn't reach your computer to transcribe."
            : humanizeDaemonError(err);
        setStatus("error");
        setError(msg);
        setLastError(msg);
        onErrorRef.current?.(msg);
      } finally {
        window.clearTimeout(timer);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  const stopAndTranscribe = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    const request = requestRef.current;
    const stream = streamRef.current;
    // Detach the recorder once, but keep the stopping stream reachable by
    // Cancel while its final data event is pending.
    recorderRef.current = null;
    statusRef.current = "transcribing";
    setStatus("transcribing");
    clearTimers();
    const audioMs = startAtRef.current ? Date.now() - startAtRef.current : 0;

    let mimeType = (rec?.mimeType as string | undefined) || "audio/webm";

    if (rec && rec.state !== "inactive") {
      // Await the `stop` event so the final ondataavailable chunk is flushed.
      // Reading chunks synchronously after rec.stop() yields an empty array and
      // is exactly the reported "nothing happens" symptom.
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const origStop = rec.onstop;
        const origError = rec.onerror;
        rec.onstop = (ev: Event) => {
          try {
            if (typeof origStop === "function") (origStop as unknown as (e: Event) => void)(ev);
          } catch {
            // ignore
          }
          done();
        };
        rec.onerror = (ev: Event) => {
          try {
            if (typeof origError === "function") (origError as unknown as (e: Event) => void)(ev);
          } catch {
            // ignore
          }
          done();
        };
        window.setTimeout(done, 800);
        try {
          rec.stop();
        } catch {
          done();
        }
      });
      mimeType = (rec.mimeType as string | undefined) || mimeType;
    }

    // A cancelled/replaced recording owns only its local stream, never the
    // next recording's analyser, chunks, status or callbacks.
    if (request !== requestRef.current) {
      releaseTracks(stream);
      return;
    }

    // Capture peak before tearing down the analyser.
    const peak = peakRef.current;
    const hadAudio = analyserRef.current !== null || peak > 0;
    // Always tear down AudioContext (stops rAF, disconnects nodes, closes context) — leaked context keeps mic light on Android.
    teardownAudio();
    setLevel(0);
    // ALWAYS release the microphone — on every path, including error/cancel.
    releaseTracks(stream);
    if (streamRef.current === stream) streamRef.current = null;

    const chunks = chunksRef.current.slice();
    chunksRef.current = [];

    // Silent detection: mic captured nothing — do NOT upload, actionable message.
    if (hadAudio && peak < SILENT_THRESHOLD) {
      setSilent(true);
      const msg = "No sound detected. Check that your microphone is not muted and no other app is using it, then try again.";
      setStatus("error");
      setError(msg);
      setLastError(msg);
      onErrorRef.current?.(msg);
      setElapsedMs(0);
      return;
    }
    setSilent(false);

    if (chunks.length === 0) {
      setStatus("error");
      const msg = "No audio captured. Try again.";
      setError(msg);
      setLastError(msg);
      onErrorRef.current?.(msg);
      setElapsedMs(0);
      return;
    }

    // Build Blob with the recorder's real mimeType (Chrome Android: audio/webm;codecs=opus)
    // rather than a hardcoded string.
    const blobMime = mimeType || (chunks[0] as Blob | undefined)?.type || "audio/webm";
    const blob = new Blob(chunks as BlobPart[], { type: blobMime });

    if (blob.size === 0) {
      setStatus("error");
      const msg = "No audio captured. Try again.";
      setError(msg);
      setLastError(msg);
      onErrorRef.current?.(msg);
      setElapsedMs(0);
      return;
    }

    setElapsedMs(0);
    await transcribeBlob({ blob, audioMs, scope: startScopeRef.current }, request);
  }, [clearTimers, teardownAudio, transcribeBlob]);

  const start = useCallback(async () => {
    if (statusRef.current === "recording" || statusRef.current === "requesting" || statusRef.current === "transcribing") return;
    const request = ++requestRef.current;

    if (!canRecord()) {
      setStatus("unsupported");
      const r = unsupportedReason();
      setReason(r);
      setError(null);
      setLastError(null);
      return;
    }

    setError(null);
    setLastError(null);
    setRecoveryError(null);
    setReason(null);
    statusRef.current = "requesting";
    setStatus("requesting");
    setElapsedMs(0);
    setLevel(0);
    setSilent(false);
    peakRef.current = 0;
    // A new recording replaces any kept one and belongs to the current scope.
    keptRef.current = null;
    setCanRetry(false);
    startScopeRef.current = scopeRef.current;
    // Load the daemon's speech model now so it overlaps the recording; the
    // daemon drops it a few minutes after dictation stops. Test doubles may
    // implement only transcribe, hence the optional call.
    void apiRef.current?.warmTranscriber?.();

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err: unknown) {
      if (request !== requestRef.current) return;
      setRecoveryError(err);
      const e = err as { name?: string; message?: string } | null;
      const name = e?.name ?? "";
      releaseTracks(stream);
      // Also ensure any dangling streamRef is released
      releaseTracks(streamRef.current);
      streamRef.current = null;

      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        setStatus("denied");
        const msg = "Microphone access is blocked.";
        setError(msg);
        setLastError(msg);
        onErrorRef.current?.(msg);
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setStatus("error");
        const msg = "No microphone found. Connect a microphone and try again.";
        setError(msg);
        setLastError(msg);
        onErrorRef.current?.(msg);
      } else {
        setStatus("error");
        const msg = "Could not start recording. Try again.";
        setError(msg);
        setLastError(msg);
        onErrorRef.current?.(msg);
      }
      setStatus((prev) => (prev === "requesting" ? (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError" ? "denied" : "error") : prev));
      // Permission failures are terminal: pin the state so the button can
      // explain how to re-enable the microphone instead of retrying blindly.
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        setStatus("denied");
      }
      return;
    }

    if (request !== requestRef.current) {
      releaseTracks(stream);
      return;
    }

    // Re-gate after the permission round-trip — the context could have changed.
    if (!canRecord()) {
      releaseTracks(stream);
      setStatus("unsupported");
      setReason(unsupportedReason());
      return;
    }

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream);
    } catch (e: unknown) {
      releaseTracks(stream);
      const msg = "Could not start recording. Try again.";
      setStatus("error");
      setError(msg);
      setLastError(msg);
      onErrorRef.current?.(msg);
      return;
    }

    streamRef.current = stream;
    recorderRef.current = rec;
    chunksRef.current = [];

    rec.ondataavailable = (ev: BlobEvent) => {
      if (request !== requestRef.current) return;
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    // We drive stop/transcribe ourselves via stopAndTranscribe; onstop is not
    // relied on for the transcribe path (we already own the chunks). Keep it
    // as a no-op so a stray stop doesn't double-transcribe.
    rec.onstop = () => {
      // no-op — stopAndTranscribe owns the flow
    };
    // Surface recorder errors as dictation errors and release mic.
    rec.onerror = () => {
      if (request !== requestRef.current) return;
      requestRef.current++;
      statusRef.current = "error";
      clearTimers();
      teardownAudio();
      setLevel(0);
      releaseTracks(streamRef.current);
      streamRef.current = null;
      recorderRef.current = null;
      chunksRef.current = [];
      setStatus("error");
      const msg = "Recording failed. Try again.";
      setError(msg);
      setLastError(msg);
      onErrorRef.current?.(msg);
      setElapsedMs(0);
    };

    try {
      rec.start();
    } catch (e: unknown) {
      teardownAudio();
      setLevel(0);
      releaseTracks(stream);
      recorderRef.current = null;
      streamRef.current = null;
      const msg = "Could not start recording. Try again.";
      setStatus("error");
      setError(msg);
      setLastError(msg);
      onErrorRef.current?.(msg);
      return;
    }

    // Tap the same MediaStream into WebAudio for live level + silent detection.
    // Do NOT open a second getUserMedia — that would request permission again.
    try {
      const AC =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        // Resume if suspended (autoplay policy may start it suspended).
        if (ctx.state === "suspended") {
          try {
            await ctx.resume();
          } catch {
            // ignore
          }
        }
        if (request !== requestRef.current) {
          try { void ctx.close().catch(() => undefined); } catch { /* already closed */ }
          releaseTracks(stream);
          return;
        }
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        sourceRef.current = source;
        peakRef.current = 0;
        const data = new Uint8Array(analyser.fftSize);
        // The meter re-renders every useDictation consumer (the whole Composer),
        // so setLevel on every rAF frame cost ~120 renders/s on a 120 Hz panel
        // for up to 120 s. Publish 1/20 steps at most ~15 Hz instead; the ring
        // reads the same to the eye.
        let shownLevel = 0;
        let shownAt = 0;
        const tick = (now: number) => {
          const an = analyserRef.current;
          if (!an) return;
          an.getByteTimeDomainData(data);
          let sumSq = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / data.length);
          if (rms > peakRef.current) peakRef.current = rms;
          // Scale RMS for visible UI (rms ~0.02 threshold → ~0.08 visible, speech 0.1→0.4)
          const scaled = Math.round(Math.min(1, rms * 4) * 20) / 20;
          if (scaled !== shownLevel && now - shownAt >= 66) {
            shownLevel = scaled;
            shownAt = now;
            setLevel(scaled);
          }
          rafRef.current = window.requestAnimationFrame(tick);
        };
        rafRef.current = window.requestAnimationFrame(tick);
      }
    } catch {
      // Audio metering is best-effort; recording continues without it.
    }

    startAtRef.current = Date.now();
    statusRef.current = "recording";
    setStatus("recording");
    setElapsedMs(0);

    elapsedTimerRef.current = window.setInterval(() => {
      const elapsed = Date.now() - (startAtRef.current || Date.now());
      setElapsedMs(elapsed);
    }, 250);

    // Hard cap the recording at 120s with a visible countdown in the last 15s,
    // then stop and transcribe automatically.
    stopTimerRef.current = window.setTimeout(() => {
      void stopAndTranscribe();
    }, 120_000);
  }, [clearTimers, stopAndTranscribe, teardownAudio]);

  const stop = useCallback(() => {
    if (statusRef.current !== "recording") return;
    statusRef.current = "transcribing";
    void stopAndTranscribe();
  }, [stopAndTranscribe]);

  const cancel = useCallback(() => {
    requestRef.current++;
    statusRef.current = "idle";
    // Cancelling an upload stops the request but keeps the recording, so the
    // user can still Retry it. Its late reply is ignored (request bumped).
    abortRef.current?.abort();
    abortRef.current = null;
    if (takeRef.current) {
      keptRef.current = takeRef.current;
      takeRef.current = null;
      setCanRetry(true);
    }
    // ALWAYS release the microphone — including on cancel/unmount/error.
    clearTimers();
    teardownAudio();
    setLevel(0);
    const rec = recorderRef.current;
    const stream = streamRef.current;
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
    releaseTracks(stream);
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    setStatus("idle");
    setError(null);
    setLastError(null);
    setElapsedMs(0);
    setSilent(false);
    peakRef.current = 0;
  }, [clearTimers, teardownAudio]);

  const discardRetry = useCallback(() => {
    keptRef.current = null;
    setCanRetry(false);
  }, []);

  const retry = useCallback(() => {
    const kept = keptRef.current;
    const s = statusRef.current;
    if (!kept || s === "recording" || s === "requesting" || s === "transcribing") return;
    if (kept.scope !== scopeRef.current) {
      discardRetry();
      return;
    }
    setLastError(null);
    void transcribeBlob(kept, ++requestRef.current);
  }, [discardRetry, transcribeBlob]);

  // A kept recording belongs to the chat it was made in: leaving that chat
  // drops it, along with the failure notice that offered it.
  useEffect(() => {
    const kept = keptRef.current;
    if (!kept || kept.scope === scope) return;
    keptRef.current = null;
    setCanRetry(false);
    if (statusRef.current === "error") {
      statusRef.current = "idle";
      setStatus("idle");
      setError(null);
      setLastError(null);
    }
  }, [scope]);

  const toggle = useCallback(() => {
    const s = statusRef.current;
    if (s === "recording") stop();
    else if (s === "idle" || s === "error" || s === "denied") void start();
    else if (s === "requesting" || s === "transcribing") {
      // ignore double-taps while busy; the status strip's X cancels
    }
  }, [start, stop]);

  const can = status !== "unsupported";
  const remainingMs = status === "recording" ? Math.max(0, 120_000 - elapsedMs) : 120_000;

  return {
    status,
    reason,
    error,
    lastError,
    recoveryError,
    elapsedMs,
    remainingMs,
    canRecord: can,
    level,
    silent,
    canRetry: canRetry && status !== "transcribing" && status !== "recording" && status !== "requesting",
    start,
    stop,
    cancel,
    toggle,
    retry,
    discardRetry,
  };
}
