# extensions/

The omp extensions and the omp skill the daemon carries. The omp
extensions are TypeScript loaded by omp itself through its extension API; the
daemon embeds their source at compile time with `include_str!`, so a binary
always ships the version it speaks to and an edit here needs a Rust rebuild.
The skill is Markdown, embedded the same way.

## `omp-pulse-child.ts`: inside the daemon's own children

Phone-only parity with the omp TUI for the `omp --mode rpc-ui` children the
daemon spawns. omp's RPC protocol has no plan mode, no in-place tree navigation,
no entry labels and no `!!` (bash kept out of the model's context); this
extension exposes each as a slash command the daemon sends as an RPC `prompt`
(`/pulse-plan`, `/pulse-goto`, `/pulse-label`, `/pulse-bash`) and replies
through `setStatus` UI frames that the daemon intercepts and never forwards.

- Embedded by `src/omp/child/extension.rs`, which writes it to
  `<state_dir>/child-extension/` (atomically, versioned per build) and passes it
  with `-e` to each child it spawns.
- Never installed into the user's own omp.
- `/pulse-command-templates` exposes loaded project template metadata without
  copying template bodies. `/pulse-bash` uses the configured user shell for both
  context-including and context-excluding execution, with piped output.
- Exact queue snapshots, removal and promotion share `pulse-queue.ts`. The daemon
  materialises its content-addressed support file before the child entrypoint;
  unsupported owner methods fail explicitly rather than falling back to text.

## `omp-pulse-control.ts`: inside the desktop omp

The desktop bridge and desktop controls. It runs inside the user's own omp
process, the only process allowed to write its session file, and serves a
loopback endpoint: `GET /events` streams the agent's own events to the daemon,
`POST /control` accepts prompts, steers, aborts, renames and model and
reasoning changes, executed through omp's API. The phone therefore never
becomes a second writer. How this fits the other live paths is in
[docs/internals/desktop-integration.md](../docs/internals/desktop-integration.md).

- Embedded by `src/omp/desktop_control.rs` and installed into omp's agent
  directory (`extensions/`) by `omp-pulse setup` and
  `omp-pulse desktop-control install`. The installer respects omp's agent
  directory and profile configuration and refuses to overwrite a file that does
  not carry its managed marker.
- The installer writes the same queue support module under the private,
  content-addressed `pulse-support/` directory outside extension autodiscovery,
  then installs the entrypoint with its matching import. Existing unequal
  content-addressed files are refused, not overwritten.
- The source contains the placeholder `__OMP_PULSE_STATE_DIR_JSON__` exactly
  once. The installer replaces it with the daemon's state directory as a JSON
  string literal, which is how the extension finds the daemon; an embedded
  source with any other count of placeholders is refused.

## `pulse-plugin/`: a skill for writing plugins

Teaches the user's own omp to write, check and link an omp-pulse plugin (see
[docs/user/plugins.md](../docs/user/plugins.md)). Not an extension: no code
runs in omp. It is `SKILL.md` (the workflow and the rules that commonly fail
`plugin check`) and `command.md` (the `/pulse-plugin <idea>` slash command).

- Embedded by `src/plugins/skill.rs` and installed into omp's agent directory
  as `skills/pulse-plugin/` and `commands/pulse-plugin.md` by `omp-pulse setup`
  and `omp-pulse plugin skill`. A starting daemon refreshes them only when they
  are already installed. New omp sessions pick them up; running ones need
  restarting.
- The installer refuses to replace a file that lacks its managed marker (a YAML
  comment in the frontmatter of each file), so a skill or command of the same
  name that you wrote yourself is left alone.
- It also writes, next to `SKILL.md`, `reference.md` (a verbatim copy of
  `docs/user/plugins.md`, so the reference cannot drift from the docs) and
  `examples/<id>/` with the manifest and script of each of the example plugins
  `host-usage`, `provider-usage` and `systemd-timers`. `SKILL.md` therefore
  keeps only the workflow and the rules that most often fail `plugin check`,
  and points at `reference.md` for everything else.

## Tern

There is no Tern plugin or helper. The existing bridge (`omp-pulse-control.ts`)
works in a Tern pane when loaded; otherwise enable `collab.autoStart: control` or
run `/collab` once, and Pulse adopts the active host (see
[docs/user/configuration.md](../docs/user/configuration.md#tern)).

## Tests

`extensions/test/*.test.mjs` run under `node --test` (the gate's "extension and
tooling tests" step) and import the extension source directly:

```sh
node --test "extensions/test/*.test.mjs"
```

End-to-end coverage with a real omp is in `e2e/omp/verify-bridge.mjs`,
`e2e/omp/verify-desktop-control.py` and `e2e/browser/verify-plan-tree.mjs`. Tern
adoption is covered by `e2e/omp/verify-tern-adoption.py` (see
[e2e/README.md](../e2e/README.md)).
