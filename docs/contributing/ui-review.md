# UI review

Three tools for looking at the web client without touching real conversations:
a photograph of every UI state with a diff against a baseline, a long-lived
isolated daemon to click through by hand, and the generator of the README
media. None of them is in the gate.

All three need what the browser suites need: a release build with the web
client embedded, `npm ci` in `web/`, and a Chromium (`OMP_PULSE_CHROMIUM`; see
[e2e/README.md](../../e2e/README.md#overrides)). They photograph the build
embedded in `target/release/omp-pulse` unless told otherwise, so rebuild first
or you are looking at the previous UI.

## Every UI state, photographed: `scripts/ui/states/`

```sh
node scripts/ui/states/capture.mjs                  # whole catalogue (~125 states, ~40 s)
node scripts/ui/states/capture.mjs --save-baseline  # this run becomes the reference
node scripts/ui/states/capture.mjs --only chat-     # ids containing "chat-" (an exact id selects just it)
node scripts/ui/states/capture.mjs --vite           # live web/src instead of the embedded build
node scripts/ui/states/capture.mjs --serve --vite   # stay up; each stdin line is one run
node scripts/ui/states/capture.mjs --review audit/ui-review.json   # annotated review (see below)
```

`captureAllStates()` in `capture.mjs` is the single call. It seeds a corpus
(`e2e/lib/ux-fixture.mjs` plus `scripts/ui/states/fixtures.mjs`), runs every
recipe in `scripts/ui/states/recipes.mjs` in parallel in one browser, and
writes `audit/ui-states.html` (a self-contained gallery) and
`audit/ui-states.json`. Run bare, it re-executes itself under
`e2e/with-test-daemon.sh`, so the only daemon it can reach is a throwaway one.

Each state is compared with `audit/ui-states-baseline/`. The gallery shows
before, after and diff for anything that moved; the JSON names the changed
states, their bounding boxes, and the UI-probe findings (contrast, tap targets
under 44 px, clipping, overflow; shared with `e2e/browser/verify-a11y.mjs`
through `e2e/lib/ui-probe.mjs`) that the change introduced or resolved. Two
runs of an unchanged tree report 0 changed: the page clock is pinned, the
timezone is UTC, motion is frozen, and `stabilize.mjs` removes the remaining
noise (sub-pixel scroll, elapsed seconds) before each shot.

Every non-GET `/api` call is answered in the page (default `{ok:true}`), so the
daemon stays read-only, recipes cannot interfere with each other, and no run
spawns an omp child or costs a model call. Live states (streaming, running
tools, desktop questions, update banners) come from protocol frames injected
into the real sockets.

`--serve` keeps the daemon, corpus, vite and browser up between runs; with
`--vite`, re-shooting one state after an edit to `web/src` takes a few seconds.
Recipes marked `embeddedOnly` need a real release ID and are skipped under
`--vite`, where the build is always "dev".

`--review <file-or-folder>` turns captures into an annotated review: findings
in JSON (schema at the top of `scripts/ui/states/review.mjs`), each pinned to a
state and to elements by selector or visible text. The run resolves every mark
to a box in the live page and writes `audit/ui-review.html` with numbered
callouts, zoomed crops and severity and category filters. A mark that no longer
matches is listed as unresolved, not drawn in the wrong place. A folder merges
every `*.json` in it.

## Clicking through by hand: `scripts/ui/review-daemon.sh`

A long-lived, isolated daemon for human or agent UI review. The deployed app
serves your real conversations, and a reviewer clicking through every flow will
eventually hit Send, Fork, Delete or Rename; this instance has its own port,
token, sessions root and state directory, seeded with `e2e/lib/ux-fixture.mjs`,
so anything may be clicked.

```sh
scripts/ui/review-daemon.sh                          # port 7690; prints BASE and the private credential-file path
OMP_PULSE_UX_PORT=7691 scripts/ui/review-daemon.sh   # another port
```

It serves the client embedded by the last `cargo build --release` at `/app/`
(no vite) and runs in the foreground so a supervisor owns its lifetime. Never
print its credential or a URL containing it. `scripts/ui/review-daemon.test.mjs`
covers it in the gate's tooling tests.

## README media: `scripts/docs/capture-readme-media.mjs`

The screenshots and demo GIF in `docs/media/` are regenerated from invented
data on a throwaway daemon:

```sh
node scripts/docs/capture-readme-media.mjs                    # all four
node scripts/docs/capture-readme-media.mjs --only chat,gif    # sessions | chat | phone | gif
node scripts/docs/capture-readme-media.mjs --out /tmp/media   # write somewhere else
```

It reuses the UI state capture's page harness (pinned clock, stubbed writes,
injected frames), so no omp child is spawned and no model is called. It also
needs ffmpeg for the GIF and pngquant for the PNGs.

`node scripts/docs/render-brand-images.mjs` regenerates `docs/media/social-card.png`, the
1280x640 link-preview card the website serves as `og:image`, and
`docs/media/readme-hero.webp`, the README's three-phone image, from the screenshots above;
it needs no daemon, and `magick` for the WebP.
