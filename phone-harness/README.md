# phone-harness

The omp agent's own harness on an Android phone running omp-pulse: global instructions, skills, the
`android` CLI and helper tools, in a git repo the agent can edit. omp-pulse ships it inside the APK
as a seed and keeps it at `/root/projects/phone-harness` in the app's Alpine guest. Everything here
must work on any arm64 Android phone; tools that need a particular OEM or app check for it and say
when they do not apply.

## What the app wires up
Only phone mode (the app running omp itself) uses the harness, and only while **Phone tools for the
agent** is on (omp-pulse Settings > Phone access). It is off for new installs; installs that already
had the harness from an earlier version keep it on. Connecting the app to a daemon on another
machine installs nothing.

With it on, before every start of the phone's local daemon (and right away when the switch is
turned on), omp-pulse seeds or upgrades the harness repo, links into the guest and starts the phone
API that `android` talks to:
- `/root/.omp/agent/AGENTS.md` → `agent/AGENTS.md` (loaded in every session)
- `/root/.omp/agent/skills` → `agent/skills`
- `/root/.omp/agent/.env` → `agent/env` (toolchain environment)
- `/root/.omp/agent/extensions/heavy-jobs.ts` → `agent/extensions/heavy-jobs.ts`
- `/usr/local/bin/android` → `bin/android`, and `/usr/local/bin/{cargo,node,npx,gradle}` → `bin/shims/*`
  (`.env`, the extension and the shims only when free or already pointing into the harness)
- MCP server `phone` (`bin/phone-mcp`) in `/root/.omp/agent/mcp.json` when absent.

The app records what it created in `/root/.config/omp-phone/harness-links.json`. Turning the switch
off stops the phone API and removes exactly those links, and the `phone` MCP entry if it is unchanged;
files of the user's own and the harness repo with its commits stay. Nothing is seeded while it is off.

It also writes `/root/.config/omp-phone/endpoint.json` (phone API and daemon URLs, package,
native library dir), `/root/.config/omp-phone/device.json` (manufacturer, model, Android version,
ABI, RAM) and the token next to them; harness tools read these instead of fixed ports or `getprop`
(not available in the guest).

## Layout
| Path | What it is |
|---|---|
| `AGENTS.md` | Rules for changing the harness (read before editing) |
| `agent/AGENTS.md`, `agent/skills/` | Instructions and skills |
| `bin/android` | Phone access over the app's authenticated loopback phone API: status, apps, intents, clipboard, screenshots, UI automation, installs, `doctor` |
| `bin/phone-mcp` | Persistent MCP server `phone`: `observe`/`act` (stable refs, change diffs, batched steps with an `expect_package` guard), `status`, `apps`, `screenshot`, `clipboard` |
| `bin/heavy`, `bin/lane`, `bin/mem-guard`, `bin/shims/`, `agent/heavy-jobs.json`, `agent/extensions/` | Build/test broker: admission by memory and CPU, shared identical runs, optional all-core shell lane, guard against low-memory kills |
| `bin/shell-tier` | Optional Android shell user over loopback adb (app, role and network control; needs Wireless debugging and `apk add android-tools`) |
| `bin/asr-setup` | Rebuild local dictation |
| `bin/phone-bench` | Read-only latency baseline |
| `docs/user-actions.md` | Ledger of what the user had to do by hand and the route the agent built to do it itself (empty on install) |
| `tests/` | `python3 -m unittest discover -s tests` |

## Change the agent
1. In omp-pulse: New session, folder `projects/phone-harness`.
2. Ask for the change in plain words ("add a skill that ...", "make `android` able to ...").
3. The agent edits, tests and commits. Start a new session to get the new instructions.

History and rollback: `git log --oneline`, `git revert <commit>` in `/root/projects/phone-harness`.

Native changes to omp-pulse (new phone API endpoints, permissions, UI) cannot be made on the phone:
the agent tells you what change would be needed, for the omp-pulse project or your own checkout.

## Upgrades
The harness upstream is the `phone-harness/` directory of omp-pulse. On each app update the app commits
the new seed to branch `upstream` and merges it into the checked-out branch. Local changes survive;
for a file changed on both sides the local version is kept and the path is listed as a conflict
in `/root/.config/omp-phone/harness-seed.json`. `android doctor` shows the merge state and what an
update broke (links, `phone` MCP registration, dictation runtime); ask the agent to merge upstream
changes into conflicted files (procedure in `AGENTS.md`).

## Extend it upstream
Changes for every phone go into `phone-harness/` in the omp-pulse repository; the APK build packs that
directory into the seed (`packageHarnessSeed` in `mobile/android/app/build.gradle`, which skips
`tests/` and caches). Everything shipped here must work on any arm64 Android phone with only public
inputs: the app's phone API, Alpine packages, and adb over Wireless debugging when the user turns it
on. Tools that need a particular OEM or app check for it and say when they do not apply. Add tests
under `tests/` and run `python3 -m unittest discover -s phone-harness/tests` from the repository root.
