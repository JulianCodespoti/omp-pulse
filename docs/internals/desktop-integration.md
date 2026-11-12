# Desktop integration

This page covers how the daemon reaches conversations a desktop omp owns: the
extension bridge, the collab relay, desktop model control, and moving a conversation
to a laptop terminal. The overview, including why there are four live paths, is in
[architecture.md](architecture.md#the-live-paths-and-why-there-are-four).

## The desktop bridge

The desktop omp runs the omp-pulse extension (`extensions/omp-pulse-control.ts`),
which publishes a pid-keyed descriptor naming its exact session file and serves
`GET /events`: an NDJSON stream of the same `AgentSessionEvent`s `omp --mode rpc-ui`
prints. `src/omp/bridge.rs` keeps one reader thread per desktop process and
republishes those events into the child-event channel, so a laptop turn reaches the
phone through the child pipeline unchanged (delta encoding, listing refresh,
activity, the completion buzz). Phone prompts and Stop go back through
`POST /control`. The owner processes prompts through `AgentSession.prompt` and native
skill invocation, preserving normal magic keywords, model mentions, templates,
images and steering/follow-up queues. Plain Stop uses `ctx.abort()`; restoring
Stop uses the owner's `clearQueue({forInterrupt:true})` before aborting. Queued Edit
and Remove instead select an exact owner-issued object ID through the shared
`extensions/pulse-queue.ts` helper, preserving the selected message's photos and
hidden companions even among identical texts. Taken steering rows are read-only.
Promotion delegates to native `promoteQueuedMessage` with a one-shot, exact-index
matcher; the native owner still performs its single queue move, idle drain and
retry unblocking. No mutation falls back to text matching. Recovery responses have
the native 64 MiB bound rather than the 512 KiB settings bound; older extensions
and collab-only owners refuse recovery instead of claiming their queues are empty.
The owner stays the only writer, so this is also the strongest ownership proof
`write_path` and `ChildManager::open` consult. While a session is bridged the collab
tap stays silent for it.

Before replying to a restoring Stop or a queued Edit/Remove, the extension writes the
withdrawn text and photos to the same per-session journal the daemon reads
(`queue-recovery/` in the state directory) and returns its `recoveryId`. A record too
large for the bridge frame stays intact on disk and the reply carries only
`recoveryPending`; the daemon replays it one record at a time. The phone
acknowledges a record with `acknowledge_queue_recovery` only after its own draft save.
See [delivery.md](delivery.md#withdrawn-native-queues).

The extension translates the owner's `agent_end.willContinue` into RPC
`isTerminal: false`. A logical turn stays running through compaction, retry and
continuation pauses, including reader reconnects; settings and close requests
remain blocked during those pauses. Only a terminal owner end clears the turn.
Losing the owner connection is not successful completion.

Read-only `get_prompt_config` and `get_model_mention_choices` expose the owning
session's effective keyword settings/tool eligibility and scoped model choices.
The phone never substitutes local defaults when this metadata is unavailable.

The bridge mirrors the shared native UI's notices, status text, text widgets and
prepared editor text after Pulse initialises, while still invoking the original
terminal methods. Bounded current feedback and stable draft IDs survive reader
reconnects; clear operations and owner changes remove stale state.
OMP 18.8.6 exposes no getter for earlier notices/status/widgets, so calls made by
other extensions before Pulse's initialisation cannot be recovered. The native
stdio path captures its startup frames independently.

Only `hasUI` sessions publish (subagents share the process and used to overwrite the
parent's pid-keyed descriptor), and the daemon's own children are excluded by
`OMP_PULSE_CHILD=1`. Descriptors of dead pids are pruned by a 5 s rescan, which runs
only while descriptors exist: with none, the reconciler waits on the descriptor
directory's watch, so a phone with no desktop omp is not woken.
`e2e/omp/verify-bridge.mjs` proves the loop end to end.

## Desktop control: model settings and compaction

Desktop model and reasoning settings use `src/omp/desktop_control.rs` and the same
extension, not collab prompt text. The extension publishes a private PID/session
descriptor and authenticates a loopback-only settings endpoint. The daemon resolves
the existing process owner before routing a request. omp applies settings through
its own API and returns observed state; native session navigation is blocked while
an asynchronous settings change is applying. No second writer or direct session-file
edit is introduced. `omp-pulse setup` installs the extension; upgrades use the
explicit `omp-pulse desktop-control install` command. Normal daemon startup never
installs it, so isolated harness daemons cannot rewrite the user's installed
extension. `e2e/omp/verify-desktop-control.py` covers it.

Delivery modes come from the active desktop session and are read-only on the
phone. Unknown modes remain Unavailable; no default selection is invented.
Context snapshots carry the native-clock start of their measurement so a response
started before compaction cannot restore a stale percentage.

Phone-initiated compaction of a desktop-owned session rides the same bridge:
`ExtensionContext.compact` runs in-process on the host, so the single-writer
invariant holds. The collab protocol carries no compact channel, which is why the
mutating-RPC gate still refuses `compact` on the host path.

## The collab relay

When a TUI already owns the session but runs no bridge-capable extension,
`src/omp/collab.rs` joins that session's collab room as a guest and forwards the
host's frames. Without a bridge this is the only way to see desktop typing at token
level.

Stored links and explicit `POST /api/collab/announce {sessionId, link}`
announcements come first. When attaching or sending, `src/terminal/adopt.rs` next
uses `src/omp/native_collab.rs` to query the supported `omp collab list --json`
registry and request a link for the exact session. The link's instance, generation
and control access must still match; ambiguity, rotation and view-only hosts fail
closed. The native registry owns private IPC and capability retrieval; omp-pulse
neither scans speculative runtime files nor logs links. With omp's opt-in
`collab.autoStart: control`, this needs no terminal input. Only absent or
unsupported native hosts fall back to herdr, kitty or tmux adoption, then
manual `/collab`. Merely viewing a conversation still does not trigger adoption;
existing stored and announced auto-attach behaviour stays.

### Tern adoption

Tern runs omp as a native surface, so the Pulse bridge extension and omp's native
Collab list/link work unchanged. `src/terminal/adopt/tern.rs` only adopts an
already-sharing host and runs before the daemon-default native Collab lookup (it is
itself native discovery), then herdr, kitty and tmux.
It matches a Tern owner by the exact canonical session file and known owner pid,
then runs omp's native Collab CLI, bounded, in that owner's home, config directory,
profile and runtime and validates the link's session, control access and
generation. It never trusts persistent screen or transcript hints, so a stopped
share is not revived from an old link. Outcomes: not a Tern owner or genuinely gone
lets the normal path continue; an active exact host yields its link; a known Tern
owner that is unshared, refused or errored is authoritative and never falls through
to keyboard typing.

There is no helper plugin, spool or raw input, and no Tern injection backend or
availability entry (herdr, kitty and tmux remain the injection backends). A refusal
sends no keys, focuses nothing, launches no GUI and leaves an unsent draft intact.
The reason: Tern's native surface can lag about 5 seconds and a native ask replaces
the draft with no atomic guard (omp 18.18.1,
`packages/tui/src/prompt/custom-editor.ts`). The user shares via the loaded Pulse
extension, `collab.autoStart: control` or a manual `/collab`. Adoption is not a
desktop launch; "Open on laptop" stays herdr-only. Tested on Linux with Tern 0.9.12
and omp 18.18.1; macOS and Windows native fallback runtime is unexercised. User
setup is in [configuration](../user/configuration.md#tern).

### Direct agent follow-ups

The Agents conversation sends direct replies through native collab `agent-cmd`
`chat`, separately from preparing a main-chat draft. Running, idle and parked
subagents are eligible; cancelled agents, advisors, ambiguous identities,
unavailable owners and view-only connections are refused. The route never starts
a replacement child or silently falls back to the main conversation.

Admission and socket drain both check the captured daemon binding, parent
session, desktop connection, scoped agent identity and creation time. Replacement
or disconnection cannot replay a queued reply into a new owner. The UI prevents
duplicate dispatch and retains refused or unconfirmed text.

Native omp 18.10.4 does not include an expected agent reference/creation time or
callback receipt in `agent-cmd`. Its host can await parking in `ensureLive` before
re-reading an agent ID. The daemon's fences cannot make that final host-side
replacement/cancellation window atomic. A successful write therefore reports
connection handoff, not confirmed acceptance by the selected agent.


### Guest liveness

The ordinary guest's joined lifetime (`collab/guest_liveness.rs`) sends WebSocket
Ping every 15 seconds and records inbound socket traffic, including Pong, on a local
monotonic clock. An independent guard ends that connection transiently when a
15-second check observes more than 40 seconds of silence. Checks skip missed ticks;
scheduling delays are not a reconnect-completion guarantee. A relay Pong proves
transport reachability, not desktop execution or host-to-relay health.

The guard encloses live outbound and Pong awaits. Initial queued-answer writes use
the same guard individually: a failure stops further sends while the shared flush
restores unsent answers, only under the current attachment generation. Detach or
replacement cannot restore the retired queue. Prompt writes retain their existing
receipt and cancellation behaviour; an interrupted write is uncertain, never
replayed. No new RPC child or independent reconnect owner is introduced.

Completed fatal outcomes take priority over an expiry tick; existing close codes,
room-closed, bye, decryption rejection and first-join behaviour remain unchanged. A
timeout cannot classify a fatal frame that the existing operation has not read. The
existing guest reconnect loop owns backoff, generation fencing and the write gate.
Relay taps and host-peer routing are unchanged: a tap's local relay Pong cannot
detect a silent remote host, and taps still rely on host reconnect to retap.

Verification uses injected ticks, pending/recording sinks and in-memory channels. It
does not establish socket, browser, sleep/resume, device, installed-runtime,
full-gate or deployment acceptance.

### Bounded relay peer output

Each self-hosted relay peer admits at most **256 outstanding frames and 128 MiB of
wire-payload bytes**, including the frame being sent. `collab/relay_output.rs` uses
an atomic count/byte reservation for every binary or control producer. The
reservation stays owned by the frame across dequeue and the writer's send await;
success, error, receiver drop and task cancellation release it. Captured sender
clones reject new admissions after retirement. This bounds logical payload length,
not allocator capacity or all process memory.

A guest output overflow closes that guest's admission, removes its
current-generation membership and cancels its reader and writer. Healthy peers
continue; the existing peer-left control uses the same limits. Cascading failures
are processed iteratively with each peer scheduled once. Host output failure closes
the current room's admissions and tears down that generation only. Join
announcements and normal Gone cleanup use the same generation-fenced lifecycle.
Removed routing and socket handles are cancelled after releasing the registry lock.
Queue-budget code never acquires the registry mutex; no mutex is held across an
await.

The byte budget accommodates one 64 MiB WebSocket message. The four-byte collab
prefix is already included; sender stamping does not expand it. A 4 MiB transcript
range is not a wire-frame limit because JSON escaping, metadata and AES-GCM framing
add bytes and validation happens after forwarding and decryption. Over-budget bursts
intentionally interrupt that transport: encrypted commands, answers and receipts
cannot be classified for conflation, truncation or silent queue discard while leaving
the connection healthy.

Cancellation does not guarantee graceful Close delivery or immediate remote
observation. If the affected guest is the internal tap, its observed EOF/error path
retires its source, marks the connection Reconnecting and activity stale, closes the
write gate and reports stream loss. A tap inside an existing inner send await may
observe the failure later. Recovery stays with manual attach or host replacement; no
reconnect owner, heartbeat or receive pump is added. No prompt is replayed and no
success or non-execution acknowledgement is invented: a previously observed
forwarded receipt remains only the guest socket write, never proof of desktop
execution.

Room ingress `PeerEvent` channels, live room and peer counts, upstream
`CollabSession` queues, one incoming or rejected frame, socket staging and
object/allocator overhead remain outside this bound. Tests use in-memory queues, task
probes and generic pending/recording sinks. They do not establish live throughput,
RSS, socket timing, phone or installed acceptance, or the full gate.

### Replaced relay-room task ownership

A live host cannot be displaced by another connection claiming `role=host`.
Admission checks and publishes under the room-registry lock; a contender receives
close code 4009 (host conflict), without replacing the host, guests or internal
tap. The bare-room protocol remains supported. Reconnection is accepted only once
the old host has departed or its relay output is closed, not merely because a
new socket claims to be the host.

When a stale room entry remains, `join_as_host` publishes the replacement room and
signals the removed room's watch. After releasing the registry lock, it consumes
that removed room through `RelayRoom::abort_tasks`: the old routing task and all old
peer reader and writer tasks are cancelled. The removed value is the authority for
cancellation; cleanup never looks up the replacement's peers by room or ID. Dropping
a Tokio `JoinHandle` would merely detach its task, allowing a silent old reader or
blocked writer to retain a socket after the room was replaced.

Cancellation is completed by Tokio scheduling, not synchronously by `abort()`. This
path does not promise a graceful WebSocket close. Normal room teardown, retapping,
wire routing and guest/tap liveness behaviour remain unchanged. Regressions cover
live socket conflicts, concurrent claims, preserved guest/tap traffic and genuine
reconnects, alongside pending-task probes for stale-room cancellation. They do not
establish installed-phone acceptance.

## Laptop handoff

`POST /api/desktop/open` (`src/terminal/handoff.rs`) moves a conversation the laptop
is not running into a herdr tab there: herdr starts the user's own
`omp --resume <file>` TUI, whose extension then bridges it back, so the phone keeps
streaming and sending through the laptop. Tabs go into workspaces labelled
`Pulse mobile`, `Pulse mobile 2`, … of at most four tabs each, read back from
`herdr workspace list` on every call rather than remembered, and nothing is focused.

If herdr is stopped, handoff starts it and waits for its API before releasing the
phone owner. Only a structured server-not-running response permits startup; timeouts
and protocol errors never launch a competing server. Busy or foreign-owned
conversations are refused before startup and checked again afterwards.

`src/terminal/herdr_startup.rs` validates the selected herdr's configuration with
`herdr config check`, then atomically sets only
`session.resume_agents_on_restore = false`, preserving comments, permissions and
symlink targets. Otherwise herdr can restore saved conversations still owned by phone
children; even a schema error can enable that behaviour by falling back to defaults.
Layout and history remain, but only the selected conversation resumes. A running
server's config is untouched. On systemd Linux, startup uses a separate user scope so
restarting omp-pulse cannot kill herdr.

**INVARIANT: the TUI starts only after our own child for the session has EXITED.**
Signalled is not enough, because omp flushes the session on SIGTERM. The handoff
checks herdr is reachable BEFORE stopping anything, refuses while a phone reply is
streaming or when anything else holds the file, waits out an in-flight boot
(mid-boot our child's sidecar reads as a foreign owner), and while it runs
`ChildManager::do_open` refuses to spawn a child for the path.

`e2e/omp/verify-laptop-handoff.mjs` proves it against a throwaway named herdr
session; `e2e/with-test-daemon.sh` isolates both `HERDR_SESSION` and
`HERDR_CONFIG_PATH`. The suite covers cold start, saved-layout restoration without
bulk session writers, failure preservation, and herdr surviving daemon shutdown.

## Laptop sessions in the list

How the phone's list shows sessions open on the laptop, and how laptop-driven turns
are told apart from open-but-idle ones, is in
[web-client.md](web-client.md#laptop-visibility-and-read-state). herdr's per-pane
agent state (`src/terminal/herdr_state.rs`) feeds the listing's running and blocked
state for laptop TUIs; checking it against a deployed daemon is described in
[deploying](../contributing/deploying.md).
