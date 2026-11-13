---
name: pulse-plugin
description: Build, check and install an omp-pulse plugin, a small sandboxed script that draws chips, rows, cards, a page or a tab in a chat's workspace in the omp-pulse phone app. Use when the user asks for a Pulse plugin, phone widget, chip, drawer panel, menu item, page, workspace tab or transcript card for omp-pulse, or wants to show host command output or run a host action from the phone.
# omp-pulse managed skill: omp-pulse rewrites this folder; local edits are lost
---

# Writing an omp-pulse plugin

A plugin is a folder on the computer that runs the omp-pulse daemon, holding a
manifest (`pulse-plugin.toml`) and one script (`client.js`). The phone app runs
the script in a sandboxed worker and draws the declarative nodes it returns. The
script has no DOM, no CSS, no network and no storage. Host commands run as
`[[sources]]` (read-only polling) or `[[actions]]` (run on a tap) that the
manifest declares, and the daemon runs them. With the `session.bash` permission
the script itself chooses a shell command and runs it on the computer, in the
conversation's folder, after any tap on something it draws: ask for it only when
a declared action cannot do the job. The user reviews the plugin and switches
it on; you cannot and must not do that for them.

## First, read

1. `skill://pulse-plugin/reference.md`: the full manifest rules, script API,
   node kinds, per-slot limits and security model. It is the source of truth;
   this file only summarises the workflow.
2. The closest example under `skill://pulse-plugin/examples/<id>/`
   (`pulse-plugin.toml` and `client.js`):
   - `host-usage`: sources read with `pulse.source`, a drawer, a composer chip
     and a page opened from the chip. Start here when unsure.
   - `provider-usage`: `session.read` permission, `choice` and `bool` options,
     and the `omp` program name in a source command.
   - `systemd-timers`: a list that runs a host action on tap with `{arg}` and
     `arg_pattern`, plus a bool option.

## Slots

`composer.status` chip(s) beside the composer; `composer.actions` rows in the
plus sheet; `drawer` a few chips, text, progress bars; `page` a full page opened
from a chip or button; `workspace` a page in the chat's workspace drawer, shared
as one Plugins tab after Terminal; `session.row` chips on a conversation's row
in Chats; `session.menu` rows in a conversation's actions menu;
`transcript.tool` a card replacing a claimed tool call's body (needs `tools`);
`transcript.message` the same for custom messages (needs `messages`).

## Workflow

1. Clarify what to show, from what, and where. Map it to slots, and ask only if
   the request leaves that open. Prefer one or two slots.
2. Create the plugin in its own folder outside the plugins folder:
   `~/pulse-plugins/<id>` unless the user names a place. Never write into the
   folder `omp-pulse plugin dir` prints; `link` is the install step.
3. Write `pulse-plugin.toml` and `client.js`, starting from the closest example.
   Ask for the fewest permissions, sources and actions that do the job, and
   prefer a command that names a program and its arguments outright over a
   script in the folder (the hash does not cover other files).
4. Run `omp-pulse plugin check <folder>` and fix what it reports until it prints
   `ok: <id> <version>`. Read the slots, commands and actions it lists back
   against what you meant. `check` validates the manifest and that the script
   file loads; it does not run the script, so reread the script against the
   node and slot limits in the reference.
5. Run `omp-pulse plugin link <folder>`. The plugin stays off.
6. Hand over. Tell the user to open Settings, then Plugins, in the phone app (or
   run `omp-pulse plugin enable <id>` in their own terminal), read the commands
   and permissions shown, and switch it on. Do NOT run `omp-pulse plugin enable`
   yourself: switching on is the user's review.

Any later edit to the manifest or `client.js` changes the hash and sends the
plugin back to review, so batch your changes and tell the user when it needs
reviewing again. If `omp-pulse` is not on PATH, the daemon's binary is usually
`~/.local/bin/omp-pulse`. Other verbs: `plugin list`, `unlink <id>`,
`disable <id>`, `options <id> [KEY=VALUE]...`.

## Rules that bite

- Manifest: `schema = 1`; unknown keys are rejected; `client` is a bare file
  name inside the folder, at most 262144 bytes, UTF-8.
- `id` matches `^[a-z0-9][a-z0-9._-]{0,63}$`. Source, option and action ids
  match `^[a-z0-9][a-z0-9_-]{0,31}$` (no dot). `name` 1 to 64 characters,
  `version` 1 to 32, `description` at most 200.
- `tools` (at most 16 claim patterns) is required exactly when `slots` has
  `transcript.tool`, and rejected otherwise; `messages` likewise for
  `transcript.message`. A claim is 1 to 64 characters of `A-Z a-z 0-9 _ . : / -`
  and `*`.
- Limits: at most 8 sources, 8 actions, 16 options. Source `interval_s` 2 to 3600
  (default 30), `timeout_s` 1 to 30 (default 5); action `timeout_s` 1 to 120.
  Output is cut at 65536 bytes.
- A source or action `command` is an argv array, never a shell line. No control
  characters in any string. A program named exactly `omp` runs the daemon's omp.
  Sources run only when a device asks and the cache is older than `interval_s`;
  always check `reading.ok`.
- An action's `command` may contain `{arg}` as one whole element, at most once;
  then `arg_pattern` is required (at most 200 characters, Rust regex, matched
  against the whole argument), otherwise it is rejected. Keep the pattern
  tight, start it with a letter or digit, and put `--` before `{arg}` when the
  program accepts it. The argument is at most 256 characters.
- Options: `bool`, `choice` (needs `choices`, 1 to 20) or `text`; read them from
  `pulse.options`.
- Acting needs a tap: `pulse.composer.insert`, `pulse.session.prompt`,
  `pulse.session.bash`, `pulse.session.rpc` and `pulse.host.run` each use up
  one fresh tap (at most 3 seconds old), so one tap does one thing, and each
  needs the matching permission or declared action. Without a tap they resolve
  `{ ok: false, error }`. The phone also asks the computer whether the plugin is
  still switched on and unchanged before each one.
- `pulse.session.prompt` sends a message (skills and prompt templates included).
  It refuses a leading `!` (that is `session.bash`), a built-in command (that is
  `session.rpc`), and anything that opens a sheet or app screen (`/btw`,
  `/goal`, `/plan`, `/settings`, ...). For a conversation that is not open, it
  refuses every slash command.
- Without `session.read`, `ctx.session` is `null` except in `session.row` and
  `session.menu`.
- Views: a slot has a node, depth and kind limit (for example `composer.status`
  holds at most 4 nodes, chips only; `composer.actions` and `session.menu`
  need a `list` with `actions.click`). Over a limit, the view is rejected.
  Chip text is cut at 48 characters, button text at 32. Return `null` for
  "show nothing".
- A renderer that takes over 2000 ms, or returns an invalid view three times
  running, stops the plugin.
- UI strings: British English, no emoji. Be terse; a chip is a few words.
