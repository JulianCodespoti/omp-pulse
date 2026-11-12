# Plugins

A plugin adds small views to the omp-pulse app, fed by commands on the computer
that runs the daemon. This page covers what a plugin can and cannot do, how to
write one, and the security model.

## What a plugin is

A plugin is a folder on the daemon's computer holding two files: a manifest
(`pulse-plugin.toml`) and one script (`client.js`). The daemon finds the folder,
hashes it, remembers whether you turned it on, runs the host commands the
manifest declares, and serves the script to your paired devices. The app runs
the script in a sandboxed worker and draws the small declarative views it
returns.

A plugin can draw in eight slots:

- `composer.status`: a chip, or a row of chips, beside the composer.
- `composer.actions`: rows in the composer's plus sheet.
- `drawer`: a few chips, text, progress bars and rows in the drawer.
- `page`: a full page of your own, opened from a chip or button.
- `session.row`: chips at the end of a conversation's row in the Chats list.
- `session.menu`: rows in a conversation's actions menu.
- `transcript.tool`: a card under a tool call's row, which stays visible.
- `transcript.message`: a card that replaces the body of an extension's custom message.

It can also, when you tap something it drew and you have approved the matching
permission, put text in the composer, send a message, run a shell command of
its own choosing or an allowed RPC command in a conversation, or run a command
declared in its manifest on the computer.

It cannot read a session on its own, use the network, store anything, or touch
the app's page. Nothing runs while the app is closed: the script lives in the
app, and the daemon runs a plugin's commands only when a device asks for them.

## Ask your agent to write one

omp-pulse ships a skill and a slash command that teach your omp how to write a
plugin. Run `omp-pulse plugin skill` once to install them (`omp-pulse setup`
already does, and a starting daemon refreshes them if they are installed, unless
`OMP_PULSE_SKIP_SKILL_REFRESH` is set, as the test harnesses do). They
go into omp's agent directory, so restart any omp session that was already
running. Then, in an omp session, type `/pulse-plugin <what you want>`, or just
ask: the skill loads itself when you talk about a Pulse plugin.

The agent writes the plugin in a folder of its own (`~/pulse-plugins/<id>`
unless you say otherwise), runs `omp-pulse plugin check` until it is clean and
links it. It leaves it off. You review the commands and permissions in
**Settings › Plugins** (or with `omp-pulse plugin enable <id>`, which asks before
switching it on) and switch it on; the agent is told not to do that itself.
Editing the plugin afterwards sends it back to review.

## Quick start

The repository ships three examples:

- [host-usage](../../examples/plugins/host-usage/): load and memory of the
  daemon's computer, plus a sandbox self-check. The one to start from.
- [provider-usage](../../examples/plugins/provider-usage/): how much of each
  model provider's usage limits you have used, from `omp usage`.
- [systemd-timers](../../examples/plugins/systemd-timers/): your systemd user
  timers, with a tap to run one's service now (Linux).

1. Make a folder and put the example's `pulse-plugin.toml` and `client.js` in it.
2. Validate it: `omp-pulse plugin check ./my-plugin`. It prints the id, the
   slots and the exact command of every source, a warning for each file in the
   folder a command uses (see [Security model](#security-model)), or the first
   problem it finds.
3. Install it by link: `omp-pulse plugin link ./my-plugin`. The plugin stays off.
4. Turn it on in **Settings › Plugins** on the phone, after reading the
   commands shown, or with `omp-pulse plugin enable host-usage`, which prints
   the same review and asks.

Edit the files in place afterwards; a changed plugin goes back to needing review.

## Where plugins live

- The plugins folder is `OMP_PULSE_PLUGINS_DIR` if that is set and non-empty,
  otherwise `<config_dir>/omp-pulse/plugins`. `omp-pulse plugin dir` prints it.
- A plugin is a directory in that folder containing `pulse-plugin.toml`, or a
  file `<id>.path` whose trimmed content is the absolute path of such a
  directory. `plugin link` writes the second form.
- Entries whose name starts with `.` are ignored. Entries are read in name order.
- Your decisions (on or off, which hash you approved, and the values of the
  plugin's options) are in `plugins.json` in the daemon's state directory.
  Unlinking a plugin keeps its decision.

## Manifest reference

Unknown keys are rejected everywhere, so a typo shows up in `plugin check`.

| Key | Rule |
|---|---|
| `schema` | Required. Must be `1`. |
| `id` | Required. Matches `^[a-z0-9][a-z0-9._-]{0,63}$`. If two plugins share an id, the later one in name order is invalid. |
| `name` | Required. 1 to 64 characters after trimming. No control characters. |
| `version` | Required. 1 to 32 characters. No control characters. |
| `description` | Optional. At most 200 characters. No control characters. |
| `client` | Required. A file name with no path separator and no `..`, inside the plugin folder, valid UTF-8, at most 262144 bytes. |
| `slots` | Required. Non-empty, no duplicates, each one of `composer.status`, `composer.actions`, `drawer`, `page`, `session.row`, `session.menu`, `transcript.tool`, `transcript.message`. |
| `permissions` | Optional, no duplicates, each one of `session.read`, `session.compose`, `session.prompt`, `session.bash`, `session.rpc`. |
| `tools` | Required, non-empty (at most 16) exactly when `slots` has `transcript.tool`; rejected otherwise. Claim patterns, see below. |
| `messages` | The same for `transcript.message`: claim patterns for custom message types. |
| `[[sources]]` | Optional, at most 8 tables, with the keys below. |
| `sources.id` | Matches `^[a-z0-9][a-z0-9_-]{0,31}$`, unique within the plugin. |
| `sources.command` | A non-empty array of non-empty strings: an argv, never a shell line. No control characters in any element, since one could hide the review output in a terminal. |
| `sources.interval_s` | 2 to 3600. Default 30. |
| `sources.timeout_s` | 1 to 30. Default 5. |
| `[[options]]` | Optional, at most 16 tables, with the keys below. |
| `options.id` | Matches `^[a-z0-9][a-z0-9_-]{0,31}$`, unique within the plugin. |
| `options.label` | 1 to 64 characters. |
| `options.type` | `bool`, `choice` or `text`. |
| `options.choices` | Required for `choice` (1 to 20 unique strings of 1 to 64 characters); rejected for the other types. |
| `options.default` | Optional. A TOML boolean for `bool` (default `false`), one of `choices` for `choice` (default the first), a string of at most 200 characters for `text` (default empty). A default of the wrong type is invalid. |
| `[[actions]]` | Optional, at most 8 tables, with the keys below. |
| `actions.id` | Same pattern as a source id, unique among actions. |
| `actions.label` | 1 to 80 characters. Shown at review. |
| `actions.command` | An argv like a source's. At most one element may be exactly `{arg}`, and no other element may contain `{arg}`. |
| `actions.arg_pattern` | Required exactly when `command` has `{arg}`, rejected otherwise. At most 200 characters, Rust `regex` syntax, must compile. It is matched against the whole argument. |
| `actions.timeout_s` | 1 to 120. Default 30. |

Every human-readable string also rejects control characters. A claim pattern is
1 to 64 characters from `A-Z a-z 0-9 _ . : / -` plus `*`; `*` matches any run
of characters (including none), everything else matches itself,
case-sensitively, against the whole tool name or message type.

## Status and review

Every plugin has one status:

- `enabled`: you turned it on and it has not changed since.
- `disabled`: you turned it off.
- `needs_review`: it is new, or it changed after you approved it. It stays off.
- `invalid`: the manifest or script broke a rule; the reason is shown.

The hash is the SHA-256 of the manifest bytes, a zero byte, then the script
bytes. Turning a plugin on names the hash you reviewed; if the files changed
since, the request fails with `plugin_hash_mismatch` and you review again.
Turning off needs no hash. Only an enabled plugin has its script served or its
sources run. Anything that changes the hash (permissions, claims, an option's
schema, an action) sends the plugin back to review; option values are not in
the hash, so changing them does not.

## Sources

A source is a command the daemon runs for the plugin so the script can read the
output with `pulse.source(id)`.

- The command is run directly from its argv, with no shell. Its working
  directory is the plugin folder, stdin is closed, stderr is discarded, and the
  environment is the daemon's, without the daemon's own token
  (`OMP_PULSE_TOKEN`, `OMP_REMOTE_TOKEN`), plus `OMP_PULSE_PLUGIN_ID` and
  `OMP_PULSE_PLUGIN_DIR`.
- It runs only when a control device asks and the cached reading is older than
  `interval_s`; nothing runs on a timer. Callers at the same moment share one
  run. A read-only device cannot read a source, since that can make the
  computer run the command.
- It is killed at `timeout_s`, together with anything it started (on Unix, its
  whole process group). Stdout is kept up to 65536 bytes (`truncated` tells you
  when it was cut). At most 4 source commands run at once on the daemon.
- The reading is cached and shared by every device, so ten phones cost one run.
- A reading has `ok` (the command started and exited 0 in time), `text`,
  `exitCode`, `fetchedAtMs`, `truncated` and, on failure, `error`.
  Always check `ok`.
- A command whose program is exactly `omp` runs the daemon's own omp binary,
  because a service's `PATH` often lacks yours. This applies to actions too.

## The script API

The script is plain JavaScript run once in a worker. Its one global is `pulse`:

| Call | What it does |
|---|---|
| `pulse.slot(slotId, render)` | Registers the renderer for a slot; `render(ctx)` returns a node, `null` or a promise of either. One renderer per slot. `ctx` is the render context, below. |
| `pulse.source(id)` | Promise of the latest reading of a declared source. |
| `pulse.options` | The current option values, a frozen object. Empty until the host sends them, before the first render. |
| `pulse.on("options", fn)` | Optional. `fn(values)` after the values change; a render follows anyway. |
| `pulse.on("action", fn)` | `fn({ slot, act, value?, item?, key?, session? })`. `act` is the action name up to its first `=`; `value` is the rest; `item` is the tapped list item's `id`; `key` is set for the keyed slots; `session` is the conversation the tap targets, or `null`. Without `session.read` it is `null` unless the tap was on a `session.row` or `session.menu` item. |
| `pulse.refresh(slotId?)` | Renders again, all slots when omitted. |
| `pulse.openPage()` | Opens this plugin's page; ignored unless it declares `page`, and only honoured within one second after a tap on something the plugin drew. |
| `pulse.toast(message)` | A short message, at most 200 characters, shown with the plugin's name in front. Each tap lets the plugin show one; any other toast shows at most once every 30 seconds, and the rest are dropped. |
| `pulse.composer.insert(text)` | Puts text in the composer. Needs `session.compose`. |
| `pulse.session.prompt(text)` | Sends a message as the composer would; skills, prompt templates and extension commands (`/review …`) expand as usual. Refused: a leading `!` (use `session.bash`), a built-in command such as `/compact` (use `session.rpc`), and anything that opens a sheet or screen on the phone (`/btw`, `/goal`, `/plan`, `/settings`, …). For a conversation that is not open, every slash command is refused. Needs `session.prompt`. |
| `pulse.session.bash(command, { excludeFromContext })` | Runs any shell command the script chooses on the computer, in the conversation's folder. Needs `session.bash`. Resolves to `{ ok, output, exitCode, error? }`. |
| `pulse.session.rpc(command, params)` | Runs one of the daemon's existing allowed RPC commands in the conversation. Needs `session.rpc`. Resolves to `{ ok, data?, error? }`. |
| `pulse.host.run(actionId, arg)` | Runs a declared `[[actions]]` entry. Resolves to `{ ok, text, exitCode, truncated, error? }`. |
| `pulse.ui.text(text, props?)`, `chip(text, props?)`, `row(children, props?)`, `col(children, props?)` | Builders. |
| `pulse.ui.card(title, children, props?)`, `kv(items)`, `list(items, props?)` | Builders. |
| `pulse.ui.progress(value, label?, props?)`, `button(text, action, props?)`, `empty(title, description?)` | Builders. |

Builders return plain `{ k, p, c }` objects (kind, props, children); you may
write those by hand. The app calls every renderer at start, after each new
source reading, after an action handler returns, and on `pulse.refresh`. An
action name is 1 to 64 characters.

### Node kinds

Tones are `neutral`, `accent`, `success`, `warning`, `error` and `muted`.
Unknown props are dropped, a wrong type for a required prop rejects the whole
view, and over-long strings are cut with `…`.

| Kind | Props | Children |
|---|---|---|
| `text` | `text` (up to 2000), `tone?`, `strong?`, `mono?` | none |
| `chip` | `text` (up to 48), `tone?`, `actions?: { click }` | none |
| `row` | `gap?` (`sm` or `md`) | laid out horizontally, wrapping |
| `col` | `gap?` (`sm` or `md`) | laid out vertically |
| `card` | `title?` (up to 80), `tone?` | body, vertical |
| `kv` | `items`: up to 50 of `{ key (80), value (400), tone? }` | none |
| `list` | `items`: up to 100 of `{ id?, label, detail?, value?, tone? }`, `actions?: { click }` | none |
| `progress` | `value` (clamped to 0..1), `label?` (up to 80), `tone?` | none |
| `button` | `text` (up to 32), `variant?` (`default`, `primary`, `danger`), `actions: { click }` | none |
| `empty` | `title` (up to 80), `description?` (up to 300) | none |

### Limits per slot

A view over a limit is rejected with a reason naming the limit. A view larger
than 65536 bytes as JSON is rejected in every slot. Returning `null` or
`undefined` means "show nothing".

| Slot | Allowed kinds | Max nodes | Max depth | Extra |
|---|---|---|---|---|
| `composer.status` | `chip`, or one `row` of chips | 4 | 2 | |
| `composer.actions` | `list` | 1 | 1 | At most 8 items; the list must have `actions.click`. |
| `drawer` | `chip`, `text`, `progress`, `row`, `col` | 12 | 3 | |
| `page` | all | 300 | 8 | |
| `session.row` | `chip`, or one `row` of chips | 3 | 2 | |
| `session.menu` | `list` | 1 | 1 | At most 6 items; the list must have `actions.click`. |
| `transcript.tool` | all | 120 | 6 | |
| `transcript.message` | all | 120 | 6 | |

A list item's `id` (at most 64 characters) is what a tap passes as `item`.

### Where the new slots appear

| Slot | Where | Context |
|---|---|---|
| `composer.actions` | The composer's plus sheet, after the commands. | The open conversation. |
| `session.row` | The end of the meta line of a row in the Chats list and a project's chats. Not on drawer rows. | That row's conversation. |
| `session.menu` | Both conversation menus: the long-press actions sheet and the chat header's menu. Drawn as rows under the plugin's name; a tap closes the menu. | That conversation. |
| `transcript.tool` | Under the stock row of a tool call the plugin claims; the row stays, so a card can add to what a call says it did but never replace it. | The call, and the open conversation. |
| `transcript.message` | Replaces the body of an extension's custom message the plugin claims. | The message, and the open conversation. |

A transcript card has a "Show original" toggle that brings the stock view back.
While the plugin is starting, returns `null`, or is off or failed, the stock
card is shown. The first enabled plugin (by id) that declares the slot and
whose claim matches draws a card; the plugin only runs for cards on screen.

### Render context

Every renderer receives `ctx`:

```js
{ session: { id, title, cwd, model, status, activeAt } | null,  // status: idle, working, needs-you
  call?: { id, name, args, output, state, truncated },          // transcript.tool
  message?: { id, customType, text, details, truncated } }      // transcript.message
```

`session` is the conversation the surface belongs to: the row's or menu's
conversation, otherwise the one open on screen, or `null` on the home screen
(`model` looks like `provider/model`). It needs the `session.read` permission:
without it `ctx.session` is `null` in every slot except `session.row` and
`session.menu`, whose own conversation those slots already disclose. Unkeyed
slots render again when the open conversation changes.
To keep workers small, `args` and `details` over 32768
bytes of JSON become `null`, `output` and `text` over 32768 characters are cut,
and `truncated` says so. Rows, menus and cards are drawn for a bounded number
of conversations or cards at once; beyond that a surface simply gets no view.

### Tap actions

A plugin acts only because you tapped something it drew. Every tap gives the
plugin one grant, and the next call to one of the five methods
(`pulse.composer.insert`, `pulse.session.prompt`, `pulse.session.bash`,
`pulse.session.rpc`, `pulse.host.run`) uses it up, provided it is at most 3
seconds old. A call without a fresh grant is refused with "needs a tap", so
one tap can do one thing. Before the call runs, the app asks the computer
again whether the plugin is still on and unchanged since you approved it; if
it was turned off (on the computer or another device) or edited, the call is
refused and the plugin stops.

- The conversation targeted is the one in the tapped row or menu for
  `session.row` and `session.menu`, otherwise the one open on screen. A plugin
  can never name the conversation itself. With none, a session method is
  refused ("no conversation is open").
- A call needing a permission the manifest did not declare, or naming an
  action it did not declare, is refused and does not use up the grant.
- Limits: text up to 20000 characters, a shell command up to 4000, an RPC
  command name up to 64 characters and its params up to 16384 bytes of JSON.
- `pulse.composer.insert` needs the conversation to be open; otherwise it is
  refused. `pulse.session.prompt` sends like the composer's Send for the open
  conversation, and sends a durable prompt to another one. It never disturbs a
  pending edit. One rule decides what it may send, on both routes: messages
  only. Text that leads with `!` or `!!` (however it is indented) is refused
  with "Run commands with session.bash"; a built-in command is refused (use
  `session.rpc`); anything that opens a sheet or one of the app's own screens
  (`/btw`, `/goal`, `/plan`, `/settings`, `/new`, `/resume`, `/tree`,
  `/agents`, `/fork`) is refused: a plugin cannot navigate the phone. For a
  conversation that is not open there is no command list to check against, so
  every slash command is refused.
- All five always resolve; a refusal is `{ ok: false, error }`.

Permissions are declared in the manifest and shown at review:

| Permission | Shown at review as |
|---|---|
| `session.read` | Sees the open conversation's title, folder and model |
| `session.compose` | Put text in the message box |
| `session.prompt` | Send messages to the conversation (skills and prompt templates too) |
| `session.bash` | Run any shell command it chooses on this computer, in the conversation's folder |
| `session.rpc` | Read the whole conversation and change it (settings, rewind, fork, compact) |

Review also lists what else the plugin sees: conversation titles, folders and
models (when it declares `session.row` or `session.menu`), calls to tools
matching its `tools` claims with their arguments and output, and extension
messages matching its `messages` claims. Commands are shown with each argument
quoted where needed, so one argument holding a space never reads as two, and a
warning names each file in the plugin folder a command uses.

### Options

Declare `[[options]]` in the manifest and the plugin gets controls in
**Settings › Plugins**: a switch for `bool`, a choice for `choice`, a text field
for `text`. Read the values from `pulse.options`; a change re-renders. They are
editable whatever the plugin's status, except `invalid`, are stored on the
daemon and shared by every device, and are not part of the hash. A stored value
that no longer fits the manifest's schema falls back to the default.

### Host actions

A host action is a command declared under `[[actions]]` that the plugin may run
on the computer, only on a tap, with `pulse.host.run(id, arg)`.

- It runs like a source: argv, no shell, working directory the plugin folder,
  stdin closed, stderr discarded, killed at `timeout_s`, output capped at 65536
  bytes and never cached. `OMP_PULSE_PLUGIN_ACTION` is set to the action id.
- If the command has an `{arg}` element, `arg` is required, at most 256
  characters with no control characters, and must match `arg_pattern` in full.
  Without `{arg}`, no argument is accepted.
- One action per plugin runs at a time, and actions share the daemon-wide limit
  of 4 concurrent commands.
- It is refused unless the plugin is enabled and its current hash is the one
  that was approved. A command that fails still returns normally, with
  `ok: false`.

### Timing and failures

Renders of one slot are at least 250 ms apart (a request inside the gap is
deferred, not dropped), and none happen while the app is hidden. Source
polling also happens only while the app is visible, about one second after
`interval_s` has elapsed.

A plugin keeps running for 10 seconds after the last slot it declares leaves
the screen, so opening and closing the drawer does not restart it.

A plugin that fails is stopped and shown in Settings as "Stopped on this phone"
with the reason and a **Restart** button: a script error at load, a render
taking longer than 2000 ms, an invalid view three times running, or a message
that is not what `pulse` itself sends. The 2000 ms limit does not count time the
app spends fetching a source reading the renderer is waiting for. A refresh that
shows a different hash starts it afresh. A plugin whose script could not be
downloaded is not failed, just not running yet; it is retried on the next
refresh. Errors about the catalogue shown on a device never include folder
paths from the computer.

## Command line

`omp-pulse plugin <verb>` edits the files directly; a running daemon re-reads
them on each request, so nothing needs restarting. Errors go to stderr with
exit code 1.

| Verb | Does |
|---|---|
| `dir` | Prints the plugins folder. |
| `list [--json]` | One line per plugin: id, version, status (and the reason when invalid). `--json` prints the full records. |
| `check <DIR>` | Validates a folder without installing it: `ok: <id> <version>`, its slots and each source's exact command, a `warning:` line for each file in the folder a command uses, then its permissions (in the words the phone's review uses), claims, actions and options (`action <id>: <argv>` with the `{arg}` pattern under it), or the error (exit 1). |
| `link <DIR>` | Installs the folder by link. Prints `linked <id> <version> -> <dir>`; it stays off until enabled. |
| `unlink <ID>` | Removes the link. |
| `enable <ID> [--yes]` | Prints what `check` prints, then asks before turning it on. `--yes` skips the question for scripts; with no terminal to ask in, enabling needs it. |
| `disable <ID>` | Turns it off. |
| `options <ID> [KEY=VALUE]...` | With no pairs, prints `id = value` for each option (effective values). With pairs, sets them (`true` or `false` for a bool) and prints the result. |
| `skill` | Installs or refreshes the `pulse-plugin` skill and `/pulse-plugin` command in omp's agent directory; see [Ask your agent to write one](#ask-your-agent-to-write-one). |

## Security model

Read this before turning on a plugin you did not write.

- **The script is sandboxed.** It runs in a worker inside a frame with a content
  security policy that allows no network, so `fetch`, `XMLHttpRequest`,
  `WebSocket`, `importScripts` of URLs, dynamic `import`, `eval` and
  `new Function` all fail; a nested worker can start but is held to the same
  policy. It has no storage (`localStorage` and IndexedDB fail), no access to
  the page, and no device credential or native bridge: its origin is `null`. An
  infinite loop cannot freeze the app; the worker is terminated. The example's
  **Sandbox check** card tests this on your own device.
- **Source commands run as the daemon's user.** They are exactly the argv
  shown at review, with no shell, and the script cannot change them: a changed
  command changes the hash and the plugin needs review again. They never see
  the daemon's token, and only a control device can make one run.
- **The hash covers the manifest and the script, nothing else.** A command
  such as `["sh", "probe.sh"]` runs a file in the plugin folder whose contents
  are not part of the hash, so editing `probe.sh` does not send the plugin back
  to review. Prefer commands that name a program and its arguments outright;
  when you approve one that runs a file from the folder, you are trusting that
  folder to stay as it is. `plugin check` and both review screens name every
  such file they can see in a command's argv (not inside a `sh -c` script).
- **A control device can turn plugins on.** A control device can already run
  commands on the computer, so approving a plugin's fixed, displayed commands
  grants it nothing new.
- **Permissions act only on a tap, but they are real.** A plugin with
  `session.prompt`, `session.bash` or `session.rpc` can, once per tap, make
  your agent do something or run a command in a conversation. With
  `session.bash` the script chooses the command: any shell command, on the
  computer, after a tap on anything it drew. The script itself has no network,
  but that shell can reach the network: a plugin with that permission can send
  data out. Grant it only to plugins you trust as you would trust a script.
- **Toasts name their plugin.** A plugin cannot show a notice that passes for
  the app's own, and cannot keep one on screen without your taps.
- **A host action's argument pattern is the only thing between a plugin and the
  command line.** The plugin chooses `{arg}`; the daemon checks it against
  `arg_pattern` in full and nothing else. Keep the pattern tight (a whole
  service name, not `.*`), and avoid an action whose program interprets its
  argument as options or code. Make the pattern start with a letter or digit,
  and put `--` before `{arg}` when the program accepts it, so the argument can
  never be read as an option (the systemd-timers example does both). Review
  shows the argv and the pattern.
- **Claims reveal content.** A plugin that claims tools or messages receives
  those calls' arguments and output, and one with a session slot sees
  conversation titles, folders and models. Review lists both.
- **Review does not stop your own agent.** An agent with a shell on the computer
  can enable a plugin itself with `omp-pulse plugin enable --yes`, or edit the
  decisions file. Review protects against unreviewed or changed plugins, not
  against an agent you already trust with a shell.

## Known limits

- The example's sources (`/proc/loadavg`, `/proc/meminfo`) are Linux-only. On
  macOS, Windows and Android phone mode the plugin shows "host usage
  unavailable" rather than failing.
- A plugin's worker has no memory cap; only the time limit above and
  termination guard it.
- The `systemd-timers` example is Linux with systemd user units only; the
  `provider-usage` example needs an omp that has `omp usage`.
- A second tap within 3 seconds replaces the first tap's unused grant, so a
  handler that waits before acting may act on the later tap's conversation.
- A keyed slot over its cap drops the view of its least recently shown item
  rather than refusing the new one.
- List item ids are capped at 64 characters. The `systemd-timers` example uses
  the service name as the id, so it leaves out services whose names are longer
  (a cut name would no longer match its action's pattern).
