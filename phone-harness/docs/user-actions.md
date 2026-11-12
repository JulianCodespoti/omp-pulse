# User actions ledger

Every time the agent needs the user to do something on the phone (tap, grant, unlock, open an app, pair, enter a code), it records it here together with the route that lets the agent do it itself next time. Check this file before asking. Rule: `agent/AGENTS.md` "User actions".

How to use it:
- Before asking: search the table for the action. Status **automated**: use the route, do not ask.
- After asking: add a row (or update the existing one) and commit it at once; other sessions edit this file too.
- In the same task, build a route (an `android` subcommand, a script, a shell-tier call); when only a native omp-pulse change can add one, tell the user which change. When it lands, flip the status and say how to use it.
- Rows describe this phone; the file starts empty on every install and upstream updates never add rows.

Status: **automated** (use the route, do not ask), **user-only** (Android forbids automation, e.g. security prompts and special-access grants; ask and say why), **requested** (native omp-pulse change needed: name it), **open** (no route yet: build one).

| Date | Action | Why it was needed | Route | Status |
|---|---|---|---|---|
| _Example:_ YYYY-MM-DD | Grant "Control the screen" (accessibility) under omp-pulse Settings > Phone access | `android ui` commands failed with "accessibility service is off" | None: Android lets only the user enable accessibility services | user-only |
