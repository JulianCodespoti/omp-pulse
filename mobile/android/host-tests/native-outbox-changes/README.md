# Native outbox change signal: host-JDK test

```sh
python3 mobile/android/host-tests/native-outbox-changes/run.py
```

`NativeOutbox` signals every committed mutation to the page bridge, which posts
`{"event":"outbox-changed"}` so the page no longer lists the outbox every second.
The signal is coalesced to at most one call per 250 ms.

## What is real

`NativeOutbox.ChangeSignal` is extracted verbatim from
`mobile/android/app/src/main/java/com/omppulse/app/NativeOutbox.java`, and
`OutboxPageRegistry.java` is compiled as is, both with `-Xlint:all -Werror`. The test
drives the signal with a fake clock and a fake scheduler that runs a task only when
the test advances time to it, and checks: no listener arms no timer; the first change
fires at once; a burst inside the window arms one trailing call at the window's end; a
steady stream stays at or below 4 Hz with the final change still announced; clearing
the listener cancels the trailing timer, and an already queued task from the old
generation cannot notify a replacement listener. The registry assertions cover
independent main and bubble channels, navigation of one page leaving the other's
channel alone, obsolete renderer generations being refused, and a failing page not
suppressing another.

## What is not

The production scheduler (`DEADLINES`), the bridge's main-thread post, the
`JavaScriptReplyProxy` and the WebView are not exercised; nor is which mutators call
the signal (the receipt harness compiles them against a counting stub).
