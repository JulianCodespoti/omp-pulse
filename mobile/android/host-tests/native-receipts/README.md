# Native receipt recovery: hermetic focused tests

From the repository root:

```sh
python3 mobile/android/host-tests/native-receipts/run.py
# Optional retained evidence and regression-mutation checks:
python3 mobile/android/host-tests/native-receipts/run.py --mutations --output /tmp/native-receipt-proof
```

Only the installed Java compiler module (`java com.sun.tools.javac.Main`) and Python
standard library are used. Java compilation uses `-Xlint:all -Werror`. The runner
never starts a server, socket, daemon, model, Android build, emulator, or ADB task.

## What is source-bound

The pure production validator is compiled unmodified in its own class directory
with `validator/`'s typed-object fixture. A separate integration class mechanically
extracts exact complete methods/classes from the current `NativeOutbox.java`,
including insertion, public snapshot, durable routing, status admission and execution,
scoped lookup, HTTP-session configuration/deadline/body limits, receipt application,
local error CAS, posting-authority transitions, delivery, POST serialization and
response handling, notification effects, reserved photo edits, conditional remove/clear,
and their narrow dependencies. The actual `NativeOutboxBridge.execute` dispatcher
also runs against these extracted methods for browser-import coverage.
Relevant constants are extracted too; the single-worker bounded executor constructor is source-checked. Each extracted block and the production files are hashed in `source-manifest.json`.

Two one-line claim/rearm delegators are represented by counting wrappers that call
the exact extracted `changePostingAuthority` implementation. The runner verifies
that each original delegator still has precisely that forwarding body. This permits
explicit claim/rearm invocation counts, including unsuccessful attempts, without
rewriting the production transaction logic. Version-request, POST, global-wake,
job-schedule and notification counts are captured at their synthetic boundaries. The fake global wake counts entry only; actual wake internals are not executed (production wake also schedules a job).

## Coverage

- New save versus existing save versus a duplicate discovered inside the insert
  transaction; payload collision; existing postable first sends; handed-off and
  evidence-bearing imported rows; existing migrated-style saved rows retaining may_post=1/legacy=0 alongside a prior receipt or binding; legacy flags; terminal immediate acknowledgement.
- Persistence acknowledgement before queued network work, same-key coalescing,
  50-key admission cap, rejection cleanup, retry after rejection, scope/revision
  changes before execution, exact URL-encoded raw path and exact ID.
- Zero targeted POST, global wake, global job, claim/rearm and version preflight,
  including nonterminal, malformed, missing, transport-error, deadline-expired and
  oversized results. Targeted status preserves the version-cache sentinel.
- Cache-control, redirects and deadline configuration through the actual extracted
  `HttpSession`; synthetic transport verifies configured properties and elapsed
  deadline checks, not platform transport enforcement.
- Atomic receipt/binding/state/post-flag/revision application; captured identity and
  local revision fences; stale local error; terminal immutability; conflicting
  canonical witnesses; downgrade prevention; malformed retained/imported witnesses;
  equal-millisecond and backwards-clock terminal settlement; removed/cleared rows.
- Delivery losing receipt, claim, or rearm CAS to a newer nonterminal receipt retains
  its own retry scheduling. The target path never schedules that delivery work.
- Delivery follow-up starts at its floor and backs off with command age to a cap.
  Handed-off work older than the daemon's receipt watch stops polling and is left
  uncertain (never resent or settled); unsent saved work keeps retrying.
- Strict POST `ok` handling; saved imports with old evidence never regain POST
  authority; 404 with prior evidence preserves no-replay behavior. Winning terminal
  applies notify locally; CAS losers and terminal rereads do not notify again;
  notification failures cannot regress committed evidence.
- Existing count/byte caps, tombstone anti-resurrection, clear-marker import fence,
  and dispatching remove/clear protection.
- Photo-edit reservations versus dispatch and receipt updates; exact original photo
  recovery, lost begin/finish acknowledgements, stale credential/intent/discard
  fencing, deadline and unreadable-photo refusal, commit/tombstone replay, and
  explicit reservation release without deleting the saved copy.
- Reserved browser imports retain exact photo bytes and edit tokens without wake,
  status lookup or HTTP delivery. Same-session sends remain fenced until explicit
  finish or discard; unrelated conversations remain usable.

## Real SQLite migration proof

`baseline-v1-schema.json` contains mechanically concatenated exact CREATE statements
from the pinned version-1 source blob recorded in the fixture. The runner extracts
fresh CREATE and additive ALTER statements from the current production source.
The extracted Helper callbacks are exercised against a SQL-recording fake that
tracks columns, answers `PRAGMA table_info`, and applies additive migrations.
Legacy queues remain readable and editable after upgrades, including version 4's
nullable `edit_token`; no test pins incidental SQL statement counts or version
defaults. Python `sqlite3` creates v1 on disk, seeds every original command column plus
attachments/tombstones/clear markers, closes it, applies the exact migration SQL,
closes/reopens again, and compares every original value. It also checks new defaults,
retained witness/revision after another reopen, tombstone uniqueness, and fresh versus
upgraded logical column schema. Physical column ordinals differ naturally because
SQLite ALTER appends fields; comparison uses names, types, nullability, defaults and
primary-key positions. This proves actual SQLite SQL effects, not Android lifecycle.

## Deliberate limits

Java Android context, SQLite operations/transactions, executors, HTTP connections,
notification APIs, JSON parser and attachment files are synthetic. Java SQLite is a
small deterministic model supporting only the exercised statements; it is not SQLite
or proof of SQLite lock scheduling. Concurrency interleavings are deterministic
injection points, not real threaded races. Attachment staging/cleanup is simulated;
attachment disk streaming/fsync is not exercised. The small JSON fixture is not an
Android `org.json` conformance implementation; numeric/type coverage in `validator/`
also uses injected typed objects. Real HTTP, cache behavior, timers, executor threads,
Android SQLiteOpenHelper lifecycle, device restart/archive services, full repository
build/tests, deployment and installed-device correctness remain separate gates.

`--mutations` independently recompiles intentionally bad generated fixtures and
requires test failure for removed coalescing, removed status capacity limit, omitted
GET session scope, target global wake, missing revision advance, enabled HTTP
caching, and removed saved-evidence routing guards. It never changes production source.
