package com.omppulse.app.bridge;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JavascriptInterface;

import androidx.core.app.NotificationManagerCompat;

import com.omppulse.app.NativeConfig;
import com.omppulse.app.NotifyService;
import com.omppulse.app.OmpShellActivity;
import com.omppulse.app.phone.PhoneAccessibilityService;
import com.omppulse.app.runtime.LocalPulseService;
import com.omppulse.app.runtime.LocalRuntime;
import com.omppulse.app.runtime.RuntimeStatus;
import com.omppulse.app.runtime.RuntimeSpec;

import org.json.JSONObject;

/**
 * {@code window.OmpLocal}: the run-mode bridge the onboarding UI and the
 * offline page use to pick phone or laptop, install and start the on-device
 * runtime, sign in to a model provider and request the Android permissions
 * the phone agent needs. Contract: web/src/platform/local-mode.ts.
 *
 * INVARIANT: addJavascriptInterface exposes this object to every document the
 * WebView ever shows, including pages a link navigates to. Every method first
 * checks that the current document is one of ours — the bundled app (or its
 * offline page), the on-device daemon in phone mode, or the configured laptop
 * — and otherwise does nothing, returning "{}" / "[]". Methods run on the
 * WebView's JavaBridge thread, so the URL comes from the activity's tracked
 * main-frame URL; WebView.getUrl() may only be called on the UI thread.
 */
public final class LocalModeBridge {
    private static final String TAG = "OmpLocalModeBridge";
    private static final String BUNDLED_ASSETS = "file:///android_asset/public/";
    private static final String PREFS = "omp_pulse_shell";
    private static final String KEY_ASKED_NOTIFICATIONS = "asked_post_notifications";
    // The page re-reads access() itself after a request, so these codes need no result handler.
    private static final int REQUEST_STORAGE = 0x4C01;
    private static final int REQUEST_NOTIFICATIONS = 0x4C02;

    private final OmpShellActivity activity;
    private final ComputerProbe computerProbe = new ComputerProbe(
            ComputerProbe::fetchOnline, LocalModeBridge::canonicalComputerUrl,
            android.os.SystemClock::elapsedRealtime, ComputerProbe.SWEEP_GAP_MS);

    public LocalModeBridge(OmpShellActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String state() {
        if (!trusted()) return "{}";
        try {
            LocalRuntime runtime = LocalRuntime.get(activity);
            RuntimeStatus.Snapshot status = runtime.status();
            RuntimeSpec spec = runtime.spec();
            boolean supported = runtime.isSupported();
            return new JSONObject()
                    .put("mode", runtime.mode().json())
                    .put("supported", supported)
                    .put("installed", runtime.isInstalled())
                    .put("phase", status.phase())
                    .put("message", orNull(status.message()))
                    .put("progress", status.progress())
                    .put("error", orNull(status.error()))
                    .put("appUrl", supported ? runtime.appUrl() : JSONObject.NULL)
                    .put("laptopUrl", orNull(NativeConfig.laptopUrl(activity)))
                    .put("computers", new org.json.JSONArray(NativeConfig.computers(activity)))
                    .put("downloadBytes", spec.downloadBytes())
                    .put("ompVersion", spec.ompVersion())
                    .put("phoneTools", runtime.phoneTools())
                    .toString();
        } catch (Exception e) {
            Log.w(TAG, "state failed", e);
            return "{}";
        }
    }

    /**
     * Persist the run mode and restart the activity, which then loads that
     * mode's document with a matching Capacitor server.url.
     */
    @JavascriptInterface
    public void setMode(String value) {
        if (!trusted()) return;
        LocalRuntime.Mode mode = LocalRuntime.Mode.fromJson(value);
        if (mode == null) return;
        LocalRuntime runtime = LocalRuntime.get(activity);
        if (mode == LocalRuntime.Mode.PHONE && !runtime.isSupported()) return;
        runtime.setMode(mode);
        // The listener streams from the previous mode's daemon with that
        // daemon's token; the restarted activity starts it again in the new scope.
        if (mode == LocalRuntime.Mode.UNSET) ProviderLogin.stop(runtime);
        NotifyService.stop(activity);
        if (mode == LocalRuntime.Mode.PHONE) runtime.prepare();
        else LocalPulseService.stop(activity);
        activity.runOnUiThread(activity::restartForMode);
    }

    /**
     * One step from a scanned or pasted pairing link to a paired computer:
     * saves the laptop address from the link, switches to laptop mode and
     * restarts onto that page with the link's one-use code, which the page
     * redeems at once. Returns {"ok":true} or {"ok":false,"error":"…"}.
     * Typing an address and then a code by hand was the only way before.
     */
    @JavascriptInterface
    public String connectLaptop(String link) {
        if (!trusted()) return "{}";
        try {
            String[] parsed;
            try {
                parsed = NativeConfig.laptopFromPairingLink(link);
            } catch (IllegalArgumentException e) {
                return new JSONObject().put("ok", false).put("error", e.getMessage()).toString();
            }
            NativeConfig.saveLaptopUrl(activity, parsed[0]);
            LocalRuntime.get(activity).setMode(LocalRuntime.Mode.LAPTOP);
            NotifyService.stop(activity);
            LocalPulseService.stop(activity);
            String hash = "#pair=" + parsed[1] + "&connect=1";
            activity.runOnUiThread(() -> activity.restartForMode(hash));
            return new JSONObject().put("ok", true).toString();
        } catch (Exception e) {
            Log.w(TAG, "connectLaptop failed", e);
            return "{\"ok\":false,\"error\":\"Could not connect to that computer.\"}";
        }
    }

    /**
     * Switch to a computer this phone already connected to: make it active,
     * enter computer mode and restart onto it. Its page still holds its own
     * credential, so no pairing is repeated. Unknown URLs are refused.
     */
    @JavascriptInterface
    public String useComputer(String url) {
        if (!trusted()) return "{}";
        try {
            if (url == null || !NativeConfig.computers(activity).contains(url)) {
                return "{\"ok\":false,\"error\":\"That computer isn't saved on this phone.\"}";
            }
            NativeConfig.saveLaptopUrl(activity, url);
            LocalRuntime.get(activity).setMode(LocalRuntime.Mode.LAPTOP);
            NotifyService.stop(activity);
            LocalPulseService.stop(activity);
            activity.runOnUiThread(activity::restartForMode);
            return new JSONObject().put("ok", true).toString();
        } catch (Exception e) {
            Log.w(TAG, "useComputer failed", e);
            return "{\"ok\":false,\"error\":\"Couldn't switch to that computer.\"}";
        }
    }

    /**
     * Reachability of the saved computers for the stopped-phone-mode chooser:
     * JSON {url: "checking"|"online"|"offline"}, one entry per saved computer.
     * {@code true} starts or refreshes a bounded background sweep and returns
     * what is known so far; {@code false} cancels it and forgets the answers.
     * Read-only: only this phone's own saved canonical addresses are
     * contacted, with no credential, and nothing here changes the active
     * computer, mode, tokens or list order. Never blocks on the network.
     */
    @JavascriptInterface
    public String computerStatus(boolean active) {
        if (!trusted()) return "{}";
        try {
            if (!active) {
                computerProbe.cancel();
                return "{}";
            }
            JSONObject out = new JSONObject();
            for (java.util.Map.Entry<String, String> entry
                    : computerProbe.refresh(NativeConfig.computers(activity)).entrySet()) {
                out.put(entry.getKey(), entry.getValue());
            }
            return out.toString();
        } catch (Exception e) {
            Log.w(TAG, "computerStatus failed", e);
            return "{}";
        }
    }

    /** A saved address is contacted only in the exact form {@link NativeConfig#normalizeLaptopUrl} produces. */
    private static boolean canonicalComputerUrl(String url) {
        try {
            return url != null && url.equals(NativeConfig.normalizeLaptopUrl(url));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /**
     * Forget a saved computer. Forgetting the one in use while in computer
     * mode restarts onto the next one, or onto the first-run screen when none
     * are left.
     */
    @JavascriptInterface
    public void forgetComputer(String url) {
        if (!trusted() || url == null) return;
        boolean activeChanged = NativeConfig.forgetComputer(activity, url);
        LocalRuntime runtime = LocalRuntime.get(activity);
        if (!activeChanged || runtime.mode() != LocalRuntime.Mode.LAPTOP) return;
        NotifyService.stop(activity);
        if (NativeConfig.laptopUrl(activity) == null) runtime.setMode(LocalRuntime.Mode.UNSET);
        activity.runOnUiThread(activity::restartForMode);
    }

    /** Install or upgrade the runtime if needed, then start it; progress shows in state(). */
    @JavascriptInterface
    public void prepare() {
        if (!trusted()) return;
        LocalRuntime.get(activity).prepare();
    }

    /** Settings › Phone access › "Phone tools for the agent"; state().phoneTools reads it back. */
    @JavascriptInterface
    public void setPhoneTools(boolean on) {
        if (!trusted()) return;
        LocalRuntime.get(activity).setPhoneTools(on);
    }

    @JavascriptInterface
    public String providers() {
        if (!trusted()) return "[]";
        return ProviderLogin.providers(LocalRuntime.get(activity));
    }

    @JavascriptInterface
    public void loginStart(String providerId) {
        if (!trusted()) return;
        ProviderLogin.start(activity, LocalRuntime.get(activity), providerId);
    }

    @JavascriptInterface
    public void loginInput(String text) {
        if (!trusted()) return;
        ProviderLogin.input(text);
    }

    @JavascriptInterface
    public String loginState() {
        if (!trusted()) return "{}";
        return ProviderLogin.state();
    }

    @JavascriptInterface
    public void loginCancel() {
        if (!trusted()) return;
        ProviderLogin.cancel();
    }

    /** What the phone agent may do: {storage,install,accessibility,battery,notifications}. */
    @JavascriptInterface
    public String access() {
        if (!trusted()) return "{}";
        try {
            return new JSONObject()
                    .put("storage", hasStorage())
                    .put("install", Build.VERSION.SDK_INT < 26
                            || activity.getPackageManager().canRequestPackageInstalls())
                    .put("accessibility", PhoneAccessibilityService.isEnabled(activity))
                    .put("battery", ignoresBatteryOptimizations())
                    .put("notifications", NotificationManagerCompat.from(activity).areNotificationsEnabled())
                    .toString();
        } catch (Exception e) {
            Log.w(TAG, "access failed", e);
            return "{}";
        }
    }

    /** Open the system screen or prompt that grants {@code kind} (see access()). */
    @JavascriptInterface
    public void grant(String kind) {
        if (!trusted() || kind == null) return;
        activity.runOnUiThread(() -> {
            switch (kind) {
                case "storage": grantStorage(); break;
                case "install": grantInstall(); break;
                case "accessibility": launch(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS), null); break;
                case "battery": grantBattery(); break;
                case "notifications": grantNotifications(); break;
                default: break;
            }
        });
    }

    /** Restricted settings and permanently denied permissions need the app's own details page. */
    @JavascriptInterface
    public void openAppSettings() {
        if (!trusted()) return;
        activity.runOnUiThread(() ->
                launch(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri()), null));
    }

    @JavascriptInterface
    public void openNetworkSettings() {
        if (!trusted()) return;
        activity.runOnUiThread(() -> {
            if (trusted()) launch(new Intent(Settings.ACTION_WIRELESS_SETTINGS), null);
        });
    }

    private boolean trusted() {
        String url = activity.trackedPageUrl();
        if (url == null) return false;
        if (url.startsWith(BUNDLED_ASSETS)) return true;
        String origin = NativeConfig.originOf(url);
        if (origin == null) return false;
        if (origin.equals(NativeConfig.originOf(NativeConfig.BUNDLED_APP_URL))) return true;
        LocalRuntime runtime = LocalRuntime.get(activity);
        if (runtime.mode() == LocalRuntime.Mode.PHONE && origin.equals(NativeConfig.originOf(runtime.appUrl()))) {
            return true;
        }
        return origin.equals(NativeConfig.originOf(NativeConfig.laptopUrl(activity)));
    }

    /** The guest reaches /sdcard through the host's view of shared storage. */
    private boolean hasStorage() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        if (Build.VERSION.SDK_INT < 23) return true;
        return activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean ignoresBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < 23) return true;
        PowerManager power = (PowerManager) activity.getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(activity.getPackageName());
    }

    private Uri packageUri() {
        return Uri.parse("package:" + activity.getPackageName());
    }

    private void grantStorage() {
        if (Build.VERSION.SDK_INT >= 30) {
            // Some OEM builds lack the per-app screen; the list still works.
            launch(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, packageUri()),
                    new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
        } else if (Build.VERSION.SDK_INT >= 23) {
            activity.requestPermissions(new String[]{
                    Manifest.permission.READ_EXTERNAL_STORAGE,
                    Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_STORAGE);
        }
    }

    private void grantInstall() {
        if (Build.VERSION.SDK_INT >= 26) {
            launch(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri()),
                    new Intent(Settings.ACTION_SECURITY_SETTINGS));
        } else {
            launch(new Intent(Settings.ACTION_SECURITY_SETTINGS), null);
        }
    }

    /**
     * Without the exemption Doze suspends the daemon's network and timers while
     * the screen is off, which stalls a running agent.
     */
    private void grantBattery() {
        if (Build.VERSION.SDK_INT < 23) return;
        launch(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri()),
                new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
    }

    /**
     * Android shows the runtime prompt only until the user declines it twice;
     * after that requestPermissions() silently does nothing, so a prompt that
     * was already asked and no longer warrants a rationale goes to settings.
     */
    private void grantNotifications() {
        if (Build.VERSION.SDK_INT >= 33
                && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            boolean asked = prefs.getBoolean(KEY_ASKED_NOTIFICATIONS, false);
            if (!asked || activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
                prefs.edit().putBoolean(KEY_ASKED_NOTIFICATIONS, true).apply();
                activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQUEST_NOTIFICATIONS);
                return;
            }
        }
        Intent details = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri());
        if (Build.VERSION.SDK_INT >= 26) {
            launch(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName()), details);
        } else {
            launch(details, null);
        }
    }

    private void launch(Intent primary, Intent fallback) {
        try {
            activity.startActivity(primary);
        } catch (ActivityNotFoundException e) {
            if (fallback == null) {
                Log.w(TAG, "no settings screen for " + primary.getAction());
                return;
            }
            try {
                activity.startActivity(fallback);
            } catch (ActivityNotFoundException e2) {
                Log.w(TAG, "no settings screen for " + fallback.getAction());
            }
        }
    }

    private static Object orNull(String value) {
        return value == null ? JSONObject.NULL : value;
    }
}
