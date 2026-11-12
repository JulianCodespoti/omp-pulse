# End-to-end suites

Every suite here runs against a throwaway daemon that its own run starts. They
spawn real `omp` children (about 280 MiB each) and some make real model calls,
so they are slow, load-sensitive and never part of `cargo test`. Where these
suites sit among the project's other tests, and which ones the gate runs, is in
[docs/contributing/testing.md](../docs/contributing/testing.md).

## Rules

1. **Only through the harness.** `e2e/run.sh` wraps every suite in
   `e2e/with-test-daemon.sh`; if you run a suite by hand, wrap it yourself. Never
   point a suite at a daemon you did not start: the conventional port of a real
   daemon, 7682, is refused, and a suite must fail with a clear message rather
   than fall back to a real token when the harness variables are missing. A
   suite that once reached a real daemon delivered its test prompts into a live
   conversation.
2. **Never touch real sessions.** Nothing here may write under
   `~/.local/share/omp/sessions`; omp rewrites session files wholesale, so a
   second writer destroys history.
3. **Run them alone.** A concurrent `cargo build` or a second suite causes
   failures that look exactly like regressions. `e2e/run.sh` runs suites one at
   a time for this reason.

## Tiers

A tier is a directory of suites grouped by what running them needs. Each tier
needs everything the one above it needs.

| Tier | Needs | In the gate |
|---|---|---|
| `daemon/` | a release build with the web client embedded, `curl`, `python3` (with `websockets` for the smoke suite), Node.js | default |
| `omp/` | also `omp` on PATH with a model provider configured; laptop handoff also needs `herdr`; the Tern suite needs Linux, `tern`, `xvfb-run`, `Xvfb` and usable GL or software rendering, not model credentials | `--full` |
| `browser/` | also Chromium and `npm ci` in `web/` (provides puppeteer-core and vite); several suites spawn an omp child or make model calls | `--full` |
| `android/` | also the Android SDK, an AVD and JDK 21; see the header of `e2e/with-emulator.sh` | `--full` |

Build first:

```sh
(cd web && npm ci && npx vite build --base=./ --outDir ../public/app --emptyOutDir --sourcemap false)
cargo build --release
```

## Running

```sh
e2e/run.sh daemon                         # every suite in e2e/daemon/
e2e/run.sh omp browser android            # several tiers, in that order
e2e/run.sh e2e/browser/verify-send.mjs    # one suite
```

`e2e/run.sh` finds every `*.mjs` and `*.py` directly in a tier directory, runs
it with `node` or `python3` under `e2e/with-test-daemon.sh` (android suites also
under `e2e/with-emulator.sh`), prints one line per suite and the tail of the
output of any that failed. Unit tests of the suites' own helpers
(`*.test.mjs`, `test_*.py`) are skipped here; the gate runs them separately.

To run one suite by hand, wrap it the same way:

```sh
e2e/with-test-daemon.sh python3 e2e/daemon/pulse-smoke.py
e2e/with-test-daemon.sh e2e/with-emulator.sh node e2e/android/verify-native.mjs
```

Two further scripts are not suites:

- `e2e/fresh-install.sh [path-to-binary]` runs the built binary against a
  pristine `HOME` with no config, token, state or checkout, proving a stranger
  can use it. The default gate runs it.
- `e2e/with-emulator.sh` boots or reuses an emulator, installs a debug APK
  pointed at the test daemon over `adb reverse`, then runs its command. It must
  run inside `e2e/with-test-daemon.sh`.

## What the harness isolates

`e2e/with-test-daemon.sh` starts `target/release/omp-pulse` with its own:

- port (`OMP_PULSE_TEST_PORT`, default 7699; 7682 is refused);
- token, state directory and sessions root, all under a temporary directory
  deleted afterwards, so `/api/sessions` sees only sessions this run creates and
  the collab link registry, push store and VAPID keys are throwaway;
- `XDG_RUNTIME_DIR`, because omp hosts publish collab announcements under
  `$XDG_RUNTIME_DIR/omp/collab`, and a suite writing one into the real
  directory would land beside the developer's live hosts;
- named herdr session (`HERDR_SESSION`) and herdr config. Never isolate herdr
  with `HERDR_SOCKET_PATH` alone;
- plugins folder (`OMP_PULSE_PLUGINS_DIR`), and `OMP_PULSE_SKIP_SKILL_REFRESH`,
  because omp's agent directory stays real (its sign-ins live there) and a
  starting daemon would otherwise rewrite the developer's installed
  `pulse-plugin` skill with this checkout's copy.

It also unsets the terminal-integration variables (`HERDR_PANE_ID`, `TERN_PANE`,
`TERN_WINDOW_KEY` and friends), because a fixture inheriting the developer's pane
once made the daemon type `/collab` into a live conversation. Tern is isolated
with a private `TERN_CONFIG_DIR` and `TERN_DAEMON_SOCKET` under the temporary
directory; unsetting the socket alone would fall back to the developer's real
daemon. `XDG_DATA_HOME` stays real, or omp's native addon fails to load.

It exports `OMP_PULSE_TEST_BASE`, `OMP_PULSE_TEST_WS`, `OMP_PULSE_TEST_TOKEN`,
`OMP_PULSE_TEST_STATE_DIR`, `OMP_PULSE_TEST_SESSIONS`, `OMP_PULSE_TEST_TMP`,
`OMP_PULSE_TEST_HERDR_SESSION` and `OMP_PULSE_TEST_DAEMON_PID` to the suite.
Fixture session `cwd`s must exist on disk, or omp cannot switch into them.

## Overrides

Machine-specific inputs are resolved in one place, the header of
`e2e/lib/env.mjs`:

| Variable | Meaning | Default |
|---|---|---|
| `OMP_PULSE_CHROMIUM` | browser executable | puppeteer's, else `/usr/bin/chromium` |
| `OMP_PULSE_PUPPETEER` | puppeteer module file | `web/node_modules` |
| `OMP_PULSE_WS` | `ws` module file | `web/node_modules` |
| `OMP_PULSE_OMP_MODULES` | an omp checkout's `node_modules` to borrow puppeteer-core and ws from | unset |
| `OMP_PULSE_E2E_APP` | `embedded` (the daemon's `/app/`) or `vite` (a dev server over `web/src`) | `vite` when mise is on PATH, else `embedded` |
| `OMP_PULSE_TEST_MODEL` | `provider/id` for suites that make model calls | a cheap model the test daemon's omp offers |
| `OMP_PULSE_TEST_REQUIRE_TERN` | `1` turns the Tern suite's named SKIP (missing optional prerequisite) into a failure | unset: skip and exit 0 |

The emulator's overrides (`ANDROID_SDK_ROOT`, `OMP_PULSE_EMU_AVD`,
`OMP_PULSE_EMU_PORT`, `ANDROID_AVD_HOME`, `OMP_PULSE_JDK`) are in the header of
`e2e/with-emulator.sh`.

## Shared helpers (`e2e/lib/`)

- `env.mjs`: the overrides above, `loadPuppeteer()`, `chromium()`,
  `startWebApp()`, `testModel()`.
- `browser-pairing.mjs`: `openPairedPage()` pairs a page by seeding the token
  into `localStorage` before the app boots, so the token never enters a URL.
- `ui-probe.mjs`: contrast, tap-target, clipping and overflow probes, shared by
  `verify-a11y.mjs` and the UI state capture.
- `ux-fixture.mjs`: the synthetic session corpus used by several browser suites,
  the UI state capture and the review daemon.
- `jump-latest.mjs`: the jump-to-latest gesture used by the navigation suites.
- `file-write-validation.py`: file-write checks the smoke suite runs.

## Suites

"Model" is whether a suite makes real model calls (they cost money and need
`OMP_PULSE_TEST_MODEL` or a configured provider). Each suite's header comment
says what it proves and why; exit code is the number of failures.

| Suite | Tier | What it proves | Model |
|---|---|---|---|
| `pulse-smoke.py` | daemon | REST + WebSocket smoke: API, lazy spawn, watcher, RPC, file writes; skips and names live-child checks without omp | no |
| `verify-answer-loop.mjs` | daemon | every rejection branch of `POST /api/panes/answer` | no |
| `verify-collab-authority.mjs` | daemon | collab host protocol over real encrypted sockets and daemon routes | no |
| `verify-issue-regressions.py` | daemon | provider-free HTTP smoke: project-scoped search, no HOME fallback and 404 downloads, resume targets, Git conflicts, withdrawn-queue journal replay and acknowledgement | no |
| `verify-session-discovery.mjs` | daemon | real filesystem events reach the listing WebSocket with no polling | no |
| `verify-bridge.mjs` | omp | the desktop bridge makes a desktop conversation live on the phone with the desktop omp as the only writer | yes |
| `verify-desktop-control.py` | omp | real omp TUI plus the control extension: model and settings changes persist | no |
| `verify-tern-adoption.py` | omp | Tern adoption of existing hosts with real Tern and omp, no helper: manual share then stop is refused, an unshared owner is refused without typing, focus or GUI launch (an unsent draft stays unchanged), an active exact owner is adopted | no |
| `verify-laptop-handoff.mjs` | omp | "Open on laptop" moves a conversation into a herdr tab, starting herdr when safe; busy refusals | yes |
| `verify-notify-e2e.mjs` | omp | a finished turn reaches a subscribed phone | yes |
| `verify-stop.mjs` | omp | Stop interrupts a turn promptly | yes |
| `verify-a11y.mjs` | browser | contrast, touch-target size and clipped text across the main surfaces | no |
| `verify-agent-transcript.mjs` | browser | a real subagent's reply is readable from the Agents tab | yes |
| `verify-batch-pills.mjs` | browser | identical prompts in flight get one status card per row | no |
| `verify-branch.mjs` | browser | rewinding from the Tasks tab's timeline creates and opens the new session | no |
| `verify-chrome.mjs` | browser | app chrome does not bury or crowd the transcript | no |
| `verify-collab-announce.mjs` | browser | zero-link collab announcements: validation, persistence, background attach | no |
| `verify-command-shapes.mjs` | browser | each slash command keeps its laptop shape: pickers open their tab, builtins print into a sheet, drills reveal their subcommands | yes |
| `verify-commands.mjs` | browser | slash commands keep their laptop shapes on the phone | no |
| `verify-compact.mjs` | browser | `/compact` answers in the compaction row without a confirmation, as in the terminal | yes |
| `verify-composer-busy-enter.mjs` | browser | Enter keeps a busy draft; Stop still works (no daemon traffic) | no |
| `verify-composer-input.mjs` | browser | held keys do not outrun the composer | no |
| `verify-composer-parity.mjs` | browser | composer parity with the omp TUI editor against a real child: two tiers, Send disabled when empty, `!cmd` in the Terminal tab | no |
| `verify-composer.mjs` | browser | drafts survive quick session switches, and two related composer faults | no |
| `verify-double-send.mjs` | browser | a double tap sends once | no |
| `verify-draft-race.mjs` | browser | Send inside the autosave window leaves no stale draft | yes |
| `verify-edge-feel.mjs` | browser | visible opening frames stay pinned, delayed history never pulls back, and dead-link waiting and indicator identity remain clear (link checks require embedded mode) | no |
| `verify-features.mjs` | browser | the client's core surfaces (collapsed work groups, reasoning disclosure, command labels and output sheets, projects, slash palette, long-press sheet, image prompts, day separators, no overflow, settings), each its own named check; fails on any page error or `console.error` | no |
| `verify-history-autoload.mjs` | browser | earlier history loads by itself on scroll-up | no |
| `verify-image-stash.mjs` | browser | per-session attachment trays survive a switch and back | no |
| `verify-projects.mjs` | browser | the drawer lists folders as projects, a folder opens only its chats, and New chat there arrives with it chosen | no |
| `verify-link-state.mjs` | browser | cutting the network raises the connection banner in the drawer, keeps its chats, and clears by itself when the link returns | no |
| `verify-lazy-recovery.mjs` | browser | failed screen downloads recover through a draft-safe reload; Back and failed storage preserve unsent input | no |
| `verify-live-agents.mjs` | browser | the Agents tab shows desktop-agent messages and tool activity | no |
| `verify-markdown.mjs` | browser | the lazily loaded markdown layer and restricted grammar set | no |
| `verify-model-picker.mjs` | browser | `/model` opens a searchable picker fed by a live child | no |
| `verify-nav-paging.mjs` | browser | history paging and the way back to the live edge | no |
| `verify-nav.mjs` | browser | the jump control's "latest" gesture lands accurately | no |
| `verify-open-scroll.mjs` | browser | a long chat opens at the newest message without travelling, and a reader who left the end is not pulled back | no |
| `verify-omp-surfaces.mjs` | browser | todo lists, desktop `!cmd` runs and other wire data are visible | no |
| `verify-outbox-storage.mjs` | browser | outbox locks and IndexedDB transactions in real Chromium (no daemon traffic) | no |
| `verify-owned-session.mjs` | browser | the phone against a session a terminal omp owns | no |
| `verify-partial.mjs` | browser | a session file's unterminated tail renders as a provisional row | no |
| `verify-plan-tree.mjs` | browser | plan mode, tree moves, labels and `!!` through the child extension | yes |
| `verify-plugin-slots.mjs` | browser | plugin slots and tap rules: review facts, options, row chips, conversation menus, composer actions, tool and message cards, host action refusals | no |
| `verify-plugins.mjs` | browser | plugins: review and enable, drawer and page slots, sandbox isolation probes, runaway and changed plugins | no |
| `verify-queue.mjs` | browser | queued follow-ups show as removable chips | yes |
| `verify-reliability-transitions.mjs` | browser | cross-layer reliability transitions | yes |
| `verify-resync-turn.mjs` | browser | a turn whose end frames were dropped still ends on screen | yes |
| `verify-send.mjs` | browser | the primary journey: create a session, send, get a reply | yes |
| `verify-session-actions.mjs` | browser | every session-sheet action does its job | no |
| `verify-shared-drafts.mjs` | browser | two views of one conversation do not overwrite a saved draft | no |
| `verify-small-parity.mjs` | browser | `/context`, `/todo`, slow mode and other small parity surfaces | yes |
| `verify-sockets.mjs` | browser | both live sockets, `/ws` and `/ws/sessions`, connect and speak | no |
| `verify-surfaces.mjs` | browser | session search, the Files tab and the timeline in the Tasks tab | no |
| `verify-switch-landing.mjs` | browser | in-chat session switches land at the bottom; the switcher lists the open chat first, then the list order | no |
| `verify-sync.mjs` | browser | sync fundamentals: paging, polling budget, optimistic echo | no |
| `verify-tool-images.mjs` | browser | `blob:sha256:` images resolve through the authenticated fetch | no |
| `verify-transcript-content.mjs` | browser | every content kind omp emits renders | no |
| `verify-warm-tail.mjs` | browser | the warm tail paints and the authoritative page keeps the reader's place | no |
| `verify-windowing.mjs` | browser | the transcript holds a bounded window into the file; an evicted span reloads by itself | no |
| `verify-answer-intent.mjs` | android | a notification tap opens the chat with the answer sheet | no |
| `verify-native.mjs` | android | everything only the Android shell has: bridge, plugins, permissions, deep links, predictive Back, native outbox, notifications and bubbles | yes |

`verify-native.mjs` uses a debug-only loopback endpoint and never changes the
release endpoint. Its predictive-Back swipes need a navigation bar
(`hw.mainKeys=no` in the AVD config); WebView screenshots stay in the proof
directory the runner prints.

Run the Tern suite with `e2e/run.sh e2e/omp/verify-tern-adoption.py`. It is Linux
only and needs `tern`, `xvfb-run`, `Xvfb`, `omp` and GL or software rendering (it
launches a real private Tern GUI under Xvfb); each missing prerequisite prints a
named `SKIP` and exits 0. Set `OMP_PULSE_TEST_REQUIRE_TERN=1` (for example in a
gate that must prove Tern) to make the skip a failure. Cases: manual old share then
stop (refused, no stale link), unshared refusal, active adoption, draft unchanged
and no extra GUI launched. It installs no plugin and makes no model calls.

## Known failures

Checks that fail because the product is wrong, not the suite. Each entry goes
when the bug is fixed; until then `scripts/ci.sh --full` reports them.

- `verify-laptop-handoff.mjs` needs `herdr` on PATH; without it the suite stops
  at the first herdr call.

## Adding a suite

1. Pick the tier by the most demanding thing the suite needs.
2. Add `e2e/<tier>/verify-<name>.mjs` (or `.py`). `e2e/run.sh` picks it up; there
   is nothing to register.
3. Start with a header comment: what it proves, why it exists (name the bug),
   and whether it makes model calls.
4. Read `OMP_PULSE_TEST_BASE`, `OMP_PULSE_TEST_TOKEN` and friends from the
   environment; if they are missing, print `run through e2e/with-test-daemon.sh`
   and exit non-zero. Pair browser pages with `openPairedPage()`. Exit with the
   number of failed checks.
5. Put helpers shared by more than one suite in `e2e/lib/`. The gate runs the
   `test_*.py` files in `e2e/daemon/` as unit tests of the suites' own helpers
   (today `test_pulse_smoke.py`); nothing discovers tests elsewhere in `e2e/`.
