package com.omppulse.app.phone;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import java.io.File;
import java.io.FileOutputStream;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Screen reading and input for {@link PhoneApi}. Android only grants these powers to an accessibility
 * service the user enabled in Settings, so the service just publishes itself while bound and does
 * nothing with events: every action is pulled by an API request.
 */
public class PhoneAccessibilityService extends AccessibilityService {
    /** Deeply nested UIs (WebViews) would otherwise make the dump unbounded. */
    private static final int MAX_DUMP_DEPTH = 60;

    private static volatile PhoneAccessibilityService instance;

    public static PhoneAccessibilityService get() {
        return instance;
    }

    /** True if the user enabled the service; it may still be unbound (e.g. right after enabling). */
    public static boolean isEnabled(Context ctx) {
        String enabled = Settings.Secure.getString(ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled == null) return false;
        // Entries may be flattened in short ("pkg/.phone.X") or long form; compare parsed components.
        ComponentName self = new ComponentName(ctx, PhoneAccessibilityService.class);
        for (String entry : enabled.split(":")) {
            if (self.equals(ComponentName.unflattenFromString(entry))) return true;
        }
        return false;
    }

    @Override
    public void onServiceConnected() {
        instance = this;
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Pull model: nothing to react to.
    }

    @Override
    public void onInterrupt() {
        // No ongoing feedback to interrupt.
    }

    // ---- Reading ----

    /** Text tree of every interactive window (falls back to the active window). */
    public String dump() {
        StringBuilder sb = new StringBuilder();
        boolean any = false;
        List<AccessibilityWindowInfo> windows = getWindows();
        if (windows != null) {
            for (AccessibilityWindowInfo window : windows) {
                AccessibilityNodeInfo root = window.getRoot();
                if (root == null) continue;
                sb.append("# window ").append(window.getId()).append(" type=").append(window.getType()).append('\n');
                dumpNode(root, 0, sb);
                any = true;
            }
        }
        if (!any) {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) dumpNode(root, 0, sb);
        }
        return sb.toString();
    }

    private static void dumpNode(AccessibilityNodeInfo node, int depth, StringBuilder sb) {
        if (depth > MAX_DUMP_DEPTH) return;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        for (int i = 0; i < depth; i++) sb.append("  ");
        sb.append(node.getClassName());
        if (!TextUtils.isEmpty(node.getText())) sb.append(" text=\"").append(clean(node.getText())).append('"');
        if (!TextUtils.isEmpty(node.getContentDescription())) {
            sb.append(" desc=\"").append(clean(node.getContentDescription())).append('"');
        }
        if (node.getViewIdResourceName() != null) sb.append(" id=").append(node.getViewIdResourceName());
        sb.append(" [").append(bounds.left).append(',').append(bounds.top)
                .append("][").append(bounds.right).append(',').append(bounds.bottom).append(']');
        if (node.isClickable()) sb.append(" clickable");
        if (node.isEditable()) sb.append(" editable");
        if (node.isScrollable()) sb.append(" scrollable");
        if (node.isFocused()) sb.append(" focused");
        sb.append('\n');
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) dumpNode(child, depth + 1, sb);
        }
    }

    /** One line per node: escape newlines and swap quotes so the CLI can parse `text="..."`. */
    private static String clean(CharSequence s) {
        return s.toString().replace("\n", "\\n").replace("\"", "'");
    }

    // ---- Acting ----

    /** Clicks the first node whose text or description contains {@code text} (case-insensitive). */
    public boolean clickText(String text) {
        String needle = text.toLowerCase(Locale.ROOT);
        List<AccessibilityWindowInfo> windows = getWindows();
        if (windows != null) {
            for (AccessibilityWindowInfo window : windows) {
                AccessibilityNodeInfo root = window.getRoot();
                if (root != null && clickIn(root, needle)) return true;
            }
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root != null && clickIn(root, needle);
    }

    private boolean clickIn(AccessibilityNodeInfo node, String needle) {
        if (!matches(node.getText(), needle) && !matches(node.getContentDescription(), needle)) {
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null && clickIn(child, needle)) return true;
            }
            return false;
        }
        // Labels are often non-clickable children of the clickable row.
        for (AccessibilityNodeInfo n = node; n != null; n = n.getParent()) {
            if (n.isClickable() && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
        }
        // Custom-drawn views (games, Compose without semantics) only react to real touches.
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return tap(bounds.centerX(), bounds.centerY());
    }

    private static boolean matches(CharSequence s, String needle) {
        return s != null && s.toString().toLowerCase(Locale.ROOT).contains(needle);
    }

    public boolean tap(int x, int y) {
        return swipe(x, y, x, y, 50L);
    }

    /** Blocks until the gesture completes; false if cancelled (e.g. a touch interrupted it). */
    public boolean swipe(int x1, int y1, int x2, int y2, long ms) {
        long duration = Math.max(1L, ms);
        Path path = new Path();
        path.moveTo(x1, y1);
        if (x1 != x2 || y1 != y2) path.lineTo(x2, y2);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, duration))
                .build();
        CountDownLatch done = new CountDownLatch(1);
        boolean[] completed = new boolean[1];
        GestureResultCallback callback = new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription description) {
                completed[0] = true;
                done.countDown();
            }

            @Override
            public void onCancelled(GestureDescription description) {
                done.countDown();
            }
        };
        if (!dispatchGesture(gesture, callback, null)) return false;
        try {
            return done.await(duration + 5000, TimeUnit.MILLISECONDS) && completed[0];
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /** Sets the text of the focused editable field (replaces its content). */
    public boolean type(String text) {
        AccessibilityNodeInfo focus = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focus == null || !focus.isEditable()) return false;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return focus.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    public boolean key(String name) {
        int action;
        switch (name) {
            case "back": action = GLOBAL_ACTION_BACK; break;
            case "home": action = GLOBAL_ACTION_HOME; break;
            case "recents": action = GLOBAL_ACTION_RECENTS; break;
            case "notifications": action = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick_settings": action = GLOBAL_ACTION_QUICK_SETTINGS; break;
            default: return false;
        }
        return performGlobalAction(action);
    }

    /** Writes a PNG of the default display to {@code file}. */
    public void screenshot(File file) throws Exception {
        if (Build.VERSION.SDK_INT < 30) throw new Exception("screenshot needs Android 11+");
        Bitmap bitmap = capture();
        File dir = file.getParentFile();
        if (dir != null) dir.mkdirs();
        try (FileOutputStream out = new FileOutputStream(file)) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        } finally {
            bitmap.recycle();
        }
    }

    @RequiresApi(30)
    private Bitmap capture() throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        Bitmap[] out = new Bitmap[1];
        int[] errorCode = new int[1];
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(@NonNull ScreenshotResult result) {
                HardwareBuffer buffer = result.getHardwareBuffer();
                try {
                    Bitmap wrapped = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                    // Hardware bitmaps cannot be compressed; copy to a software bitmap first.
                    if (wrapped != null) out[0] = wrapped.copy(Bitmap.Config.ARGB_8888, false);
                } finally {
                    buffer.close();
                    done.countDown();
                }
            }

            @Override
            public void onFailure(int code) {
                errorCode[0] = code;
                done.countDown();
            }
        });
        if (!done.await(10, TimeUnit.SECONDS)) throw new Exception("screenshot timed out");
        if (out[0] == null) throw new Exception("screenshot failed (code " + errorCode[0] + ")");
        return out[0];
    }
}
