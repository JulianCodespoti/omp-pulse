# Daemon I/O and memory bounds

This page covers the bounds on the daemon's blocking file work and retained memory
outside the streaming hot path: the shared file-I/O admission gate, the session-index
memos, the watcher's attachment probe and the socket queue's byte accounting. The
hot-path bounds (per-client queues, back-pressure) are in
[architecture.md](architecture.md#back-pressure-which-is-where-the-subtlety-lives)
and the measurements in [performance.md](performance.md).

## File-I/O admission

`src/server/http/files/file_io.rs` holds one process-wide gate of two slots, shared by
every router and listener. Five routes take it: file preview and save
(`GET`/`POST /api/file`), both raw downloads (`/api/raw` and `/raw`), and the
directory listing (`GET /api/files`). Each runs its whole filesystem-dependent
operation inside a slot on Tokio's blocking pool: session and path resolution,
session-header and cwd lookup, containment, metadata and type checks, then the read,
the parent creation and write, or the scan (for listings also per-entry metadata,
sorting and JSON construction). No filesystem work runs before admission, so a save
can overlap a preview but nothing runs on a request worker.

**Waiting.** A request that finds both slots taken waits up to 10 s for one; a
dropped requester leaves the queue. The first version refused at once, and tapping a
second file while a preview still read showed an error the file viewer never retried.

**Failures.** Saturation past the wait returns HTTP 503
`{"ok":false,"error":"file operation busy"}` before any filesystem work, so busy can
precede ordinary session, path or validation errors. A blocking-task join failure
returns HTTP 500 `{"ok":false,"error":"file operation failed"}`. Neither adds a retry
instruction. Admitted operations keep their ordinary responses and validation order
(an admitted listing error is still HTTP 200 with `ok:false`).

**Ownership.** The blocking job owns its slot until its closure returns or unwinds,
including when the HTTP requester was dropped: cancellation never releases a slot
early, and a started write is not cancelled. The slot ends when the closure returns,
before the response body is consumed.

**What it does not bound.** It bounds admitted queued and running work and keeps
blocking calls off request workers. It does not bound latency, scan duration, entry
count, file size, response size, or the memory of completed responses still being
sent (a raw download holds the whole file). Two stuck operations make all five routes
busy, while other handlers are unaffected. Authentication, query extraction and
middleware run before the handler; authentication may synchronously persist device
last-seen data and is outside the offload. `/api/browse` and the transcript readers
are outside the gate. Not added: pagination, size caps, streaming, retry, timeouts,
conditional or atomic saves, external-writer coordination, uncertain-save recovery,
or protection against metadata/read replacement races.

**Per-route detail.**

- **Previews** (`GET /api/file`) read through EOF or 1 MiB + 1 observed bytes,
  return at most the first 1 MiB, and derive `truncated` from the extra byte.
  Successful short reads and `Interrupted` no longer omit available content; other
  I/O failures reject partial results. Binary sniffing and lossy UTF-8 are
  unchanged. Size and mtime are sampled metadata, not a coherent content snapshot.
- **Raw downloads** check the resolved target's metadata before the whole-file read:
  an observed non-regular target returns HTTP 400 with `ok:false` and `not a file`;
  metadata failures keep the ordinary error convention. Authorization, containment,
  regular bytes, MIME and `no-store` are unchanged. The precheck does not close
  replacement races or bound download memory. Its tests are source-bound and use
  protection mutants, so they cover handler decisions without opening special files.
- **Listings** keep their types, metadata-failure skips, iteration-error flattening,
  relative paths and dirs-first, name-ascending order.

**The client side.** The Files tab (`web/src/app/tools/FilesTab.tsx`) surfaces busy
through its ordinary error and manual Retry, which reloads the folder it was
showing. The new-session folder picker (`web/src/app/sessions/NewSessionScreen.tsx`)
uses `/api/browse`; when its remembered folder fails it clears it and starts at home,
so gating `/api/browse` would need matching client work first. Save outcomes on the
client are in [web-client.md](web-client.md#unconfirmed-file-save-outcomes).

## Session-index memos

The listing index (`src/sessions/index.rs`) keeps metadata, snippet and model memos
per session file (`src/sessions/index/memo.rs`).

- **Bounded.** Each memo enforces a FIFO limit of 4,096 entries and 4 MiB of retained
  owned dynamic path and value storage, counting both path-key copies and every value
  `String`'s capacity. Container backing allocations and other overhead are
  additional; this is not an RSS limit. Oversized values return unchanged without
  retention, and every insertion enforces the bounds independently of scan
  completeness or root ownership.
- **Precise stamps.** The memos key on the filesystem's precise
  `Option<SystemTime>` plus length. Integer-millisecond wire timestamps are
  unchanged; using them as memo keys previously hid same-size rewrites inside one
  millisecond. Equal actual stamps plus equal lengths, and concurrent read/rewrite
  races, remain metadata-only detection limits.
- **Malformed timestamp fractions.** Metadata and snippet reads take fractional
  milliseconds through a checked UTF-8 substring. An invalid character boundary
  yields an unavailable time without losing the newest message identity, revision,
  snippet or terminal outcome. Numeric timestamp precedence and ASCII fractional
  precision are unchanged. This is a narrow panic fix, not a calendar or ISO
  validator.

## Watcher attachment boundaries

Initial watch and rewatch (`src/sessions/watcher.rs`) preserve a final incomplete
record's start when a backward probe in 4 KiB chunks finds its delimiter or the file
start within 8 MiB in total. Complete-line EOF behaviour, the raw-EOF fallback for
unprovable or error cases, audience gating and catch-up caps are unchanged. Empty or
non-regular metadata skips the probe open; metadata, probe and reset are serialized
under the per-path lock, never the global map lock. Stable-ID entry replay is still
handled by the client. This does not repair truncation or replacement, or HTTP cursor
reset behaviour.

## Socket queue accounting

In `src/server/ws.rs`, a client queue's entries and their canonical-text byte total
share one mutex. Every replacement, eviction, pop and resync updates the total with
the entries, so budget checks no longer rescan payloads. Delta order, resync
boundaries and wire accounting are unchanged. The measured effect is in
[performance.md](performance.md#bounded-architecture-microbenchmarks).
