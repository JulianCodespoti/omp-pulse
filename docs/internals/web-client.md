# Web client internals

This page covers behaviour of the React client in `web/` (and the daemon endpoints
that exist for it): read state and session status, the session listing, usage
meters, workspace tabs, images, file saves, drafts handed between views, the offline
history cache and why HTTPS matters. Command delivery and outboxes are in
[delivery.md](delivery.md). The overview is in [architecture.md](architecture.md).

## Prompt keywords and model mentions

The composer and sent user messages share the owning session's effective magic
keyword configuration. Matching follows OMP's case-sensitive boundaries and
code/XML exclusions; unavailable or disabled configuration never guesses a
highlight. The textarea's paint layer changes no submitted text, selection or
native editing behaviour.

Typing `^` offers the owner's scoped model selectors. Arrow keys, Enter, Tab and
touch insert only the selector at the caret, preserving surrounding text. This
does not send the prompt or change the conversation model. File, slash-command
and model completion menus are mutually exclusive.

The slash catalogue includes the project's loaded prompt templates with editable
arguments. Native names and aliases win collisions; an incomplete catalogue does
not forbid unknown extension commands. Insert skill places its namespaced token
at the remembered UTF-16 caret and preserves surrounding text, photos and agent
references. History resolves the selected original by file offset and entry ID,
preserves multiline text, and merges it with the current draft rather than inserting
a search preview. Editing, navigation or credential changes invalidate pending reads.

Explicit `!`/`!!` input shows Run and its context policy before execution. Both use
OMP's configured user shell with piped output, not a terminal PTY; attachments or
agent references keep the complete message on the normal Send path.

Bare `@` browses the project root; a typed file query searches nested project
files and inserts their full relative paths. Search honours ignore rules,
does not follow symlinks, and requires the conversation's recorded working
directory. Results and traversal are bounded; incomplete results are indicated.
Closing the picker or changing credentials, session or query cancels stale work.
The composer exposes the active listbox option without moving input focus.
Options announce their full relative path, including a directory's trailing
slash; keyboard selection scrolls the active option into view.

## Search tool results

Native search counts, failures and coverage limits survive live updates, history,
message merging and cache round trips. Legacy empty-result notices are recognised
only as complete output, never as a substring of a matching source line. Inline
and expanded readers retain the same incomplete-coverage indication; Copy returns
the original output. Native web-search source and citation links open only safe
HTTP(S) URLs. Provider failures remain errors even without a top-level `isError`.


## Extension feedback and prepared text

Extension notices retain severity; status rows update or clear by key; plain-text
widgets keep their requested placement. Reconnect snapshots replace current
feedback rather than accumulating stale values. These surfaces never count as
requests for input. Internal Pulse command replies remain hidden.

Catch-up requests `/api/history?feedback=true` to recover the same bounded
`extension_ui_snapshot` in `extensionFeedback`; ordinary scrollback omits it.
The snapshot is captured with `sessionState` before reading the journal. The
client checks conversation, credential, daemon, binding and authority revision.
Newer live feedback prevents replacement of mutable status/widget/editor state;
missing stable notices still merge without undoing newer updates or dismissals.
Hard resets fence both paths. Local draft preparation or consumption during the
read survives.

Native `extension_error` events become bounded notices with their extension and
hook context, not terminal connection errors. Native `command_output` can arrive
after the initial acknowledgement and remains visible as session feedback. The
native event has no command ID or completion flag: an acknowledgement means
started, and late feedback is session-scoped rather than a correlated completion.
The existing immediate-output collector also cannot distinguish concurrent
same-session `command_output` events: a background command can print while
another command is being collected, and that sheet can include unrelated text.
The native protocol does not expose the correlation needed to separate them.

Prepared editor text belongs to its credential and conversation. An empty,
hydrated composer adopts it without sending; existing text, photos and agent
references require explicit review. Add preserves the existing draft, replace
changes only text, and dismissal is remembered across reloads and replay.

Custom and legacy hook messages render only when OMP explicitly sets
`display: true`, except the activity-only `irc:incoming`, `async-result` and
`launch-completion` types. Those internal deliveries retain their compact
activity markers and agent-completion accounting, never their instruction
bodies. Older offline-cache entries follow the same rule. Ordinary messages
and deliberate extension messages may still quote XML literally. Live extension
messages refresh canonical history instead of inventing identities that
duplicate on reload.

A `reset_boundary` entry displays `Context cleared` without deleting older
messages. Its detail distinguishes saved history from the context sent to the
model. Metadata-only entries advance the timeline revision even when no message
array changes, so boundaries and fallback explanations paint immediately.

## Background and foreground recovery

Visibility-aware UI intervals stop while the page is hidden and resume on show;
they do not replace the delivery worker. A hidden open chat records recovery debt.
On return, the controller fetches current history and state before relying on the
socket again. A failed fetch retains that debt and its visible error, with one
bounded automatic retry per recovery burst; a healthy heartbeat alone cannot clear
it. New visibility or online events permit a later recovery attempt.

## Laptop visibility and read state

The session switcher drawer puts each matching session in exactly one place, in the
order a person acts on: Needs you, Pinned, then Recent by activity time
(`web/src/app/nav/SessionSwitcher.tsx`). Read state is separate: an unread or
blocked laptop session must still appear exactly once, and an unread reply alone
does not mean an agent is waiting for an answer. Valid metadata-only sessions
remain discoverable under an untitled label.

**INVARIANT: the open, visible chat owns read state** (`web/src/app/read-state.ts`).
Every way into a chat (list row, notification or deep link, Recent, new chat,
branch) ends at the store's `sessionPath`; App marks it seen whenever its listing
revision or its newest shown entries change. The listing is not polled while a chat
is open, so the marker also keeps the newest shown entry ids
(`r:<revision>;e:<id>,…`): a later listing whose `latestEntryId` is among them was
read in the chat. A hidden app marks nothing. On the daemon, `trigger_refresh`
records every change even with no listing socket attached, and the next listing poll
waits (at most 2 s) for the refresh instead of answering with the old payload, so
Back from a chat shows the new preview at once.

## Independent conversation switcher

`SessionSwitcher` queries the controller directly rather than filtering the main
list's loaded page. Its unfiltered recents contain at most 12 sessions plus the
current session; server-backed search returns at most 30. It leaves the main
list's query, project, cursor and rows unchanged. The controller shares listing
validation and authority reconciliation but keeps an independent eight-page cache,
so switcher searches cannot evict the main list's page evidence.

Queries are aborted and fenced when superseded, hidden, closed, covered or bound to
another controller. Obsolete replies cannot replace results, populate the cache or
ingest authority. Loading and request errors remain distinct from an empty search.
When no chats are visible, the drawer shows "No chats yet", keeps its single
bottom New chat action and omits See all. Loading and errors keep the full-list
route available.


## Session status: live and running are orthogonal

`live` and running are two independent axes of a listing row (`OmpSessionSummary`;
daemon `src/sessions/index.rs`, web `web/src/app/session-format.ts`):

- **`live`: a desktop holds the session file** (`ownerPid`, a file handle or the
  sidecar), whether or not it is generating. The daemon also sets it for its own
  child mid-turn, so `isOnLaptop` decides "on the laptop" from the owner kind first
  and only then from `live`.
- **Running: a turn is in progress**, by canonical turn evidence (`sessionTurn`),
  which wins over a stale listing `status`.

**INVARIANT: `sessionStatus()` in `session-format.ts` derives from turn evidence and
MUST NOT incorporate `session.live`.** A prior bug aliased `live` to streaming, so
every session open on the laptop read as busy and wore the running treatment.

`web/src/app/session-status.ts` maps a row to the one status vocabulary that rows,
headers, counts and aria labels share, by precedence: Needs you (an open question:
`inboxState` `asking` or `needs`), Working (turn evidence says running), Unread, On
computer (`live`), Idle. A session whose authority is reconnecting and that is not
open on the computer reads Idle rather than gaining a sixth label. If this mapping
changes, check the rows with the UI state capture (`scripts/ui/states/capture.mjs`,
see [ui-review](../contributing/ui-review.md)).

Known `backgroundWork:true` is separate from streaming. An idle chat says that
background work is pending and may resume the conversation, without disabling
the composer. Disconnected or stale authority makes that status unconfirmed;
missing evidence never claims that the work finished.

## Single-item Responses identity recovery

The browser preserves raw `openai-responses` text-item metadata before display
coalescing. A strict JSON v1 `textSignature` supplies the provider's output-message
item ID, scoped by the exact nonempty API/provider/model. This is producer identity
metadata, not a cryptographic signature or a universal response identifier.

`ResponseItemRecovery` (`web/src/domain/response-item-provenance.ts`) owns one
observed assistant `message_start` lifecycle. A single signed live provisional with
no response ID may join exactly one persisted canonical response with a response ID.
The live witness survives an idle commit; it cannot cross a later start, session
reopen or switch, accepted daemon/binding/owner change, or cache reconstruction. Raw
descriptors and origin/alias proofs use private, identity-bound symbols and both
cache boundaries explicitly remove them. History-only input never mints live
ownership. Duplicate raw entry IDs veto the entire normalized batch before known-ID
filters can discard repeated claims. A late delivered full final constrains the
later canonical response ID; it does not make the live snapshot a persisted
canonical row.

Recovery preflights retained and incoming claims, keeps canonical ID/text and Copy
content authoritative, and preserves current live tool/thinking/image/error details.
It does not alter delta chain IDs, raw text coordinates, authority acceptance,
terminal delta handling or daemon ownership. Different known response IDs,
conflicting namespaces or phases, independent starts, ambiguous claims, unsigned,
legacy or malformed signatures and multi-text-item messages fail closed. The original
unsigned duplicate-output route and broad canonical-history deduplication remain
unresolved. Bookkeeping is limited to the current lifecycle and the immediately
previous item, plus metadata attached only to currently held messages.

The recovery also fences duplicate raw entry IDs hidden by role filtering or distinct
normalized IDs, and retains fresh details from late known-ID finals without letting
provisional prose replace canonical text. Six regressions cover these cases. In an
isolated real-browser replay the code before this recovery showed two reply rows;
with it, one canonical row, and Copy returned its complete text, with no daemon
traffic. This synthetic replay is not a physical handset observation.

Contract sources: [official output-message schema](https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/response_output_message.py)
(checked 2026-10-09), pinned oh-my-pi [signature encoding](https://github.com/can1357/oh-my-pi/blob/579da1d661c5cb8d43bc2ddd429ab72e67165ad8/packages/ai/src/providers/openai-shared.ts#L1450-L1474),
[item-start identity](https://github.com/can1357/oh-my-pi/blob/579da1d661c5cb8d43bc2ddd429ab72e67165ad8/packages/ai/src/providers/openai-shared.ts#L3401-L3425),
[item-end identity](https://github.com/can1357/oh-my-pi/blob/579da1d661c5cb8d43bc2ddd429ab72e67165ad8/packages/ai/src/providers/openai-shared.ts#L3621-L3638)
and [later response-ID promotion](https://github.com/can1357/oh-my-pi/blob/579da1d661c5cb8d43bc2ddd429ab72e67165ad8/packages/ai/src/providers/openai-shared.ts#L3729-L3739).
The frozen synthetic producer-shaped replay in `web/test/signed-response-alias.test.mjs`
proves this bounded client recovery through the real controller, store, render and
Copy harness. It does not establish a real reported incident, installed producer
version, production frequency, browser paint, geometry or native acceptance.

## The session listing

### Weekly project filters

`GET /api/sessions` returns global `projects` metadata: the top three exact working
directories by conversation count active in the rolling past seven days, with latest
activity and cwd breaking ties. Ranking uses the full index, not a loaded page or
search result; it refreshes at rolling-window boundaries even without file changes.
The optional `project` parameter filters by exact cwd before pagination and pinned or
live inclusions. Cache keys, cursors and ETags include project scope. Selecting a
chip does not impose a seven-day cutoff on the results: older conversations remain
pageable and searchable.

Cursor pages binary-search the same total order used to sort the catalogue (activity
descending, path ascending), then filter only the remaining suffix. First-page
live/pinned inclusion and global project summaries still inspect the whole
catalogue; this is not an indexed replacement for those operations.

### Response validation

The browser accepts a listing only from an object with an array-valued `sessions`
field and no explicit `ok:false`. A present `nextCursor` must be a string or null;
missing legacy cursors still mean no next page. Every row must be a JSON object with
a string path, and the complete array is preflighted before the first authority
reconciliation. A bad later row therefore cannot leave earlier authority changes
partially installed. These envelope and row-identity checks precede page/ETag cache
writes. They add no path-content restrictions or required optional fields. Authority
and legacy-turn lookups only use own map entries, so string identities such as
`constructor` never fabricate authority from an inherited object member. Existing
authority/activity enum parsers require documented string values without coercing
JSON objects; malformed optional evidence is still ignored rather than rejecting the
listing. Valid empty pages and cached 304 responses retain their existing behaviour.

### Controller lifetime

Session-list reads belong to a controller lifetime. Disposal advances a monotonic
lifetime and the listing generation, preventing old first/older-page promises from
being reused after a controller resumes. Delayed offline hydration, successful
responses and 304s cannot mutate shared state or page caches after retirement;
pagination cleanup cannot release a replacement request's loading flag. Because
store subscribers run synchronously, the lifetime is checked between ingestion and
page/project/error writes, and across the notification boundaries of listing-driven
active idle stream finalization. Other stream callers retain their existing
behaviour. Active-controller reads remain useful across polling changes and session
navigation; credential namespaces, response validation and direct/background error
ownership are unchanged. See the synthetic
`web/test/session-listing-lifetime.test.mjs` and
`web/test/session-listing-reentrancy.test.mjs`.

### Authority ingestion batching

Session-page authority ingestion batches only contiguous passive rows in the same
raw daemon namespace. The first row of each namespace run and both controller/store
active paths keep their single-row notification boundaries. This preserves active
idle stream commits and running-agent-count source cancellation and replacement
while collapsing passive notifications. Single and batch routes share the same
ordered revision/binding/retired-daemon/legacy reducer. Batch records and retained
rows use copy-on-write; the temporary path index keeps the first duplicate
occurrence. Evidence normalization is yielded immediately before each reducer step
so receipt and authority clock reads retain their order. Page order, deduplication,
cache, validators and structural guards remain unchanged. See
`web/test/session-page-batching.test.mjs`; the work counts are in
[performance.md](performance.md#session-page-authority-ingestion).

## Model selection and fallback

The configured thinking selector and effective effort are distinct. Verified
reasoning models offer Auto; unverified model capabilities do not invent it.
`thinking_level_change.configured` and owner snapshots preserve the selector,
while native `get_state.thinkingLevel` describes effective effort. A refresh or
model switch cannot silently pin a known Auto selection to High or Low.

Both owner extensions append `omp-pulse-model-fallback` custom journal entries
with the native from/to/role/reason. The daemon never becomes a second writer.
Durable markers use the actual journal entry ID; an unkeyed child event shows
its reason until that receipt arrives. Reasons remain readable after reopening,
and do not promise that the original model will be restored automatically.

Cold metadata reuses the resumable usage fold and its byte budget. A shared,
copy-on-write index retains at most 4096 recent entry IDs and follows parent
ancestry, including native `model_usage.activeLeafId`, rather than abandoned
physical tail entries. An expired ancestor means unknown; live owner snapshots
recover authoritative branch state. Pending folds continue through the existing
visible-chat catch-up cadence and cannot promote ambiguous bounded-tail receipts.
`sessionModelProvenance` tracks file/live ownership independently for configured
thinking, effective effort and fallback. Completed metadata replaces unknown or
file-owned values; passive writers must pass their actual source to the store.
Live controls remain protected while their canonical `sessionModelAuthority`
binding is current. Confirmed replacement/release, including the registry's
advanced-binding owner-scan retirement, releases that protection; disconnect or
same-binding inferred absence does not. An explicit `modelFallback:null` clears
the current fallback without erasing its historical explanation.

Fast modes are service tiers, not reasoning quality: standard, priority and
ultrafast. `/fast status` uses the native printed result because the boolean
`fastModeEnabled` cannot distinguish priority from ultrafast.

Available models are resolved within the requested project. A saturated child pool
may use a fresh cache for that same project, never another project's live owner or
an expired model list. Failure is explicit rather than offering unrelated choices.

## Session usage meters

Listing rows carry three optional, never-null fields for the context and cost meters
(chat header beside the model, session-row meta line): `costTotal` (USD, the sum of
every `usage.cost.total` in the file across assistant messages, `model_usage` records
and `task` results, omp's own session-cost rule; present once the whole file is
folded, `0` allowed), `ctxTokens` (the latest completed assistant measurement or
newer compaction's `tokensAfter`) and `usageThrough` (entry id of the newest
assistant message the total includes). Compaction without a valid token count
makes context unknown. History loads in pages, so only the daemon can total a
long session.

`src/sessions/jsonl/usage.rs` folds a file forward and stops at a line boundary
sealed by a hash of the 64 bytes before it; the index memoizes the tally in a
`FileMemo` by (mtime, length) and, when the stamp moves, resumes from the sealed
offset (an appended turn costs its own bytes; a shrink or seal mismatch restarts).
Listing rows, history and passive state reuse this fold under a 16 MiB budget per
read. An unfinished fold omits totals/configuration until a later refresh finishes it.

The chat adds held assistant turns after `usageThrough` to `costTotal` (all of them
when absent, none when that entry is not held), so a turn that finished after the
row was computed counts once. Row context % is a live child's `ctxPercent`, else
`ctxTokens` over the window cached from the model catalogue, else omitted.

Compaction boundaries invalidate earlier assistant measurements and live
percentages. An owner percentage survives only when its measurement began after
the boundary, in the owner's clock; an older settings response cannot restore it.
Metadata-only appends advance the timeline revision, repainting the compaction
summary without fabricating a message or changing session spend.

The Usage sheet labels the same whole-file total `Session spend`, including
discarded contexts and other branches. Native `get_session_stats` separately
provides `Current context cost`. Without owner access, loaded-message statistics
remain explicitly partial and are not presented as the current context; a missing
whole-session total is unavailable, not zero.

## Workspace tabs

Changes, Files, Agents, Tasks (todo and timeline) and Terminal are tab contents of
the workspace panel (`web/src/app/tools/index.ts`), each
`({ sessionPath, active })`. The panel lazy-mounts a tab on first visit and keeps it
mounted; `active` replaces the old sheets' `open`, so every
read/page/branch/action generation that was fenced on close is now fenced on hide
(`active` false), session change and unmount. Tabs draw no header and scroll inside
their own `ScrollArea`.

Project file routes require the recorded working directory to exist. Missing or
absent directories return `project_folder_unavailable`; listing, mentions, reads,
raw downloads, saves and catalogues never substitute HOME. Files offers Browse
home explicitly, labels its absolute location as outside the conversation's
project, and clears that opt-in when the conversation changes.

Blocked todo entries keep their native status and blocker reason in the chat
checklist, expanded board and current Tasks view. Rewind resolves current labels
across the journal, carries only retained targets and repairs parent links around
discarded label receipts; the source file remains untouched.

Agents and Tasks act on the open chat (jump to an entry, open a branch, draft an
agent reference). ChatScreen publishes those through `useProvideWorkspaceHost`
(`web/src/app/tools/workspace-host.ts`); with no chat the tabs degrade instead of
failing. Jumps call `closePanels()` then `host.jumpTo`, which owns the scroll and
its late-jump fencing. The tabs replaced per-feature sheets, and with them their
lazy-chunk boundaries and opener/focus-return latches: a panel tab has no opener to
return focus to.

Timeline navigation asks whether to summarise the branch being left. The owner
performs the native tree operation; cancelling or stopping its question or
summary leaves the selected branch unchanged. Successful moves reload canonical
history and offer returned editor text through the prepared-draft inbox.
Historical question rows retain their original answers and raw result IDs.
Re-answering creates a sibling answer and resumes from it; the earlier answer
remains available on its original branch, including after an owner restart.

Planning uses the owner's configured planning role and explicit reasoning level
without rewriting model-role settings. Exiting restores the original model,
reasoning and tools. Approval offers configured execution roles and stops the
planning loop before implementation: the native abort-cleanup promise must settle
before applying the selected executor and dispatching one synthetic prompt.
An idle flag alone is insufficient because native cleanup can still restore an
earlier reasoning setting.

An unset/inherited reasoning setting is a real restoration target, not a missing
override. Same-model planning must clear its temporary explicit level on exit;
execution without an explicit override inherits the restored setting. Deferred
model switches retain this distinction through approval and cancellation.

Fresh-context approval creates a native session in the same journal directory,
copies its local plan artefacts and starts exactly one implementation prompt
containing the approved plan, not the rejected planning discussion. A private
handshake fences ordinary commands while the daemon moves the existing writer
and owner declaration to the actual destination. The source-scoped follow event
only moves a client still viewing that source; pending text, file and photo
draft writes finish first. Source drafts remain separate and are never sent
automatically. Keep-context and compact-context approval retain their native
behaviour; compaction chooses its own model before the selected executor starts.

Retained workers use neutral `Parked` status. They contribute neither working nor
attention counts, even when older transcript progress still says pending.
Explicit `awaiting_input`/`needs_input` reports show `Needs you`; ambiguous
`waiting`/`blocked` words alone do not establish a question.

`SessionSettingsSheet` and `FileViewer` remain one-step sheets. Session settings
bound their first read at 12 s and then offer Retry, so a session whose agent is
still starting never leaves "Loading settings…" spinning.

Changes shares chat's diff renderer and `Wrap lines` control. Its toggle applies
to every expanded file without altering copied diff content.

Unresolved conflicts come from Git's unmerged index states (`DD`, `AU`, `UD`,
`UA`, `DU`, `AA`, `UU`), not from conflict-marker text. Full and summary endpoints
include index-only conflicts; refreshing after staging clears only resolved rows.
Recorded edit results retain every per-file diff, including additions, removals
and moves. Ordinary `read` output remains literal even when it contains `+`, `-`
or a complete Git patch header.

Changes also offers file notes and notes on added, removed or context lines.
Notes retain the exact patch, old/new coordinates and original code under the
device credential and conversation. Refresh never moves them: changed or missing
snapshots become stale and must be removed and recreated before preparation.
`review-notes.ts` bounds storage to 100 notes and 2 MiB per credential; storage
failures preserve the existing saved bytes and keep editor text recoverable.
Clearing offline data clears these notes, not repository files.

Prepare review rechecks current changes and durably prepares the native `/review`
command through the existing prepared-text inbox. Notes and captured code use JSON
strings so native review whitespace normalisation cannot change their contents.
Existing composer text and photos remain untouched; only Send submits the review.
Saved notes remain available afterwards. Session, credential and view changes
invalidate late preparation; a failed inbox write leaves the prior draft intact.

File editor drafts retain exact text and their original conflict baseline across
Close, Escape and remount. They are scoped by origin, device credential, session
and file; explicit Cancel/Reload discards only the current draft. Confirmed saves
clear only the submitted edit lifetime, preserving newer typing. Storage failures
retain text in memory with a warning and prevent update reload until durable.
Clearing offline data clears those drafts, not files on the computer.

`POST /api/file` requires `expectedContent`: the exact original text for an
existing file, or `null` for create-only. Missing preconditions return HTTP 428;
invalid preconditions return 400. A changed or missing original, or an existing
create-only destination, returns 409 with `code: "file_conflict"`. The editor
keeps both its text and original baseline on conflict, including after reopening;
loading the latest version requires explicitly discarding that draft.

Pulse serialises saves from path resolution through comparison and commit.
Existing files use same-directory staged replacement, preserving mode bits;
create-only publication never replaces an existing destination. Staging and
replacement change the inode; open descriptors, hard-link aliases and extended
metadata are not preserved. The request cap accommodates both 1 MiB texts and
their JSON escaping. This is version checking, **not** filesystem compare-and-swap:
an external editor or agent that does not share Pulse's lock can still write
between the server's final comparison and replacement.

Reply links using `local://` and `artifact://` open a read-only file sheet with
the originating conversation captured when tapped. Navigation cannot retarget
that open reader. Local files resolve within that journal's `local` artifact
directory; numeric saved-output IDs resolve only within the same journal's
artifact directory, never another session. Line/range/raw selectors are retained.
Traversal, foreign symlinks, missing files and unknown agent origins fail visibly
instead of opening external applications or guessing the active conversation.
Previews and downloads are bounded to 1 MiB; oversized downloads are refused.

## Run screenshots and daemon images

A run shows only its newest tool screenshot in the chat flow, plus any the reply that
continued it names by file (`summarizeRun` with the timeline run item's `reply`) and
any image the agent posted itself. Every other screenshot renders with its step when
the run is expanded, so each photo appears exactly once. Inline and step screenshots
are capped at `min(66%, 16rem)` wide.

Generated-image results are not deduplicated as screenshots: every call retains
its own ordered image slots, even when two calls return identical bytes. Unavailable
slots stay visible. Inline retention is bounded to 8 MiB per image and 16 MiB per
call. Shell rows and expanded output distinguish reported exit codes, timeout,
cancellation and unknown status; stdout that resembles JSON is not exit metadata.

`ImagePart` reads a `blob:sha256:` image only once an IntersectionObserver (rooted at
`.chat-scroll`, 150% margin) reports it near; without IntersectionObserver it reads
at once. A 400/404/410 shows "Image is no longer available"; anything else shows
"Waiting for the connection…" and retries after 2, 5, 15, 30 then every 60 s, on
`online`, and whenever the session socket opens
(`web/src/runtime/daemon-reachability.ts`), which also retries missing images in case
a restarted daemon has them. Manual Retry stays. `/api/blob` answers a full 64-hex
hash with `Cache-Control: private, max-age=31536000, immutable`; a shorter prefix is
not cached.

## Unconfirmed file-save outcomes

`FileViewer` preserves its local destructive-alert treatment when a dispatched file
POST rejects: "Couldn't confirm the save. The file may have been saved; check it
before trying again." Successful-status unreadable JSON already uses that wording.
Preflight failures stay distinct because no write was dispatched. Neither outcome
advances the submitted baseline or shows Saved; typing during the request retains the
latest draft. Existing owner/generation checks reject obsolete outcomes after
cancel/reedit, path or session change, reopen and unmount.

No automatic retry is added. Pending POST/body reads can remain pending
indefinitely. An explicit retry retains the same original baseline: if the first
write committed different text, the retry conflicts rather than overwriting it.
Transport failure still proves neither write failure nor old-file integrity.
`web/test/file-edit-owner.test.mjs` covers draft/baseline retention and obsolete
outcomes; the disposable-daemon file-write checks exercise real stale and
concurrent HTTP saves. Admission bounds are in [io-bounds.md](io-bounds.md).

## Workspace operation ownership

A composer shell command keeps its draft until the Terminal admits execution.
Busy or unavailable terminals reject it rather than consuming or queueing it;
leaving the originating chat before admission cancels the hand-off.

Side-question asks and history are fenced to their session, credential and view
visit. Late replies cannot retarget the shared side-question store or unlock a
newer question.

Bare and focused `/compact`, the compact pill and Session settings share one
credential/session-owned operation. A lost acknowledgement leaves an uncertain
status and blocks another compaction while read-only observations reconcile it.
Acknowledged completion, a context/token drop or an observed compaction end can
settle it; merely reopening a sheet does not retry the mutation.

Notification links are retained during pairing and native credential hand-off.
The newest notification replaces the boot destination; readiness opens it once.
Back cancels a pending destination.

New-session and fork results refresh session discovery even if their originating
visit has ended. Navigation and prepared editor text additionally require the
same visit, navigation request and credentials; returning to the same session
does not revive an old operation.

Task mutations recheck the current row and its exact text before optimistic
changes or dispatch. Native `/todo` targets text rather than row identity, so
blank, padded, stale or case-insensitively duplicate names are refused instead of
risking a different task or an entire board.


## First-message draft ownership

The new-session composer keeps its text and image previews until the durable
outbox accepts the complete first message. `StartSessionError` distinguishes
settings and save failures from delivery failures after enqueue. Settings/save
failures stay on the new-session screen; Retry reuses the already-created session
and its project instead of creating another session or relying on broken storage
to transfer the draft. After enqueue, the outbox owns recovery and the chat opens
without manufacturing another sendable copy of the message.

While selected images are decoding, pointer, keyboard, empty-session and dictation
send actions are blocked. The toolbar shows Preparing images; sending becomes
available after the prepared images have joined the draft.

## Complete-message resend ownership

Edit, resend and rewind resolve all original photos through
`web/src/runtime/message-images.ts` before enqueueing. Inline data and authenticated
blob references are supported, including photo-only messages; unavailable bytes
prevent both a partial prompt and branch creation. The failed-turn retry uses the
same loader.

The editor retains its text and photos until `sendPromptDurably.onSaved` transfers
ownership to the outbox. It then closes, even if delivery or accepted-receipt
persistence fails: recovery must use the saved command ID, not another editable
copy. If rewind creates a branch but enqueue fails, an explicit retry retains that
branch. Session, credential and editor-generation checks fence obsolete actions.

Taking a queued message back merges its text and photos with the destination
draft, including unsynchronised editor input. Recovery captures the originating
credential/session and never sends automatically; offscreen recovery joins the
same serialised attachment owner used by hydration, intake and send cleanup.
Over-capacity photos remain recoverable, but Send refuses the oversized message.

The withdrawal response keeps each message's text and photos together in
`messages`, in steering-then-follow-up order. After hydration and earlier intake
finish, recovery maps each message's `[Image #N]`/`[Video #N]` labels and matching
`attachment://N` links to its photos' destination positions. Existing draft
references and references outside that message's photo range remain unchanged.
Persisted recovery IDs locate already-restored photos on retry or reload, so
numbering does not drift and photos are not duplicated.
This grouped withdrawal contract requires protocol 4 on both sides; deploy the
daemon, web client and native outbox's protocol metadata together.

Saved-outbox Edit first reserves the exact intent against dispatch. The native
and browser stores remove it only after draft text and photo persistence succeeds.
An unconfirmed transfer stays reserved for retry or explicit discard. While that
reservation exists, new sends, local commands and dictation sends in the same
conversation refuse before clearing the recovered draft; other conversations
remain usable. Edit again finishes removal, and explicit discard releases the
source. Dispatch claims and edit reservations are checked atomically, including
when Web Locks are unavailable.

Recovery identities use the reservation token, not a browser-only row identity.
Browser-to-native import retains that token and its non-postable state, so an
upgrade cannot send a message being edited. Native schema version 4 adds an
`edit_token` without replacing existing queues.


## Agent conversation to main-session draft

The child retains at most 256 bounded agent metadata records for its current
binding, not their transcripts. Newer lifecycle events outrank stale roster
responses, including empty responses. Completed rows remain readable without
running counts or live controls. Reading does not create a new owner, and the
registered transcript path must still exist and match the reader's identity.
Back and reopen retain access while that owner and registration remain available.

Eligible desktop agents also offer a direct follow-up, separate from the local
draft action below. This uses the authenticated, identity-fenced native collab
route; it never sends through the main chat or starts a fallback child. Refused
or unconfirmed text remains available. A connection handoff is not a callback
receipt; see [desktop integration](desktop-integration.md#direct-agent-follow-ups)
for the native protocol limit.

The selected agent conversation offers "Discuss in main chat". This is a local draft
action: the Agents tab passes a typed stable agent reference through the workspace
host to ChatScreen's current Composer handle. Composer appends through its
revision-aware setter, retaining text bytes, attachments and selection. Newly
generated reference suffixes appear as compact named rows while the exact
ordinary-text draft remains authoritative. Empty drafts show a reference row and an
empty editable field at caret zero. Details exposes the exact block; Edit full draft
and restored or remounted drafts reveal full text. No prompt or agent command is
emitted. Send remains the deliberate delivery boundary.

The tap rechecks current session, roster identity and ownership/source facts before
changing any draft. Desktop references require the roster connection binding,
avoiding preparation with an incomplete identity while its read is pending. Stable
identity includes source, ID, creation time when present and desktop connection ID;
display-name changes do not defeat deduplication. Deduplication checks the current
draft, so deleting a reference permits adding it again. A leading slash-command draft
is refused visibly without modification to avoid changing command arguments. Normal
Back and sheet close keep their focus and navigation behaviour.

`web/test/agent-response-journey.test.mjs` composes the actual session listing,
ChatScreen, sheet, transcript and Composer with synthetic services. It proves the
local prepare/send boundary and interruption handling, not daemon delivery, browser
layout or handset acceptance.

## Offline history cache

`web/src/runtime/offline-cache.ts` reads and deletes tails by their credential-scoped
key. Saving and pruning share one IndexedDB readwrite transaction: retained tails
stay in place, evicted keys are deleted, and only the saved tail is put. This
prevents two views from committing stale whole-store snapshots over each other. An
expired read conditionally deletes the `savedAt` version it observed, not a fresh
replacement. The persisted format, seven-day TTL, eight-session namespace cap, global
4 MiB cap and key-order tie behaviour are unchanged. The transaction-owned metadata
index supplies pruning metadata; a missing index falls back to a cursor scan.
Idle-writer cleanup does not alter this storage path.

Cached tails also retain the latest context boundary, including an unknown
post-compaction token count. Generated-image slots survive without inline image
bytes, and blocked tasks retain their reasons. Old tails without a boundary remain
readable; there is no cache-version cutover or wholesale deletion.

The tail coalescer's module-global writer state expires after its current two-second
idle window. A pending trailing write cancels idle cleanup; flushing it starts a new
window. Cleanup is timer-token and writer-identity fenced, and clearing cancels both
timers. Storage completion cannot retire a successor. This changes only scheduling
lifetime. The measured effect is in
[performance.md](performance.md#bounded-architecture-microbenchmarks).

## Hidden pages arm no timers

Every periodic loop in the web client starts through
`web/src/runtime/visible-interval.ts` (`startVisibleInterval`), which clears the
interval when the page is hidden and starts a fresh one when it is shown. The loops
used to keep ticking while hidden and early-return, so a backgrounded phone WebView
woke once per period for work nobody could see. Clocks pass `tickOnShow` so a label
is right as soon as the page shows; polls that already refresh on
`visibilitychange` do not, so a show costs one fetch, not two.

- The conversation controller's offline ticker (1 s), stale-socket watchdog (15 s)
  and liveness probe (30 s) run only while visible. The probe used to reopen a stale
  socket from the background; a hidden page now reconnects nothing, and the visible
  resume revalidates and reconnects.
- The session-list poll is not rescheduled while hidden. While `/ws/sessions` is open
  and heard from it runs every 30 s, waking no later than the 45 s staleness bound;
  the 3 s cadence applies only while that socket is down or stale.
- The visibility frame goes out on every hide and show, and on every socket (re)open
  while hidden (the daemon counts a new socket as visible).
  The daemon stops tailing a session file when only hidden viewers remain and sends
  one resync when the page reports visible again; a resync that meets a hidden page
  (that one, or a full queue's) is owed to the visible resume, which runs it through
  the resync path (coalesced with the cooldown, never dropped).
- The Android native outbox pushes `{"event":"outbox-changed"}` instead of being
  listed every second ([delivery](delivery.md#the-android-native-outbox)); the page
  lists again only while visible. Until a bridge reply carries `changeEvents` (an
  older APK never pushes) it keeps the old visible-only 1 s / 5 s poll.
- `html[data-hidden]` (set from `visibilitychange` in `main.tsx`) pauses every CSS
  animation; reduced motion already ends them after one pass.

Not converted: dictation's 250 ms elapsed clock and the QR camera scan, both bounded
user-started activities, and the running-agent count, which already resets while
hidden.

## HTTPS is a feature, not a detail

A plain-HTTP origin is not a secure context, so dictation, the service worker and Web
Push are ALL unavailable on it. The daemon therefore detects its tailscale serve front
door once at startup (`tailscale serve status --json`) and publishes it as
`httpsOrigin` in `/api/status`; the phone uses that to name the real address and
offer it as a single tap that carries both the token (the new origin has its own
localStorage) and the open session. The microphone button previously carried a
hardcoded tailnet URL, which was wrong on every other install, and pinned a red
error line above the composer for the whole session. Availability is a standing
property of the environment, so it lives on the control; the status line is for
things that HAPPEN. Setting up HTTPS is covered in
[networking](../user/networking.md).

## The transcript viewport has one owner

`web/src/components/ai-elements/transcript-viewport.tsx` owns every write to the
transcript's scroll position. Consumers use `useTranscriptViewport()` rather
than writing `scrollTop` or running their own settle loops. Before this, seven
writers fought: opening a 150-turn chat painted 5,546 px above the newest message
and travelled for 730-790 ms; a history page landing while the reader scrolled
yanked the view 236-964 px back down.

- **Lock.** Upward wheel input, a touch drag of at least 12 px towards older
  messages, PageUp, ArrowUp, Home, Shift+Space or mouse text selection releases
  following. Input fields and nested scrollers keep their own gestures. The
  reader's downward scroll re-locks within 24 px of the end; `follow()` also
  re-locks. A content shrink re-locks within 2 px only after a reader release.
  `release("program")`, used before navigation and sending, survives a shrink.
  The separate 70 px `nearBottom` threshold controls UI, never the lock.
- **Open.** The first content measurement pins to the end synchronously in
  ResizeObserver, before paint. Growth follows instantly for 500 ms or until
  the first reader gesture, then uses the follow spring. Navigation releases
  following before moving, so later growth cannot undo a jump to an older row.
- **Holds.** One target and offset can be held at a time. A new hold or
  `follow()` ends the previous hold. After one synchronous correction, the hold
  corrects drift of at least 0.5 px; while a finger is down or another scroll
  moves the view, it adopts the new offset without writing. A later reader
  gesture, cancellation or a disconnected target ends it. Non-persistent holds
  also end after eight stable frames or their deadline (600 ms by default).
  Expanding a row uses a hold; it must never fight the finger.
- **Place.** A free reader's place is kept by `placeTick`, not by the browser
  (`overflow-anchor: none`) and not by whoever caused the change. Each frame
  that the view moves or the layout changes, one transcript row is measured; its
  offset changes by the layout shift minus the change in `scrollTop`, so the
  reader's own scrolling is never touched and only the remainder is written
  back. This is why a history page lands under the finger however the row count
  moves (once the 400-message window is full a page arrives together with a
  bottom trim, and a count-based check moved the reader a whole page, 15,400 px,
  on every page from the ninth) and why rows above the view re-measuring
  against their `content-visibility` estimate no longer push the reader down.
  `LoadEarlier` only decides when to fetch, preloading 2,400 px ahead.
- **Send room.** `SendAnchor` releases following and holds the new user turn
  with a persistent hold. The room remains when a short reply ends, or when a
  turn never starts. It leaves only when natural content fills it, removing it
  cannot move the reader, or the next send replaces it.
- **Resize.** A scroller resize (keyboard, composer or attachment strip) honours
  an active hold first. Otherwise a following view, or one within 48 px of the
  end before resize, stays pinned. A free view keeps its visible bottom edge:
  the height change is subtracted from `scrollTop`, clamped to the new bounds.

### Opening reveal

`web/src/app/chat/OpenReveal.tsx` controls visibility, not scroll position.
ChatScreen keeps the transcript at `opacity-0` until history has answered
(including a known-empty chat), the markdown layer has loaded, and the viewport
is within 16 px of the end. The check waits two animation frames for rows and
the viewport pin to land; a reader who has released following is not forced
back to the end. This prevents plain text, arriving rows and the journey to the
newest message from appearing as separate opening stages.

A quiet skeleton appears only after 150 ms, so a fast open has no flashing
placeholder. The reveal has an 800 ms cap: a slow or unreachable computer must
show the available content and connection state rather than a skeleton forever.
Once revealed, that conversation stays revealed.

## One connection verdict

`web/src/runtime/link-state.ts` owns the reachability evidence and
`socketDownSince`; the socket connection state remains controller plumbing.
`web/src/runtime/link-indicator.ts` derives `ok`, `connecting`, `unreachable`,
`daemon-down` or `offline`, and `useLinkIndicator()` takes no store argument.
With a live link, a socket outage gets 2 s of grace before `connecting`; retries
never reset its down time. Proven unreachability or a stopped server has no
grace. Platform-reported offline status refines `unreachable` to `offline`.

The audit saw no idle-chat indicator in 75 s, a sent message still labelled
Sending after 45 s, and nine pill re-entries in 40 s of retries. The controller
probes after 25 s without a frame in a visible chat, closes a connecting socket
after 8 s, and reconnects immediately when reachability returns. Reads and
writes both arm the 3 s slow-request probe; composer focus calls
`controller.noteUserActivity()` to probe a suspect link before sending.

`ConnectionPill` uses `NoticePill` and changes text in place across retries.
Connecting shows a spinner; unreachable, offline and stopped-server states
offer Retry, and tapping their text opens Settings > Computer. A stopped
server says that the named computer is on but omp-pulse is not running.
Retry probes before retrying the chat and ignores repeated taps while
retrying. A saved transcript appends "saved copy"; with a healthy link it
reads "Showing a saved copy" with Retry.
An outage visible for at least 3 s ends with "Back online" for 1.5 s; a
connecting blip does not produce that success notice.

Unsent bubbles read "Waiting for connection" with a clock while the computer
cannot be reached. The composer uses the steady placeholder "Message omp
(sent when online)" for unreachable, offline and stopped-server states.
`LinkBanner` appears in drawers, above the Chats search field even with cached
rows, and on the new-chat screen. Its advice comes from `linkAdvice`, and
`computerName` uses inline capitalisation and phone-mode wording. Only a
tailnet host gets Tailscale-specific advice.

## Notice stack

`web/src/app/ui/NoticePill.tsx` supplies the shared floating surface for toasts,
banners and the connection pill. `web/src/app/toast-stack.ts` owns the pure
admission policy. A single toast slot used to erase Undo while its deletion
still fired, and two replies finishing together lost one notice. Three-line
clamping hid the rest of long errors from touch users.

- At most two toasts are visible, oldest above newest. Matching groups, or
  matching message and tone, update in place and restart the timer. Undo toasts
  coalesce only through an explicit matching group, so separate deletes retain
  separate Undo actions.
- With a full stack, replace the oldest toast without an action, then the
  oldest non-Undo toast, then the older Undo only for an actionable newcomer.
  Passive toasts never evict Undo, and routine info/success never evicts a plain
  error.
- Passive toasts last 2.2 s (errors 4 s), plus 40 ms per character beyond 60,
  capped at 8 s. Actions without an explicit duration stay until dismissed.
  Hover, focus, touch and a hidden page pause ordinary timers. Undo never
  pauses: its deadline is real, shown by the draining progress line, and its
  toast is removed when the page hides.
- Tapping a recovery or Open notice runs its action; only the Undo button
  undoes. Clamped text expands on tap. A passive, unclamped notice dismisses
  on tap. Timed notices have no dismiss button.
- The toast follows an upward or sideways drag and dismisses beyond 48 px or
  on a fast flick; shorter drags spring back. Downward movement is resisted.
  Swiping an Undo away does not undo. Reduced motion removes positional
  entrance and exit movement; status and alert roles preserve announcements.

`showToast(message, tone?, action?, { durationMs?, kind?, group?, title? })`
retains one call shape for every surface. Undo callers provide
`kind: "undo"` and their real deadline; `title` separates the conversation
name from a reply preview.

Reply-ready batches share the `reply-ready` group and a 10 s duration. One
reply shows its conversation title and preview; several say "N replies ready".
Open goes to the newest reply. Android and Web Push still alert for the visible
chat, then clear its completed-reply notification after 4 s; questions remain.
The always-notify invariant in `src/bin/omp-pulse/main.rs` is unchanged.

## Composer controls and intake

Stop remains available throughout a running turn when permitted. With an empty
draft it occupies the action slot; with a draft it becomes a compact control
beside Send. Previously typing one character hid Stop. ChatScreen owns the
`stopping` state: Stop becomes a disabled, busy spinner until the turn ends or
the request fails. Failure offers a "Try again" toast. The action owner emits
one haptic, including for the retained long-press "Stop and send" action.

Send and Stop prevent pointer-down focus transfer, preserving the soft keyboard.
After sending, the editor regains focus only if it had focus when Send was
pressed. A sending restriction keeps the draft editable but changes the
placeholder to "Can't send from here" and explains the authority reason above
the field, including the `/collab` instruction for a chat open on the computer.

The "When to send" control says "Send now" and "After this reply". While a turn
runs and queueing is possible, it appears when the field is focused or contains
content, avoiding the layout jump on the first keystroke. These are the existing
steering-at-the-next-step and follow-up delivery modes, not new outbox semantics.

Photo intake creates one spinner tile per selected file immediately, each
independently cancellable. Each becomes its thumbnail when ready; failed tiles
leave and one summary reports the failures, preserving the specific reason for
a single failure. Removing an attached photo offers a 5 s Undo that restores
its position. The transcript and composer share a centred 48rem column and
safe-area-aware side padding. Composer height measurement includes these extra
controls because transcript bottom padding depends on it.

## Notification permission in context

`web/src/app/chat/NotificationNudge.tsx` sits first above the composer. It asks
"Get notified when this finishes?" only after the open turn has run for 20 s,
when notifications are available but not enabled and permission is not blocked
or denied. `web/src/platform/notification-nudge.ts` owns the decline record:
one decline suppresses the ask for 14 days, two suppress it permanently.

"Turn on" uses the same enable action as Settings > Notifications (native
permission and preferences, or browser push subscription), then confirms
"Notifications on". "Not now", refusal or failure records a decline and hides
the row. Blocked permissions remain a Settings task; opening a chat never
automatically invokes the system prompt.

## Client updates

`web/src/app/update-client.ts` exposes `updateClientNow(controller, options)`;
Settings > About and the banner call the same function. The banner's Update
action dispatches `app:update-now`, whose App handler invokes it directly,
instead of sending the user through Settings for a second Update tap.

Pending work blocks activation with "A message hasn't been sent yet. Update
once it's delivered." and a "View pending work" action when a destination is
provided, otherwise a route to Settings. A safe update calls
`controller.prepareForUpdate()`, then `applyClientUpdate()`, then reloads.
Failures become humanised error toasts; the update never bypasses delivery and
draft-persistence safety.

Version banners distinguish an older computer (or missing protocol fields),
which needs the computer's update guide, from a client below the computer's
minimum, which offers Update for this app. In Android phone mode the client
ships in the APK, so that case instead points to the Android app update guide.
