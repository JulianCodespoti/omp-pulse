package com.omppulse.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

/** Non-secret shell facts: a capability marker so a new shell fails closed without its bridge, and the system font scale. */
public final class NativeShellMarker {
    private final Context context;

    public NativeShellMarker(Context context) {
        this.context = context;
    }

    @JavascriptInterface public boolean senderRequired() { return true; }

    /**
     * The system font size (Settings › Display), e.g. 0.9 on a phone set one
     * step small. The page applies it to its root rem (platform/appearance.ts),
     * so it scales text and boxes together the way sp scales a native app;
     * WebView textZoom stays pinned at 100 because it grows text only.
     */
    @JavascriptInterface public float fontScale() {
        return context.getResources().getConfiguration().fontScale;
    }
}
