---
name: asr-setup
description: Use when omp-pulse dictation (local Parakeet speech-to-text via musl sherpa-onnx) fails, e.g. after an app update, to rebuild it with bin/asr-setup.
---

# Rebuild dictation

`omp-pulse asr install` cannot work here (PyPI has only glibc sherpa-onnx wheels), so
`/root/projects/phone-harness/bin/asr-setup` builds sherpa-onnx from source against Alpine's onnxruntime
into `/root/.local/state/omp-pulse/asr/venv` and downloads the Parakeet model next to it. It is idempotent.

- Check first: `android doctor` (dictation runtime/model lines) or `omp-pulse asr status` (prints `READY`).
- App updates can replace rootfs packages (onnxruntime, compilers, ffmpeg), which breaks the import even though
  the venv and model survive under `/root/.local/state`.
- Run it as a background job with a log, then `android notify` when done: the source build takes a long time
  (memory is tight, so it builds with few parallel jobs) and downloads go through the phone's network, so retry
  once on a timeout. `/root/projects/phone-harness/bin/asr-setup >/root/asr-setup.log 2>&1`
- It ends with `omp-pulse asr status`. The daemon loads the runtime at start: the user force-stops and
  reopens omp-pulse (that ends this session; say so first).
- Model: default Parakeet unified 0.6B (~0.73 GiB resident, ~1.03 GiB peak). `asr-setup --small` installs
  Parakeet TDT 110M (~0.21 GiB resident, ~0.40 GiB peak, ~2x faster, WER ~7.5% vs 5.91%) for phones with little
  RAM or when the app keeps getting low-memory-killed (check `MemTotal` in `/proc/meminfo`). Each run pins its
  model as `asr_model_dir` in `/root/.config/omp-pulse/config.toml`; switching back is a plain rerun without
  `--small` (needs the daemon restart).
- Build fixes baked in (do not undo): deps prefetched to `~/Downloads` because CMake's own downloads hang on
  slow links; `-include cstdint` for GCC 15; TTS stays on because the python package imports it.
