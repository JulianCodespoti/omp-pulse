#!/usr/bin/env python3
"""Warm speech-to-text sidecar for omp-pulse.

WHY A SIDECAR AND NOT A RUST CRATE: the daemon's dependency policy forbids any
crate that pulls `openssl-sys`, and the ONNX Runtime bindings (`sherpa-rs`, `ort`)
add a large native dependency that would have to build for the shipped
`x86_64-pc-windows-gnu` and `x86_64-unknown-linux-musl` targets. Shelling out
keeps Cargo.toml untouched, mirrors how the daemon already drives `omp`, and lets
the model live outside the binary.

WHY WARM: loading Parakeet 0.6B int8 costs ~3s. Decoding 7.4s of audio costs
~0.5s. A per-request process would spend 85% of its life loading weights, so the
process stays alive and the daemon reuses it, shutting it down when idle.

PROTOCOL, one JSON object per line on stdin/stdout:
    in   {"id": "1", "wav": "/tmp/clip.wav"}
    out  {"id": "1", "text": "...", "ms": 461}
    out  {"id": "1", "error": "..."}
and one unsolicited line at startup once the model is resident:
    out  {"type": "ready", "model": "...", "loadMs": 2994}

The wav MUST be 16-bit PCM. Any sample rate is accepted (sherpa-onnx resamples),
but the daemon feeds it 16 kHz mono because that is what the model was trained on.

MEMORY: the model itself is ~700 MiB resident. Two things used to double that:
- ONNX Runtime's CPU arena keeps every activation buffer it ever grew for, and
  with variable-length audio it kept growing (~713 MiB loaded, ~1.4 GiB after two
  30 s clips on the phone). The arena is disabled through sherpa-onnx's
  `provider="cpu:<config file>"` hook, so activations go back to the allocator
  after each decode (steady state stays ~730 MiB; 30 s decodes ~10% slower).
- Encoder activations grow with clip length (~10 MiB per second of audio, so a
  5-minute upload would need ~3 GiB at once). Clips longer than CHUNK_MAX_S are
  cut at their quietest point between CHUNK_MIN_S and CHUNK_MAX_S and decoded
  one piece at a time.
"""

import json
import os
import sys
import tempfile
import time
import wave


# See MEMORY above. Keys are sherpa-onnx's provider-config keys (session.cc).
ORT_CPU_CONFIG = "EnableCpuMemArena=0\n"
CHUNK_MIN_S = 20
CHUNK_MAX_S = 30
# Window over which loudness is compared when choosing a cut point.
QUIET_WINDOW_S = 0.1


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_pcm(path):
    """16-bit PCM wav -> (float32 samples in [-1,1], sample_rate).

    Mono is required by the recognizer; a stereo file is averaged rather than
    rejected, because a phone that records stereo should still work.
    """
    import numpy as np

    with wave.open(path, "rb") as f:
        if f.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit pcm, got {f.getsampwidth() * 8}-bit")
        channels = f.getnchannels()
        rate = f.getframerate()
        raw = f.readframes(f.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def chunks(samples, rate):
    """Split audio longer than CHUNK_MAX_S at its quietest QUIET_WINDOW_S window
    between CHUNK_MIN_S and CHUNK_MAX_S from the previous cut, so each decode's
    activations stay bounded and a cut lands in a pause rather than in a word.
    """
    import numpy as np

    win = max(1, int(QUIET_WINDOW_S * rate))
    lo, hi = CHUNK_MIN_S * rate, CHUNK_MAX_S * rate
    start = 0
    while len(samples) - start > hi:
        span = samples[start + lo : start + hi]
        n = len(span) // win
        energy = np.abs(span[: n * win]).reshape(n, win).mean(axis=1)
        cut = start + lo + int(np.argmin(energy)) * win + win // 2
        yield samples[start:cut]
        start = cut
    yield samples[start:]


def main():
    if len(sys.argv) < 2:
        emit({"type": "fatal", "error": "usage: asr-server.py <model-dir> [threads]"})
        return 2
    model_dir = sys.argv[1]
    threads = int(sys.argv[2]) if len(sys.argv) > 2 else 4

    try:
        import sherpa_onnx
    except Exception as e:  # pragma: no cover - environment failure
        emit({"type": "fatal", "error": f"sherpa_onnx import failed: {e}"})
        return 3

    need = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
    missing = [n for n in need if not os.path.isfile(os.path.join(model_dir, n))]
    if missing:
        emit({"type": "fatal", "error": f"model dir {model_dir} missing {missing}"})
        return 4

    # sherpa-onnx reads the provider config while building the sessions, so the
    # file only has to outlive the constructor.
    t0 = time.time()
    conf = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", prefix="asr-ort-", suffix=".conf", delete=False
        ) as conf:
            conf.write(ORT_CPU_CONFIG)
        rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(model_dir, "encoder.int8.onnx"),
            decoder=os.path.join(model_dir, "decoder.int8.onnx"),
            joiner=os.path.join(model_dir, "joiner.int8.onnx"),
            tokens=os.path.join(model_dir, "tokens.txt"),
            num_threads=threads,
            provider=f"cpu:{conf.name}",
            model_type="nemo_transducer",
        )
    except Exception as e:  # pragma: no cover - environment failure
        emit({"type": "fatal", "error": f"recognizer init failed: {e}"})
        return 5
    finally:
        if conf is not None:
            try:
                os.unlink(conf.name)
            except OSError:
                pass
    emit(
        {
            "type": "ready",
            "model": os.path.basename(model_dir.rstrip("/")),
            "threads": threads,
            "loadMs": int((time.time() - t0) * 1000),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "error": f"bad request json: {e}"})
            continue
        rid = req.get("id")
        wav = req.get("wav")
        if not wav:
            emit({"id": rid, "error": "wav path required"})
            continue
        try:
            t0 = time.time()
            samples, rate = read_pcm(wav)
            texts = []
            for piece in chunks(samples, rate):
                stream = rec.create_stream()
                stream.accept_waveform(rate, piece)
                rec.decode_stream(stream)
                text = stream.result.text.strip()
                if text:
                    texts.append(text)
            emit(
                {
                    "id": rid,
                    "text": " ".join(texts),
                    "ms": int((time.time() - t0) * 1000),
                    "audioMs": int(len(samples) / rate * 1000),
                }
            )
        except Exception as e:
            emit({"id": rid, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
