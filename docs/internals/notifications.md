# Notifications

This page covers how a turn ending, a question or a failure becomes a notification:
one payload built by the daemon, two transports (Web Push for browsers, a native
event stream for the Android app), and the rules that keep the shade readable. The
overview is in [architecture.md](architecture.md); turning notifications on is in the
user docs ([configuration](../user/configuration.md)).

## One payload, two transports

`push_payload` in `src/server/push.rs` builds one shape,
`{title, body, sessionPath, kind, tag, reqId?}`, and fans it out to two transports
that must never duplicate on one handset:

- **Web Push** (browser): `PushManager` and the service worker. The RFC 8291
  `aes128gcm` encryption and RFC 8292 VAPID signing are implemented in `push.rs`
  itself, not through a crate, so no dependency pulls OpenSSL. The subscription list
  is device-scoped (`DEVICE_SCOPE`), and the `tag` `omp-<kind>-<hash>` makes a new
  notification replace the previous one of the same kind for the same session.
- **Native stream** (Android app): `NotifyService` holds `/api/notify/stream` open
  (Server-Sent Events, with `Last-Event-ID` replay). Android 14+ uses the
  `remoteMessaging` foreground service type for cross-device conversation
  continuity; older versions use `dataSync`. It posts through `NotificationHelper`
  channels. No Firebase.

Browser Web Push and native notifications are separate opt-ins, and the daemon does
not merge separately enrolled devices: a phone with both enabled alerts twice.

The Android app loads the same React interface and chat runtime in a Capacitor
WebView. `OmpNotify` connects pairing and settings to the native service,
notification channels, event switches and quiet hours.

## Running-turn progress (native only)

While a turn runs, the phone shows one silent ongoing notification (channel
`omp_progress`, importance LOW) with the session title, the live line (the running
tool call's intent, else its argument or name, else "Thinking") and a chronometer,
plus a Stop action that posts `/api/abort`. `authority::activity::emit` (the one place
every turn start, tool change and end passes, for daemon children and bridged
desktop sessions alike) feeds `server/push/progress.rs`, which throttles to one
update per session per 2.5 s and sends them as `event: progress` on the same stream.
They are not notifications in the table above: no SSE `id` (so `Last-Event-ID` stays a
replay cursor), never in the replay ring (status ticks would evict the `agent_end` a
dozing phone needs), never Web Push. A connecting stream is sent the running turns,
and `NotifyService` first drops every progress notification still up, so a turn whose
end the phone missed cannot tick forever (a 15-minute timeout is the last resort).
The "Agent finished" switches also gate it, and the completion notification is
unchanged.

## Native reconnect backoff

Native reconnect backoff is 1, 2, 4, 8, 16 and then at most 30 seconds, plus
0–699 ms of jitter. HTTP 200 does not reset the failure streak: short EOFs and body
failures remain unhealthy. The loop-local `NotifyReconnectBackoff` resets only after
a recognized JSON-object ping or notification/default event, or a comment line, is
received at least 25 seconds after that connection's HTTP 200 headers. This matches
the server heartbeat interval but is measured on the client, so the first server
ping may arrive slightly before the threshold and a later ping will qualify.
Immediate replay, empty envelopes, unknown events, invalid JSON and incomplete data
frames do not reset retries. Comment-line parsing, explicit reconnect interrupts,
cursor updates and notification eligibility are unchanged. The policy is covered by
`python3 mobile/android/host-tests/notify-backoff/run.py`; that host-JDK harness does
not replace Android build or device acceptance.

## Stream liveness and the unpaired service

A stream that stops delivering bytes is dead: the connection's socket read timeout
is 60 seconds against the server's 25-second pings, and it bounds both the wait for
response headers and every gap in the body. A timeout throws
`SocketTimeoutException` into the same failure path as any transport error, so it
records the error, waits the current backoff delay and advances the failure streak.
This replaced a `Handler` watchdog that checked the stream every 15 seconds for the
service's whole life; a read timeout costs nothing while bytes flow and, measured on
the monotonic clock, does not wake a suspended phone. The last-event time still
decides whether screen-on reconnects (`isStreamFresh`).

Without a pairing token the loop exits and the service stops itself instead of
polling for a token every 5 seconds. Every path that stores a token starts the
service with it (`OmpNotify.setToken` through `startWithToken`, and `startIfPaired`
at boot, app launch and when background delivery is switched on). The stop runs on
the main thread, ordered against `onStartCommand`, so a token that arrives while the
loop is exiting restarts it, and `stopSelfResult` keeps a service whose newer start
request is still pending.

## The foreground notice

The native stream runs in a foreground service, which Android requires to show an
ongoing notification. Its channel `omp_foreground_v2` is `IMPORTANCE_LOW`, and the
notice itself is `PRIORITY_MIN`, silent and without a timestamp.

The first version asked for `IMPORTANCE_MIN` on a channel named `omp_foreground` and
never got it: Android raises foreground-service channels to at least LOW, and it
restores a deleted channel's old settings when the same id is recreated (so apps
cannot reset user preferences), so the delete-and-recreate meant to migrate it ran
on every call and stayed LOW. A channel's importance therefore cannot be changed in
place: a change needs a new channel id, with the old id deleted once, as
`NotificationHelper.ensureChannels` does for `omp_foreground`.

## Small icon

Every notification used `android.R.drawable.ic_dialog_info`, the stock info circle,
so omp-pulse looked like a system message. `NotificationHelper.smallIconRes()` now
returns `R.drawable.ic_stat_omp`, a white single-colour vector of the pulse line and
end dot from `web/public/icon.svg` (the launcher icon's plate and gradients would
render as a solid blob, since Android reads only the alpha channel). Conversation
notifications are tinted with the app accent `0xFF48AAFF`.

## Grouping

Conversation notifications (turn finished, needs input, alerts) used to pile up as
separate rows. They share the group `omp-pulse.conversations`; the foreground notice
and the progress notification are outside it. While two or more are active
`updateConversationSummary` posts a group summary (tag `omp-conversations-summary`,
`GROUP_ALERT_CHILDREN`, so the summary never alerts itself); below two it cancels it,
including after `clearConversationNotifications`. Per-conversation tag replacement and
bubbles are unchanged. A notification that times out (below) does not re-run the
count, so a summary can outlive its last-but-one child until the next post or clear.

## The conversation on screen

A finished turn in the chat you are reading left a notification in the shade that
you had already seen. The web layer reports the open conversation through
`OmpNotify.setForegroundConversation({ sessionPath })` (absent or empty means none);
the plugin clears it on activity pause and destroy. When an `agent_end` notification
is for that conversation, `post` sets `setTimeoutAfter(4000)` (API 26+): it still
sounds and vibrates per its channel, then removes itself. `needs_input` never gets a
timeout, since a question that disappears goes unanswered.

The always-notify invariant is unchanged: the daemon still notifies on every turn end
even with the app open, and nothing here suppresses a notification.

## INVARIANT: the shade is plain text

`BigTextStyle` and `MessagingStyle` render plain text, so markdown (`**bold**`,
`` `code` ``, `# heading`, `> quote`, links) must never reach a payload.
`strip_notify_markup` in `src/server/push.rs` is the one scrub function; assistant
replies reach it through `summarise_assistant`, which builds every `agent_end` body.
Session titles (`session_title`) and dialog prompts (`maybe_push_needs_input`) are
passed through as they are. A new notification kind or body source that can carry
markdown must call it; a notification showing `**` or a backtick is a bug.
