package com.omppulse.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * JS bridge so the WebView can hand the pairing token to the native service
 * and drive permission / settings.
 *
 * JS usage:
 *   const OmpNotify = Capacitor.registerPlugin('OmpNotify');
 *   await OmpNotify.setToken({ token });
 *
 * The daemon token is already obtained by the web layer (pairing flow);
 * this bridge is the only hand-off. It persists the token via TokenStore
 * and (re)starts the foreground service.
 *
 * INVARIANT: the service persists the token separately — even if the WebView
 * is cleared, the service survives reboot via TokenStore.
 */
@CapacitorPlugin(
    name = "OmpNotify",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NotifyBridgePlugin extends Plugin {
    private static final int REQ_NOTIFICATIONS = 9001;
    private PluginCall pendingPermissionCall;

    @PluginMethod
    public void clearNotifications(PluginCall call) {
        String sessionPath = call.getString("sessionPath");
        NotificationHelper.clearConversationNotifications(getContext(), sessionPath);
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void setForegroundConversation(PluginCall call) {
        NotificationHelper.setForegroundConversation(call.getString("sessionPath"));
        call.resolve(new JSObject().put("ok", true));
    }

    // A paused or destroyed activity means nobody is looking at the chat any more;
    // a stale path would make its next finished-turn notification vanish unseen.
    @Override
    protected void handleOnPause() {
        NotificationHelper.setForegroundConversation(null);
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        NotificationHelper.setForegroundConversation(null);
        super.handleOnDestroy();
    }
    @PluginMethod
    public void setToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null || token.isEmpty()) {
            call.reject("token required");
            return;
        }
        try {
            TokenStore.saveToken(getContext(), token);
            // Only acknowledge once the credential is really durable: the web
            // layer shows native readiness off this resolution, and a token
            // that failed to persist would leave the listener on a stale
            // credential until the next process start.
            String persisted = TokenStore.getToken(getContext());
            if (persisted == null || !persisted.equals(token)) {
                call.reject("token could not be persisted");
                return;
            }
            // (Re)start service with new credential
            NotifyService.startWithToken(getContext(), token);
            // Optionally ensure permission is prompted at pairing time if web layer asks.
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
            // Emit event to JS that token was accepted
            notifyListeners("tokenSet", new JSObject().put("ok", true), false);
        } catch (Throwable e) {
            call.reject("setToken failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        try {
            String t = TokenStore.getToken(getContext());
            JSObject ret = new JSObject();
            ret.put("token", t);
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void clearToken(PluginCall call) {
        try {
            TokenStore.clearToken(getContext());
            NotifyService.stop(getContext());
            call.resolve(new JSObject().put("ok", true));
        } catch (Throwable e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        try {
            String t = TokenStore.getToken(getContext());
            boolean hasToken = t != null && !t.isEmpty();
            JSObject ret = new JSObject();
            ret.put("hasToken", hasToken);
            ret.put("serviceRunning", NotifyService.sAlive);
            ret.put("connected", NotifyService.sConnected);
            ret.put("releaseId", NativeConfig.releaseId());
            ret.put("protocolVersion", NativeConfig.PROTOCOL_VERSION);
            ret.put("minClientProtocolVersion", NativeConfig.MIN_CLIENT_PROTOCOL_VERSION);
            JSObject capabilities = new JSObject();
            capabilities.put("offlineRecovery", true);
            capabilities.put("deepLinks", true);
            capabilities.put("notifications", true);
            capabilities.put("bubbles", true);
            capabilities.put("explicitUpdates", true);
            ret.put("capabilities", capabilities);
            long lastAt = NotifyService.sLastEventAt;
            if (lastAt > 0) {
                long ago = SystemClock.elapsedRealtime() - lastAt;
                ret.put("lastEventAgoMs", ago);
            }
            String err = NotifyService.sLastError;
            if (err != null && !err.isEmpty()) {
                ret.put("lastError", err);
            }
            // Version info from PackageManager — use compat helper for long versionCode.
            try {
                String pkg = getContext().getPackageName();
                PackageManager pm = getContext().getPackageManager();
                PackageInfo info = pm.getPackageInfo(pkg, 0);
                long vc = PackageInfoCompat.getLongVersionCode(info);
                // versionCode ~2.4M fits int, but keep long semantics and cast for JS number.
                ret.put("versionCode", (int) vc);
                if (info.versionName != null) {
                    ret.put("versionName", info.versionName);
                }
            } catch (Throwable ignore) {
                // Omit version keys when PackageManager is unavailable (test harness / missing package).
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    PowerManager pmgr = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                    if (pmgr != null) {
                        boolean unrestricted = pmgr.isIgnoringBatteryOptimizations(getContext().getPackageName());
                        ret.put("batteryUnrestricted", unrestricted);
                    }
                } catch (Throwable ignore) {
                    // Omit battery key on failure — JS reads null.
                }
            }
            call.resolve(ret);
        } catch (Throwable e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        // Pre-33: permission is implicitly granted
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            ret.put("canRequest", false);
            call.resolve(ret);
            return;
        }
        boolean granted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        boolean canRequest = !granted && getActivity() != null;
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        ret.put("canRequest", canRequest);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(new JSObject().put("granted", true));
            return;
        }
        boolean granted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            call.resolve(new JSObject().put("granted", true));
            return;
        }
        // Must be called from a user gesture; Capacitor will show system dialog.
        // We use the platform request path and handle the callback in handleRequestPermissionsResult.
        if (getActivity() == null) {
            call.reject("no activity");
            return;
        }
        NotificationPreferences.markPermissionAsked(getContext());
        pendingPermissionCall = call;
        // Keep the call alive until the permission result arrives.
        // requestPermissionForAliases is Capacitor 5+; fall back to ActivityCompat.
        try {
            requestPermissionForAlias("notifications", call, "permCallback");
        } catch (Throwable e) {
            // Fallback path: direct Android request
            try {
                getActivity().requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATIONS);
                // do not resolve yet — onRequestPermissionsResult will
            } catch (Throwable e2) {
                pendingPermissionCall = null;
                call.reject("request failed: " + e2.getMessage());
            }
        }
    }

    // Capacitor callback name
    @com.getcapacitor.annotation.PermissionCallback
    private void permCallback(PluginCall call) {
        boolean granted = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            granted = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        } else {
            granted = true;
        }
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
        if (pendingPermissionCall != null && pendingPermissionCall != call) {
            // also resolve the stashed call if different
            pendingPermissionCall.resolve(new JSObject().put("granted", granted));
            pendingPermissionCall = null;
        }
        pendingPermissionCall = null;
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);
        if (pendingPermissionCall != null) {
            boolean granted = false;
            for (int i = 0; i < permissions.length; i++) {
                if (Manifest.permission.POST_NOTIFICATIONS.equals(permissions[i])
                        && i < grantResults.length && grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                    granted = true; break;
                }
            }
            pendingPermissionCall.resolve(new JSObject().put("granted", granted));
            pendingPermissionCall = null;
        }
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent intent = new Intent();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent.setAction(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
            } else {
                intent.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("ok", true));
        } catch (Throwable e) {
            call.reject(e.getMessage());
        }
    }

    /** Every preference the notification page edits, as plain fields (minutes are minutes since midnight). */
    @PluginMethod
    public void getNotificationPrefs(PluginCall call) {
        call.resolve(prefsJson(getContext()));
    }

    /** Any subset of the fields getNotificationPrefs returns; unknown or missing fields are left alone. */
    @PluginMethod
    public void setNotificationPrefs(PluginCall call) {
        Context c = getContext();
        if (call.hasOption("enabled")) {
            NotificationPreferences.setGloballyEnabled(c, Boolean.TRUE.equals(call.getBoolean("enabled")));
        }
        if (call.hasOption("agentEnd")) {
            NotificationPreferences.setGlobalEventEnabled(c, NotificationPreferences.EVENT_AGENT_END,
                    Boolean.TRUE.equals(call.getBoolean("agentEnd")));
        }
        if (call.hasOption("needsInput")) {
            NotificationPreferences.setGlobalEventEnabled(c, NotificationPreferences.EVENT_NEEDS_INPUT,
                    Boolean.TRUE.equals(call.getBoolean("needsInput")));
        }
        if (call.hasOption("alerts")) {
            NotificationPreferences.setGlobalEventEnabled(c, NotificationPreferences.EVENT_ALERTS,
                    Boolean.TRUE.equals(call.getBoolean("alerts")));
        }
        if (call.hasOption("quietEnabled") || call.hasOption("quietStart") || call.hasOption("quietEnd")) {
            // setQuietHours writes all three together, so unspecified ones keep their stored value.
            NotificationPreferences.setQuietHours(c,
                    call.hasOption("quietEnabled")
                            ? Boolean.TRUE.equals(call.getBoolean("quietEnabled"))
                            : NotificationPreferences.isQuietHoursEnabled(c),
                    call.getInt("quietStart", NotificationPreferences.quietStartMinutes(c)),
                    call.getInt("quietEnd", NotificationPreferences.quietEndMinutes(c)));
        }
        if (call.hasOption("background")) {
            boolean on = Boolean.TRUE.equals(call.getBoolean("background"));
            NotificationPreferences.setBackgroundEnabled(c, on);
            // Turning it off stops the listener but never unpairs; turning it on resumes only when paired.
            if (on) NotifyService.startIfPaired(c);
            else NotifyService.stop(c);
        }
        call.resolve(prefsJson(c));
    }

    private static JSObject prefsJson(Context c) {
        JSObject r = new JSObject();
        r.put("enabled", NotificationPreferences.isGloballyEnabled(c));
        r.put("agentEnd", NotificationPreferences.isGlobalEventEnabled(c, NotificationPreferences.EVENT_AGENT_END));
        r.put("needsInput", NotificationPreferences.isGlobalEventEnabled(c, NotificationPreferences.EVENT_NEEDS_INPUT));
        r.put("alerts", NotificationPreferences.isGlobalEventEnabled(c, NotificationPreferences.EVENT_ALERTS));
        r.put("quietEnabled", NotificationPreferences.isQuietHoursEnabled(c));
        r.put("quietStart", NotificationPreferences.quietStartMinutes(c));
        r.put("quietEnd", NotificationPreferences.quietEndMinutes(c));
        r.put("background", NotificationPreferences.isBackgroundEnabled(c));
        return r;
    }

    /**
     * One chat's own switches. A chat without an override inherits the global
     * event switch, so these are the effective values, not just the stored ones.
     */
    @PluginMethod
    public void getChatNotifications(PluginCall call) {
        String path = call.getString("sessionPath");
        if (path == null || path.isEmpty()) {
            call.reject("sessionPath required");
            return;
        }
        call.resolve(chatJson(getContext(), path));
    }

    /** Any subset of enabled / agentEnd / needsInput / alerts for one chat. */
    @PluginMethod
    public void setChatNotifications(PluginCall call) {
        Context c = getContext();
        String path = call.getString("sessionPath");
        if (path == null || path.isEmpty()) {
            call.reject("sessionPath required");
            return;
        }
        if (call.hasOption("enabled")) {
            NotificationPreferences.setChatEnabled(c, path, Boolean.TRUE.equals(call.getBoolean("enabled")));
        }
        if (call.hasOption("agentEnd")) {
            NotificationPreferences.setChatEventEnabled(c, path, NotificationPreferences.EVENT_AGENT_END,
                    Boolean.TRUE.equals(call.getBoolean("agentEnd")));
        }
        if (call.hasOption("needsInput")) {
            NotificationPreferences.setChatEventEnabled(c, path, NotificationPreferences.EVENT_NEEDS_INPUT,
                    Boolean.TRUE.equals(call.getBoolean("needsInput")));
        }
        if (call.hasOption("alerts")) {
            NotificationPreferences.setChatEventEnabled(c, path, NotificationPreferences.EVENT_ALERTS,
                    Boolean.TRUE.equals(call.getBoolean("alerts")));
        }
        call.resolve(chatJson(c, path));
    }

    private static JSObject chatJson(Context c, String path) {
        JSObject r = new JSObject();
        r.put("enabled", NotificationPreferences.isChatEnabled(c, path));
        r.put("agentEnd", NotificationPreferences.isChatEventEnabled(c, path, NotificationPreferences.EVENT_AGENT_END));
        r.put("needsInput", NotificationPreferences.isChatEventEnabled(c, path, NotificationPreferences.EVENT_NEEDS_INPUT));
        r.put("alerts", NotificationPreferences.isChatEventEnabled(c, path, NotificationPreferences.EVENT_ALERTS));
        return r;
    }

    /**
     * What the notification page needs to say whether alerts reach this phone:
     * permission ("granted" | "ask" | "blocked"), bubbles ("on" | "off" |
     * "unsupported"), paired, listener ("off" | "stopped" | "connecting" |
     * "connected"), batteryUnrestricted and lastError when known.
     */
    @PluginMethod
    public void getNotificationStatus(PluginCall call) {
        try {
            Context c = getContext();
            NotificationHelper.ensureChannels(c);
            JSObject r = new JSObject();
            r.put("permission", permissionState(c));
            r.put("bubbles", bubbleState(c));
            String token = TokenStore.getToken(c);
            r.put("paired", token != null && !token.isEmpty());
            String listener;
            if (!NotificationPreferences.isBackgroundEnabled(c)) listener = "off";
            else if (!NotifyService.sAlive) listener = "stopped";
            else listener = NotifyService.sConnected ? "connected" : "connecting";
            r.put("listener", listener);
            String err = NotifyService.sLastError;
            if (!"connected".equals(listener) && err != null && !err.isEmpty()) r.put("lastError", err);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
                if (pm != null) r.put("batteryUnrestricted", pm.isIgnoringBatteryOptimizations(c.getPackageName()));
            }
            call.resolve(r);
        } catch (Throwable e) {
            call.reject(e.getMessage());
        }
    }

    private String permissionState(Context c) {
        boolean runtimeGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (runtimeGranted && NotificationManagerCompat.from(c).areNotificationsEnabled()) return "granted";
        // Android shows the runtime prompt only until the user declines it twice;
        // after that requestPermissions() silently does nothing, so a prompt that
        // was already asked and no longer warrants a rationale goes to settings.
        Activity activity = getActivity();
        if (!runtimeGranted && activity != null
                && (!NotificationPreferences.askedForPermission(c)
                || activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))) {
            return "ask";
        }
        return "blocked";
    }

    /** Bubbles need the device, the app and both bubbling channels to allow them. */
    private static String bubbleState(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unsupported";
        android.app.NotificationManager manager = c.getSystemService(android.app.NotificationManager.class);
        if (manager == null) return "unsupported";
        boolean device = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.areBubblesEnabled();
        boolean on = device && manager.areBubblesAllowed()
                && channelBubbles(manager, NotificationHelper.CH_AGENT_END)
                && channelBubbles(manager, NotificationHelper.CH_NEEDS_INPUT);
        return on ? "on" : "off";
    }

    private static boolean channelBubbles(android.app.NotificationManager manager, String id) {
        android.app.NotificationChannel channel = manager.getNotificationChannel(id);
        return channel != null && channel.canBubble();
    }

    @PluginMethod
    public void verifyBubbleContract(PluginCall call) {
        if (!BuildConfig.DEBUG) {
            call.reject("native bubble verification is available only in debug builds");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.resolve(new JSObject().put("supported", false));
            return;
        }
        android.app.NotificationManager manager = getContext().getSystemService(android.app.NotificationManager.class);
        if (manager == null) {
            call.reject("notification manager unavailable");
            return;
        }
        String sessionPath = call.getString("sessionPath");
        if (sessionPath == null || sessionPath.isEmpty()) sessionPath = "/tmp/omp-bubble-verification.jsonl";
        // The verification alert must not share a tag with a real alert for the
        // same conversation: the check posts an ordinary alert next to one that
        // is backing a live bubble, and the two are only distinguishable by tag.
        String kind = call.getString("kind");
        if (kind == null || kind.isEmpty()) kind = "needs_input";
        try {
            android.app.PendingIntent first = NotificationHelper.buildBubblePendingIntent(
                    getContext(), sessionPath, -1041L, kind);
            android.app.PendingIntent nextRequest = NotificationHelper.buildBubblePendingIntent(
                    getContext(), sessionPath, -1042L, kind);
            android.app.PendingIntent otherKind = NotificationHelper.buildBubblePendingIntent(
                    getContext(), sessionPath, -1041L, "agent_end");
            boolean distinct = first != null && nextRequest != null && otherKind != null
                    && !first.equals(nextRequest) && !first.equals(otherKind)
                    && !nextRequest.equals(otherKind);
            if (first != null) first.cancel();
            if (nextRequest != null) nextRequest.cancel();
            if (otherKind != null) otherKind.cancel();

            NotificationHelper.ensureChannels(getContext());
            String tag = verificationTag(sessionPath, kind);
            String title = call.getString("title");
            if (title == null || title.isEmpty()) title = "Bubble verification";
            String body = title + " — Synthetic native bubble check";
            manager.cancel(tag, 0);
            NotificationHelper.post(getContext(), kind, title,
                    body, sessionPath, tag, 1041L);
            JSObject result = new JSObject();
            result.put("supported", true);
            result.put("distinctPendingIntents", distinct);
            result.put("notificationTag", tag);
            result.put("appAllowsBubbles", manager.areBubblesAllowed());
            result.put("deviceAllowsBubbles", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    && manager.areBubblesEnabled());
            android.app.NotificationChannel channel = manager.getNotificationChannel(NotificationHelper.CH_NEEDS_INPUT);
            result.put("channelAllowsBubbles", channel != null && channel.canBubble());
            call.resolve(result);
        } catch (Throwable e) {
            call.reject("native bubble verification failed");
        }
    }
    @PluginMethod
    public void getBubbleVerificationStatus(PluginCall call) {
        if (!BuildConfig.DEBUG) {
            call.reject("native bubble verification is available only in debug builds");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            call.resolve(new JSObject().put("supported", false));
            return;
        }
        android.app.NotificationManager manager = getContext().getSystemService(android.app.NotificationManager.class);
        if (manager == null) {
            call.reject("notification manager unavailable");
            return;
        }
        String sessionPath = call.getString("sessionPath");
        if (sessionPath == null || sessionPath.isEmpty()) sessionPath = "/tmp/omp-bubble-verification.jsonl";
        String kind = call.getString("kind");
        if (kind == null || kind.isEmpty()) kind = "needs_input";
        String tag = verificationTag(sessionPath, kind);
        boolean posted = false;
        boolean metadataAttached = false;
        try {
            for (android.service.notification.StatusBarNotification active : manager.getActiveNotifications()) {
                if (tag.equals(active.getTag())) {
                    posted = true;
                    android.app.Notification.BubbleMetadata metadata = active.getNotification().getBubbleMetadata();
                    metadataAttached = metadata != null && metadata.getIntent() != null;
                    break;
                }
            }
            JSObject result = new JSObject();
            result.put("supported", true);
            result.put("posted", posted);
            result.put("bubbleMetadataAttached", metadataAttached);
            result.put("appAllowsBubbles", manager.areBubblesAllowed());
            result.put("deviceAllowsBubbles", manager.areBubblesEnabled());
            android.app.NotificationChannel channel = manager.getNotificationChannel(NotificationHelper.CH_NEEDS_INPUT);
            result.put("channelAllowsBubbles", channel != null && channel.canBubble());
            call.resolve(result);
        } catch (Throwable e) {
            call.reject("native bubble status unavailable");
        }
    }

    /**
     * One verification tag per conversation AND kind, so a synthetic alert of
     * one kind never stands in for another kind's row in the audit.
     */
    private static String verificationTag(String sessionPath, String kind) {
        return "omp-native-bubble-verification-" + Integer.toHexString(sessionPath.hashCode())
                + "-" + Integer.toHexString(kind.hashCode());
    }


    @PluginMethod
    public void getNotificationAudit(PluginCall call) {
        if (!BuildConfig.DEBUG) {
            call.reject("native notification audit is available only in debug builds");
            return;
        }
        android.app.NotificationManager manager = getContext().getSystemService(android.app.NotificationManager.class);
        if (manager == null) {
            call.reject("notification manager unavailable");
            return;
        }
        try {
            org.json.JSONArray rows = new org.json.JSONArray();
            for (android.service.notification.StatusBarNotification active : manager.getActiveNotifications()) {
                if (!getContext().getPackageName().equals(active.getPackageName())) continue;
                android.app.Notification notification = active.getNotification();
                android.os.Bundle extras = notification.extras;
                JSObject row = new JSObject();
                row.put("tag", active.getTag());
                row.put("id", active.getId());
                row.put("title", extras == null ? "" : String.valueOf(extras.getCharSequence(android.app.Notification.EXTRA_TITLE, "")));
                row.put("text", extras == null ? "" : String.valueOf(extras.getCharSequence(android.app.Notification.EXTRA_TEXT, "")));
                row.put("subText", extras == null ? "" : String.valueOf(extras.getCharSequence(android.app.Notification.EXTRA_SUB_TEXT, "")));
                row.put("sessionPath", extras == null ? "" : extras.getString("com.omppulse.app.sessionPath", ""));
                row.put("category", notification.category == null ? "" : notification.category);
                row.put("ongoing", (notification.flags & android.app.Notification.FLAG_ONGOING_EVENT) != 0);
                // Only the system telling us this notification currently backs a
                // live bubble. Metadata alone is present on every conversation
                // notification, so it cannot distinguish two rows of one chat.
                row.put("bubbleBacking", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        && (notification.flags & android.app.Notification.FLAG_BUBBLE) != 0);
                row.put("visibility", notification.visibility);
                row.put("silent", notification.sound == null && notification.vibrate == null && notification.defaults == 0);
                row.put("channelId", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? notification.getChannelId() : "");
                rows.put(row);
            }
            call.resolve(new JSObject().put("notifications", rows));
        } catch (Throwable e) {
            call.reject("native notification audit unavailable");
        }
    }
    @PluginMethod
    public void openBubbleSettings(PluginCall call) {
        try {
            String action = Build.VERSION.SDK_INT >= 34
                    ? Settings.ACTION_APP_NOTIFICATION_BUBBLE_SETTINGS
                    : Settings.ACTION_APP_NOTIFICATION_SETTINGS;
            Intent intent = new Intent(action)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("ok", true));
        } catch (Throwable e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            // Prefer the system battery-optimisation list; fall back to app details if not resolvable.
            // WHY: ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS triggers the direct opt-in dialog,
            // which is a Play policy violation to fire without user context and can get flagged.
            // The LIST screen (ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS) is the safe entry point.
            if (intent.resolveActivity(getContext().getPackageManager()) == null) {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            }
            getContext().startActivity(intent);
            call.resolve(new JSObject().put("ok", true));
        } catch (Throwable e) {
            call.reject(e.getMessage());
        }
    }

    /**
     * Crisp system haptic for send / stop / long-press.
     *
     * WHY here and not `navigator.vibrate`: the WebView's Vibration API needs
     * the VIBRATE permission (never declared), so the long-press buzz the web
     * layer has always requested was a silent no-op inside the APK. And a raw
     * vibrator pulse is the wrong feel anyway: `performHapticFeedback` plays the
     * device's tuned click effects and honours the user's system "touch
     * feedback" setting, which is what ChatGPT/Claude feel like.
     */
    @PluginMethod
    public void haptic(PluginCall call) {
        final String kind = call.getString("kind", "tap");
        getActivity().runOnUiThread(() -> {
            try {
                android.view.View view = getBridge().getWebView();
                int constant;
                switch (kind) {
                    case "longpress":
                        constant = android.view.HapticFeedbackConstants.LONG_PRESS;
                        break;
                    case "confirm":
                        constant = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? android.view.HapticFeedbackConstants.CONFIRM
                            : android.view.HapticFeedbackConstants.VIRTUAL_KEY;
                        break;
                    case "reject":
                        constant = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                            ? android.view.HapticFeedbackConstants.REJECT
                            : android.view.HapticFeedbackConstants.LONG_PRESS;
                        break;
                    default:
                        constant = android.view.HapticFeedbackConstants.KEYBOARD_TAP;
                }
                boolean played = view != null && view.performHapticFeedback(constant);
                call.resolve(new JSObject().put("played", played));
            } catch (Throwable e) {
                call.reject(e.getMessage());
            }
        });
    }
}
