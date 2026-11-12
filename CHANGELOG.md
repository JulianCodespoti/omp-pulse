# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The website, README and docs now lead with what Pulse does for you instead of how it is built: a "Your coding agent, in your pocket" landing page with a six-part feature tour (including notifications and plugins), a three-step setup, plain-language "Safe by design" promises, downloads split by computer and phone (with iPhone covered), and a questions section.
- New [Getting started](docs/user/getting-started.md) guide, from installing Pulse to a first conversation and notifications; the docs sidebar is regrouped into Start here, Using Pulse, Under the hood and Project.
- The app is called OMP Pulse wherever it is installed (Android home screen, browser Home Screen, page title), and its default look is the new OMP Pulse preset: brand violet on black, matching the icon and the website. ChatGPT's white and blue remains a preset; an accent you chose yourself is kept.
- Android: the app theme and the widget's accent before Android 12 are violet instead of mint, and Android 13+ themed icons get a monochrome Pulse mark instead of the full-colour icon.
- Shared links to the website show a preview: a 1280×640 social card (`docs/media/social-card.png`, rendered by `scripts/docs/render-social-card.mjs`) at an absolute URL. The old SVG card, which most apps cannot display, is gone.
- Brand colours, radii and fonts live in one file, `brand/tokens.json`. `scripts/brand/sync-tokens.mjs` carries them into the website, the social card, the Android colours, the README badge and the icon, and the gate fails when any of them drift. The [brand guide](docs/contributing/brand.md) covers the name, colours, type and assets.
- The website sets its text in Geist, plays the hero demo as a sharper, smaller video instead of a GIF (with a pause button, and still on its first frame when reduced motion is on), and has PNG and Apple touch icons.

### Fixed
- A notice with a long conversation title (such as "Reply ready") truncates the title instead of pushing the notice and its Open button past the edge of the screen.
- A plugin card for a tool call shows once per turn; a turn that edited files no longer repeats it under the edit summary after the reply.

## [0.1.0] - 2026-11-12

### Changed (mobile polish)
- Session list, search across titles and message transcripts, and project-folder scoping now live exclusively in the left session drawer, removing the duplicate pushed Chats page.
- Static product and documentation website (`website/build.mjs`) with interactive product tour, Android phone-mode showcase, downloads matrix, and rendered documentation hub.

- Chats open at the newest message without travelling through history or flashing the Down button; a delayed skeleton appears only while the opening settles.
- Reading earlier messages no longer pulls the view back down when a page loads or rows resize, and the keyboard keeps the lines above the composer in view.
- Scrolling back down through a long chat reads the newest messages back by cursor as you near them, sliding the window instead of replacing every row with a fresh tail.
- Sending keeps room beneath the new message until removing it cannot move the view, even after a short reply finishes.
- One steady connection indicator drives the chat, lists and waiting messages; retries no longer flash it, saved copies are labelled, and a recovered outage briefly says "Back online".
- Unsent messages say "Waiting for connection" when offline; unconfirmed delivery says "Not confirmed" with Check, while refused sends offer Edit and undoable Remove.
- Notices stack two at a time without passive messages replacing Undo; Undo shows its remaining time, long text expands on tap, and upward or sideways drags dismiss notices.
- Reply-ready notices show the conversation title or a count of finished replies, with Open leading to the newest.
- Stop stays beside Send while a draft exists, shows progress after a tap and offers Try again on failure; sending and stopping keep the keyboard open.
- The composer explains why sending is unavailable and offers "Send now" or "After this reply" as soon as the field is focused during a running turn.
- Selected photos appear immediately as cancellable loading tiles, failures are summarised once, and removing a photo offers Undo at its original position.
- Chats keeps search and scroll position when returning from a conversation, shows a connection banner above cached rows and explains when Delete is unavailable.
- Deleting the open conversation leaves it first, Undo reopens it, and pending deletions finish when the app is hidden.
- Cold start uses cached chats immediately; a slower launch shows a quiet frame instead of a blank page, and the new-chat screen shows connection problems.
- Transcript and composer share a centred column on wide screens and respect landscape display cutouts.
- Content sheets keep drafts; images reserve space while loading, file previews highlight code and offer downloads for binary or truncated content, and stalled reads offer recovery.
- Markdown links open outside the app, maths loads only when needed and renders as native MathML without a stylesheet, and thinking disclosures keep the reader's place.
- Notifications can be enabled above the composer once a turn has run for 20 seconds, with remembered declines and no repeat ask after two declines.
- Android uses one launch background colour, a monochrome notification icon and grouped conversation alerts; Web Push has a monochrome badge and alerts again for a new reply.
- Completed-reply notifications for the visible chat still sound and vibrate, then clear after 4 seconds; questions remain until answered.
- Settings → Appearance → Coloured markdown (off by default; on in the Terminal
  preset) gives rendered markdown the omp terminal's palette: H1 magenta, H2
  yellow, H3-H6 blue, bold and italic magenta, inline code green, table
  headers yellow.
- The version banner's Update button applies the update directly through the same guarded function as Settings > About, without leaving pending messages behind.
- Update instructions distinguish an older computer from an older app, including the Android app guide in phone mode.

### Added

- Plugins: put a folder with a `pulse-plugin.toml` and a `client.js` on the
  computer, check and link it with `omp-pulse plugin`, and turn it on in
  **Settings › Plugins** after reviewing its slots, permissions and exact host
  commands (each argument quoted, with a warning for any file in the plugin
  folder a command uses, which the approval does not cover). Its script runs
  in a sandboxed worker with no network or storage and draws views in the
  composer status and plus sheet, the drawer, its own page, conversation rows
  and menus, under a claimed tool call's row, and in place of a claimed
  extension message card (with "Show original"). On a tap it can put text in
  the composer, send a message, run a shell command of its own choosing or an
  allowed RPC command in a conversation, or run a command the manifest
  declares, each only with the permission you approved and only while the
  computer still has the plugin on and unchanged. A plugin's prompts never run
  shell or built-in commands or open the phone's sheets and screens, its toasts
  carry its name, and only a control device can make the computer run its
  commands. Plugins can have options set in Settings and shared by every
  device, and `omp` in a command means the daemon's own omp. New or changed
  plugins stay off until approved; `omp-pulse plugin enable` asks first
  (`--yes` for scripts). Examples: `host-usage`, `provider-usage` and
  `systemd-timers`; see [plugins](docs/user/plugins.md).

- A skill and a `/pulse-plugin <idea>` command for your own omp that teach it to
  write, check and link a plugin for you, leaving the review and switching on to
  you. `omp-pulse plugin skill` installs or refreshes them in omp's agent
  directory; `omp-pulse setup` installs them too, and a starting daemon
  refreshes them only if they are already installed (test daemons set
  `OMP_PULSE_SKIP_SKILL_REFRESH`, so a test run never rewrites yours). Restart
  running omp sessions to load them; see [plugins](docs/user/plugins.md#ask-your-agent-to-write-one).

- Android phone mode can be stopped from Settings to end on-phone work and
  release runtime resources without deleting conversations, files or sign-ins.
  It stays off until explicitly resumed, including after app launch or reboot.
  Settings now separates **Run on this phone** from **Run on PC** controls;
  pairing actions appear only for computer connections.
  The stopped screen lists saved computers with checked online/offline status
  and lets you continue using an existing pairing, without switching automatically.

- An empty chat sidebar keeps only its bottom **New chat** button and hides
  **See all**, removing the duplicate action from the empty view.

- Tern adoption: omp-pulse adopts an already-sharing omp in a Tern pane through
  omp's native Collab, matching the exact session file and owner process id and
  validating the link's generation and control access in the owner's own
  profile and runtime. A Tern session that is not sharing is refused: Pulse never
  types, focuses or launches a GUI and leaves an unsent draft untouched, because
  Tern's native surface can lag about 5 seconds and a native ask replaces the
  draft with no atomic guard. Share with the Pulse control extension,
  `collab.autoStart: control` or a manual `/collab`; there is no helper to install.
  Tested on Linux with Tern 0.9.12 and omp 18.18.1. "Open on laptop" stays
  herdr-only; see [configuration](docs/user/configuration.md#tern).

- A live turn no longer hides the steps it has already taken. Both bodies
  windowed the newest work while it streamed — Grouped showed the last two
  steps, Summary the last three — so a run that reached eight lines suddenly
  read as three, and the lines were only reachable through a header tap or a
  small "N earlier steps" link. Every step now stays on screen; the group's own
  fold still collapses the whole run on tap once you want it out of the way.
- The newest reasoning is drawn last. omp keeps appending to a message's
  thinking part while the calls that part already issued run and report, so
  drawing parts in order put a streaming thought *above* four running reads
  the reader had just watched it start. While a turn is live, the newest
  thought renders after its step's rows — reasoning at the end, work above it,
  the way DeepSeek and ChatGPT draw their current block — and a settled run
  returns to the true order.
- One live voice: a running call's verb no longer shimmers inside a work group,
  whose title already shimmers the step in hand. Two animated labels in the
  same block read as two spinners.

- The work group being written is now fully open instead of a five-line scroll
  box. It grows downward as steps arrive and the transcript follows its end, so
  the whole current stretch is readable without scrolling inside a 100 px
  rectangle; when its stretch ends it shrinks into its one-line title as before.
  A group whose newest step has finished also stops claiming "Working…" — it
  reads its elapsed time ("Worked for 7m 26s") until the turn settles and folds.

- Motion is one spring instead of a set of timers. DeepSeek's client is
  springs-only (damping 1.0 for anything positional, 0.9 for a released
  gesture); ours was beziers at fixed durations, which always spend the whole
  duration and cannot start at the finger's velocity. One sampler now produces
  both, published as CSS `linear()` curves that run on the compositor:
  the sheet's snap-back (seeded with the release velocity), the selection
  indicator, the toast (150 ms in and out, was 520 ms), the composer's
  expand, the progress bars (scaled, not laid out), and the list's reorder,
  which is now a FLIP of `transform` on rows near the screen instead of a
  whole-screen view-transition snapshot. The switch thumb slides and grows by
  transform rather than animating margin and size, and screen pushes are 240 ms
  without a full-screen brightness filter. Long-press menus, the drawer, the
  streaming fade and the scroll-follow spring already matched; they are
  untouched.

- Navigation follows ChatGPT's model: one way to start a chat, one chat list,
  and projects that are simply the folders chats run in. Every "New chat"
  (the drawer's pill, the chat header's pen, `/new`, the command palette)
  goes to the home screen with the current chat's folder already chosen and
  still changeable, so no empty session is ever created in a folder the
  person did not see. The pushed list is "Chats": the same screen header as
  every other page, with no large title, no connection line the drawer already
  shows, and no second New button. The drawer lists those folders under
  Projects, each opening only its own chats, with "All projects…" for the
  whole list; the project filter chip, "Group by project" and the saved filter
  went with the screen they lived on. A chat's header now names the chat and
  its folder, which the floating pills never did once messages arrived. The
  composers say where the message goes ("Message omp", "Describe a task in
  <folder>").
- Small things from the same pass: a pasted file that is not an image says so
  instead of vanishing; the drawer's long-press menu fades in over a blurred
  scrim and lifts its row, like the message menu; the empty drawer says
  "No chats yet" and offers one, and its error state uses a connection icon
  rather than a search one; more than ten pins collapse to their heading; an
  export keeps "Preparing export…" on screen until it finishes instead of
  expiring in two seconds; finishing or stopping a turn is announced to screen
  readers. A screen change also lands even when the browser never runs the view
  transition's callback (a tab producing no frames, or a capture still running
  over a huge transcript): before, that left the page unable to navigate at all
  until it was reloaded. The browser test suites' "New chat" and list entry points were
  rewritten for this, and the web unit suite now runs at most four files at a
  time: fifteen copies of jsdom drove a 16-core desktop into swap until it
  froze.

- Settings follows one structure, modelled on DeepSeek's: rows grouped by
  task (your computer first, then Preferences, About, and the destructive
  actions last), one meaning per affordance (chevron opens a page, a switch
  applies at once), no expanders hiding facts, and no sheet stacked on
  another. "Pair this device" is gone while pairing works; "Repair pairing"
  appears only when the computer refuses this phone, without the first-run
  screen's hero and tips. Unpair is offered once. Device rows show their
  action instead of a "tap a device" footnote, a saved computer can be
  forgotten without a long-press, and resetting Appearance asks first.
- Notifications is a page in the app instead of a native Android dialog: a
  status line that says whether alerts reach this phone (with the fix when
  they don't), switches for what to be told about, quiet hours with time
  pickers, and background delivery, bubbles and battery in plain words. The
  browser gets the same page with its push switch. Each chat's own
  notification switch is in Session settings.
- Usage leads with this conversation's context and one cost, then each
  provider's plan limits once, as meters with their reset time; token and
  message counts sit in a compact grid below. The composer's context ring
  opens Usage.
- Session settings fits on one or two screens: Model & thinking, Context
  (with Compact asking inline), Messages as inline choices in plain words
  ("Messages sent while it works: All at once / One by one"), and Behaviour.
  The session menus share one set of words and one order everywhere.
- Settings › Model providers now adds a provider from the phone, on a computer
  as well as on the phone itself. Signed-in providers come first with a tick;
  "Add a provider" opens a searchable list with the common ones first. The
  sign-in link is a button, a device code is shown large with Copy, and a
  paste field takes a code, link or API key, all in the page. When it
  finishes the model list refreshes and "Choose a model" is offered. On a
  computer this is a new administrator-only daemon route set
  (`/api/providers` and `/api/providers/login[/input|/cancel]`) that runs one
  `omp login` at a time, strips its terminal colours, caps the transcript at
  64 KB, never logs it, and stops it on Cancel or after 10 minutes. Other
  devices see the list read-only. The model picker ends with "Add a
  provider", and its empty and sign-in-needed states lead there. First-run
  setup uses the same flow.
- The app no longer opens on the Sessions list. A cold start reopens your most
  recent chat if you used it in the last 30 minutes, it is running, or it is
  waiting on you; otherwise it opens the new-chat home. A notification still
  opens its own chat. The session drawer is the way to every chat; "See all…",
  search open Chats as a page with a back arrow, and choosing a chat there
  opens it. Back in a chat opens the drawer once; Back from the
  drawer or home leaves the app. "New chat" always means the new-chat home.
- Settings › Unpair this phone (was "Forget this pairing") now revokes the
  phone's credential on the computer, not only on the phone, so the old
  token stops working and the computer lists the phone as removed. In the
  Android app it also forgets that computer, which stops background
  notifications. An unreachable computer is named so it can be removed there.
- The floating chat buttons carry ChatGPT's 1px lighter ring and sit on its
  top shade: the conversation dims from ~80% at the top to nothing ~113px
  below the status bar, so the buttons never blend into a bubble behind them.
- ChatGPT composer and chrome, second pass: the header is only floating
  buttons (menu, and workspace / new chat / ⋮) with the conversation
  visible behind them; ⋮ and "+" open floating menus instead of sheets; the
  composer is a two-row card with the model chip (tap for a small model and
  thinking picker, "All models…" for the full list) and the context ring
  beside "+", then the mic and send/stop; dictation shows a live waveform.
- ChatGPT-style chat chrome:
  - Floating header: a round menu button that opens the session drawer,
    the title with the model under it (tap to change model), and a pill
    with workspace, new chat and ⋮ (which gains "All sessions" and
    "Share conversation").
  - Floating composer pill: "+" opens a sheet with images, camera,
    history, skills, commands, model and context; the send button turns
    into an accent stop button while the agent works.
  - Settled turns fold their tool work into one "Worked for 42s ›" line
    above the reply; tapping it shows the turn's full activity in a sheet.
    New default tool-call mode "Summary"; Grouped and Expanded remain in
    Appearance.
  - Long-press opens an anchored menu over a dimmed scrim (Copy, Select
    text, Edit & resend, Branch, Read aloud, Share, and every earlier
    action) instead of a bottom sheet.
  - Read aloud: a speaker button beside Copy on every reply (phone speech
    synthesis, read in sentence chunks).
  - Share conversation as a Markdown file (share sheet, or copied).
  - A new chat opens on "What should we work on?" with suggestions that
    fill in the message box.
  - The jump-to-latest button is a round ↓ centred above the composer.
  - The session drawer is laid out like ChatGPT's: search, Settings,
    pinned chats, chats grouped by project, "See all…" and a "New chat"
    pill.
  - Agent conversations opened from a recorded task show how the agent
    actually ended (Done, Failed, Stopped) instead of "Started".
- Agents tab: every agent the chat started opens as its own conversation,
  running or finished, drawn exactly like the main thread (user bubble for
  its assignment, folded tool runs, sender lines, "Worked for" footers with
  Copy). Finished agents with no live host are read from the transcript omp
  keeps beside the session (`GET /api/agents/file`); previously their rows
  only jumped to the parent chat.
- Settings → Appearance replaces the Text size page: text size, density,
  accent colour, streaming style (instant, fade in, caret), tool-call grouping,
  thinking visibility (hidden, collapsed, latest turn open), long-reply
  previews, a wrap default for code and diffs, an in-app reduce-motion switch
  and haptics, with a live preview. Also: auto-scroll while a reply streams
  (follow or stay put), what Enter does in the composer, a compact turn
  footer, a last-active time on session rows (relative or clock), and a code
  size for code, diffs and command output. Message style → Bubbles shows the
  agent's words in grey bubbles beside an avatar and yours in the accent
  colour, with a sender line per turn, its tool work threaded beneath, a tap
  on any bubble for its time and model (long-press keeps the actions sheet),
  and a typing indicator while it works. Stored per device in `omp-appearance`;
  the old `omp-text-size` choice carries over.
- Direct recovery actions for model/provider setup, pairing, device access,
  permissions, connectivity, file workflows and failed chat messages.
- Read-only saved-work recovery when repairing pairing, including original
  photo attachments and later browser draft changes; old messages are never
  automatically replayed under a replacement pairing.
- Signed, app-private conversation transfers between separate Android installs,
  with stable source snapshots, exclusive atomic moves (Android denies hard
  links), and authenticated destination hash/session-index receipts.
- `GET /api/busy?after=<version>&wait=<s>` long-polls whether the daemon has
  work, and `/api/status` reports it as `busyWork`. Phone mode uses it to hold
  its wake lock only while needed.
- Prebuilt releases for arm64 Linux and for macOS (Intel and Apple silicon):
  `install.sh` now installs on both instead of pointing at a source build.
- Hosted CI: every pull request and push to main runs `scripts/ci.sh` on Linux
  and `cargo test` on real macOS and Windows.
- A release workflow builds the daemon archives for every published platform
  when a `v*` tag is pushed.
- `scripts/ci.sh --group web|rust` runs one half of the gate, and every step
  prints its duration. Hosted CI runs the two halves as parallel jobs.

### Fixed

- Reopening a drawer no longer replays its loading state over a list the phone
  already had. The chats drawer matched its result to a request object that
  changed on every open and close, so each reopen threw the rows away and drew
  the skeleton until the refetch landed. It, the workspace drawer's Agents tab
  and its Tasks tab now keep the previous rows on screen while they re-read, and
  show a skeleton only for a first read or a different chat. Tasks also keeps
  the earlier turns a reader had paged in.
- The chats drawer and the workspace drawer are loaded before the first swipe.
  The chats drawer reads its list once per chat while closed, and the
  workspace drawer reads Agents, Tasks and Files once per chat a few seconds
  after it opens. Changes (a git diff on the computer) and Terminal still load
  on open.
- A computer that is slow, asleep or not running is now named, not left as a
  loading skeleton. One shared link state is fed by what the app already does
  (every daemon request, and every frame the sockets hear), with one short
  probe only when a socket drops or goes silent or a read has waited 3 s, and
  Retry. It tells "can't reach" (Tailscale off on the phone, computer asleep,
  no network) from "omp-pulse isn't running" (the proxy answers, the daemon
  doesn't). Both drawers and the chats page show a banner with the cause, keep
  the chats they had, replace a stuck skeleton after 8 s, and re-read by
  themselves when anything answers again. Workspace reads (Agents, Tasks,
  Files) now have the same 20 s deadline as every other read.
- The chat's own connection pill said "Reconnecting to your computer…" with a
  spinner whatever the cause, and left and re-entered on every socket retry
  (nine times in 40 s on a dead link; no indicator at all for 75 s). One
  verdict now drives it: a socket that reopens within 2 s shows nothing, a dead
  link shows "Can’t reach <computer>" (or "You’re offline", or "omp-pulse isn’t
  running") and stays put with Retry, a tap opens Settings › Computer for the
  advice, and an outage of 3 s or more ends with "Back online" for 1.5 s. The
  advice names Tailscale only for a tailnet host.
- Opening a chat no longer travels. It used to paint 5,546 px above the newest
  message and scroll down for 730–790 ms with the Down button flashing; it now
  paints at the newest message. Reading history is never pulled back down while
  an older page loads (it was yanked 236–964 px), because one viewport owner
  (`transcript-viewport.tsx`) now decides the bottom lock, and a late page is
  anchored at the commit that adds it. Replacing `use-stick-to-bottom` and six
  separate scroll writers also fixes the 70 px re-lock after a small scroll.
- Stop is always reachable while the agent works: with a draft typed, a compact
  Stop sits beside Send. It shows a spinner until the turn ends, a failed stop
  says so with Try again, it buzzes once, and Send and Stop no longer take the
  keyboard away. A chat that cannot be sent to from here says why above the
  field. The send-mode choice reads "Send now" / "After this reply", appears
  with focus rather than on the first keystroke, and the placeholder says
  "(sent when online)" steadily while the link is down.
- Picking photos shows one placeholder tile per file at once, and removing an
  attached photo offers Undo for 5 s.
- The "A new version is ready." banner now updates and reloads in one tap
  (Settings › About calls the same function). A phone whose app is older than
  the computer allows is told to update the app, not the computer.
- On wide screens the transcript and composer share one centred 48 rem column,
  with side padding that respects display cutouts.

### Changed

- Long messages you send fold to eight lines with a fade and a chevron, and
  keep their line breaks (markdown used to join a pasted log into one
  paragraph).
- A turn that goes quiet says so: "Taking longer than usual" after 40 s with
  no new activity, then "Still working on it" and "Feel free to check back in
  a moment", rotating every 7 s.
- Delete no longer asks first. The conversation disappears with a 5 s Undo,
  and is deleted when that runs out. Discarding a saved or refused message
  works the same way; an unconfirmed one still asks.
- Duplicate says "Duplicating…" at once and opens the copy. Pin and Unpin no
  longer toast.
- Try again opens a small menu: Try again, or Try with another model.
- When another conversation finishes while you are in a chat, a 10 s notice
  shows its title and the start of the reply, with Open. While a chat is open
  and another conversation is running, the list refreshes every 10 s to see it.
- Error notices stay long enough to read (4 s, longer for long text) and a
  routine notice can no longer replace one. Notices scale in.
- Tables have a header with Copy (tab-separated, so it pastes into a sheet).
- A long draft can be expanded to most of the screen.
- Copy buttons cross-fade to a tick, with a haptic tap.
- The "Reconnecting" pill has a Retry button. Cancel-edit and tool rows have
  full-size tap targets.
- Delivery problems say what to do: "We couldn’t confirm this message
  arrived. Check the conversation before sending again."
- The look follows ChatGPT's dark theme, measured on its Android app and
  named by its OAITheme tokens: a pure black conversation, #212121 sheets
  and cards, a #303030 composer, your message at 13% white (tinted by the
  accent, as ChatGPT draws its purple accent #2E0450), #FFFFFF / #CDCDCD /
  #AFAFAF text, white primary buttons, links in its Android blue, its
  status colours and scrim. Violet is now ChatGPT's purple. The
  text is the system font (Roboto on Android) at its type scale: replies
  16/26 with its tracking, titles 18/26. "ChatGPT" is the new default
  accent; Violet and the others stay in Settings → Appearance. Geist (sans)
  is no longer downloaded.
- Motion follows the ChatGPT Android app, value for value (read from its
  1.2026.300 UI bundle). Replies stream in by default, each word fading in
  over 0.5s ease-in-out, 70ms after the previous one. Buttons, chips and
  transcript rows squeeze to 0.98 on ChatGPT's press spring and hold it at
  least 120ms; list rows get its ripple. A tap on anything inside a reply
  plays a light haptic. Revealed details fade in over 0.24s; switches and
  segmented controls use its control curve, and a segmented choice slides.
  The running turn shows ChatGPT's single breathing dot, and its status line
  shimmers glyph by glyph and crossfades as the step changes.
- The chat has one 56px bar instead of a header plus a six-tab row: back, the
  conversation (title over its project folder; a tap opens model, usage,
  settings, rename and switch), and a workspace button whose badge says what
  needs you or is working.
- The workspace (Agents, Tasks, Changes, Files, Terminal) is a drawer that
  slides over the chat from the right, opened by a leftward swipe or the
  workspace button, so the chat stays in view beside it instead of sliding off
  screen. It has the page title on top and a bottom tab dock (icon over label,
  every tab always in view); its pages swipe between each other, and a
  rightward swipe on Agents, the scrim, Escape or Back closes it. The dock's
  indicator rides the pager's scroll timeline, so it tracks the finger instead
  of catching up after a swipe settles, and every page is built shortly after
  the drawer opens so a swipe never waits on one. Neither drawer has a border
  or dark band against the chat.
- The workspace pages match: agent rows are one line of state, age and task
  (the state word "Working" is now "Running"); Changes opens with a summary
  card (file count, added/removed bar, branch) and icon-only tools; the add-task
  and terminal fields are composer-style cards; no page draws row dividers.
- App banners (such as "A new version is ready") are one-line floating pills
  that spring in below the chat bar instead of a card over the title.
- Dragging a sheet or drawer moves it directly each frame instead of
  re-rendering on every touch move, so it no longer lags the finger when the
  phone is busy.
- Connecting the Android app to a computer is one scan: Settings › Run on ›
  Computer (and first-run "Connect a computer") opens the camera on the code
  `omp-pulse pair` shows, which saves the address, switches to the computer
  and pairs, with nothing typed. Pasting the printed link does the same; a
  bare address still works.
- The app remembers every computer it has connected to. Settings › Run on
  lists them by name with the one in use ticked; a tap switches (each keeps
  its own pairing, so nothing is asked again), press and hold forgets one, and
  "Add a computer" scans another.
- The app and daemon say "computer" rather than "laptop" everywhere a person
  reads it.
- Once there are two places to run (this phone and a computer, or several
  computers), a pill left of the Settings cog names the one in use; a tap
  opens the list and switches in one more tap.
- The QR scanner asks the camera for 1080p with continuous focus; WebView's
  default 640x480 stream looked blurry stretched across the screen.
- Running sessions stand out again in the list: a shaded row with a slow
  sweep and a live line of what it is doing now (tool, its target, turn time
  and tool count). Sessions open on the computer get a green shade and an
  "On computer" label. Idle rows keep the minimal title, project, model and
  context.
- Streaming is steadier: a finished reply no longer remounts when its footer
  appears (it jumped by ~335px for a frame), a thought folding into a row as
  the first tool starts now eases instead of snapping, and assistant text
  fades in without the springy overshoot reserved for taps.
- "Can't reach your computer" has a back arrow to the phone, Try again and
  one quiet link, instead of five buttons, and names the usual cause
  (Tailscale off on the phone). Its status line works again: a top-level
  `var status` was `window.status`, so every progress update threw.
- The QR scanner no longer flashes Android's grey video placeholder before
  the camera starts.
- The composer is a rounded card: the message on top, then plus, a model chip
  (provider logo and name; opens the model picker), a thinking chip (brain and
  level; opens the level menu) and a context ring with the fill percentage,
  then voice and send. Routine extension notices and statuses share one muted
  line; warnings and errors keep their card.
- Sessions open with "Needs you" and "Running" sections above the date groups.
  Rows show only the title and one quiet line (project, model, context ring);
  state is one small glyph, and there is no cost, time or preview.
- Rounder and springier throughout: radii are 8/12/18/24px, buttons are pills
  or circles, controls squeeze and spring back on press, and sheets, drawers
  and sent messages land on a spring with a slight overshoot.
- The Android app follows the phone's system font size: the WebView kept text
  at 100% while native apps shrank theirs, so Pulse looked zoomed in on a
  phone set to a smaller font.
- Workspace pages open with a summary (agents by state, plan progress, changed
  files and lines, folder counts, terminal connection), and session settings
  gather model, context and spend in one sheet.
- Conversation tool activity is one quiet row per call (`Ran git status · 794
  lines`) instead of command cards and plan cards. A tap opens the call's
  command, arguments, output, diff, exit status and duration in a sheet;
  consecutive calls fold into one summary row ("Read 3 files, ran 5 commands"),
  and a run that ended on a failure opens itself with the first error line in a
  danger-tinted row. Settled reasoning is a single "Thought for Ns" row, and the
  model is named only where it changes.
- Recovery notices and sheets use neutral surfaces, concise copy, semantic icons
  and direct actions. Supporting instructions and diagnostics expand on demand;
  delivery uncertainty and pairing safety remain visible.
- Saved-work recovery lists conversations as expandable rows, keeping original
  drafts, attachments and source details available without filling the screen.
- Linux releases are static musl builds that run on any distribution, glibc or
  musl; the separate glibc archive is gone. The Windows archive is the MSVC
  build (`x86_64-pc-windows-msvc`) instead of the MinGW one.
- `scripts/release/release.sh` builds only the signed APK and the proot/talloc
  sources and attaches them to the tag's release; the daemon archives come from
  the release workflow. It refuses to attach from anything but a clean checkout
  of the tag, and `--publish` refuses while any archive is missing.
- The CLI's help and bind warning, and the comment in a newly generated
  `config.toml`, now point at `docs/user/networking.md`.
- Log lines name the subsystem in their target, for example
  `omp_pulse::server::http` instead of `omp_pulse::http`. Update any log filter
  that matched the old targets.
- The repository is reorganised so its layout explains itself:
  - the gate is `scripts/ci.sh` (was `packaging/ci-local.sh`), the release
    script is `scripts/release/release.sh` (was `packaging/release-local.sh`)
    and `set-repo.sh` moved from `packaging/` to `scripts/release/`;
  - maintainer scripts are grouped by purpose under `scripts/android/`,
    `scripts/deploy/`, `scripts/docs/`, `scripts/release/` and `scripts/ui/`
    (the UI review daemon, `scripts/ui/review-daemon.sh`, was `ux-stage.sh` in
    `e2e/`);
  - end-to-end suites, including the browser and Android suites that were
    `verify-*` files in `scripts/`, are grouped in `e2e/daemon/`, `e2e/omp/`,
    `e2e/browser/` and `e2e/android/` by what they need, with shared helpers
    in `e2e/lib/` and one runner, `e2e/run.sh`;
  - the web client's unit tests live in `web/test/` and run with `npm test`;
    the Android host-JDK harnesses live in `mobile/android/host-tests/`;
  - `harness/` is `phone-harness/` and `integration/` is `extensions/`;
  - docs are sorted by reader into `docs/user/`, `docs/contributing/` and
    `docs/internals/`, indexed by `docs/README.md`;
  - the daemon's modules are grouped into `src/server/`, `src/omp/`,
    `src/sessions/`, `src/authority/` and `src/terminal/`, and the binary is
    `src/bin/omp-pulse/`.
- The gate runs every test in the repository: the web typecheck and unit
  tests, extension and tooling tests, every Android host-JDK harness, the
  phone-harness tests and the daemon e2e tier by default; `--full` adds the
  Android JVM tests and the omp, browser and android e2e tiers.
- `e2e/with-test-daemon.sh` gives each run a private `XDG_RUNTIME_DIR`, so no
  suite can write a collab announcement beside the developer's live hosts.
- `pulse-deploy.sh --phone` builds the embedded web client and phone daemon
  without an APK, then schedules an idle-safe swap through the phone harness.
- Protocol 4 preserves per-message photo associations when withdrawing queued
  content. The daemon, web client and native app must be updated together.
- Protocol 5 adds authoritative collab question snapshots and token-correlated
  answers. Update the daemon, web client and native app together.
- Phone mode lets the phone sleep. The daemon's partial wake lock used to be
  held for the service's whole life, so the phone never suspended and every
  timer fired around the clock. It is now held only while the daemon has work
  (a turn, an accepted prompt, background jobs or subagents, a side question or
  a dialog), plus a 60-second grace, and every hold is timed.
- Background battery use is lower:
  - The app pauses WebView timers while it is not visible.
  - The web client stops its polls, watchdogs and clocks while the page is
    hidden, and pauses CSS animations.
  - Outbox changes are pushed from the native side instead of polled every
    second. Older APKs keep the old poll, only while the page is visible.
  - The daemon stops tailing a session whose only clients are hidden, and sends
    those clients one resync when they become visible again.
  - The watcher tick, bridge rescan, child reaper, collab answer sweep, voice
    reaper and receipt reconciler wait for work instead of ticking.
  - Session discovery coalesces file events for one second while no session
    list is open.
  - The accessibility service subscribes to window changes only.
  - The notification stream detects a stall with a socket read timeout
    instead of a 15-second watchdog, and stops when it has no token.
  - The native outbox job reschedules only while work is pending.
  - The laptop-mode network callback is registered only while the fallback
    page is showing.
  - `daemon.log` is written in buffered batches.

### Changed

- Chats list: chats that were started but never sent a message are no longer
  listed (they showed as "Untitled session #bb82"). "Open on your computer" is
  a small monitor icon instead of a green dot. Drawer rows sit on inset,
  rounded pills with a wider gutter, like ChatGPT's.
- New chat: the project picker moved from the top of the screen into the
  composer, beside the model.
- Chat: the Up / Down message-stepping pair is gone; one round Down button
  (tap or hold) jumps to the latest message, as in ChatGPT. The Timeline is
  the way back through a conversation.
- Extension status (e.g. "ponytail: FULL") is a small floating pill above the
  composer instead of text on a black fade band.
- Questions from the agent show their web links as tappable links: one on the
  app's own address opens inside the app, any other in the browser.
- The agent's work reads as a rail (the default Summary view; picked in an
  in-app review against real recorded turns, after ChatGPT's thinking and
  Perplexity's steps). While it works, a live line says what it is on: a step
  that has run for more than 1.5 s, with its clock, or "Thinking". Under it,
  each thought reads as a short paragraph (tap for the rest) and consecutive
  calls of one kind group into a verb with chips: file names for reads and
  edits, the plain-English intent for everything else. A failed call is a red
  chip; any chip opens the call's full detail sheet (output, diff, Stop).
  A settled turn still folds to "Worked for". Grouped and Expanded keep the
  step rows.
- A turn's work reads like DeepSeek's thinking groups in every Tool calls
  mode; the mode only picks what an open group shows (the step rail in
  Summary, tool rows in Grouped and Expanded). Everything is collapsed except
  the group that is working, so a long conversation in Expanded mode no
  longer renders hundreds of open rows (54 tool rows and 1312 nodes down to
  0 and 720 on one page of a long session). Each
  stretch of work between two pieces of prose, or between two markers
  (compaction, a background job, a retry), is one group in place, with a
  single title line. While live, the title shimmers with the step in hand
  ("Reading retry.ts…", "Running npm test…") over a window about five lines
  tall that follows the newest steps with faded edges. When the answer
  starts, the window shrinks into the title (125ms after 50ms, fade 150ms),
  which then reads "Worked for 18s" (or "Thought for 3s"). A tap opens the
  whole timeline in place on a critically damped spring instead of a sheet.
  The head "Worked for" chip over the whole turn is gone, and the live
  footer keeps only its loader and clock; a retry wait still speaks there.
  Only the newest group ever previews: when a new one starts, every earlier
  group folds to its "Worked for …" title (two used to preview at once while
  a new step began streaming).
- Settings › Appearance is rebuilt around a pinned live preview and four
  tabs (Look, Text, Chat, Controls), with new choices: one-tap presets
  (ChatGPT, DeepSeek, Terminal, Messenger), a custom accent of any hue
  (gamut-fitted so white on it and its text colour hold 4.5:1 at every hue),
  Black / Dim / Grey backgrounds, high contrast, Square / Round corners
  (bubbles and the composer included), System / Serif / Mono font, line
  spacing, and grey or accent-tinted messages. The preview now sits on the
  chat's own page colour, so your message's bubble shows in it.
- Short pickers open as a bubble off the control you tapped, the same floating
  menu as the composer's + and model menus and the chat's message menu,
  instead of a bottom sheet: the computer switcher (drawer row and chip), the
  project filter, the sign-in provider, and Stop and send on a held Send.
  Every menu now shares one look (48px rows, the float shadow); sheets stay
  for forms, search, help and reading.
- The sessions drawer pushes the screen aside as DeepSeek's does: the chat (or
  home) slides over by the drawer's width and shrinks to 95% under a faint
  veil, while the drawer grows from 95% out of a 20% shade, all on the one
  release spring. Replaces the black scrim over a still chat. The workspace
  drawer on the right pushes the chat the other way, the same way.
- Swiping the drawer open puts the keyboard away at once, rather than
  mid-spring when the drawer takes focus.
- A streaming reply is followed with a firmer, non-bouncy spring: the view
  reaches 95% of new text in ~185-210 ms rather than ~480-520 ms (DeepSeek's
  critically damped catch-up, mapped onto use-stick-to-bottom's model).
- Swiping a drawer open no longer stalls (traced: a 120 Hz drag at 4x CPU over
  a long chat, production build). The claiming touch ran 53-75 ms of React
  (the whole chat re-rendered under the drawer) and every frame repainted the
  transcript; now the already-mounted drawer is moved straight in the DOM and
  React is told only after release, while the spring runs on the compositor,
  the chat and its header no longer re-render on drawer changes, and the panel
  and scrim have layers of their own. Claim 13 ms, 12-14 paints per drag
  instead of ~175.
- - Drawers move like DeepSeek's (read from its Android app): letting go runs a
  spring (stiffness 1500, damping 0.9) that starts at your finger's speed and
  settles in about 170 ms with no overshoot, instead of a fixed 420 ms ease. A
  quick flick goes where it points, even reversing a half-done drag; a slow
  drag commits past half the width. The sessions list stays built while the
  drawer is closed, so a swipe never builds it mid-gesture.
- Streaming text fades in like DeepSeek's: each arrival fades together over
  300 ms on a decelerating curve, with no word-by-word cascade, and the live
  reply never shrinks while it streams, so a re-parsed block can't jump the
  page.
- Work steps are quiet text rows (DeepSeek's tool steps), not filled pills
  that read as chat bubbles; a started-agents step names its agents instead of
  the first line of their prompt.
- - Long turns fold into sections. A turn with more than 12 tool calls splits
  into sections of about 12, each one line such as "Read 14 files · Ran 9
  commands · 4 searches" with its duration and, in red, how many calls failed.
  Inside a section, calls of one kind merge into one group across the thoughts
  between them (those sit behind "N thoughts"). While a turn runs, everything
  older folds behind one "Earlier · 173 steps · 1h 40m" line and the newest
  section shows its last three steps under its own summary row (tap to fold it
  too, so a whole turn can be two lines). Older runs of a running turn, split
  off by compaction or background-job notices, fold behind their own line
  instead of lying flat. Your own message stays a screen away
  instead of ~24 (a real 230-call turn). The "Worked for" sheet of that turn
  went from hundreds of rows to 22. Short turns are unchanged.
- - Nothing is read through anything any more, following how ChatGPT's client
  does it: top notices (toast, update banner, chat error, offline hint) share
  one opaque column under the header instead of three overlapping layers; a
  solid page-colour backdrop with a 40px eased fade sits behind the composer
  and its pills; the header fades the conversation out on ChatGPT's own eased curve, with no solid band; and the
  Down button appears only half a screen plus the composer from the end.
- One live indicator: while a turn runs only the turn footer shimmers; the rail
  no longer repeats the current step, and its group icons follow the group's
  kind (a tool call is a wrench, not a file).
- Editing a message swaps it into the composer; the × on "Editing message"
  puts back the draft you had (agent references included).
- - Agent progress in the notification shade (Android): while a turn runs, one
  silent ongoing notification per chat shows its title, the current step (the
  call's intent, else its command, else "Thinking"), a running clock and Stop.
  It goes when the turn ends; the completion notification is unchanged. The
  daemon sends it as a throttled `progress` event on the notification stream,
  never replayed and never sent as Web Push.
- Home-screen widget (Android): a New chat pill and your three most recent
  chats with their state (running, needs input, done) and age; a tap opens the
  chat. Follows system colours on Android 12+. Refreshes every 30 minutes, on
  app start, on pairing and when a turn starts or ends; says so when unpaired
  or offline, keeping the last chats. New chat uses a new `#new=1` link, which
  also works while a chat is open.
- Try again and Edit on the newest turn, as in ChatGPT. Try again sits in the
  last reply's action row; Edit (the newest message's menu) puts its text in
  the composer under an "Editing message" chip. Both rewind the conversation to
  before that message and re-run it, so the old turn is replaced, not
  duplicated; a chat open on the computer gets a branch instead, with a toast.
  Older messages keep Edit & resend and Edit & rewind from here.
- Sending scrolls your message to the top of the view and the reply streams
  into the space below, without chasing it past the screen (the Down button
  follows). Opening or switching chats still lands at the bottom.
- In-place work lines say how long each stretch took ("Worked for 3m 10s ·
  4 tools"), the first no longer repeats the turn's "Worked for", and the rail
  groups MCP and tool-device calls by server ("Used WorkIQ", "Used LSP").
- Session lists load older chats by themselves as you scroll, and the command
  palette's chat search also asks the daemon, so an old chat beyond the loaded
  pages is found.
- A long turn's steps stay where they happened. Summary mode used to lift all
  of a turn's work behind the one "Worked for" line at its top, so a turn that
  narrated as it went read as a wall of messages with nothing between them.
  When the agent's messages interleave its work, each stretch between two
  messages is now a "Used N tools ›" line in place that unfolds its rail
  there; "Worked for" still opens the whole turn.
- Design review inside the app: an agent's question can link to
  `…/app/#dev=live-turn&turn=<session>@<offset>`, which opens a review screen
  over the app that replays real recorded turns (read through /api/history)
  in each candidate design, with playback, key moments and a Reply button back
  to the question.

### Fixed

- Settings > Update works while a turn is running. The turn runs in omp on the
  computer, so reloading the phone app cannot interrupt it; Update used to
  refuse with "An update would interrupt work" through any long run. Only a
  message the phone has not delivered yet still holds it back.
- Settings › Model providers on a paired computer lists the providers that
  computer is signed in to, with their model counts, instead of always saying
  "Sign in on your computer to load its models". The sign-in steps show only
  when the computer has no models. Derived provider names keep brand casing
  (ChatGPT Web, OpenCode Zen).
- A view transition skipped for a newer one no longer surfaces as a page error
  ("Transition was skipped").
- A failed send is shown once, on its "Not sent" bubble, in plain words: raw
  file paths and omp's "session header is missing or malformed" no longer
  reach the screen, and no duplicate red banner repeats it.
- The blank room under a sent message is released when the reply finishes or
  the send never starts, instead of waiting for you to scroll.
- Sending an edit no longer merges your old draft into the edited message.
- Edit on a failed reply and the empty-chat prompt picker no longer toast
  "The composer isn't ready yet" after placing the text successfully.
- Images an agent embeds by a path on the computer (a Markdown image whose
  address is something like `/tmp/x.webp`)
  now load on the phone instead of "Couldn't load image". The daemon serves
  them through `GET /api/image`, only for image files whose exact path that
  conversation's transcript embeds; a file that has since been deleted says so.
- The Agents tab no longer says "Couldn't load agents … Reconnect" for a
  chat run by the desktop omp through the extension bridge. That owner never
  publishes a live agent list, so the tab now shows the agents the chat
  started (from its transcript) or the empty state.
- Conversations with pasted images no longer end in a bubble of
  "[Image #1] [blocked]": the desktop's `local-image-labels` entry, links to
  image files on the laptop, is hidden like the other non-conversation
  entries. The images themselves still show in your message.
- `scripts/android/build-runtime.sh` finds cargo-zigbuild 0.24, which rejects
  `cargo zigbuild --version`. The phone-harness tests no longer fail on hosts
  whose git config signs commits, and the `--full` musl build is `--locked`.
- Recovery settings preserve the current chat, new-session draft and workspace;
  Back restores the originating sheet, with model availability refreshed after
  provider setup.
- Failed sends expose their reason and the relevant recovery action. Messages
  with uncertain delivery offer a delivery check instead of a duplicate send.
- Notification recovery distinguishes rejected pairing from refused access.
  Supported Android shells open app or network settings directly; browser and
  older-shell fallbacks provide contextual help.
- Opening or restoring a chat preserves partially written journal records;
  parked watchers wake when a full client queue starts draining (#60).
- Retargeted maintenance probes, interrupted native outbox jobs and laptop-mode
  offline fallback retain recovery across lifecycle and ownership races (#60).
- Completed large journal tails no longer retain multi-megabyte watcher buffers
  while idle. The memory benchmark now writes its stated fixture sizes and
  reports slope units and decreasing-memory verdicts correctly.
- Auto thinking remains selected independently of each turn's effective effort,
  including reconnects, model switches and cold history pages (#27).
- Usage separates whole-session spend from current-context cost; desktop
  loaded-history figures are labelled partial rather than substituted as totals (#28).
- Questions accept an explicit empty multi-select, preserve option previews, and
  distinguish stopping an ask turn from hiding or cancelling other dialogs (#29–#31).
- Question answers retain their values through sending, queueing, transport handoff,
  refusal and uncertain delivery. Only authoritative closure settles a question;
  stale callbacks, duplicate taps and replacement credentials cannot reuse it (#40).
  Reconnect recovers missed collab closure, reused request IDs cannot inherit an
  earlier answer, and native ask settlement no longer re-locks its session mutex.
- Changes reports all seven unresolved Git index states, including files without
  conflict markers and partially resolved merges (#32).
- Multi-file edit results show every recorded file; ordinary read output no longer
  becomes a diff merely because it contains patch-like text (#33, #39).
- Browsing Commands leaves the existing composer draft untouched (#34).
- Automatic model fallback retains its reason in owner-written history and remains
  visible after reopening, without promising automatic restoration (#35).
- Unconfirmed messages offer Check delivery rather than implying a fresh resend;
  removing a local copy explicitly does not cancel accepted work (#36).
- Quiet chats distinguish known pending background work from active streaming and
  unconfirmed connectivity, without locking the composer (#37).
- Context clearing retains saved messages and displays a durable boundary showing
  where the model's current context begins (#38).
- Fast status preserves standard, priority and ultrafast service-tier distinctions;
  it no longer describes a change in model or reasoning quality (#41).
- Project prompt templates appear with editable arguments; native command names
  and aliases retain precedence (#42).
- Held-message actions select exact owner-issued IDs, not duplicate text. Taken
  steering rows have no edit/remove action; promotion retains native idle-drain
  and retry behaviour (#43).
- `!` and `!!` use OMP's configured user shell with explicitly labelled piped
  output, and the composer distinguishes Run from Send before dispatch (#44, #45).
- Generated images stay attached to every originating call, including unavailable
  slots. Shell results retain actual exit codes, timeouts, cancellation and unknown
  status rather than inventing exit 1 (#46, #50).
- Blocked tasks retain their blocker reasons in chat, Tasks and cached history (#47).
- Rewind preserves current labels on retained entries without copying abandoned
  labels or changing the source conversation (#48).
- Compaction immediately repaints its summary and invalidates older context
  measurements without reducing whole-session spend (#49, #55).
- Skills insert at the saved caret without replacing the draft. History restores
  the full original multiline message, not its search preview, while preserving
  existing text and rejecting stale asynchronous insertions (#51, #57).
- Completed agent conversations remain reopenable under their original owner;
  model catalogues cannot fall back to another project's live process or expired
  model choices (#52, #53).
- Desktop editors preserve editable prefill, multiline input and intentionally
  empty answers. Desktop delivery settings show actual read-only values or
  Unavailable rather than assumed defaults (#54, #56).
- Missing project folders explicitly refuse project files, searches, saves and
  catalogues. Files offers a labelled, opt-in home browser instead of silently
  redirecting the conversation to HOME (#58).
- Desktop agent conversations offer a direct follow-up separately from preparing
  a main-chat draft. Replies recheck the exact desktop identity, refuse stale or
  read-only destinations, and retain text while delivery is unconfirmed (#59).
- Desktop multi-select questions distinguish host-confirmed checkboxes from
  Continue and custom-answer actions, preserving native answer values (#61).
- Search results preserve native counts and coverage limits across live updates,
  history and cached messages. Literal “no matches found” matches remain visible;
  web sources open safely, and provider failures are shown as failures (#62, #63,
  #70, #71).
- Task actions refuse ambiguous duplicate names before changing the board or
  sending a native command (#64).
- Native extension errors and delayed command output remain visible without
  terminating the chat. Catch-up recovers missed notices and pending or closed
  questions without overwriting newer live state (#65, #66, #69).
- Timeline actions can continue after a specific completed answer, including
  sibling answers, separately from editing the original prompt (#72).
- File autocomplete exposes its active option and complete relative path to
  assistive technology, retains composer focus and follows keyboard selection
  when scrolling (#73).
- Withdrawn queued messages and photos are journalled per conversation and keyed
  by the owner-issued item, and stay recoverable until the phone has saved the
  draft and acknowledged it, even if the response is lost or the daemon restarts
  (#81).
- Desktop extension input handlers run before a phone prompt reaches the desktop
  session, and a handled prompt completes as handled locally (#80).
- A stopped automatic retry shows "Automatic recovery stopped" with the final
  error instead of a silent end of turn (#85).
- Mentioned files that were skipped for size or type say so in saved history, and
  executions excluded from model context are labelled as such (#84, #86).
- Message search can be limited to one project, and session IDs are searchable
  (#87, #88).
- A failed raw file download returns an HTTP error status (400, 403 or 404)
  instead of a saved error page (#78).
- Windows service installation starts the scheduled task and waits up to 30
  seconds for its listener. The PowerShell installer prints a quoted
  `$env:Path +=` line instead of a `setx` command that truncates the user path
  (#75, #77).

- Forgetting a browser pairing removes its push subscription before signing out,
  including when the computer is unreachable or notification enrolment is pending.
- Failed screen downloads keep navigation available and offer a draft-safe reload
  instead of leaving a blank app. Reload is refused if drafts cannot be saved.
- New-session drafts retain their text, photos, project and model choices across
  Back and reload. Recovery after submission retries draft cleanup without sending
  the prompt again.
- Offline launches use an installed release's complete HTML and asset set; an
  incomplete or background update cannot replace the last usable offline shell.
- Delayed new-session, fork and branch replies cannot replace a newer chat visit
  or seed a draft after the originating view or pairing has changed. Completed
  new sessions and forks refresh discovery even when navigation is stale (#67).
- Recovered text must be saved before submission; a later draft flush cannot
  resurrect content that was already sent.
- History-gap restoration advances across duplicate and metadata-only pages.
  Search and timeline jumps retain their target within the bounded transcript
  window until scrolling has landed.
- Recovering queued messages keeps numbered photo references and `attachment://`
  links matched to their original photos, including merges, removal of earlier
  photos, remounts and recovery retries (#68).
- Native saved prompts and photos remain visible after switching chats or
  reopening the view, with scoped retry, edit and discard actions.
- File saves require the original contents on the server and reject stale edits
  without discarding the phone draft. Concurrent Pulse saves are serialised;
  external tools do not share that lock.
- A busy Terminal rejects a composer command without clearing its draft or
  silently running it later.
- Late side-question replies cannot replace another chat's answers or release
  its pending question.
- Settings, focused commands and the compact pill share one compaction outcome.
  Lost acknowledgements are reconciled without issuing another compaction.
- Notification destinations arriving during native setup are retained; the
  latest tap wins once pairing is ready, unless Back cancels it.
- Collab Stop uses the supported abort request; child and desktop owners retain
  queued-message recovery. Unsupported desktop queue promotion is not offered.
- Catching up after missed updates refreshes extension feedback and prepared
  text without reconnecting, while preserving newer feedback and unsent input.
- Leaving planning restores inherited reasoning even when the planner used the
  same model with a temporary explicit level. A selected executor's explicit
  override still takes precedence.
- Plan approval and discard dialogs refuse stale answers after session or branch
  navigation, rather than compacting, executing or discarding the destination plan.
- The minimum supported Rust is 1.95, not 1.85: locked dependencies
  (`sysinfo`) already required it, so older toolchains failed with a
  dependency error instead of a version message. CI now checks the build on
  exactly that version. Clippy follows `rust-version`, so its let-chain
  suggestions now apply: 79 nested `if`s are collapsed into let-chains.
- The gate's cargo commands run with `--locked`, so a stale `Cargo.lock` fails
  instead of being re-resolved.
- The gate's web unit tests take about half as long on hosted CI (about 560 s
  to about 290 s): they run at least three files at a time instead of one on a
  2-vCPU runner, share Node's compile cache, and each test file compiles its
  DOM fixture bundle once instead of once per test.
- Hosted CI fails the Linux package install after 5 minutes instead of letting
  a stalled mirror hold the Rust gate until its 60-minute timeout.
- The daemon compiles on macOS again: `service status` built its launchd
  error message from a borrowed string.
- Tests that change `PATH` or `HOME` restore them afterwards. They used to
  leave them changed, so later tests in the same run could not find `git` or
  `mkfifo`.
- The Rust test suite passes on macOS and Windows. Tests that assumed Linux
  paths now build their fixtures the way the code under test sees them, and
  tests of Linux- or Unix-only behaviour run only there.
- Internal IRC, background-job and service-completion deliveries stay out of
  chat bodies, including live delivery, history, file-tail previews and older
  offline caches. Compact activity markers and expandable tool output remain.
- The latest thinking block streams in full and stays expanded through tool
  calls and the final reply. Only a newer thinking block replaces it; older
  thoughts remain available in the collapsed activity.
- Planning honours configured OMP model roles and reasoning levels. Approval
  finishes stopping the planner before starting implementation with the selected
  executor, without changing saved model settings.
- Plan approval can start a fresh conversation containing the approved plan,
  retaining the planning discussion, local files and unsent drafts separately.
- Taking queued messages back keeps their photos and existing draft content.
  Saved-message edits reserve their outbox copy until recovery is durable.
- Recovered outbox drafts cannot be sent until source removal finishes, preventing
  retry from recreating an already-sent message. Browser-to-native imports retain
  edit reservations, and browser dispatch claims cannot overwrite a competing edit.
- `local://` and `artifact://` reply links open read-only in Pulse, retaining
  their originating conversation and line selectors across navigation.
- History navigation offers branch summarisation. Earlier questions can be
  re-answered without destroying their original answers or branches.
- `@` file mentions find nested project files and distinguish duplicate names
  by their paths, while respecting ignore rules and project boundaries.
- Extension notices, status text and text widgets now reach the phone and survive
  reconnects without exposing internal Pulse replies. Prepared text can be
  reviewed without overwriting an existing draft or its photos.
- Deliberately visible extension messages remain in the conversation; hidden
  instructions stay hidden and background-task completion still updates agents.
- Prompt editing and sent messages highlight only magic keywords enabled by the
  owning OMP session. `^` completes scoped model mentions without changing the
  conversation's model.
- Desktop prompts now use OMP's normal keyword, model-mention, template and skill
  processing, including queued prompts and photos.
- Desktop sessions stay running through automatic compaction, retries and other
  continuations; finished notifications wait for the owner's terminal turn end.
- Retained workers show neutral Parked status instead of Needs you and no longer
  inflate amber agent badges. Explicit input requests retain their attention state.
- Changes now offers the same Wrap lines control as chat diffs.
- Changes supports saved file and line notes for native OMP reviews. Notes retain
  their captured code and become stale when changes differ. Preparing a review
  preserves existing drafts and photos; only an explicit Send starts it.
- Unsaved file edits survive accidental dismissal and Escape. Explicit Cancel
  discards the draft; unavailable storage keeps it in memory with a warning and
  prevents an update reload from losing it.
- The new-session composer now includes voice dictation, with Insert, Insert
  and send, cancellation and transcription retry before the first message.
- Failed first-message storage or settings keep the new-chat text and photos on
  screen; Retry reuses the created session. A message already saved in the outbox
  opens its chat for recovery instead of producing a duplicate draft.
- Starting a chat waits for selected images to finish preparing, including sends
  from the keyboard or dictation controls.
- Raw `switch_session` RPCs are rejected at the HTTP, child-manager and child-gate
  boundaries. Boot and managed retargeting retain exclusive session ownership.
- A competing relay host receives a host-conflict close instead of disconnecting
  the active host, guests and internal tap. Reconnection after genuine departure
  remains supported.
- Pairing codes retain the permissions and name submitted when they were issued;
  permission controls cannot change while creation is pending.
- Edit, resend and rewind preserve inline and stored photos, including photo-only
  messages. Missing photos prevent a partial send or branch.
- After a resend is saved, delivery and receipt-storage failures recover through
  its original outbox command instead of leaving an editor that can send it twice.
  A rewind whose draft cannot be saved reuses its already-created branch.
- The in-chat session switcher searches independently of the main list's filters,
  with bounded recent/search results and explicit loading and retry states.
- Cancelling QR scanning releases the camera even if permission or decoder
  preparation finishes after leaving the scanner.
- The `native-receipts` and `native-attachments` Android host-JDK harnesses
  compile again: their fakes now model the column-driven `NativeOutbox`
  upgrade.

### Removed

- Abandoned tools nothing ran, from `scripts/`: `css-where.mjs`,
  `ui-metrics.mjs`, `capture-preview.mjs`, `ux-drive.mjs`, `audit-browser.mjs`
  and its test, and an empty test file; and `native.sh` from `e2e/`.
  `scripts/ui/states/capture.mjs` covers every state the screenshot tools did.

### Initial Architecture & Platform Support

First public release. omp-pulse is a single-binary daemon that serves your omp
coding sessions to a React PWA and an Android app, so a phone can list, read,
prompt and steer the same conversations you run on your computer, or run omp
on the phone itself.

### Added

#### Daemon

- **Single binary for Linux, macOS and Windows** (tokio/axum) with the web app
  embedded. Installs via the checksum-verifying `install.sh` / `install.ps1`
  (x86_64 Linux and Windows release binaries) or a build from source.
- **CLI:** `serve` (the default), `setup`, `pair [--role control|read|admin]`,
  `doctor`, `service install|status|uninstall` (systemd user unit, launchd or
  Task Scheduler), `push-test`, `migrate-owner-token`,
  `desktop-control install`, `asr install|status` and `version`.
- **Layered configuration:** command-line flag > `OMP_PULSE_*` environment
  variable > `config.toml` > built-in default. Legacy `OMP_REMOTE_*` names are
  still honoured, and state from the earlier `omp-remote` daemon is migrated
  by copy on first run.
- **`omp-pulse doctor`** checks every link of the live-sync chain (daemon,
  collab relay URL, link registry, terminal control surface, auto-collab
  probe, omp version drift) and prints a remedy for each failure.
- **Device enrollment:** `pair` prints a QR code and link carrying a
  five-minute, single-use code; each device gets its own credential with a
  read, control or admin role and can be revoked individually.
- **Networking tiers:** loopback by default; Tailscale Serve (the HTTPS front
  door is detected and used for pairing links), Cloudflare Tunnel, or a
  degraded plain-HTTP LAN mode. When bound to a non-loopback address the
  daemon also listens on loopback so the desktop TUI's collab relay keeps
  working.
- **Session archive:** a stale-while-revalidate session index with
  content-addressed ETags and 304 responses, 50-row pages with cursors,
  pinned and live inclusions, and search across titles and message text of
  the whole archive.
- **Four live paths into omp:** a bounded pool of `omp --mode rpc-ui`
  children for conversations the daemon runs, the desktop bridge (below) for
  desktop omp processes running the bundled extension, an embedded collab
  relay so turns the desktop TUI shares with `/collab` stream to the phone
  with no third party in the path, and tailing of session files (inotify or
  native watchers, polling fallback) for everything else.
- **Desktop bridge:** a bundled omp extension streams the desktop omp's own
  events to the daemon token by token and executes phone prompts, steers,
  Stop, renames and model/reasoning changes inside the desktop process.
- **Native Collab Autostart discovery** (omp 18.1.20+, opt-in): the daemon
  finds an exact session through `omp collab list`/`omp collab link`, with
  terminal auto-adoption (herdr, kitty, tmux) and manual `/collab` as
  fallbacks.
- **Laptop handoff:** "Open on computer" starts the conversation in a herdr
  tab on the desktop (after stopping the phone-side agent), and "Close on
  computer" exits a verified idle desktop session without losing history.
- **Child pool that holds its cap:** lazy spawn, admission control, LRU
  eviction that never evicts a busy child, idle and unwatched reaping,
  recycling past a resident + swap memory limit, and process-group
  termination so MCP servers do not outlive their child.
- **Phone-side omp features over RPC:** a small child extension adds plan
  mode, timeline "Go here", entry labels and `!!` (run without context) to
  daemon-run sessions, and conversations started from the phone get a short
  generated title.
- **WebSocket hub:** bounded per-client queues with a byte budget, in-place
  conflation, delta frames keyed by base sequence, snapshot/resync for clients
  that fall behind, raw-DEFLATE binary frames for large payloads, and a
  first-screen bundle that merges history, state and the listing ETag.
- **Live activity:** what each agent is doing (thinking, writing, which tool),
  the turn clock and tokens per second, pushed to the session list, the open
  chat and native notifications.
- **Workspace APIs:** git working-tree changes per session (`/api/changes`),
  file listing, preview, raw download and save, HTML export, user shell
  commands with live output, slash commands that print output without
  entering the conversation, and conversation delete.
- **In-house Web Push** (VAPID, RFC 8291; aes128gcm, RFC 8188) built on
  `p256`, `hkdf` and `aes-gcm`, with no OpenSSL dependency, so the Windows and
  musl targets build cleanly.
- **Local dictation:** `omp-pulse asr install` sets up an on-device
  speech-to-text sidecar (English-only by default, `--multilingual`
  optional); the model loads on demand and is released when idle.

#### Web client

- **React PWA at `/app/`,** installable with a service worker, served from
  precompressed copies; the same app runs in browsers and inside the Android
  shell.
- **Session list:** active (working or waiting on you) sessions on top,
  unread markers, per-row model, context bar and cost, one search over
  sessions, projects and messages, a project filter, pull to refresh and
  paging into older history.
- **Chat:** streaming markdown that never shows half-drawn tables or code
  fences, syntax highlighting, collapsible tool runs, shell command cards with
  live output and exit codes, diffs with word-level highlights, plan cards,
  inline images, reasoning windows and a per-turn footer with duration,
  speed and cost.
- **Workspace tabs** beside the chat (Chat, Agents, Tasks, Changes, Files,
  Terminal) with swipe navigation and badges, plus a session switcher drawer.
- **Composer:** model and thinking chip, context meter and session cost,
  image attachments and camera, slash-command palette, `@` file mentions,
  prompt history, `!cmd`/`!!cmd`, and Steer, Queue or Stop-and-send while the
  agent works, with queued messages shown as editable chips.
- **Model picker:** Current, Recent and per-provider groups, each model's own
  thinking levels, fast mode, context window sizes and maker logos.
- **omp features from the phone:** plan mode with approval, goal mode,
  `/btw` side questions, an editable todo list, `/context`, provider usage
  limits under `/usage`, `/export`, `/fork`, `/tree`, compaction with a live
  progress pill, and omp's ask/confirm/select/input dialogs.
- **Agents tab:** background subagents with status, model and context, their
  live transcripts, and per-agent stop or steer.
- **Tasks tab:** the plan with progress and a turn timeline with rewind,
  "Go here" and labels.
- **Changes, Files and Terminal tabs:** the session's git diff, a folder
  browser with file viewer and editor, and a shell with live output.
- **New session screen:** pick a project and model, attach images and send
  the first message in one step.
- **Durable sending:** every prompt gets a command ID and a receipt (saved,
  received, running, completed, failed, uncertain); sends survive reloads and
  reconnects, and uncertain sends are never replayed automatically.
- **Offline support:** bounded offline history per conversation, drafts and
  attachment drafts that survive restarts, and connection state derived from
  the socket rather than the browser's online flag.
- **Settings:** device management (pair another device by QR, roles,
  revocation), diagnostics with redacted export, notification controls and
  text size.
- **Accessibility:** layouts that hold up at large system text and
  screen-reader announcements for agent progress.

#### Android app

- **Capacitor shell** around the same `/app/` interface, with no second chat
  implementation; upgrades keep the pairing credential.
- **Native notifications** over the daemon's own stream (no Firebase):
  agent-finished and needs-input alerts with inline Reply, a live ongoing
  notification per working agent with Stop and Reply, chat bubbles,
  per-chat and per-event switches, quiet hours and Android channels.
- **Native durable outbox** shared by the app, bubbles and notification
  replies, so sends do not depend on a suspended WebView.
- **Deep links, predictive Back** (sheets, panels and screens close one layer
  at a time), QR-code pairing and an offline fallback page.

#### Phone mode

- **Run omp on the phone itself:** on first run the public APK asks
  "Run on this phone" or "Connect a laptop". Phone mode downloads a pinned,
  sha256-verified Alpine Linux runtime and omp (~250 MB, resumable), runs the
  daemon inside a proot guest under a foreground service, and points the app
  at it.
- **Daemon ships inside the APK** as a static aarch64 musl library, so an app
  update upgrades the daemon with no download; a new omp pin replaces omp on
  the next start.
- **Device coverage:** arm64 Android 7.0+, 4 KB and 16 KB page sizes,
  secondary users and work profiles, automatic port fallback, and side-by-side
  `.dev` test installs.
- **Model provider sign-in** from Settings, showing which providers are
  signed in.
- **Phone harness (opt-in):** with **Phone tools for the agent** turned on,
  the `android` CLI, `phone` MCP server, skills, job broker and memory guard
  from `phone-harness/` are merged into the device's copy, keeping the agent's own
  edits. Off by default.
- **Lighter on memory:** a smaller default child pool on Android, children
  released soon after nobody is viewing their chat or when free memory runs
  low, and leaner JavaScript start-up for each child.
- **Tooling:** `scripts/android/build-runtime.sh`,
  `scripts/android/build-on-phone.sh` (build the APK on a phone) and
  `scripts/android/runtime-pins.mjs` (check and bump the pinned runtime).

### Security

- The desktop owner credential never appears in a pairing link; the device
  registry stores only SHA-256 hashes of credentials and enrollment codes.
- Revoked credentials are refused on new requests, and open streams recheck
  revocation before delivering private data.
- Web Push subscriptions are bound to the authenticated device.
- One writer per session file: the daemon never lets a second omp process
  append to a conversation the desktop holds open.
- A plaintext `ws://` collab relay on a non-loopback host is refused, because
  the room key travels in the link.

### Known limitations

- Plain-HTTP LAN is not a secure context: the PWA cannot install, Web Push
  does not register, and binary frames fall back to text.
- Windows has no terminal auto-adoption; use native Collab Autostart or run
  `/collab` once per room.
- The APK is arm64-only and is distributed by sideloading or Obtainium, not
  Google Play.
- Aggressive OEM battery optimisation can still stop background delivery or
  the phone-mode daemon.

[Unreleased]: https://github.com/JulianCodespoti/omp-pulse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JulianCodespoti/omp-pulse/releases/tag/v0.1.0
