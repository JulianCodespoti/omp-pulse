# Benchmarks

How to measure the daemon's latency, wire cost and memory with the harness in
`bench/`. The numbers it produced, and the findings they led to, are in
[performance.md](../internals/performance.md).

Benchmarks run against an isolated daemon, never your own: a benchmark that can
reach a real conversation can damage one. Run them alone, like the end-to-end
suites; a concurrent cargo build makes the numbers meaningless.

## When to run them

After changing `src/sessions/watcher.rs`, `src/server/ws.rs` or
`src/server/delta.rs`, run the memory bench (`bench/mem.py`), not just the unit
tests: those modules are the bounded hot path, and their bounds were found by
measurement. For listing and history changes run `bench/lat.py`; for anything that
changes what goes over the socket, `bench/wire.py` and `bench/protocol-ab.py`.

## Running

```sh
cargo build --release
bench/with-bench-daemon.sh python3 bench/lat.py          # latency and throughput
bench/with-bench-daemon.sh python3 bench/wire.py         # bytes on the wire (spends model turns)
bench/with-bench-daemon.sh python3 bench/mem.py          # memory, incl. slow-consumer and cap probes
bench/with-bench-daemon.sh python3 bench/protocol-ab.py  # legacy vs optimised protocol on ONE turn
BENCH_QUICK=1 bench/with-bench-daemon.sh python3 bench/lat.py   # fast smoke version of any suite
```

`bench/with-bench-daemon.sh` starts an isolated instance (its own port, token,
sessions root and state directory, the same isolation contract as
`e2e/with-test-daemon.sh`), seeds or reuses the corpus at
`~/.cache/omp-pulse-bench/corpus`, samples daemon RSS every 200 ms, and prints
start/peak/mean on exit. It exports `BENCH_BASE`, `BENCH_WS`, `BENCH_TOKEN`,
`BENCH_CORPUS`, `BENCH_STATE`, `BENCH_PID`, `BENCH_RSS_LOG` and `BENCH_TMP` to the
benchmark. `BENCH_PORT` picks the port and `BENCH_FRESH=1` starts with an empty
corpus; the header of each script lists its own knobs (`BENCH_WORDS` for reply
length, `BENCH_SOAK_SECS`, …).

Scripts emit `METRIC <name> <value> <unit>` lines plus a human summary, so runs are
diffable.

## The suites

| script | measures |
|---|---|
| `bench/lat.py` | the request paths a phone waits on: `/api/sessions` cold, cached and stale; `/api/history` pages on small and large sessions; `/api/open`; throughput under concurrency; the send path only with `BENCH_TURNS=1` or more (model calls) |
| `bench/wire.py` | bytes on the wire per streaming turn, fan-out to N clients, the session-open request sequence, idle cost; makes real model calls |
| `bench/mem.py` | daemon RSS at rest and under load, per-client and per-watch cost, child lifecycle and the cap, a raw-socket slow consumer, a soak |
| `bench/protocol-ab.py` | a legacy client and an optimised client attached to the SAME streaming turn, so the difference is the protocol, not the reply |
| `bench/seed-corpus.py` | seeds the synthetic corpus (3365 sessions across 60 project directories, largest 44 MiB); called by the wrapper |

## The corpus

**The corpus must use omp's real entry shape**
(`{"type":"message","message":{"role",…}}`). A flat `{role,content}` loads fine in
our reader but crashes omp's session loader on `msg.role`, so every spawned child
dies with "open failure": this cost two measurement runs before it was found.
`bench/seed-corpus.py` writes the real shape and its marker carries `format: 2`, so a
shape change forces a re-seed.

## Notes for the next measurement round

- `wire.py` observed ~50% of model turns returning empty (`message_start` +
  `message_end`, no content) while three benches ran concurrently. It retries, and
  emits `wire.turn.<label>.failed` rather than hanging. Not a daemon fault, but it
  makes turn-shaped measurements noisy under load: run them serially.
- The synthetic corpus averages 0.33 MiB per session against the real corpus's
  1.2 MiB. File **count** drives the listing cost, so list numbers transfer; if a
  future finding depends on per-file size, raise the size mix first
  (`seed-corpus.py --big-mb`/`--mid-mb`).
- `collab_state` re-broadcast cadence (rank 7 in the original wire findings) could
  not be measured: the bench has no desktop host. It needs a TUI-hosted session.
- `bench/mem.py`'s slow-consumer metric measures parse-and-forward throughput for a
  client that IS consuming, not a queue bound; see "Still open" in
  [performance.md](../internals/performance.md#still-open).
