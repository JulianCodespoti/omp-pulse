# Command delivery, identity and client persistence

This page covers how a prompt gets from a phone to an agent exactly once: the
daemon's command ledger and receipts, device enrolment, and the durable outboxes and
drafts in the browser and the Android app. The overview is in
[architecture.md](architecture.md); turn state is in [session-state.md](session-state.md).

## The command ledger and receipts

`src/authority/command_ledger.rs` persists a command identifier before dispatch.
Repeating the same identifier and payload returns its receipt; a conflicting payload
is rejected. Restart recovery treats a possibly started handoff as uncertain, not
permission to execute it again. Child lifecycle events update receipts. The client
retains durable intent, including image bytes, and reconciles ambiguous delivery by
receipt lookup rather than blind retry.

Desktop prompt receipts advance to `forwarded` only after the encrypted socket write
succeeds. That is terminal for delivery, not agent execution; ambiguous writes remain
uncertain and are never automatically replayed.

### Receipt session binding

The complete daemon binding contract is advertised by the additive
`receipt-session-binding-v1` capability in `/api/version`. Numeric protocol and
minimum-client versions remain unchanged. Updated browser dispatch requires both
existing numeric compatibility and this exact capability; unsupported preflight keeps
the original intent saved and makes no prompt POST.

Successful prompt acknowledgements, including direct same-ID replays, contain a
sibling `receiptBinding` with version 1, the exact `requestedSessionPath` and the
`canonicalSessionPath` resolved for that request. Every prompt branch uses the same
checked response seam. `GET /api/receipts/{commandId}?session=...` resolves the
supplied raw path through the unchanged resolver and checks the stored receipt's
canonical path before returning the same envelope. It uses ledger `get`, including
archived receipts. Invalid scope is 400, canonical mismatch is 409, and only an
absent exact ID after valid scope is 404. Unscoped lookup remains unchanged for older
and native clients. The list endpoint is not recovery proof.

This is authenticated server-resolved agreement, not cryptographic or historical
inode identity. Alias retargeting or deletion can leave earlier work unconfirmed; it
never authorizes replay. No writer arbitration, ledger format, shared path resolver
or file-save behaviour changes. Normal browser command IDs are whitespace-free
UUID/cmd identifiers; the backend trims ingress IDs then stores and echoes them
unchanged. Imported or caller IDs with surrounding whitespace can remain
unconfirmed; the browser never silently changes a durable intent key after
submission or updates the record for the trimmed ID.

## The browser outbox

Browser submit and status paths share command-receipt validation before applying
state: exact requested command ID, all eight backend states, nonempty identity
strings, nonnegative integer timestamps and optional string error/code fields.

The browser requires the exact alias echo, version, command ID and canonical receipt
linkage before applying evidence; it never normalizes client paths or compares a raw
alias directly with a canonical path. Bound evidence survives the final queue
dispatch boundary and existing durable storage in an optional sibling
`receiptBinding`. Legacy or local synthetic receipts are last-known evidence, not
canonical witnesses. A present malformed binding fails closed instead of being
silently treated as legacy absence. A validated binding pins canonical continuity
for that intent, including reload. Atomic application checks the current durable row
and latest binding again, fencing overlapping observations and removed or recreated
intents. New browser rows retain an independent local incarnation token for
same-millisecond replacement fencing. Tokenless legacy rows are not backfilled:
byte-identical legacy-to-legacy recreation cannot be distinguished, and existing
no-Web-Locks cross-tab transaction limits remain.

### Lease expiry

Hydration and existing visible-page maintenance share conservative local lease
expiry. The deadline is `updatedAt` plus 60 seconds and the payload's upload
allowance at 32 KiB/s; expiry uses strict greater-than. Each due row is re-read under
existing mutation exclusion and in its IndexedDB transaction, checking credential
scope, exact intent and incarnation, dispatch state, lease stamp and current
receipt/binding. Only local state and state-change time become uncertain; payload
bytes, raw alias, errors and evidence (including absent or invalid-present binding)
remain intact. Committed storage is re-read before the snapshot is published. Failed
persistence leaves the durable intent unchanged and retries on the next eligible
maintenance pass. Terminal retention pruning uses the same per-row fencing, never
stale whole-store replacement. The 50-row capacity applies to nonterminal intents,
not all retained terminals; large expired terminal sets can take more hydration
transactions to prune.

A young recovered dispatch is reconsidered by the existing visible one-second ticker,
session open and visible resume, independently of receipt availability and
connectivity. Overlapping controller passes coalesce; no new timer or network cadence
is added. Suspended pages expire on their next eligible pass. Expiry never sets
saved, invents a receipt, or resends. A live pre-handoff failure may still use the
existing guarded rollback, but cannot re-arm an already expired uncertain row.
Process death during preflight does not prove that HTTP handoff was impossible:
durable preflight and handoff phases remain explicitly deferred.

Invalid post-handoff acknowledgements retain the original uncertain intent without
replay or a replacement ID. Failed, absent or invalid status responses preserve the
entire prior row; independent clock expiry may subsequently change local dispatch
state. Reconnect, durable Check status and read-only Details use retained intent
context; Details never wakes or updates native outbox delivery. Old servers cannot
bless an unbound status merely by ignoring the new query. NativeOutbox has a separate
binding and targeted-status contract; browser guarantees do not imply native or
device acceptance.

### Pending intents in the composer

Browser chat lists retained saved, dispatching or uncertain intents that have no
owned transcript bubble (exact active scope and session) in the composer's queue
stack, with attachment counts and without loading image bytes. Native outbox
intents use the same projection after navigation or WebView recreation, including
unconfirmed and refused delivery. An owned local echo, canonical row, held
steering/follow-up chip or pending row owns presentation, never multiple copies.
Native canonical pairing is newest-first by text/image count, excluding known
older timestamps; transcripts without command IDs retain that matching limitation.

Ephemeral local-echo ownership is excluded from the history cache. Unconfirmed
delivery reads `Not confirmed`, with the shared explanation "We couldn't
confirm this message arrived. Check the conversation before sending again."
Its action is `Check`, never a blind resend. Browser reconciliation keeps the
original command ID; the native action wakes and reconciles its sender, never
dispatching through the browser.

A terminal refusal reads `Not sent` with the computer's humanised reason.
It offers `Edit` and undoable `Remove`, plus a relevant recovery action when
available, but no retry of the spent command ID. A saved message delayed for
at least 6 s may offer `Try again`; its age is measured from creation, so
automatic dispatch attempts cannot reset the visible delay. While the link
is unreachable, saved or dispatching messages instead read `Waiting for
connection` with a clock.

Removing an unconfirmed bubble asks for confirmation and explains that deleting
this device's copy does not cancel work already accepted by the computer. Edit
reserves a saved intent, restores text and photos durably, then finalises
withdrawal. Every action rechecks the captured credential and exact intent.

Queue promotion is offered and dispatched only for confirmed child ownership.
Desktop and collab queues retain their supported edit/remove controls without a
fallback resend. Confirmed writable collab Stop uses plain abort; child, bridge
and unresolved ownership retain safe queue withdrawal. Refusal is surfaced, not
retried with a lossy abort.

## Device enrolment and credential scope

`src/server/device_auth.rs` separates desktop administration from enrolled devices.
Enrolment codes are short-lived and single-use; stored credentials are hashed and
carry explicit roles. HTTP and authenticated sockets enforce the same boundary,
streams recheck revocation, and push destinations retain their authenticated owner.
Owner-token migration is an explicit stopped-daemon operation, not a side effect of
normal startup.

The browser outbox, attachment drafts and history cache are scoped to the paired
credential. Changing credentials never assigns old pending work to the new identity.
History is disposable and bounded; unsent commands are not silently evicted to make
room. Update activation waits for draft persistence and refuses unresolved commands.
Native recovery uses the configured app URL, while the release and protocol fields
of the web client, the native shell and the daemon expose compatibility.

## The Android native outbox

Android sends from both WebViews and notification replies through one native SQLite
outbox (`NativeOutbox`), scoped by endpoint origin and paired credential. Durable
saves run separately from the serialized delivery worker; neither acquires browser
Web Locks. Photos live in private files outside SQLite cursor rows. Network and
persisted job callbacks recover delivery without a running main WebView. Every
attempt checks protocol compatibility and the daemon receipt before dispatch;
uncertain legacy imports are reconciliation-only, never blind replay. The
origin- and main-frame-restricted bridge exposes no credential. An APK requiring
native delivery fails closed when the bridge is unavailable. Browser and PWA
delivery retain their independent outbox.

Native exact-ID receipt reads include the saved raw session path. A valid v1
`receiptBinding` independently binds that raw alias to the receipt's canonical path.
Old unbound exact-path receipts remain compatible only while no witness has been
retained; present malformed or null bindings and downgrade or retarget attempts fail
closed. The additive SQLite v2 schema persists `receipt_binding` and a local
`receipt_revision` beside the existing command; v3 adds the nullable mid-turn
`delivery` mode. Browser-import null means absent legacy proof; other malformed
imported values remain invalid. Receipt application rereads exact scope, ID, raw
path, payload and revision in one transaction, preserving removed rows, terminal
state and newer local evidence. Server wall-clock timestamps are validated as numeric
fields rather than used as a freshness order, so equal-millisecond changes and clock
rollback cannot prevent an otherwise current terminal receipt from settling.

Persistence returns an explicit insert-versus-existing outcome. New saved work and an
existing saved first-send retain normal delivery. Duplicate handed-off work requests
one coalesced, bounded target receipt GET on a separate worker; terminal duplicates
acknowledge immediately. This preserves the existing Check status UI without waking
or scheduling unrelated sends. Target reads bypass HTTP caches and cannot POST,
rearm, run version preflight or change evidence on 404 or error. The durable save
acknowledgement never waits on that network work; the page learns of committed
results by push. Every committed outbox mutation signals a change listener,
coalesced to at most 4 Hz (a pending trailing flush is cancelled when the
listener is cleared), and `NativeOutboxBridge` posts `{"event":"outbox-changed"}`
to each trusted WebView through `OutboxPageRegistry`, so the main and bubble shells
no longer replace one another's reply proxy (a view is dropped on renderer loss).
The page lists again only while visible, catches up on its next show, and
keeps a 30 s visible-only fallback poll while a row is unfinished or a refresh
failed or was missed: the 1 Hz
`list` poll this replaced kept a timer waking the phone with an idle outbox. Every
bridge reply carries `changeEvents: true`; the web ships with the daemon, ahead of the
APK, so until a reply confirms it from the bridge instance it installed the page keeps
the old visible-only poll (1 s while a
row is unfinished or the first listing is pending, else 5 s) for older APKs. A
stopped delivery job is rescheduled only when unfinished work remains. Only the normal
delivery caller owns retries, including
recovery after losing a revision race to a nonterminal observation. Either winning
terminal application may finish the existing local notification; failures cannot
regress the committed receipt and losing or terminal rereads do not notify again.
The 50-row nonterminal cap is unchanged, and genuine uncertainty is not automatically
marked complete or discarded. Verification is hermetic (the harnesses under
`mobile/android/host-tests/`); Android device acceptance is separate.

## Android activities and cold deep links

Main and bubble Activities share `OmpShellActivity`, including Capacitor plugins,
pairing acknowledgement, media and file permissions, recovery and deep links. Cold
intents are included in the initial document URL, before React installs listeners.
Conversation acknowledgement clears ordinary alerts but preserves Android
`Notification.FLAG_BUBBLE` backing rows. The bubble closes its own window on
unhandled Back; the main Activity moves its task to the background.

The home-screen widget (`PulseWidget`) shows a "New chat" pill and the three latest
chats from `GET /api/sessions?limit=5` with the paired token. It draws only from a
preferences cache, so the main thread never touches the network or `TokenStore`;
one background job fetches (a refresh asked for mid-fetch queues one more, extras are
dropped). `PulseWidget.refresh(Context)` runs on the 30-minute update, shell start,
pairing, and the notify service's turn start and end. A row opens its chat with the
notification extras; "New chat" is the `#new=1` hash link, which
`web/src/app/App.tsx` consumes and which also cancels the cold-start "reopen the last chat" decision.

While no shell Activity is started, the WebView is paused and its JavaScript timers
are stopped (`onStop`: `WebView.onPause` and `pauseTimers`; `onStart` resumes them).
Before this, every page timer kept firing while nobody could see the page.
`pauseTimers` acts on the whole process, so only the last shell to stop pauses: the
incoming Activity's `onStart` runs before the outgoing one's `onStop`, and a bubble
expanded over a stopped main window must keep running. Stop rather than pause keeps a
page visible in split screen or behind a permission dialog live. `visibilitychange`
is an event, not a timer, so the page still reports itself hidden to the daemon.

In laptop mode the offline fallback page reloads the configured app when a new
network appears. That network callback is registered only while the fallback page is
showing and unregistered once the app document finishes loading; networks already up
at registration are ignored, since the load just failed over them.

In laptop mode, returning to the offline fallback in the foreground retries the
configured URL once, retaining its deep-link hash. A failed retry waits for a later
foreground return or network arrival rather than looping on the initial network
registration. The set of started shells is tracked by identity, so a destroyed or
stale Activity cannot pause the timers of a visible one.

The web `App` selects a captured cold deep-link chat route before first render,
behind the existing credential and native-readiness gates. Its cancellation-aware
deferred effect still owns opening transport; route selection never waits for
listing, history or the chat chunk. A newer accepted hash or notification, or Back,
retires the pending boot route. Native Back and popstate chat handling stay inactive
while pairing or native synchronization is pending, preserving the captured target
through that waiting policy. Auth rejection retains that selected chat route only
while its captured target is unconsumed, so re-pairing cannot briefly mount the list
before the surviving boot effect. Handled or Back-cancelled targets stay retired
after re-pairing. A normal boot chat therefore avoids a temporary session-list
subscription; open drawer visits and ChatScreen polling for answers, laptop questions
and bridged summaries remain unchanged. Socket teardown, strict wire errors, recovery
cadence and all receipt and send behaviour are preserved. Synthetic lifecycle tests
(`web/test/cold-link-boot-routing.test.mjs`) establish this routing behaviour, not
Chromium causal repair or native or device acceptance.

## Composer drafts

Composer draft writes belong to views with unsaved edits. Successful persistence
releases edit ownership; otherwise a later blur can resurrect obsolete text.
Untouched views follow saved text, and concurrent edits retain both drafts. Send
cleanup compares the submitted text and observed photo tray before deleting persisted
work, so it cannot erase another view's newer draft.

### Withdrawn native queues

Stop and queued-message editing use a durable session-scoped recovery journal
(`src/server/http/queue_recovery.rs`), under `queue-recovery/` in the state
directory, so it survives a daemon restart. The desktop owner saves text and photos
before aborting or replying; phone-owned withdrawals continue through persistence
even if the HTTP client disconnects. A single-message withdrawal is keyed by the
owner-issued `itemId` the phone selected, so a repeated withdrawal of one item is
one record, never keyed by text. The journal holds at most 64 unacknowledged records
per session (oldest dropped first) and never logs message text.
`get_queue_recovery` reads one full record at a time without starting an idle child.
The browser restores that record into the captured session and credential-scoped
draft using its `recoveryId`, then calls `acknowledge_queue_recovery` only after
text and photo persistence completes; acknowledging twice is harmless. Duplicate
replay does not duplicate content. An explicit Remove action may acknowledge a
deliberate discard. Reconnect replays unacknowledged records; recovery never sends
a prompt.

Native RPC timeout or process death before a phone-owned response reaches the
daemon remains outside response journaling. Native truncation/photo-loss flags
remain visible rather than being converted into a successful complete restore.

The composer's More actions → Commands opens the existing global palette with
its own slash query. Opening or dismissing it never writes `/` into the editor
or replaces the persisted draft; deliberately typing a slash still uses inline
completion.

## Migration and upgrades

Migration into the native outbox preserves command IDs, state, timestamps and
attachments, and deletes browser and legacy notification sources only after native
persistence. Tombstones prevent late migration from restoring dismissed work. If a
save acknowledgement or draft cleanup is lost, the complete text/photo draft keeps
its original command identity until durable cleanup succeeds. Android force-stop
still requires reopening the app or a bubble; OS battery restrictions can defer jobs.

`TokenStore` retains pairing across APK upgrades; it only fills blank browser
credential storage. `OmpNativeUpgrade` reads the replaced native app's drafts and
pending commands into the existing web stores before the composer mounts. Command IDs
are kept and uncertain sends are not automatically replayed. Original native data is
retained; saved recordings remain downloadable from the conversation.
