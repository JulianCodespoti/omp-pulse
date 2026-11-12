# Performance: baseline and findings

This page holds the daemon's measured baseline, what shipped against it, and the
ranked findings F1–F13 with their status. Code comments cite the F-numbers, so they
are stable. The architecture they shaped is in [architecture.md](architecture.md);
how to run the benchmarks is in [benchmarks.md](../contributing/benchmarks.md).

The baseline was measured 2026-08-12 on a development laptop (Intel Core Ultra 9
285H, 30 GB RAM, NVMe), binary `target/release/omp-pulse`, against an **isolated**
daemon with a synthetic corpus of 3365 sessions (largest 44 MiB, one 11 MiB). Every
number below is reproducible with the commands in
[benchmarks.md](../contributing/benchmarks.md#running). The sections under
[Later measurements](#later-measurements) state their own scope.

Nothing here ran against a real daemon or real sessions: a benchmark that can reach
a real conversation is a benchmark that can damage one.

## Baseline

### Latency (p50 unless noted, ≥5 samples, warmup discarded)

| path | cost | note |
|---|---|---|
| `/api/sessions` cold (cache expired) | **134.2 ms** | 3365 files; 71.2 ms is the syscall floor, 63.1 ms is ours (18.7 µs/file) |
| `/api/sessions` cached (within 3 s TTL) | **43.5 ms** | still stats + serializes the page. The 1.87 MiB in this row is the pre-paging whole listing; `MAX_PAGE_SIZE` is 50 rows, measured at 74,256 B identity / 12,395 B gzip-9 for 50 rows on a 3.3 GB store (2026-11-05) |
| `/proc` owner sweep, per refresh | 7.5 ms | 815 pids, 456 fd links |
| `/api/history` page 1, small session | 0.60 ms | |
| `/api/history` page 1, 11 MiB session | 5.07 ms | whole file read per page |
| `/api/history` page 1, 44 MiB session | **36.4 ms** | whole file read per page, 70 KiB returned |
| `/api/history`, 2 MiB single line | 13.9 ms | backward window grows to the whole file |
| `/api/open` handler, cold / warm | 0.96 ms / 0.53 ms | boot is async behind it |
| child boot (omp's own) | **2719 ms** | daemon's `child_boot_ms`; ~1.3 s on a warm page cache |
| `/api/rpc get_state` warm / cold | 15.5 ms / 2449 ms | |
| WS attach | 14.7 ms | |

Concurrency: `/api/sessions` saturates at **~295 req/s** with p95 rising 8.8× from
C=1 to C=64 (sub-linear, not pathological); `/api/history` holds ~4.8k req/s.

### Wire (per streaming turn, one client)

| reply size | wire bytes | frames | amplification | savable |
|---|---|---|---|---|
| 821 B | 32.4 KB | 23 | **39.5×** | 97.5% |
| 4032 B | **305.7 KB** | 50 | **75.8×** | 98.7% |

Fan-out is exactly linear (`linearity 1.0`): each extra client pays the whole
stream again. Idle cost per attached phone: **185 KB/h** (28 B heartbeats are
negligible; the client's 60 s tail poll dominates), rising to **2.17 MB/h** when
the WebSocket is down and the client falls back to 5 s polling.

Compression left on the table (gzip-6, measured on real payloads):

| payload | ratio | saved |
|---|---|---|
| `/api/sessions` listing (1.96 MB) | 0.128× | 1.71 MB |
| `/api/history` page, 44 MiB session | 0.0151× | 69.5 KB |
| `index.html` (279 KB, the legacy single-file client) | 0.242× | 211 KB |
| one 600-word turn's frames (306 KB) | 0.024× | 298 KB |

### Memory

| item | value |
|---|---|
| daemon at boot | 12.4 MiB |
| after listing 3365 sessions | 23.2 MiB (+10.8) |
| after open + stream | 47.2 MiB (+24.0) |
| per extra WS client on one session | ~0.15 MiB |
| per watched session (daemon side) | 0.155 MiB |
| **per omp RPC child** | **281 MiB p50, 305 MiB p95, 493 MiB peak at boot** |
| 8 MiB unterminated line held in `partial` | **0.0 MiB** (disproven as a concern) |

The daemon itself is lean. **All meaningful memory is children, and at the time of
the baseline their count was not actually bounded**: see F1.

## After: what shipped, and what it measures

Same harness, same corpus, same box. Every row was re-measured after the change;
the A/B row comes from `bench/protocol-ab.py`, which attaches a legacy client and
an optimised client to the SAME streaming turn, so the difference cannot be an
artifact of reply length.

| measurement | before | after | factor |
|---|---|---|---|
| streaming turn, 4 KB reply (one client) | 244,174 B | **25,290 B** | **9.7x** |
| turn amplification vs final text | 57.8x | **6.0x** | 9.6x |
| text delivered (equivalence check) | 4228 chars | 4228 chars | identical |
| `/api/sessions` cold p50 | 134.2 ms | **1.5 ms** | 87x |
| `/api/sessions` cached p50 | 43.5 ms | **0.74 ms** | 58x |
| `/api/sessions` revalidated (`If-None-Match`) | one page (74 KB identity, 12 KB gzip) | **300 B (304)** | — |
| `/api/sessions` gzip (live daemon, per 50-row page) | 74,256 B | **12,395 B** | 6.0x |
| `/api/history` page 1, 44 MiB session | 36.4 ms | **0.59 ms** | 62x |
| `/api/history` page 1, 11 MiB session | 5.07 ms | **0.49 ms** | 10x |
| `/api/sessions` throughput (C=1) | 32 req/s | **2642 req/s** | 82x |
| `/api/sessions` p95 at C=8 | 49.1 ms | **6.1 ms** | 8x |
| children after 12 simultaneous opens at cap 3 | 12 (3464 MB) | **3 (891 MB)** | cap holds |
| 150 MiB appended, no consumer | +320 MB RSS | **+0 MB** | bounded |
| soak slope (120 s, 265 churn cycles) | +1252 KiB/min | **+47 KiB/min** | 26x |
| daemon RSS, browsing a conversation | 281 MiB (child) | **~14 MiB** | no child |

Gate results on that build (historical, 2026-08; the gate has grown since): 105
unit tests, smoke 32/32, browser E2E 40/40, doctor 10/10.

### The mechanisms

**Conflation with per-chain delta resolution** (`src/server/ws.rs`, `src/server/delta.rs`).
Per-client queues are bounded last-value caches: a newer supersedable frame
replaces a pending one in place. Every frame carries a canonical full `text` plus
an optional `delta` tagged with the `base_seq` it continues; a client receives the
delta only when its position in THAT chain is exactly `base_seq`. So fast clients
get increments, and a client that fell behind, just attached, or had frames
collapsed automatically gets a snapshot: the form it actually needs. Correctness
is structural: full text is always valid, so every fallback is safe.

**Deltas are suffix replacements, not appends.** omp normalises a block's tail
when it finalises, so the text stops prefix-extending near the end; append-only
diffing gave up on 5 of 33 updates (~12 KB per turn). Diffing on the common prefix
turns those into "keep k units, append the rest". `k` counts UTF-16 code units
because the consumer is `String.prototype.slice` in a browser: a byte offset or a
scalar count would split an emoji.

**Admission control for children** (`src/omp/child.rs`). In-flight spawns count
against the cap through a `Drop` guard, eviction loops, and a 5 s minimum lifetime
stops a burst from cannibalising boots its siblings just paid for. At a saturated
cap the daemon prefers RETARGETING a warm child (`switch_session`: 59 ms empty,
151 ms at 11 MiB, 444 ms at 44 MiB) over kill-and-respawn (2249 ms + 281 MiB), and
refuses rather than exceeding the cap. Idle children are reaped after 15 min and
recycled past 700 MiB RSS, because `switch_session` accumulates (291 to 582 MiB
over five switches) and never gives it back. The pool's current rules (busy
children are never evicted, a full pool holds sends) are in
[session-state.md](session-state.md#the-child-pool).

**Intent-based pre-warm.** Attaching a socket no longer spawns a child; the phone
calls `POST /api/prewarm` on composer focus, where a 1.3-2.7 s boot hides inside
human typing latency. Browsing a conversation costs ~14 MiB instead of 281 MiB.

**Session index with stale-while-revalidate + ETag** (`src/sessions/index.rs`). One scan
feeds every query; payloads are cached as `Arc<str>` with a content-addressed
ETag; a poll never blocks on a refresh. With `If-None-Match` the steady-state poll
is a 304 with no body. While the discovery watch is armed and a `/ws/sessions`
client is attached, every file and child change already nudges a refresh, so the
poll-driven refresh backs off from 3 s to 15 s (each scan measured 222 ms on the
phone, every syscall also trapped by proot, repeated on every 3 s poll).

**First-screen bundle.** A client advertising `bundle` gets history page 1, cached
child state and the listing ETag in ONE frame on the socket, replacing six
sequential requests: six RTTs on cellular.

**Byte-capped queues, back-pressure, and a catch-up cap** (`src/server/ws.rs`,
`src/sessions/watcher.rs`). Three ceilings, because the first two each turned out to be
insufficient on their own:
1. frame count (staleness) and BYTES (memory): a single watcher frame can be
   megabytes, so 64 frames is not a bound;
2. a stall latch, so an overflowed client stops advertising headroom and the
   watcher stops reading tails nobody can accept;
3. an unconditional 8 MiB catch-up cap: past that, growth is a repaint (Poll,
   refetch over HTTP) rather than a stream, since a tiny resync frame always fits
   the socket and would otherwise keep reopening the gate.

**Only a visible audience keeps the tail awake** (`src/server/ws.rs`,
`src/sessions/watcher.rs`, `src/sessions/index/discovery.rs`). The web app keeps
its sockets open while the phone is locked or the app is backgrounded, so on
bytes alone a pocketed phone looked like an audience, and the tail plus the
250 ms stat tick (each `stat` a proot-trapped syscall) never let the phone sleep.
`WsHub::has_audience` counts only visible clients with headroom. A hidden client
whose tail was skipped is owed one resync order, sent when it reports visible.
With no audience on any watched session the tick parks until the hub reports one
(attach, visible, a stalled client draining), then catches up at once. With no
`/ws/sessions` client, discovery coalesces its hints over 1 s instead of 50 ms
(they only set the `changed` flag then), and the first listing client to attach
triggers the refresh.

A skipped EOF or a new attachment may bisect a record: a bounded backward probe
resumes from its delimiter. If the delimiter is beyond the cap, or an initial probe
cannot read it, only the new suffix is scanned in fixed-size chunks and its
completion requests history instead of streaming a fragment. A failed deferred probe
is retried while the client is visible. An explicitly selected polling watch backend
has its own polling cadence.

When the partial tail becomes empty, watcher buffers above 256 KiB are dropped
rather than pinned by an idle watched conversation; smaller buffers are reused.
`bench/mem.py` writes the advertised multi-MiB fixture and reports the measured
RSS change after termination, which can also depend on the allocator.

**`malloc_trim` on the maintenance ticker.** glibc keeps freed arenas mapped, so a
burst left RSS high (334 MiB, unchanged 30 s later) with nothing queued and no
children alive. Nothing was leaking, but a user cannot tell the difference
and a laptop daemon should give the pages back. The ticker runs it on every pass
while children exist and once more when the last one goes; with no children it
parks until one registers instead of waking every 10 s (musl builds, including
the phone's, have no `malloc_trim` at all).

### Corrections found only by running it

Each of these compiled, read correctly, and was wrong:

- **The delta chain key.** A live `message_update` carries no `id` at all, only
  `responseId`; `id` appears on the committed entry. Keying on `id` produced ZERO
  deltas for a whole turn, and the wire measurement could only show their absence,
  never the reason. `/api/status` now names the reason
  (`delta_built`, `delta_first_frame`, `delta_skip_rewrite`, `delta_skip_no_audience`).
- **Client and daemon disagreeing on that key.** The phone derived the chain from
  `message.id`, so every delta looked unknown and triggered a refetch. The A/B's
  text-equivalence check caught it: 4110 chars vs 4049.
- **A self-deadlock in the index.** The cold-scan arm still held the `INDEX` guard
  when `serve()` re-locked it, so every `/api/sessions` request hung forever.
- **Suppressing `entries` during a turn.** Both "child exists" and "child is
  streaming" variants lost content that ONLY the file carries (the user's own
  prompt entry), which the browser suite caught as a "new content" pill that never
  appeared. Entries are always forwarded; the client dedupes by key.
- **Back-pressure that oscillates.** Clearing an overflowed queue to one resync
  order restores headroom, so the producer resumes instantly: 123 resyncs and the
  full +321 MiB during a 150 MiB append.
- **A test harness that hides the case under test.** A `websockets` client that
  never calls `recv()` still drains the TCP transport into a userspace buffer, so
  "slow consumer" measured nothing until the probe was rewritten as a raw socket
  that stops reading at the TCP level (the `bench` probes).

### Still open

- `bench/mem.py`'s slow-consumer metric measures parse-and-forward throughput for
  a client that IS consuming (its library buffers in userspace), not a queue
  bound. The queue bound is unit-tested instead; read the ratio as "cost of
  delivering what a client accepts".
- WS frame compression for small frames was deliberately skipped. Deltas made frames
  ~100-200 B, where per-frame deflate measured only 0.34x and a shared-dictionary
  scheme would need a WASM decoder on the phone. Large frames (at least
  `ws_deflate_min`, 4096 B by default, such as the bundle) are sent as raw-DEFLATE
  binary to clients that advertise `defl`; browsers decode it natively.
- Multiplexing many sessions through ONE child is known-safe at the state level
  (`switch_session` replaces state wholesale; repeated switching is the designed
  lifecycle) and is used for retargeting at the cap, but the daemon still keeps one
  child per active session. The blocker is accumulation, not correctness: RSS never
  comes back, so a multiplexed child needs the RSS recycler as its generational
  bound.

## Findings, ranked by expected win over risk

Ranked as found at the 2026-08 baseline. Each finding's **Status** says whether its
fix shipped, with the evidence; "Mechanism" describes the code as it was measured,
naming the symbols of the time.

### F1 — The child cap does not hold; memory is unbounded in concurrent opens. **CRITICAL**
- **Status: shipped.** In-flight spawns count against the cap and eviction loops
  (the "children after 12 simultaneous opens" row above; `src/omp/child.rs`
  admission, cited as F1/F8 in `src/server/http.rs`).
- **Measured**: with `OMP_PULSE_MAX_CHILDREN=3`, twelve simultaneous `/api/open`
  calls left **12 children alive (3.46 GB)** 8 s later. Watching 128 sessions
  produced **78 children / 18.3 GB** on a 30 GB box.
- **Mechanism**: `ChildManager::open` inserted into the registry only after boot
  succeeded, while `evict_if_needed` decided on `map.len()`. In-flight spawns were
  invisible to each other, so N concurrent opens all passed the check; and eviction
  killed exactly one victim per call, so it could never recover from an overshoot.
  The `opening` map coalesced the *same* path only.
- **Fix**: reserve the slot before spawning (count in-flight spawns against the
  cap) and make eviction loop while `alive + in_flight >= cap`. Cheap, local to
  `child.rs`.
- **Win**: bounds the daemon's whole footprint at `cap × ~281 MiB` as designed
  (1.7 GB at the default 6) instead of unbounded.

### F2 — A stalled phone pins hundreds of MB. **CRITICAL**
- **Status: shipped.** Per-client queues are bounded by frame count and bytes, with
  one resync order on overflow (`src/server/ws.rs`, whose module header cites F2).
- **Measured**: with one client attached but not reading, appending 150 MB to a
  watched session grew daemon RSS by **382.8 MB (2.55× the appended bytes)**; the
  control (a client that reads) grew 0.63×.
- **Mechanism**: per-client queues were `mpsc::unbounded_channel()` in `WsHub`, and
  `broadcast` pushed every frame regardless of drain rate; the pump only advanced
  as fast as the phone's TCP window. Cellular stalls are routine.
- **Fix**: bounded per-client channel (drop-oldest, or disconnect the client on
  overflow and let it resync via `/api/history`; the UI already does that on
  reconnect). Pair with F5 so the queue holds deltas, not full messages.
- **Win**: converts an unbounded memory hazard into a fixed per-client ceiling.

### F3 — No compression on HTTP. **High win, near-zero risk**
- **Status: shipped**, with a loopback exemption. The router carries a compression
  layer (`src/server/http.rs`, citing F3).
- **Measured**: the session listing is 1.87–1.96 MB uncompressed at **0.128×**
  gzip (1.71 MB saved per fetch); a history page on the 44 MiB session is
  **0.0151×** (69.5 KB → ~1 KB); `index.html` 279 KB → 67 KB.
- **Mechanism**: `tower-http` was enabled with the `fs` feature only (`Cargo.toml`),
  and the router in `src/server/http.rs` had no compression layer.
- **Fix**: add `CompressionLayer` for `/api/*` and static assets (level 6 is
  within 1% of level 9 here).
- **Win**: 4–100× on every HTTP byte the phone fetches. This is the single
  cheapest change in the list.
- **Loopback exemption (2026-10-14)**: the on-phone daemon serves its own
  WebView over `127.0.0.1`, where the bytes are free and compression is pure CPU
  on both ends (a 2025 flagship phone's guest: 420 KB main JS 2 ms identity vs 33 ms gzip; 258 KB
  history page 21–64 ms vs 71–114 ms). A request whose `Host` is loopback and
  that carries no `Forwarded`/`X-Forwarded-*` header gets identity bodies and no
  raw-deflate WS frames (`is_local_direct` in `src/server/http.rs`); tailnet, LAN
  and proxied clients are compressed as before.

### F4 — `read_backward` reads the entire session file for every page. **High**
- **Status: shipped.** `read_backward` in `src/sessions/jsonl.rs` seeks and reads
  backward in chunks (its comments cite F4).
- **Measured**: 36.4 ms and a 319 MB daemon RSS peak to return 70 KB from the
  44 MiB session; 5.1 ms for the 11 MiB one.
- **Mechanism**: `read_backward` did `fs::read(path)` (the whole file), and the
  documented "≤256 KiB backward chunks" then operated on that in-memory buffer,
  re-copying the accumulated window on each growth step, which is quadratic for
  newline-sparse files. Its docstring was false.
- **Fix**: seek and read backward from `size` in 256 KiB chunks as documented;
  parse lines from chunk slices instead of a `to_vec()` per line.
- **Win**: 44 MiB → ~1 MiB read per page; removes the RSS spike and the quadratic
  copy. Directly improves opening a long conversation on the phone.

### F5 — Token streaming is quadratic: 39–76× amplification. **Highest network win**
- **Status: shipped.** Delta frames keyed by `base_seq` (`src/server/delta.rs`,
  whose header cites F5; the 9.7x row above).
- **Measured**: 32.4 KB for an 821 B reply (39.5×); **305.7 KB for a 4032 B reply
  (75.8×)**; 97.5–98.7% of those bytes are avoidable. `delta_sum == final_len`
  exactly, so the stream is a monotone prefix: deltas are always derivable.
- **Mechanism**: each `message_update` carried the **full accumulating message**,
  forwarded verbatim from the child by the router in `main.rs` and from a collab
  host by `collab.rs`. Per-update envelope overhead is ~1.8 KB on top
  (`thinkingSignature`, `usage`, `contextSnapshot`, `provider`, `model`).
- **Fix**: daemon-side delta frames: diff against the last forwarded text and
  send `{type:"message_delta", id, append}`, with the UI appending; fall back to a
  full frame when the new text is not a prefix-extension (rewrites happen). Slim
  the update envelope to `{id, role, content}` since the fat fields only matter on
  the committed entry. Both ends are ours, so this is a compatible change.
- **Win**: ~95% of every turn's bytes; the saving grows with reply length. On the
  measured 600-word turn: 306 KB → ~2.5 KB.

### F6 — The 3 s session-list cache is exactly out of phase with the client's poll. **High**
- **Status: shipped.** Stale-while-revalidate, cached serialized payloads and ETags
  (`src/sessions/index.rs`, whose header cites F6).
- **Measured**: cached 43.5 ms vs cold 134.2 ms; the client polls the list every
  3 s, so nearly every poll pays the cold path *and* downloads 1.87 MB.
- **Mechanism**: the listing cache's TTL was 3 s with a poll cadence of 3 s; on
  expiry the refresh re-scanned 3365 files, re-parsed headers, re-swept `/proc`
  (7.5 ms) and re-statted every row, then the handler cloned all 3365 rows and
  serialized twice (`to_value` per row plus axum's own pass).
- **Fix**: (a) serve stale-while-revalidate so a poll never blocks on a refresh;
  (b) cache the *serialized* payload keyed by query and hand out `Arc<str>`;
  (c) make the index incremental (the watcher already knows which files changed);
  (d) support `?since=<mtime>` / `If-Modified-Since` so an unchanged list returns
  304 rather than 1.87 MB.
- **Win**: 134 ms → sub-ms on the common path, and ~1.87 MB/poll → ~0 for
  unchanged lists (with F3, ~230 KB → ~0).

### F7 — Per-frame deep clones and per-client string copies. **Medium**
- **Status: shipped.** Fan-out is `Arc` clones collected under the hub lock with the
  queue work outside it (`WsHub::broadcast_frame` in `src/server/ws.rs`), and the
  collab path builds its wrapper by borrowing (`src/omp/collab.rs`); both cite F7.
- **Mechanism** (read, not measured): the child path deep-cloned the parsed
  `Value` into the broadcast and the router re-serialized it; the collab path
  cloned the event again and built a wrapper tree; `WsHub::broadcast` then did
  `msg.to_string()` **per client while holding the hub mutex**; the relay cloned
  the full sealed frame per peer.
- **Fix**: broadcast the child's raw line instead of a cloned tree; wrap by
  borrowing (`format!` over a `&Value`); make channel payloads `Arc<str>` /
  `Bytes` so fan-out is a refcount bump; clone outside the lock.
- **Win**: roughly halves peak transient memory per frame and removes N×frame
  memcpy per broadcast from a global critical section. Compounds with F5, which
  shrinks the frames themselves.

### F8 — Children never died from idleness
- **Status: shipped.** The maintenance pass reaps idle and unwatched children
  (`src/omp/child.rs`, citing F8; rules in
  [session-state.md](session-state.md#the-child-pool)).
- **Measured** (historical baseline): `mem.child.idle_survives = 1`; children only
  exited via LRU eviction at spawn time or daemon shutdown.
- **Mechanism as implemented**: maintenance checks the idle TTL; the next prompt
  may pay a cold boot, which composer-focus prewarm can sometimes hide. The child
  lifecycle fences observed registered work against the final maintenance
  decision. The win below is the historical measurement, not a new one.
- **Win**: reclaims 281 MiB per idle conversation.

### F9 — The ~51 KB command list is delivered twice per session open. **Medium**
- **Status: open, partly mitigated.** The first-screen bundle deliberately omits the
  list (`bundle_frame` in `src/server/http.rs`) and catalogues are cached per cwd,
  but the chat still requests the catalogue on every session open
  (`loadCommands`, the `get_available_commands` RPC) while a freshly spawned child
  also broadcasts `available_commands_update`. Not re-measured.
- **Measured**: `GET /api/commands` returned 51,382 B *and* the child broadcast
  `available_commands_update` (51,432 B) on every fresh spawn: ~103 KB of
  identical data per open, re-paid on every LRU respawn.
- **Fix**: drop the request when the broadcast has been seen (or defer the
  broadcast until the palette opens).
- **Win**: ~51 KB per open, more with F3 applied.

### F10 — Watcher `entries` frames duplicate the live event stream. **Low-medium**
- **Status: declined.** Suppressing them lost the user's own prompt row, which only
  the file carries (see "Corrections found only by running it" and the file-tail
  INVARIANT in [architecture.md](architecture.md#the-live-paths-and-why-there-are-four)).
  Entries are always forwarded and the client dedupes by key.
- **Measured**: 3.35 KB per turn of `entries` frames carrying content already
  delivered as `message_update`; the legacy single-file client (since replaced by
  the React client in `web/`) deduped them by key.
- **Proposed fix (not taken)**: suppress watcher `Entries` broadcasts for sessions
  with a live child; keep them for desktop-driven sessions.

### F11 — Full `/proc` sweep on every write request. **Low-medium**
- **Status: shipped.** The verdict is cached per session for `owner_cache_ms`
  (default 3 s; `OWNER_VERDICT` in `src/server/http.rs`, citing F11), and
  `ChildManager::do_open` re-checks at spawn time.
- **Mechanism**: `guard::foreign_session_owner` ran per prompt, bash and mutating
  RPC and walked all of `/proc`, reading `cmdline` per pid (815 pids here) plus fd
  scans: measured at 7.5 ms in the listing path. Its docstring's claim that it
  "runs rarely" was false at that call site.
- **Fix**: cache the per-session verdict for 2–5 s; a TUI appearing mid-window
  just defers a refusal by one prompt.

### F12 — Watcher drains hold one global mutex across file I/O and parsing. **Low**
- **Status: shipped.** Per-path locking in `src/sessions/watcher.rs` (its comments
  cite F12).
- **Mechanism**: the watcher's drain held the state mutex while doing `metadata` +
  `read_forward` + `read_tail` + broadcast, so every watched session serialized
  behind every other, and WS attach/detach blocked on the same lock. No lock was
  held across `.await` (verified), so this was throughput, not deadlock.
- **Fix**: per-path locking, or move the read/parse outside the map lock.

### F13 — Live frames are dropped at the source but buffered without limit at the sink. **Low**
- **Status: shipped.** The sink is bounded (F2), and the router no longer skips
  frames silently: on `RecvError::Lagged` it forces a resync of every client
  (`hub.resync_all("lagged")` in `src/bin/omp-pulse/main.rs`). No code comment cites
  F13; the evidence is that code.
- **Mechanism**: the broadcast channels are capacity-1024 and the router *skipped*
  frames on lag, while per-client queues were unbounded (F2). The design should be
  the other way round.
- **Fix**: bound the sink (F2) and let the watcher's file tail be the durability
  mechanism it already is.

## Disproven — do not spend time here

- **`PathState.partial` is not a memory problem**: an 8 MiB unterminated line held
  **0.0 MiB** extra RSS, freed on newline. The double-read waste is real (F7-adjacent)
  but the buffer is not a hazard.
- **Fan-out is not super-linear**: `linearity 1.0` across 1/4/16 clients; frames are
  serialized exactly once by the router, the per-client cost is a memcpy, not a
  re-serialization.
- **No lock is held across `.await`** on any hot path (`ws.rs`, `watcher.rs`,
  `child.rs`, `collab.rs` audited).
- **The session listing does not re-parse headers per row per request**: headers are
  parsed once per cache refresh and snippets are mtime-memoized.
- **`/proc` is not swept per row** in the listing: one pass per refresh.
- **The 4 KiB inotify buffer is not a correctness risk**: `IN_Q_OVERFLOW` is covered
  by the watcher's 250 ms stat-compare tick; worst case is 250 ms of latency while
  someone is watching, and with no audience the tick catches up when one returns.
- **The 250 ms watcher tick produces no idle traffic**: measured 0 bytes/h. It did
  cost wakeups with nobody looking, which is why it now parks without an audience.
- **Daemon-side per-client and per-watch overhead is negligible** (~0.15 MiB each);
  optimizing them would be misdirected effort.

## Later measurements

### Bounded architecture microbenchmarks

These are paired local microbenchmarks, not updated whole-application RSS or
endpoint latency measurements. No live daemon was used.

- Actual Chromium IndexedDB, eight cached tails with one 32,768-character text
  part each: keyed loads reduced median time from 0.765 to 0.205 ms;
  transactional saves from 1.815 to 1.285 ms. Five warmups, then fifteen
  alternating paired trials of twenty operations. Saving still scans cursor
  values for retention, but does not clear and rewrite retained bodies (the
  offline history cache in [web-client.md](web-client.md#offline-history-cache)).
- Extracted production socket queue code, fifteen alternating trials, depths
  1/16/64 and 1 KiB/256 KiB canonical frames: at depth 64, headroom checks were
  21.5 to 8.0 ns (1 KiB) and 15.0 to 10.6 ns (256 KiB). Allocation counts were
  unchanged. Depth-one/drain results were essentially unchanged, including
  small regressions; do not extrapolate the best cell to the full daemon (socket
  queue accounting in [io-bounds.md](io-bounds.md#socket-queue-accounting)).
- No endpoint speedup is claimed for cursor seek. Authority projection, project
  summaries and first-page live/pinned selection remain catalogue-wide.
- No statistics-cache speedup ships: the sole caller is a rare command-error
  fallback, so synthetic append-only gains did not justify retaining a cache.

### Motion (frame budgets, 120Hz)

`scripts/measure-motion.mjs` drives five interactions against a running app and
reports three numbers each: the rAF delta distribution (`p50`, `p95`, share of
frames over 1.5x the budget), the `LayoutCount`/`RecalcStyleCount` deltas from
CDP performance metrics, and the main-thread task time in the window.

Why a HEADED window: headless Chromium caps rAF at 60Hz, and the claim being
checked is one about a 120Hz phone. A headed window parked off-screen ticks at
the panel's rate (measured 8.3ms here), so "missed a frame" means a 16.6ms
delta. `--60` runs the headless path, `--throttle` adds 4x CPU. rAF deltas are
a callback cadence, not a paint timestamp: a page that misses a frame shows it
as a doubled delta, and a page that does nothing shows nothing.

The layout counters are the point of separating metrics from frames: an
animation that writes only `transform`/`opacity` must show **zero** layouts
while it runs. The same gesture implemented with `width`, `margin` or `top`
shows one layout per frame.

Measured 2026-11-06 against the live release, this machine, 390x844 @2x:

| interaction | frames | p50 | p95 | over% | layout | style | task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| drawer swipe open + settle, 120Hz | 719 | 8.3 | 8.4 | 1 | 32 | 775 | 650ms |
| sheet open (Session settings), 120Hz | 126 | 8.3 | 8.4 | 2 | 13 | 148 | 156ms |
| sheet close, 120Hz | 134 | 8.3 | 8.4 | 1 | 3 | 137 | 87ms |
| Settings push (view transition), 120Hz | 85 | 8.3 | 8.4 | 1 | 8 | 91 | 90ms |
| Settings pop, 120Hz | 120 | 8.3 | 8.4 | 0 | 1 | 121 | 53ms |
| drawer swipe, same at 4x CPU | 672 | 8.3 | 8.4 | 2 | 29 | 725 | 1981ms |
| **sheet open, same at 4x CPU** | 117 | 8.3 | **25.1** | **9** | 13 | 149 | 684ms |
| sheet close, same at 4x CPU | 132 | 8.3 | 8.4 | 2 | 4 | 134 | 249ms |
| Settings push, same at 4x CPU | 85 | 8.3 | 8.4 | 4 | 8 | 91 | 280ms |
| Settings pop, same at 4x CPU | 120 | 8.3 | 8.4 | 0 | 1 | 121 | 144ms |

Reading it: the frame cadence holds at 120Hz except the sheet open under 4x
CPU, which misses 9% of frames with a 25ms p95 — the one small interaction that
needs work (it mounts the whole settings body while the slide runs). The
drawer's `style` count is ~1 per frame by construction: its drag writes an
inline transform per frame, which is style (cheap algebra on one property) and
not layout. The non-zero `layout` counts are first-mount work inside the
measured window (the drawer builds its list, the sheet builds its body), not
per-frame layout; a warm measurement would be needed to claim zero.

### The worst-phone standard

The UI stays as it is; the bar is that it holds on a phone nobody would buy
today. That is written down as a profile, a set of budgets, and a corpus, so a
change is judged by a number rather than by how it felt on the machine that
built it.

**Reference profile** (`--worst`): headless 60Hz, **6x CPU** (Chrome's
"low-end mobile" factor) and **software compositing**. No real phone rasterises
as slowly as software compositing, so this is a bound rather than a model of a
particular handset: anything that passes here has margin everywhere.

**Budget per interaction** (one display frame at 60Hz = 16.7ms):

| metric | budget | why |
| --- | --- | --- |
| p95 frame delta, **motion** | **17.7ms** (one frame + 6% for rAF quantisation) | continuous motion (a drag, a settle, a pop) must hold every frame |
| frames over 25ms, motion | **at most 1%** | those are the frames a reader sees as a stutter |
| p95 frame delta, **mount** | **33.4ms** (two frames) | a mount is a discrete action that builds nodes; it may hitch once |
| frames over 25ms, mount | **at most 5%** | beyond that the screen arrives in visibly broken pieces |
| main-thread tasks >= 50ms | **zero** | a mount or parse inside a gesture is what turns a composited animation into a freeze. The threshold scales with the CPU handicap (300ms at 6x): Chrome's 50ms is a native-speed heuristic, and an ordinary 10ms commit becomes 60ms under 6x |
| `LayoutCount` while motion runs | **0** (diagnostic) | transform/opacity only; a width/margin animation shows one per frame |

**Corpus**: a seeded 120-turn conversation (long prose, code blocks, tool
output) opened by title. The gate refuses to run against a live daemon: two
identical runs there measured p95 66.6ms and 99.9ms for the same build, because
the launch rule opens whichever chat is newest. Numbers are the **median of
five runs**, so one noisy pass cannot fail a change; a mount interaction still
varies 20-40% between batches (the same sheet opened at 116.6ms and 133.4ms in
consecutive three-run medians), which is why a fix is judged by the gate's
verdict and by a change larger than that spread, not by a single run.

**Ratchet**: `bench/motion-baseline.json` holds the median per profile. A
change fails when p95 grows more than 20% + 2ms, or the over-budget share by
more than 2 points, against it. `--update-baseline` rewrites it deliberately.

```sh
e2e/with-test-daemon.sh node scripts/measure-motion.mjs --worst --gate
e2e/with-test-daemon.sh node scripts/measure-motion.mjs --worst --reduced   # attribute a miss
node scripts/measure-motion.mjs --gate                                      # 120Hz spot check
```

`--profile` reports the top functions by self time for each interaction;
`--only=<text>` runs one of them. Add `--dev` to serve the app through vite, so
the profile names real functions instead of minified ones — dev numbers are
several times slower and are for attribution only, never for the gate.

`--reduced` runs the same interactions with motion switched off. It is a
diagnostic, not a comparison: with reduced motion `navigate` skips the view
transition, so the whole screen swap happens in one task (measured 180ms under
6x CPU). A miss that stays in both modes is mount work, not animation.

**Two rules that make the budgets reachable without shrinking the UI**:
motion writes only `transform`, `opacity` and scroll offsets; and no
main-thread work starts inside a gesture — a sheet mounts its body after its
slide begins, a list reorder glides nodes that already exist.

**Status, 2026-11-06** (the baseline above; median of five runs, worst
profile):

| interaction | kind | p95 | over% | longest task | script | verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| drawer swipe open + settle | motion | 16.8ms | 0 | 261ms | 128ms | pass |
| sheet open (Session settings) | mount | 33.4ms | 10 | 312ms | 293ms | **fail** |
| sheet close | mount | 16.8ms | 2 | 147ms | 294ms | pass |
| chat open (120 turns) | mount | 183.3ms | 15 | 246ms | 1236ms | **fail** |
| composer expand | mount | 16.8ms | 0 | — | 12ms | pass |
| Settings push | mount | 16.8ms | 3 | 156ms | 481ms | pass |
| Settings pop | motion | 16.7ms | 0 | — | 14ms | pass |

Two remain, and they are the two that still build every node synchronously:
opening Session settings (10% of frames over, right on the p95 boundary) and
opening a chat (15%, 183ms p95, 1.2s of script at 6x). Both are the same
problem — React creating elements for rows the reader cannot see — and both
need the same fix: mount the viewport plus a screen and extend on scroll. The
sheet is also **bimodal**: in five passes it lands between 16.8ms and 33.4ms
depending on whether the model catalogue was already in memory, so its first
open (the one a reader feels) is the slower mode and the median flatters it.
Splitting "cold" from "warm" in the gate is the next measurement change.

### Session-page authority ingestion

Actual TypeScript controller/store, Node 24.19.0 with a network-blocked synthetic
DOM, against the unbatched baseline. One daemon namespace, unique passive paths, accepted
revisioned authority, 50-row pages; refresh supplies the complete retained set at
a newer revision. Test-only record proxies count own keys copied by object spread;
array instrumentation counts findIndex callbacks, index-building visits and retained
array slice elements. These are deterministic work counts, not device latency.

| workload | baseline copied record keys | batched copied record keys | baseline retained lookup visits | batched lookup + index visits |
| --- | ---: | ---: | ---: | ---: |
| 500 rows, 10 pages | 249,500 | 9,020 | 112,500 | 4,500 |
| 1,000 rows, 20 pages | 999,000 | 38,040 | 475,000 | 19,000 |
| 2,000 rows, 40 pages | 3,998,000 | 156,080 | 1,950,000 | 78,000 |
| 2,000-row newer-revision refresh | 8,000,000 | 8,000 | 2,001,000 | 2,001 |

The last workload also reduces copied retained array elements from 4,000,000 to
4,000. Active paths and raw daemon-namespace boundaries remain single-row updates;
only contiguous passive notifications collapse. Each passive batch is linear in
retained rows/records plus its input. Accumulating many immutable pages still costs
O(total rows squared / page size); no claim of globally linear paging, browser
paint improvement or end-to-end phone speedup is made. Dedup/cache/UI are unchanged.

The checked-in `web/test/session-page-batching.test.mjs` preserves a smaller
300-row deterministic budget plus ordered state/snapshot, tracker, stream and
advancing-clock regressions. Independent differential checks against the unbatched baseline cover
161 scenarios / 35,081 rows separately under fixed and advancing clocks.

### Child lifecycle retirement (no new measurement)

The child lifecycle fences described in
[session-state.md](session-state.md#the-child-pool) are a correctness change checked
by source-bound compilation and inert tests. They do not measure RSS, phone latency
or battery life; earlier measurements on this page keep their original scope.
