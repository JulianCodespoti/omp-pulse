package com.omppulse.app;

/**
 * Bubble target activity.
 *
 * Bubble spec. The system renders this inside the bubble window. It is the same
 * Capacitor shell as the launcher, so plugins, the native sender bridge,
 * pairing, file chooser, media permissions, recovery and Back behave
 * identically; only the window differs. A new intent reuses the live document
 * by replacing the hash, which keeps the bubble — and the notification
 * supporting it — alive.
 *
 * INVARIANT: never crash on missing extras — the shared shell shows the
 * configured app root when no session hash is present.
 */
public class BubbleActivity extends OmpShellActivity {
    @Override
    protected void onBackUnhandled() {
        // A bubble is its own window; sending it to the background would leave
        // the task hidden rather than dismissing the bubble.
        finish();
    }

    @Override
    protected boolean reopensLaunchTarget() {
        // The bubble's launch Intent IS its conversation: a bubble restored
        // after process death must reopen that chat, not the app root.
        return true;
    }
}
