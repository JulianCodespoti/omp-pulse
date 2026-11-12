package com.omppulse.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

/** Durable settings for local, Tailscale-only notification delivery. */
public final class NotificationPreferences {
    private static final String PREFS = "notification_preferences_v1";
    private static final String KEY_BACKGROUND = "background_enabled";
    private static final String KEY_GLOBAL = "notifications_enabled";
    private static final String KEY_QUIET_ENABLED = "quiet_hours_enabled";
    private static final String KEY_QUIET_START = "quiet_start_minutes";
    private static final String KEY_QUIET_END = "quiet_end_minutes";
    private static final String KEY_COMMAND_IDS = "reply_command_ids";
    private static final String COMMAND_PREFIX = "reply_command_";
    private static final String KEY_ASKED_PERMISSION = "asked_post_notifications";

    public static final String EVENT_AGENT_END = "agent_end";
    public static final String EVENT_NEEDS_INPUT = "needs_input";
    public static final String EVENT_ALERTS = "alerts";

    private NotificationPreferences() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Background delivery defaults on to preserve paired-device behavior. */
    public static boolean isBackgroundEnabled(Context context) {
        return prefs(context).getBoolean(KEY_BACKGROUND, true);
    }

    public static void setBackgroundEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_BACKGROUND, enabled).apply();
    }

    /** Whether the runtime permission prompt was ever shown: Android reports "no rationale" both before the first ask and after a permanent refusal. */
    public static boolean askedForPermission(Context context) {
        return prefs(context).getBoolean(KEY_ASKED_PERMISSION, false);
    }

    public static void markPermissionAsked(Context context) {
        prefs(context).edit().putBoolean(KEY_ASKED_PERMISSION, true).apply();
    }

    public static boolean isGloballyEnabled(Context context) {
        return prefs(context).getBoolean(KEY_GLOBAL, true);
    }

    public static void setGloballyEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_GLOBAL, enabled).apply();
    }

    public static boolean isGlobalEventEnabled(Context context, String event) {
        return prefs(context).getBoolean("event_" + event, true);
    }

    public static void setGlobalEventEnabled(Context context, String event, boolean enabled) {
        prefs(context).edit().putBoolean("event_" + event, enabled).apply();
    }

    /** A missing chat preference inherits the enabled global default. */
    public static boolean isChatEnabled(Context context, String sessionPath) {
        if (sessionPath == null || sessionPath.isEmpty()) return true;
        return prefs(context).getBoolean(chatKey("enabled", sessionPath), true);
    }

    public static void setChatEnabled(Context context, String sessionPath, boolean enabled) {
        if (sessionPath == null || sessionPath.isEmpty()) return;
        prefs(context).edit().putBoolean(chatKey("enabled", sessionPath), enabled).apply();
    }

    /** A missing per-chat event preference inherits its corresponding global event switch. */
    public static boolean isChatEventEnabled(Context context, String sessionPath, String event) {
        if (sessionPath == null || sessionPath.isEmpty()) return isGlobalEventEnabled(context, event);
        SharedPreferences p = prefs(context);
        String key = chatKey("event_" + event, sessionPath);
        return p.contains(key) ? p.getBoolean(key, true) : isGlobalEventEnabled(context, event);
    }

    public static void setChatEventEnabled(Context context, String sessionPath, String event, boolean enabled) {
        if (sessionPath == null || sessionPath.isEmpty()) return;
        prefs(context).edit().putBoolean(chatKey("event_" + event, sessionPath), enabled).apply();
    }

    public static boolean isEventEnabled(Context context, String sessionPath, String event) {
        return isGloballyEnabled(context)
                && isGlobalEventEnabled(context, event)
                && isChatEnabled(context, sessionPath)
                && isChatEventEnabled(context, sessionPath, event);
    }

    public static boolean isQuietHoursEnabled(Context context) {
        return prefs(context).getBoolean(KEY_QUIET_ENABLED, false);
    }

    public static int quietStartMinutes(Context context) {
        return boundedMinutes(prefs(context).getInt(KEY_QUIET_START, 22 * 60));
    }

    public static int quietEndMinutes(Context context) {
        return boundedMinutes(prefs(context).getInt(KEY_QUIET_END, 7 * 60));
    }

    public static void setQuietHours(Context context, boolean enabled, int startMinutes, int endMinutes) {
        prefs(context).edit()
                .putBoolean(KEY_QUIET_ENABLED, enabled)
                .putInt(KEY_QUIET_START, boundedMinutes(startMinutes))
                .putInt(KEY_QUIET_END, boundedMinutes(endMinutes))
                .apply();
    }

    public static boolean isQuietNow(Context context) {
        Calendar now = Calendar.getInstance();
        int minute = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        return isQuietAtMinute(isQuietHoursEnabled(context), quietStartMinutes(context),
                quietEndMinutes(context), minute);
    }

    /** Pure local-time window check; equal endpoints mean the quiet window is disabled. */
    public static boolean isQuietAtMinute(boolean enabled, int startMinutes, int endMinutes,
                                          int minuteOfDay) {
        if (!enabled) return false;
        int start = boundedMinutes(startMinutes);
        int end = boundedMinutes(endMinutes);
        int now = Math.max(0, Math.min(1439, minuteOfDay));
        if (start == end) return false;
        return start < end ? now >= start && now < end : now >= start || now < end;
    }


    /** Replies are never sent using a different server or pairing token than the one tapped. */
    public static boolean isReplyCommandCurrent(Context context, JSONObject command,
                                                String endpoint, String token) {
        if (command == null || token == null || token.isEmpty()) return false;
        String scope = replyScope(endpoint, token);
        return scope != null && scope.equals(command.optString("scope", ""));
    }

    public static synchronized JSONArray pendingReplyCommands(Context context) {
        SharedPreferences p = prefs(context);
        Set<String> ids = new HashSet<>(p.getStringSet(KEY_COMMAND_IDS, new HashSet<>()));
        JSONArray commands = new JSONArray();
        String token = TokenStore.getToken(context);
        String endpoint = NativeConfig.appUrl(context);
        if (token == null || token.isEmpty() || replyScope(endpoint, token) == null) return commands;
        for (String id : ids) {
            String value = p.getString(COMMAND_PREFIX + id, null);
            if (value == null) {
                removeReplyCommand(context, id);
                continue;
            }
            try {
                // Return stale-scope commands too: dispatch validates their original
                // pairing and surfaces a truthful failure instead of silently dropping them.
                commands.put(new JSONObject(value));
            } catch (JSONException ignored) {
                removeReplyCommand(context, id);
            }
        }
        return commands;
    }

    public static synchronized boolean removeReplyCommand(Context context, String commandId) {
        if (commandId == null || commandId.isEmpty()) return true;
        SharedPreferences p = prefs(context);
        Set<String> ids = new HashSet<>(p.getStringSet(KEY_COMMAND_IDS, new HashSet<>()));
        ids.remove(commandId);
        return p.edit().remove(COMMAND_PREFIX + commandId).putStringSet(KEY_COMMAND_IDS, ids).commit();
    }

    private static String replyScope(String endpoint, String token) {
        if (endpoint == null || endpoint.isEmpty() || token == null || token.isEmpty()) return null;
        try {
            URL url = new URL(endpoint);
            String origin = url.getProtocol() + "://" + url.getAuthority();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(origin.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            byte[] bytes = digest.digest(token.getBytes(StandardCharsets.UTF_8));
            char[] hex = "0123456789abcdef".toCharArray();
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) {
                result.append(hex[(value >>> 4) & 0x0f]).append(hex[value & 0x0f]);
            }
            return result.toString();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String chatKey(String key, String sessionPath) {
        String encoded = Base64.encodeToString(sessionPath.getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return "chat_" + key + "_" + encoded;
    }

    private static int boundedMinutes(int value) {
        return Math.max(0, Math.min(1439, value));
    }
}
