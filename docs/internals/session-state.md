# Session state, turns and the daemon's children

This page covers the per-session authority record, how turns stop, get cut off and
take prompts mid-turn, and the pool of omp children the daemon spawns. The overview
is in [architecture.md](architecture.md).

## The authority record and source fencing

`src/authority/session_state.rs` holds the accepted owner, binding epoch, turn,
connection, activity and supported controls for each session. HTTP history
(including empty pages), socket bundles, listing rows and activity frames project
that record. Daemon-instance IDs and monotonic revisions fence delayed client
deliveries; transport generations fence retired child, bridge and collaboration
producers before lifecycle, receipt or notification effects. Snapshot reads do not
consume the event watermark, so reading a terminal snapshot cannot swallow its event.

Transport loss preserves last-known activity as reconnecting, not completed.
Nonterminal agent boundaries likewise do not settle a turn or command receipt.
Conflicting verified owners are explicit ambiguity, not a route precedence rule.
Existing legacy fields remain projections for supported older clients and adapters;
inferred ownership does not invent capabilities or disable existing guarded routes.
The browser reconciles every state ingress through shared authority selectors.
Command delivery receipts remain distinct from turn state: forwarded is not
completed (see [delivery.md](delivery.md)).

An accepted terminal event publishes idle even if an earlier bridge observation
already evicted the activity cache. Otherwise the list can retain the pre-terminal
projection while the open conversation has already finished.

## Stopping, and unexpected exits

The reconnecting state is for unexpected exits only (crash, failed boot, a kill that
cut a turn, a terminal adopting the session), which also send the
`agent process …` error frame. A child the daemon stops on purpose while idle
(idle or unwatched reap, idle eviction, RSS recycle, shutdown) emits
`ChildEvent::Stopped` instead: the record goes unowned, idle and connected at once,
and the activity frame pushes that to the list and any open chat with no error.
Stop on a turn whose child already exited settles it the same way (`/api/abort`
answers `stopped:false, reason:"no agent running"`), and a child killed while still
streaming after its abort first gets a synthetic `session_settled`.

The phone's Stop sends `restoreQueue: true`: `/api/abort` asks the accepted child
or desktop bridge owner to `abort_and_restore_queue` and answers
`withdrawn: {messages: [{text, images}], imagesDropped, truncated}`. Protocol 4
preserves message boundaries so the client can restore photos and remap each
message's numbered references when merging into the draft. A collab-only or
foreign owner without the desktop control bridge refuses recovery rather than
losing queued content. The Android notification's Stop ignores the reply and
keeps plain `abort`, which can let queued steers run afterwards.

## The child settings overlay and side questions

Every child gets `--config <state_dir>/omp-child-settings.yml`, a per-process
settings overlay that adds `rpc` to `goal.continuationModes`. Without it a goal
created from the phone (`goal` RPC) ran one turn and stopped; the user's own omp
config is never written. `/btw` side questions use omp's `btw` RPC beside the turn
(`btw_delta`/`btw_record` frames go only to the side sheet), and a running side
question keeps the child from being reaped.

Every child also loads the helper extension `extensions/omp-pulse-child.ts`; see
[dialogs-and-controls.md](dialogs-and-controls.md#phone-controls-in-the-child).

## Interrupted turns

`src/authority/interrupted.rs` keeps `turns-in-flight.json` in the state dir. The
router records a session when the daemon's own child starts a turn and drops it when
the authority record goes idle. At startup every turn still recorded, whose
transcript tail does not show a closing reply for it, becomes interrupted (cause
`restart`); a child that exits mid-turn does the same at once (cause `exited`). Each
gets one `agent_end` notification. Listing rows, history pages and the socket bundle
carry `interrupted: {startedAt, detectedAt, cause}` (hidden while a live owner runs a
turn) until a new turn starts or `POST /api/interrupted/dismiss` clears it. The chat
offers Continue; nothing is resent automatically.

## Mid-turn prompt delivery

`POST /api/prompt` takes an optional `delivery`: `steer` (default, as the omp TUI
does on Enter), `queue` or `interrupt`; anything else is a 400 before a receipt
exists. Only a streaming owner applies it. A daemon-hosted child always gets
`prompt{streamingBehavior:"steer"|"followUp"}` (our streaming flag lags omp's, and an
idle omp ignores the field), or `abort_and_prompt` for an interrupt while we know a
turn runs (same `pulse-prompt:<commandId>` id, so receipts correlate unchanged). A
send held for a free agent keeps its mode until it dispatches. The desktop bridge
gets `deliverAs` (`steer`, or `followUp` for queue and interrupt: it has no
abort-and-prompt, so the message is kept rather than the turn killed). The collab
host's `prompt` frame carries no mode and always steers. Session capabilities report
`queue` and `interrupt` per owner (child both, bridge queue only, collab neither) and
the phone hides what is unavailable. Both outboxes persist the mode with the durable
intent so a replay keeps it.

## The child pool

`src/omp/child.rs` spawns `omp --mode rpc-ui` for a session the desktop is not
holding (`rpc-ui` rather than `rpc` because only it gives the agent a UI; see
[dialogs-and-controls.md](dialogs-and-controls.md)). Each child costs about
280 MiB (281 MiB p50, 305 MiB p95, 493 MiB peak at boot, measured in
[performance.md](performance.md#memory)), so the pool is bounded and children are
reaped aggressively.

**RPC envelope.** Generic RPC frames reserve top-level `id` and `type`:
`rpc_with_id` uses the caller-selected command and correlation ID after merging
ordinary params, so params cannot replace the command classified by HTTP routing or
the pending response ID. Nested id/type fields and all other params remain
unchanged. This envelope invariant does not change Control-role requirements or
ownership decisions.

**Capacity.** The pool is capped (`max_children`: 3 on a phone, 6 elsewhere) and
never stops a busy child to make room: busy is a live turn, background work omp
reported after the turn (`prompt_result.sessionSettled:false` until
`session_settled`), an open dialog or an RPC in flight. With every slot busy,
`/api/prewarm` does nothing; command catalogues come from a live child in the
project, the per-cwd cache (also mirrored under the state dir, any age when full) or
any live child; and New chat, slash commands and session RPCs answer 503
`agents_busy` with a sentence. A prompt is held instead (receipt
`accepted`/`agents_busy`) and sent, in order per chat, when a slot frees; after an
hour, or across a daemon restart, it fails as never sent. Holding beats a 503
because the installed Android outbox re-posts a 5xx every 8 s as "uncertain" and
fails a 4xx outright.

**Reaping.** Idle children are reaped by a 10 s maintenance pass (parked while no
child exists): 15 min after the
last activity (`child_idle_secs`), 60 s after the last visible viewer left
(`child_unwatched_secs`; the web app sends `{type:"visibility", visible}` on `/ws` at
every visibilitychange and on reopen while hidden, so a hidden page keeps its live events
and notifications but stops pinning a child), and at once, oldest first,
when host `MemAvailable` falls below 800 MiB. A child past `child_rss_mb` (700 MiB)
is recycled, because `switch_session` accumulates memory and never gives it back.

**Managed switching only.** `switch_session` is not a public `/api/rpc` command.
The child manager also refuses it before opening a child, and the per-child gate
admits it only for boot or exclusive retargeting. Otherwise a valid source path
could smuggle in an unchecked destination and leave the registry bound to the wrong
session. New/open and branch/fork navigation use their existing managed routes;
branch/fork return the destination path for the client to open normally.

**Lifecycle ownership.** Never-registered catalogue-spawn and detached-command
children own cancellation cleanup in the monitor and retain admission until
successful observed reap. Reused registered catalogue children instead use bound RPC
ownership. A shared per-child gate covers registered admission, raw UI writes,
background observations, exclusive retargeting and final
capacity/idle/unwatched/memory retirement. Uncertain registered work stays owned
until its exact response or teardown, without automatic replay. The two-hour
background bound, persisted or stale catalogue routing, busy refusal,
resident-plus-swap accounting, unconditional followUp, direct libc TERM and
`Result<bool>` abort remain intact. Planned stop intent is latched under the gate
before signal submission; failed submission rolls back both intent and phase. These
are observed-work fences, not proof of every post-ACK continuation. Idle maintenance
never invokes the forced graceful-abort path. A registered timeout or cancellation
keeps exact-response ownership: ordinary new requests are refused while abandoned
work remains, and the exact reply or teardown releases it. Uncertain raw writes or
bindings stay quarantined. Registered physical-reap capacity retention and
unobserved post-ACK continuations are outside these fences.

**Physical admission.** Registered physical admission is retained separately from
live routing: successful spawn installs a manager-owned handle and charge before
fallible setup; registration does not change capacity. The reader still drains
output before logical finish, then polls wait in place under a short owner lock.
Only successful owned wait returns the slot; cancellation or error retains it.
Full-pool admission selects at most one eligible victim and accounts for registered
retirement already recorded at its serialized decision. Defensive trim excludes
already-committed stops from its remaining alive-route target. Independent
maintenance, operator and EOF paths keep their existing concurrent authority. Status
reports physical `occupied` separately from routing `alive`; `in_flight` is
saturating occupied-minus-alive, including stopped waiters. This does not change
sidecar or direct-switch policy, boot-caller cancellation, ephemeral cleanup or
shutdown completion obligations.

**Models and providers.** Phone-created children use the installed `omp` binary and
its model registry, including `~/.omp/agent/models.yml` overrides. Do not duplicate
provider or model selection in omp-pulse. `e2e/browser/verify-send.mjs` reports the
selected model name and API; a send ACK is not proof that the provider accepted it.
Never resolve a provider consent rejection by accepting a data policy silently. How
the service environment interacts with omp's own `.env` is in
[configuration](../user/configuration.md).
