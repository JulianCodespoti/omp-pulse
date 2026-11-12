# Dialogs and phone controls

This page covers how an agent's questions (the `ask` tool and other extension
dialogs) reach the phone and survive reconnects, how the phone finds a conversation
that is waiting on a question, and the controls the phone drives through the child's
helper extension (plan mode, Go here, labels, `!!`). The overview is in
[architecture.md](architecture.md).

## Interactive dialogs (the `ask` tool)

Two transports carry a question to the phone, and they are NOT the same shape.

**Desktop-owned sessions (the normal case).** A phone usually watches a session a
desktop `omp` holds open. The desktop raises the dialog, its collab host broadcasts
`{t:"ui-request", request}` to writable peers, `src/omp/collab.rs` re-wraps it as a
`collab_ui_request` WS event, and the phone answers with `collab-ui-response`, which
`send_ui_response` turns back into `{t:"ui-response", reqId, value?}`. An ABSENT
`value` is how that protocol spells cancelled. Before this existed the phone
rendered nothing and the desktop agent blocked forever on an answer only the desktop
could give.

Desktop `editor` requests remain multiline editors, not plain text questions.
Their `prefill` is editable initial content. The exact question token owns the
draft, including an intentional empty string across hide/reopen; Enter inserts
a newline. Send with an empty value is distinct from Skip question.

**Phone-driven sessions.** The daemon's own child runs `omp --mode rpc-ui` and speaks
`extension_ui_request` / `extension_ui_response`. `rpc-ui`, not `rpc`: only it sets
`session.hasUI`, and `AskTool.createIf` returns null without a UI, so an `rpc` child
could only ask in prose. After `negotiate_protocol` the daemon sends
`set_ask_dialog{enabled:true}` (non-fatal), so an `ask` arrives as ONE
`method:"ask"` request carrying every question. The same path carries
select/confirm/input/editor from hooks, extensions, tool approval and login flows.
The chat renders them in `ExtensionDialogSheet`; the reply must carry the field the
method reads (`confirmed`, `value` = exact option label, `answers[]`, or
`cancelled`), or omp resolves it as a denial. `src/omp/ui_dialog.rs` builds and
checks every reply; `/api/panes/answer` takes `requestId` + `response` for it, and
plain `text` from the answer sheet is mapped per method (an `ask` is held per
question until its last answer).

The collab wire is RICHER than the RPC one: it preserves per-option `description`
and checkbox state, which omp's `getExtensionUISelectOptionLabel` discards on the RPC
bridge. So the phone normalises collab requests into the RPC-shaped internal dialog
and renders whatever extra survived, rather than keeping two renderers.

Desktop checkbox dialogs are not batch answers. Native `selectionMarker`,
`checkedIndices` and `markableCount` identify the checkbox prefix; trailing
Continue and custom-answer options remain ordinary actions. Each toggle is a
round trip: the desktop re-issues the list with confirmed checked state. The phone
does not infer selection from labels or tick optimistically. Native help text is
retained, and option values go back verbatim even when their display labels differ.

Structured `method:"ask"` permits an explicit empty selection for a multi-select;
single-choice still requires a choice or custom answer. Supplied option previews
are independent disclosures: inspecting one neither selects nor submits it.

Cancelling an OMP ask throws `ToolAbortError` and aborts its turn, so its action is
`Stop turn` (behind a confirmation). Any other extension question or collab request
is dismissed with `Skip question`. Close hides the sheet without answering or
cancelling.

A pending dialog survives a reload. The child manager retains the full request
payload per id and replays it with its remaining timeout and transport delivery
state. A completed pipe write is only a handoff, not proof that OMP's callback
accepted the value. Structured asks retire on their real exclusive ask tool result,
native cancellation or terminal turn end; generic dialogs await native closure.
The child extension brackets its planning selects with private callback-scope
markers, allowing the monitor to close the exact native ID after its promise
settles even when no agent turn runs. Settlement uses the already-held session
binding; re-locking it would deadlock the stdout monitor.
The client retains submitted values, locks uncertain or handed-off answers against
duplicate dispatch, and preserves the reason for an explicit refusal.
Same-connection catch-up also requests the authoritative `extensionDialogs`
snapshot through `/api/history?feedback=true`. Reconciliation is per request ID:
missed pending questions reopen, absent questions close, and newer live asks,
closures, answers and drafts win over an older read. Binding and terminal-state
fences prevent a retired owner from restoring a dialog.

Drafts and attempts are scoped to credentials, conversation and request. Each
question surface retains at most 64 question slots, refuses visibly at capacity,
and releases only authoritatively ended questions rather than evicting outstanding
answers. Hiding, disconnecting or navigating away does not establish closure.
Plain-text routing skips retained native reservations so a later dialog remains
answerable. Terminal responses have submission identities, not guessed question
IDs: they retain text/status across reopening, require an explicit action to write
another response, and offer local removal without claiming remote settlement.

`launchUrl` on an `open_url` is deliberately not a tap target: it is a loopback
address, so on a phone it resolves to the phone. Sign-in shows the host only, with
Copy and Open, and says that finishing needs the machine running omp. That card
exists for collab only: an `open_url` from the daemon's own child is forwarded but
not rendered, so omp's `login` RPC stays off the phone allowlist.

## A question must outlive the socket

The desktop broadcasts each `ui-request` exactly ONCE. A phone whose socket is shut
at that instant (an asleep tab, dropped cellular, or this daemon having just been
restarted) used to lose the frame entirely: it fanned out to zero clients and the
desktop agent then blocked forever on an answer nobody could be asked for. Measured
exactly that (`clients: 0` at the moment an `ask` was raised).

It is NOT sufficient that the collab host replays pending requests to joining peers.
The phone is not a collab peer; it is a WS client of this daemon, and the daemon's
relay tap does not re-trigger the host's replay. So `collab.rs` keeps its own
per-session store of outstanding dialogs. `src/server/http/socket.rs` captures a
complete pending snapshot after subscribing and before awaiting history, then
replays it on attach. Session, daemon generation and revision fence that snapshot
against queued older events. It settles a missed end without retaining a growing
log of closed IDs; a new daemon's empty cache cannot settle old-generation
uncertainty.

Protocol 5 binds requests, responses, queued answers, acknowledgements and editor
state to an exact `pulseQuestionToken`, not just a reusable numeric `reqId`.
Entries remain after queueing or transport handoff; only host `ui-request-end`,
actual room retirement or an authoritative same-generation pending snapshot
retires them. Ending a question also removes its queued answer. Distinct new
tokens remain answerable without overwriting an older uncertain value.
Unsent collab drafts share the controller's bounded answer cache rather than
accumulating in component state. Rendered actions carry their original token,
so a tap queued before question replacement cannot answer its successor.
Queued, sending, handoff, explicit refusal and uncertain delivery remain distinct.
An uncertain answer is not automatically resent; an explicit refusal is retryable
only while that same request remains actionable.

## Finding the blocked conversation

Native/collab dialogs without a persisted ask ID open in their own conversation,
where the exact request identity is available. Structured asks can also be
answered from the list using their ask ID and question index. Unidentified
terminal prompts retain the separate, explicit remote-response path; that path
refuses to send text into a native/collab dialog which appeared in the meantime.

`GET /api/awaiting` answers "which sessions are holding a question", from the child
manager's pending dialogs and the collab store together. It is deliberately NOT part
of `/api/sessions`: that payload is ETag-validated against file state (1.87 MB down
to zero bytes on a steady poll), and a pending dialog is not a property of the file,
so folding it in would either defeat the validator or make it churn every poll.

The inbox fetches it alongside the listing and re-renders only when the set changes,
because the list's own re-render is keyed on a signature the flag is not part of.
`asking` outranks every other row state (`inboxState` in
`web/src/app/session-format.ts`): it is the one case where the agent cannot proceed
without this person.

## Phone controls in the child

omp's RPC protocol has no plan mode, no in-place tree move, no entry labels and no
way to keep a shell command out of the model's context (`bash` calls `executeBash`
with the command alone). The TUI does all four through internals it owns, so the
phone could not, and its old `/plan` row sent the literal text to the model.

Every child the daemon spawns (`child_args` in `src/omp/child.rs`) therefore loads
one more extension with `-e`: `extensions/omp-pulse-child.ts`, embedded in the binary
and written to `<state dir>/child-extension/omp-pulse-child-<sha256 prefix>.ts` at
startup and before each spawn (`src/omp/child/extension.rs`). The name carries a
content hash, so a new daemon never edits a file a running child loaded. Each spawn
refreshes its own copy's mtime, and another version's copy is pruned only after an
hour untouched: two daemon builds can share a state dir (a deploy or rollback
overlap), and a child still booting needs its `-e` path on disk. The user's own
terminal omp never loads it; `-e` adds to the extensions omp discovers and replaces
none.

The extension registers `pulse-plan`, `pulse-goto`, `pulse-label` and `pulse-bash`.
omp runs an extension command when an RPC `prompt` starts with `/name` (agent-session
`#tryExecuteExtensionCommand`, even mid-turn), but such commands produce no RPC
output. So the daemon sends `/pulse-x <reqId> <json>` with an RPC id
`pulse-ext:<reqId>` (kept apart from `pulse-prompt:` receipts and turn tracking), and
the extension answers with a `setStatus` UI frame keyed `omp-pulse:<reqId>`.
`dispatch_value` settles the waiter from that frame and forwards neither it nor the
command's `prompt_result` to the phone. A waiting control keeps the child busy for
the reaper; a child exit wakes every waiter. The web hides any `pulse-*` name from
its command lists (`isInternalCommandName`).

Before the first control on a child, the daemon checks that omp's command catalogue
lists `pulse-plan`. An extension that failed to load would otherwise turn
`/pulse-plan …` into a message to the model. Without it every control fails with a
sentence.

What each control uses (tree navigation verified with omp 18.10.4):

- **Edit this prompt / Continue after answer** (`tree_goto`): the managed
  extension calls the live `AgentSession.navigateTree(id, {summarize:false})`.
  Prompt editing targets the user entry and restores its text to the composer;
  continuing after an answer targets that exact assistant entry and retains the
  answer in model context without preparing another prompt. `/api/tree` supplies
  separate `resumeTargets` for completed sibling answers; aborted, errored and
  tool-call entries are excluded.
  omp keeps an in-place move only in memory (its loader takes the branch from the
  LAST physical entry), so the extension then appends a metadata-only `custom`
  entry `omp-pulse-goto` whose parent is the new position and flushes. The TUI,
  `read_tree` and `src/sessions/branch.rs` all follow it. `/api/history` still
  serves every physical entry, so the web drops abandoned turns itself
  (`web/src/runtime/branch-view.ts`: from the newest marker back it keeps only the
  marker's ancestor chain) and re-seeds from the tail when a new marker arrives.
  In-place navigation is refused while the agent runs. A session the laptop owns
  keeps the file fork (`branch.rs`) and refuses the in-place move.
- **Labels** (`tree_label`): `ctx.sessionManager.appendLabelChange`. The documented
  `pi.setLabel(id, label)` only renames the extension (omp's `loader.ts`).
  `/api/tree` rows carry `label` (the newest `label` entry for the id wins; empty
  clears).
- **Plan mode** (`plan_mode`) and **`!!`** (`/api/bash` with
  `excludeFromContext: true`) need the live AgentSession, which no extension API
  exposes. The extension reaches it through the host's module namespace,
  `pi.pi.AgentRegistry.global().get(ctx.agent.id).session`: the same registry omp
  attaches every session to. Every method is feature-detected. A missing one fails
  that control with "This omp version can't do that from the phone yet." and never
  throws into omp.
  - Entering plan mode follows the TUI's `#enterPlanMode`: the goal guard,
    `setPlanModeState`, the built-in `write` added to the active tools, a
    plan-proposal handler, a steer of the plan context when mid-turn, and a
    `mode_change` `plan` entry. Leaving restores the tool presentation and appends
    `mode_change` `none`; a mid-turn exit aborts the turn the way the TUI does. The
    plan-role model swap is not done: the phone shows and picks the session model
    itself.
  - The proposal handler follows ACP's `#handleAcpPlanProposal`. It asks the phone
    through `ctx.ui.select` ("Plan ready: …" with Approve and run / Keep planning /
    Discard), which is the existing dialog sheet, and it survives reconnects like any
    dialog. Approval exits plan mode and lets the same turn continue with full tools.
  - Both `!` and `!!` call
    `session.executeBash(cmd, onChunk, {excludeFromContext, useUserShell: true})`.
    Plain `!` includes its output in context; `!!` marks the `bashExecution`
    entry so `convertToLlm` drops it. The composer labels the configured user
    shell and piped output (no terminal PTY). The reply goes through
    `bash_result_from_data` and the WS `bash_result` frame.
  - Both forms require the managed extension: native RPC `bash` would silently
    change user-shell semantics and is not a fallback. `onChunk` batches output
    into at most one
    `setStatus` frame per 100 ms, keyed `omp-pulse-out:<stream>` (newest 64 KiB kept
    between frames). The daemon re-sends each as a `bash_output` WS frame
    `{id, text}`, `id` being the `runId` the client gave `/api/bash`; the Terminal
    tab (`web/src/app/tools/TerminalTab.tsx`) appends the frames of its own run
    (newest 64 KiB) until the reply replaces them.

Plan state on the phone comes from the transcript: the newest `mode_change` on the
loaded branch (`web/src/runtime/plan-state.ts`), plus each `plan_mode` reply. That
survives reloads and reconnects without a new protocol. It is also what the TUI
restores from on resume. To keep it true, the extension reconciles the live session
with the branch's mode on `session_start`, `session_switch`, `session_branch` and
`session_tree`. RPC itself never restores plan mode, so a respawned child would
otherwise drop it silently. One gap: omp writes a brand-new chat's file only after
the first reply, so a reload between turning plan mode on and that reply shows it off
until the entry lands.
