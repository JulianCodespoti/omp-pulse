package com.omppulse.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.content.LocusIdCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONObject;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;


/**
 * Channels, notification building, and Bubble wiring.
 *
 * INVARIANT: one channel per kind so the user can tune each in Android
 * settings. The payload tag is the notification tag so same kind+session
 * replaces rather than stacks.
 *
 * Bubbles degrade: every shortcut/Person/LocusId/BubbleMetadata call is
 * guarded to API 30+ (or 29 for bubbles). On older OS the notification is
 * still fully functional as a normal notification.
 */
public final class NotificationHelper {
    private static final String TAG = "OmpNotifyHelper";

    // Channels
    public static final String CH_FG = "omp_foreground_v2";
    public static final String CH_AGENT_END = "omp_agent_end";
    public static final String CH_NEEDS_INPUT = "omp_needs_input";
    public static final String CH_ALERTS = "omp_alerts";
    public static final String CH_PROGRESS = "omp_progress";

    // IDs
    public static final int FG_ID = 1001;

    private static final String[] NOTIFICATION_KINDS = {
            "agent_end", "needs_input", "prompt_failed", "link_lost", "child_died"
    };
    private static final String EXTRA_SESSION_PATH = "com.omppulse.app.sessionPath";
    // Small icons are drawn from their alpha channel only, so the launcher icon
    // (a filled plate) showed as a white square and the stock info circle made
    // every notification look like a system message. This is the pulse glyph.
    private static int smallIconRes() {
        return R.drawable.ic_stat_omp;
    }

    private static final int ACCENT_COLOR = 0xFF48AAFF;
    // One shade entry per conversation piled up as unrelated rows; they share a
    // group, and the summary below only exists while there are two or more.
    private static final String CONVERSATION_GROUP = "omp-pulse.conversations";
    private static final String SUMMARY_TAG = "omp-conversations-summary";
    // The conversation the user is looking at, set by the web layer. Its
    // turn-finished notification still alerts but leaves the shade by itself.
    private static final long FOREGROUND_TIMEOUT_MS = 4000L;
    private static volatile String foregroundConversation;

    public static void setForegroundConversation(String sessionPath) {
        foregroundConversation = (sessionPath == null || sessionPath.isEmpty()) ? null : sessionPath;
    }

    private NotificationHelper() {}

    private static long fnv1a(String value) {
        long hash = 0xcbf29ce484222325L;
        for (byte valueByte : value.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            hash ^= valueByte & 0xffL;
            hash *= 0x100000001b3L;
        }
        return hash;
    }
    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        // The live-progress channel is retired and nothing creates it any more.
        // Deleting it once is the upgrade migration that keeps a channel (and its
        // stale settings) from surviving on installs that already have it.
        try { nm.deleteNotificationChannel("omp_live"); } catch (Throwable ignore) {}

        // Foreground keeper. v2 replaces omp_foreground: deleting and
        // recreating the SAME id can never migrate importance — Android
        // restores the deleted channel's old settings on recreate (deliberate,
        // so apps cannot reset user prefs), so the old check deleted and
        // recreated on EVERY call while staying LOW forever. And MIN was
        // never reachable anyway: the system raises foreground-service
        // channels to at least LOW. So v2 is LOW (matching enforced reality,
        // not the MIN aspiration), and the old id is deleted once — delete
        // of an absent id is a no-op, so no persistence is needed to make
        // the migration one-shot.
        try { nm.deleteNotificationChannel("omp_foreground"); } catch (Throwable ignore) {}
        if (nm.getNotificationChannel(CH_FG) == null) {
            NotificationChannel fg = new NotificationChannel(CH_FG, "omp-pulse", NotificationManager.IMPORTANCE_LOW);
            fg.setDescription("Keeps notifications in sync — required for self-hosted push without Firebase");
            fg.setShowBadge(false);
            fg.enableVibration(false);
            fg.setSound(null, null);
            safeSetAllowBubbles(fg, false);
            nm.createNotificationChannel(fg);
        }

        NotificationChannel agentEnd = new NotificationChannel(CH_AGENT_END, "Agent finished", NotificationManager.IMPORTANCE_DEFAULT);
        agentEnd.setDescription("Fires when a conversation finishes (agent_end)");
        agentEnd.enableVibration(true);
        safeSetAllowBubbles(agentEnd, true);
        nm.createNotificationChannel(agentEnd);

        NotificationChannel needsInput = new NotificationChannel(CH_NEEDS_INPUT, "Needs input", NotificationManager.IMPORTANCE_HIGH);
        needsInput.setDescription("Agent is blocked on a question");
        needsInput.enableVibration(true);
        safeSetAllowBubbles(needsInput, true);
        nm.createNotificationChannel(needsInput);

        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("prompt_failed / link_lost / child_died");
        alerts.enableVibration(true);
        safeSetAllowBubbles(alerts, true);
        nm.createNotificationChannel(alerts);

        // A running turn's ongoing status. LOW is the whole point: updates and
        // the chronometer must never buzz, and the user can hide the channel.
        NotificationChannel progress = new NotificationChannel(CH_PROGRESS, "Agent progress", NotificationManager.IMPORTANCE_LOW);
        progress.setDescription("Ongoing status while an agent turn is running");
        progress.setShowBadge(false);
        progress.enableVibration(false);
        progress.setSound(null, null);
        safeSetAllowBubbles(progress, false);
        nm.createNotificationChannel(progress);
    }

    private static void safeSetAllowBubbles(NotificationChannel ch, boolean allow) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try { ch.setAllowBubbles(allow); } catch (Throwable ignore) {}
        }
    }

    public static String channelForKind(String kind) {
        if (kind == null) return CH_ALERTS;
        switch (kind) {
            case "agent_end": return CH_AGENT_END;
            case "needs_input": return CH_NEEDS_INPUT;
            case "prompt_failed":
            case "link_lost":
            case "child_died": return CH_ALERTS;
            default: return CH_ALERTS;
        }
    }

    private static String preferenceEvent(String kind) {
        if ("agent_end".equals(kind)) return NotificationPreferences.EVENT_AGENT_END;
        if ("needs_input".equals(kind)) return NotificationPreferences.EVENT_NEEDS_INPUT;
        return NotificationPreferences.EVENT_ALERTS;
    }

    /**
     * Build and post a notification from a daemon push_payload JSON.
     * Payload shape: { title, body, sessionPath, kind, tag, reqId? }
     */
    public static void postFromPayload(Context ctx, JSONObject payload) {
        try {
            String title = payload.optString("title", "omp-pulse");
            String body = payload.optString("body", "");
            String sessionPath = payload.optString("sessionPath", "");
            String kind = payload.optString("kind", "agent_end");
            String tag = payload.optString("tag", null);
            Long reqId = null;
            Object rawReqId = payload.opt("reqId");
            if (rawReqId instanceof Number) reqId = ((Number) rawReqId).longValue();
            else if (rawReqId instanceof String) {
                try { reqId = Long.valueOf((String) rawReqId); } catch (NumberFormatException ignored) {}
            }
            if (tag == null || tag.isEmpty()) {
                tag = "omp-" + kind + "-" + (sessionPath.isEmpty() ? System.currentTimeMillis() : sessionPath.hashCode());
            }
            if ("agent_end".equals(kind)) cancelLive(ctx, sessionPath);
            if (!NotificationPreferences.isEventEnabled(ctx, sessionPath, preferenceEvent(kind))) return;
            post(ctx, kind, title, body, sessionPath, tag, reqId);
        } catch (Throwable e) {
            Log.w(TAG, "postFromPayload failed", e);
        }
    }

    public static void post(Context ctx, String kind, String title, String body,
                            String sessionPath, String tag, Long reqId) {
        post(ctx, kind, title, body, sessionPath, tag, reqId, null, false);
    }

    private static void post(Context ctx, String kind, String title, String body,
                             String sessionPath, String tag, Long reqId,
                             String replyHistory, boolean actionUpdate) {
        String channelId = channelForKind(kind);
        // Deep-link intents
        PendingIntent contentPi = buildContentPendingIntent(ctx, sessionPath, reqId,
                kind, tag, title, body);
        PendingIntent bubblePi = buildBubblePendingIntent(ctx, sessionPath, reqId, kind);

        String shortcutId = shortcutIdFor(sessionPath);

        // Try to publish shortcut for bubble correlation (API 25+ via compat, long-lived needs 30)
        maybePublishShortcut(ctx, shortcutId, title, body, sessionPath, kind);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(smallIconRes())
                .setColor(ACCENT_COLOR)
                .setGroup(CONVERSATION_GROUP)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(contentPi)
                .setAutoCancel(true)
                .setOngoing(false)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true);
        if (actionUpdate) b.setOnlyAlertOnce(true);
        // Never for needs_input: a question that vanishes after 4 s goes unanswered.
        // The notification still sounds and vibrates per its channel before it times out.
        if ("agent_end".equals(kind) && sessionPath != null && !sessionPath.isEmpty()
                && sessionPath.equals(foregroundConversation)
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b.setTimeoutAfter(FOREGROUND_TIMEOUT_MS);
        }
        if (replyHistory != null) b.setRemoteInputHistory(new CharSequence[]{replyHistory});
        if ("agent_end".equals(kind) && sessionPath != null && !sessionPath.isEmpty()) {
            b.addAction(replyAction(ctx, sessionPath, title, body, kind, tag));
        } else if ("needs_input".equals(kind) && sessionPath != null && !sessionPath.isEmpty()) {
            b.addAction(new NotificationCompat.Action.Builder(android.R.drawable.ic_menu_view,
                    "Answer", contentPi).build());
        }

        boolean quiet = NotificationPreferences.isQuietNow(ctx);
        if (quiet) b.setSilent(true);
        // On O+, channel settings own sound and vibration. Defaults are only for
        // pre-channel Android, and quiet hours must stay silent there as well.
        if (CH_NEEDS_INPUT.equals(channelId) || CH_ALERTS.equals(channelId)) {
            b.setPriority(NotificationCompat.PRIORITY_HIGH);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O && !quiet) {
                b.setDefaults(NotificationCompat.DEFAULT_SOUND | NotificationCompat.DEFAULT_VIBRATE);
            }
        } else {
            b.setPriority(NotificationCompat.PRIORITY_DEFAULT);
        }

        // MessagingStyle + Person — required for bubbles to be considered.
        // Always set CATEGORY_MESSAGE already; adding Person improves ranking.
        Person person = buildPerson(ctx, title);
        if (person != null) {
            b.addPerson(person);
            // MessagingStyle is the canonical conversation style for bubbles.
            try {
                NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(person)
                        .setConversationTitle(title)
                        .addMessage(body, System.currentTimeMillis(), person);
                style.setGroupConversation(false);
                b.setStyle(style);
            } catch (Throwable e) {
                Log.d(TAG, "MessagingStyle failed", e);
            }
        }

        // Correlate shortcut & notification for bubble ranking
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                b.setShortcutId(shortcutId);
                b.setLocusId(new LocusIdCompat(shortcutId));
            } catch (Throwable e) {
                Log.d(TAG, "setShortcutId/LocusId failed", e);
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Q has LocusId but not setShortcutId via compat? Still try compat.
            try { b.setShortcutId(shortcutId); } catch (Throwable ignore) {}
        }

        // Always attach BubbleMetadata to eligible conversation notifications.
        // Android applies global, app, and channel bubble preferences itself;
        // Let Android apply current app/channel/global preferences; attaching
        // metadata lets users opt in from the notification itself.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && bubblePi != null) {
            try {
                IconCompat bubbleIcon = IconCompat.createWithResource(ctx, android.R.drawable.sym_def_app_icon);
                try { bubbleIcon = IconCompat.createWithResource(ctx, ctx.getApplicationInfo().icon); } catch (Throwable ignore) {}

                NotificationCompat.BubbleMetadata bubble = new NotificationCompat.BubbleMetadata.Builder(bubblePi, bubbleIcon)
                        .setDesiredHeight(600)
                        .setAutoExpandBubble(false)
                        .setSuppressNotification(false)
                        .build();
                b.setBubbleMetadata(bubble);
            } catch (Throwable e) {
                Log.d(TAG, "BubbleMetadata failed (graceful degrade)", e);
            }
        }

        // Foreground service behavior flag (Android 14+): make notification
        // explicitly tied to the foreground service so it doesn't get deferred.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try { b.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE); } catch (Throwable ignore) {}
        }

        Notification n = b.build();
        if (sessionPath != null && !sessionPath.isEmpty()) {
            n.extras.putString(EXTRA_SESSION_PATH, sessionPath);
        }
        // Use tag as notification tag so same tag replaces previous.
        NotificationManagerCompat nmc = NotificationManagerCompat.from(ctx);
        try {
            // tag may be null? we ensured non-null above
            nmc.notify(tag, 0, n);
            updateConversationSummary(ctx, tag, true, null);
        } catch (SecurityException se) {
            // POST_NOTIFICATIONS not granted — degrade gracefully, nothing to do.
            Log.w(TAG, "notify blocked (POST_NOTIFICATIONS not granted)", se);
        } catch (Throwable e) {
            Log.w(TAG, "notify failed", e);
        }
    }

    /**
     * Post the group summary while two or more conversation notifications are
     * active, cancel it below two. Notifications are posted and cancelled
     * asynchronously, so the one just posted ({@code posted}) is counted by hand
     * and tags just cancelled ({@code cancelled}) are skipped; reading the active
     * list alone would be one step behind. The summary is silent
     * (GROUP_ALERT_CHILDREN) so only the child alerts.
     */
    private static void updateConversationSummary(Context ctx, String postedTag, boolean posted,
                                                  Set<String> cancelled) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            NotificationManager manager = ctx.getSystemService(NotificationManager.class);
            if (manager == null) return;
            int children = posted ? 1 : 0;
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                Notification notification = active.getNotification();
                if (!CONVERSATION_GROUP.equals(notification.getGroup())) continue;
                if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;
                String activeTag = active.getTag();
                if (posted && activeTag != null && activeTag.equals(postedTag)) continue;
                if (cancelled != null && activeTag != null && cancelled.contains(activeTag)) continue;
                children++;
            }
            NotificationManagerCompat notifications = NotificationManagerCompat.from(ctx);
            if (children < 2) {
                notifications.cancel(SUMMARY_TAG, 0);
                return;
            }
            Notification summary = new NotificationCompat.Builder(ctx, CH_AGENT_END)
                    .setSmallIcon(smallIconRes())
                    .setColor(ACCENT_COLOR)
                    .setGroup(CONVERSATION_GROUP)
                    .setGroupSummary(true)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                    .setStyle(new NotificationCompat.InboxStyle().setSummaryText("omp-pulse"))
                    .setContentTitle("omp-pulse")
                    .setContentText(children + " conversations")
                    .setAutoCancel(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .build();
            notifications.notify(SUMMARY_TAG, 0, summary);
        } catch (SecurityException se) {
            Log.w(TAG, "summary blocked (POST_NOTIFICATIONS not granted)", se);
        } catch (Throwable e) {
            Log.w(TAG, "summary update failed", e);
        }
    }

    // Safety net for a lost end event (daemon down, phone offline): the daemon
    // refreshes the notification at least on every tool/state change, so a
    // turn silent this long is gone or stuck, not working.
    private static final long PROGRESS_TIMEOUT_MS = 15 * 60 * 1000L;
    private static final String PROGRESS_TAG_PREFIX = "omp-progress-";

    /**
     * Post, update or clear the one ongoing notification of a running turn from
     * a {@code progress} / {@code progress_end} payload:
     * { kind, title, body, sessionPath, tag, startedAt, at }.
     *
     * Deliberately outside the conversation notifications: it carries no
     * EXTRA_SESSION_PATH and its tag is not a known conversation tag, so opening
     * the chat does not clear it (it would only be re-posted by the next tick).
     * "Agent finished" switches also gate it: someone who muted that chat does
     * not want its status either.
     */
    public static void postProgress(Context ctx, JSONObject payload) {
        try {
            String path = payload.optString("sessionPath", "");
            String tag = payload.optString("tag", "");
            if (path.isEmpty() || !tag.startsWith(PROGRESS_TAG_PREFIX)) return;
            NotificationManagerCompat notifications = NotificationManagerCompat.from(ctx);
            if ("progress_end".equals(payload.optString("kind"))) {
                notifications.cancel(tag, 0);
                return;
            }
            if (!NotificationPreferences.isEventEnabled(ctx, path, NotificationPreferences.EVENT_AGENT_END)) return;
            String title = payload.optString("title", "omp-pulse");
            String body = payload.optString("body", "");
            // The daemon's clock differs from the phone's: place the chronometer
            // by how long the turn has run, not by its absolute start.
            long elapsed = Math.max(0L, payload.optLong("at") - payload.optLong("startedAt"));
            PendingIntent contentPi = buildContentPendingIntent(ctx, path, null, "progress", tag, title, body);
            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_PROGRESS)
                    .setSmallIcon(smallIconRes())
                    .setContentTitle(title)
                    .setContentText(body)
                    .setContentIntent(contentPi)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setSilent(true)
                    .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setUsesChronometer(true)
                    .setWhen(System.currentTimeMillis() - elapsed)
                    .setShowWhen(true)
                    .setTimeoutAfter(PROGRESS_TIMEOUT_MS)
                    .addAction(new NotificationCompat.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,
                            "Stop", actionPendingIntent(ctx, NotificationActionReceiver.ACTION_STOP, path,
                                    title, body, "progress", tag)).build());
            notifications.notify(tag, 0, b.build());
        } catch (SecurityException se) {
            Log.w(TAG, "progress notify blocked (POST_NOTIFICATIONS not granted)", se);
        } catch (Throwable e) {
            Log.w(TAG, "postProgress failed", e);
        }
    }

    /**
     * Drop every progress notification. A (re)connected stream re-announces the
     * turns that are still running, so anything left over is a turn whose end
     * this phone never heard.
     */
    public static void cancelAllProgress(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            NotificationManager manager = ctx.getSystemService(NotificationManager.class);
            if (manager == null) return;
            for (StatusBarNotification active : manager.getActiveNotifications()) {
                String tag = active.getTag();
                if (tag != null && tag.startsWith(PROGRESS_TAG_PREFIX)) manager.cancel(tag, active.getId());
            }
        } catch (Throwable e) {
            Log.d(TAG, "cancelAllProgress failed", e);
        }
    }

    /**
     * Cancel delivered notifications for exactly one conversation.
     *
     * INVARIANT: an ACTIVE bubble keeps its supporting notification, so
     * viewing the conversation from main OR from the bubble must never cancel
     * one. The system sets {@code FLAG_BUBBLE} only on the notification that
     * currently backs a bubble window; ordinary conversation notifications
     * that merely carry BubbleMetadata do not have it and are still cleared.
     */
    public static void clearConversationNotifications(Context ctx, String path) {
        if (path == null || path.isEmpty()) return;
        NotificationManagerCompat notifications = NotificationManagerCompat.from(ctx);
        // Below M there is no way to see what is actually posted, and bubbles do
        // not exist there, so cancelling the deterministic tags is exact.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            for (String tag : knownTags(path)) notifications.cancel(tag, 0);
            return;
        }
        NotificationManager manager = ctx.getSystemService(NotificationManager.class);
        if (manager == null) {
            for (String tag : knownTags(path)) notifications.cancel(tag, 0);
            return;
        }
        Set<String> knownTags = knownTags(path);
        Set<String> cancelledTags = new HashSet<>();
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            android.app.Notification notification = active.getNotification();
            Bundle extras = notification.extras;
            if (shouldClear(active.getId(), notification.flags, active.getTag(),
                    extras == null ? null : extras.getString(EXTRA_SESSION_PATH),
                    Build.VERSION.SDK_INT, path, knownTags)) {
                notifications.cancel(active.getTag(), active.getId());
                if (active.getTag() != null) cancelledTags.add(active.getTag());
            }
        }
        if (!cancelledTags.isEmpty()) updateConversationSummary(ctx, null, false, cancelledTags);
    }

    /**
     * Whether one delivered notification may be cancelled for a conversation the
     * user is viewing. Kept free of framework calls so the rule is exercisable.
     *
     * INVARIANT: the notification currently backing a live bubble is never
     * cancelled — {@code FLAG_BUBBLE} is the system's own marker for it and is
     * set only on the notification a bubble window is using. Merely carrying
     * BubbleMetadata does not spare a notification, so ordinary read alerts
     * for the same conversation are still dismissed.
     */
    static boolean shouldClear(int id, int notificationFlags, String notificationTag,
                               String extrasSessionPath, int sdkInt, String path,
                               Set<String> knownTags) {
        if (id == FG_ID) return false;
        if (sdkInt >= Build.VERSION_CODES.Q && (notificationFlags & Notification.FLAG_BUBBLE) != 0) return false;
        if (path.equals(extrasSessionPath)) return true;
        return notificationTag != null && knownTags.contains(notificationTag);
    }

    /** Tags this helper can derive for one conversation without enumerating. */
    private static Set<String> knownTags(String path) {
        Set<String> tags = new HashSet<>();
        String hash = String.format(Locale.ROOT, "%016x", fnv1a(path));
        for (String kind : NOTIFICATION_KINDS) tags.add("omp-" + kind + "-" + hash);
        tags.add(liveTag(path));
        return tags;
    }

    public static Notification buildForegroundNotification(Context ctx) {
        ensureChannels(ctx);
        PendingIntent pi = buildContentPendingIntent(ctx, "", null, "foreground", "fg",
                "omp-pulse", "");
        // A silent, minimal ongoing notice is required while the foreground listener runs.
        // Android enforces LOW channel importance for foreground services.
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CH_FG)
                .setSmallIcon(smallIconRes())
                .setContentTitle("omp-pulse")
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setSilent(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try { b.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE); } catch (Throwable ignore) {}
        }
        return b.build();
    }


    public static void cancelLive(Context ctx, String path) {
        if (path == null || path.isEmpty()) return;
        NotificationManagerCompat.from(ctx).cancel(liveTag(path), 0);
    }


    /** Explicit action results remain visible even when event delivery is muted. */
    public static void actionResult(Context ctx, String path, String title, String body,
                                    String kind, String tag, String reply, String error) {
        if ("agent_end".equals(kind)) {
            if (tag != null && (reply != null || error != null)) {
                String text = error != null
                        ? (reply == null ? error : "Your reply: " + reply + "\n" + error
                                + "\nOpen the chat to copy or retry it.")
                        : "You: " + reply;
                post(ctx, kind, title, text, path, tag, null, reply, true);
            }
            return;
        }
        if (reply == null && error == null) return;
        String text = error == null ? "You: " + reply
                : (reply == null ? error : "Your reply: " + reply + "\n" + error
                        + "\nOpen the chat to copy or retry it.");
        String feedbackTag = tag == null || tag.isEmpty() ? liveTag(path) : tag;
        post(ctx, "agent_end", title, text, path, feedbackTag, null, reply, true);
    }

    private static String liveTag(String path) { return "omp-live-" + String.format(Locale.ROOT, "%016x", fnv1a(path)); }

    private static NotificationCompat.Action replyAction(Context ctx, String path,
                                                          String title, String body, String kind, String tag) {
        RemoteInput input = new RemoteInput.Builder(NotificationActionReceiver.EXTRA_REPLY_TEXT)
                .setLabel("Reply").build();
        return new NotificationCompat.Action.Builder(android.R.drawable.ic_menu_send, "Reply",
                actionPendingIntent(ctx, NotificationActionReceiver.ACTION_REPLY, path,
                        title, body, kind, tag)).addRemoteInput(input).build();
    }

    private static PendingIntent actionPendingIntent(Context ctx, String action, String path,
                                                     String title, String body, String kind, String tag) {
        Intent intent = new Intent(ctx, NotificationActionReceiver.class);
        intent.setAction(action);
        intent.setData(Uri.parse("omppulse://notification/" + Uri.encode(path) + "/" + Uri.encode(action)));
        intent.putExtra(NotificationActionReceiver.EXTRA_SESSION_PATH, path);
        intent.putExtra(NotificationActionReceiver.EXTRA_TITLE, title);
        intent.putExtra(NotificationActionReceiver.EXTRA_BODY, body);
        intent.putExtra(NotificationActionReceiver.EXTRA_KIND, kind);
        intent.putExtra(NotificationActionReceiver.EXTRA_TAG, tag);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= NotificationActionReceiver.ACTION_REPLY.equals(action)
                    ? PendingIntent.FLAG_MUTABLE : PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(ctx, (path + action).hashCode(), intent, flags);
    }


    // ——— helpers ———

    private static String shortcutIdFor(String sessionPath) {
        if (sessionPath == null || sessionPath.isEmpty()) return "omp_default";
        // Shortcut IDs: stable, <~100 chars, no slashes. Use hash-based stable id.
        String sanitized = sessionPath.replaceAll("[^a-zA-Z0-9_-]", "_");
        if (sanitized.length() > 48) sanitized = sanitized.substring(0, 48);
        return "omp_" + sanitized + "_" + Math.abs(sessionPath.hashCode());
    }

    private static Person buildPerson(Context ctx, String name) {
        try {
            IconCompat icon = IconCompat.createWithResource(ctx, android.R.drawable.sym_def_app_icon);
            try { icon = IconCompat.createWithResource(ctx, ctx.getApplicationInfo().icon); } catch (Throwable ignore) {}
            return new Person.Builder()
                    .setName(name != null ? name : "omp-pulse")
                    .setIcon(icon)
                    .setImportant(true)
                    .build();
        } catch (Throwable e) {
            return null;
        }
    }

    private static void maybePublishShortcut(Context ctx, String shortcutId, String title,
                                             String body, String sessionPath, String kind) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return;
        // Only publish for real conversation kinds that benefit from bubbles.
        // Foreground channel must not create shortcuts.
        if (sessionPath == null || sessionPath.isEmpty()) return;
        try {
            Person person = buildPerson(ctx, title);
            Intent intent = new Intent(ctx, BubbleActivity.class);
            intent.setAction(Intent.ACTION_VIEW);
            intent.putExtra("sessionPath", sessionPath);
            intent.putExtra("kind", kind);
            // Must be long-lived per Bubble spec; setLongLived(true) requires API 30 runtime,
            // but Compat handles degrade on older.
            ShortcutInfoCompat.Builder sb = new ShortcutInfoCompat.Builder(ctx, shortcutId)
                    .setShortLabel(title != null && !title.isEmpty() ? title : sessionPath)
                    .setLongLabel(body != null && !body.isEmpty() ? body : sessionPath)
                    .setIntent(intent)
                    .setIcon(IconCompat.createWithResource(ctx, android.R.drawable.sym_def_app_icon));
            try { sb.setIcon(IconCompat.createWithResource(ctx, ctx.getApplicationInfo().icon)); } catch (Throwable ignore) {}
            if (person != null) sb.setPerson(person);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                try { sb.setLongLived(true); } catch (Throwable ignore) {}
                try { sb.setLocusId(new LocusIdCompat(shortcutId)); } catch (Throwable ignore) {}
                try {
                    java.util.Set<String> cats = new java.util.HashSet<>();
                    cats.add("com.omppulse.app.category.CONVERSATION");
                    sb.setCategories(cats);
                } catch (Throwable ignore) {}
            }
            ShortcutInfoCompat shortcut = sb.build();
            ShortcutManagerCompat.pushDynamicShortcut(ctx, shortcut);
        } catch (Throwable e) {
            Log.d(TAG, "pushDynamicShortcut failed", e);
        }
    }

    private static PendingIntent buildContentPendingIntent(Context ctx, String sessionPath,
                                                           Long reqId, String kind, String tag,
                                                           String title, String body) {
        Intent i = new Intent(ctx, MainActivity.class);
        i.setAction(Intent.ACTION_VIEW);
        i.putExtra("sessionPath", sessionPath != null ? sessionPath : "");
        if (reqId != null) i.putExtra("reqId", reqId.longValue());
        i.putExtra("kind", kind != null ? kind : "");
        i.putExtra("tag", tag != null ? tag : "");
        i.putExtra("body", body != null ? body : "");
        i.putExtra("title", title != null ? title : "omp-pulse");
        i.putExtra("action", "needs_input".equals(kind) ? "question" : "open");
        i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        int rc = tag != null ? tag.hashCode() : (sessionPath != null ? sessionPath.hashCode() : 0);
        return PendingIntent.getActivity(ctx, rc, i, flags);
    }

    static PendingIntent buildBubblePendingIntent(Context ctx, String sessionPath,
                                                          Long reqId, String kind) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null;
        try {
            Intent i = new Intent(ctx, BubbleActivity.class);
            i.setAction(Intent.ACTION_VIEW);
            i.putExtra("sessionPath", sessionPath != null ? sessionPath : "");
            if (reqId != null) i.putExtra("reqId", reqId.longValue());
            if (kind != null) i.putExtra("kind", kind);
            i.putExtra("action", "needs_input".equals(kind) ? "question" : "open");
            // PendingIntent identity ignores extras. Include the complete chat
            // target and event identity so a second kind/request for this same
            // session cannot retarget an already-posted bubble.
            Uri identity = new Uri.Builder()
                    .scheme(ctx.getPackageName())
                    .authority("bubble")
                    .appendQueryParameter("sessionPath", sessionPath != null ? sessionPath : "")
                    .appendQueryParameter("kind", kind != null ? kind : "")
                    .appendQueryParameter("reqId", reqId != null ? reqId.toString() : "")
                    .build();
            i.setData(identity);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_MUTABLE;
            int rc = (sessionPath != null ? sessionPath.hashCode() ^ 0xB0BB1E : 0xB0BB1E);
            return PendingIntent.getActivity(ctx, rc, i, flags);
        } catch (Throwable e) {
            return null;
        }
    }

}
