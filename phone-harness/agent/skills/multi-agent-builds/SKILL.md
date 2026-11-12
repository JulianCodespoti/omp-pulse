---
name: multi-agent-builds
description: Use when running several subagents or worktrees that build or test on the phone, so verification does not queue for hours.
---

# Many agents, one phone

Agents are cheap: the model runs remotely. The phone is not: the app gets only some of its cores
(`Cpus_allowed_list` in `/proc/self/status`), RAM is shared with Android and swap is often full.
When many agents each run full gates, a seconds-long build can wait tens of minutes and queued jobs
die of timeouts. `bin/heavy` schedules every heavy job; your part is to ask it for less work.

## Rules for every worker brief
- Iterate with the narrowest check: `cargo check`, one `cargo test <filter>`, the test
  files that import what you changed, one e2e scenario. Never the full suite or e2e
  sweep from a worker unless that is the task.
- Full gates (all tests, clippy, release build, e2e) run once per integration batch, by
  the one integrating agent. Identical gate commands on the same tree are shared
  automatically, so a second agent asking gets the same run, not a new one.
- No `flock`, `-j1`, `nice` or hand-rolled queues: the broker handles admission, and
  your `timeout` counts from start. Give real run-time limits, not queue guesses.
- Start long jobs with `async: true` and keep working; never sleep-poll.

## Integration batch (integrating agent)
1. Collect the ready branches; merge them together onto the integration worktree.
2. Run the gates once. Green: land all. Red: split the batch in halves to find the
   culprit, send it back to its worker, land the rest.
3. Do not start a new full gate while one for the same tree is queued or running.

## Worktrees and caches
- Prefer reusing a worktree (`git switch`) over a new one: each new `target/` rebuilds
  the workspace crate. Dependencies come from sccache (cargo shim), shared by all.
- Keep one set of flags per repo: flipping `RUSTFLAGS`, `--release` or
  `CARGO_PROFILE_*` between runs rebuilds every dependency.
- Delete worktrees you are done with (`git worktree remove`); check free space with `df -h /root`.

## All-core lane
- Android often confines the app to a background cpuset with fewer cores than the phone has. When the
  shell tier is up (`shell-tier status`), the broker runs side-effect-free cargo test/check/clippy,
  `node --test` and `tsc --noEmit` lines in `bin/lane` instead: a copy of the toolchain and of the git tree in
  /data/local/tmp/omp-lane, run as the shell user on all cores.
- Builds whose output you use (`cargo build`, vite build, gradle) always run here.
- The lane copies the working tree (not `.git`, not `target/`) before each run (~1 s when little
  changed). A test that reads files outside its repo or needs git history fails there: rerun it with
  `HEAVY_LANE=off`. Stale `node_modules` copy after a hand edit inside it: `bin/lane clean <repo>`.
- After a reboot the lane falls back to local until the user turns Wireless debugging on again and
  `shell-tier connect` runs.

## Seeing the queue
- `bin/heavy status`: running jobs with memory now vs predicted, queued jobs and waits.
- `bin/heavy history -n 30`: outcome, wait, run time and peak memory per job.
- Wait consistently above run time means too much heavy work is in flight, not too many
  agents: cut what workers verify, not how many think.
- `HEAVY=off` runs one command outside the broker (debugging only);
  `HEAVY_NO_CACHE=1` forces a rerun of a cached pass.
- Project-specific heavy scripts: add rules to `<repo>/.omp/heavy-jobs.json`
  (`{"rules": [{"id": "...", "class": "browser", "re": "scripts/run-e2e\\.sh"}]}`;
  classes and syntax in `/root/projects/phone-harness/agent/heavy-jobs.json`).
