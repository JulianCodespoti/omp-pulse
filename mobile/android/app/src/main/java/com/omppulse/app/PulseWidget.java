package com.omppulse.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Home-screen widget: a "New chat" pill and the three most recently active chats.
 *
 * Data comes from {@code GET /api/sessions?limit=5} with the paired token, the same
 * way NotifyService reaches the daemon. The last answer is cached in preferences so
 * the widget always has something to draw and never blocks on the network; every
 * draw reads only that cache. A failed fetch keeps the old rows and says so.
 *
 * INVARIANT: no network and no TokenStore access on the main thread. TokenStore may
 * open the Keystore, so "unpaired" is recorded by the fetch job, not recomputed at draw.
 */
public final class PulseWidget extends AppWidgetProvider {
    private static final String TAG = "OmpPulseWidget";
    private static final String PREFS = "omp_pulse_widget";
    private static final String KEY_ROWS = "rows";
    private static final String KEY_ORIGIN = "origin";
    private static final String KEY_OK_AT = "okAt";
    /** Absent before the first fetch; otherwise "" (fresh), {@link #OFFLINE} or {@link #AUTH}. */
    private static final String KEY_ERROR = "error";
    private static final String OFFLINE = "offline";
    /** Unpaired, or the daemon refused the token: either way the fix is to open the app. */
    private static final String AUTH = "auth";
    private static final int FETCH = 5;
    private static final int MAX_ROWS = 3;
    private static final int MAX_BODY = 1 << 20;

    private static final String RUNNING = "running";
    private static final String NEEDS_INPUT = "needs";

    /**
     * One job running, at most one queued. A refresh asked for while one runs is
     * covered by the queued job; anything beyond that is dropped (and its caller's
     * completion callback fired) because the queued job will read newer state anyway.
     */
    private static final ThreadPoolExecutor IO = new ThreadPoolExecutor(
            1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1),
            runnable -> {
                Thread thread = new Thread(runnable, "omp-pulse-widget");
                thread.setDaemon(true);
                return thread;
            },
            (job, executor) -> ((Job) job).finish());

    /**
     * Fetch the chat list and redraw every placed widget. Safe from any thread, never
     * throws, and returns at once; does nothing (no network) while no widget is placed.
     */
    public static void refresh(Context context) {
        refresh(context, null);
    }

    private static void refresh(Context context, Runnable done) {
        Job job = null;
        try {
            job = new Job(context.getApplicationContext(), done);
            IO.execute(job);
        } catch (Throwable error) {
            Log.w(TAG, "refresh not scheduled", error);
            if (job != null) job.finish();
            else if (done != null) done.run();
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        // The periodic update: keep the process alive until the fetch lands.
        if (intent != null && AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(intent.getAction())) {
            PendingResult pending = goAsync();
            refresh(context, pending::finish);
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) render(context, manager, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        render(context, manager, id);
    }

    private static final class Job implements Runnable {
        private final Context app;
        private final Runnable done;

        Job(Context app, Runnable done) {
            this.app = app;
            this.done = done;
        }

        void finish() {
            if (done == null) return;
            try { done.run(); } catch (Throwable ignored) { }
        }

        @Override
        public void run() {
            try {
                AppWidgetManager manager = AppWidgetManager.getInstance(app);
                int[] ids = manager.getAppWidgetIds(new ComponentName(app, PulseWidget.class));
                if (ids.length == 0) return;
                fetch(app);
                for (int id : ids) render(app, manager, id);
            } catch (Throwable error) {
                Log.w(TAG, "refresh failed", error);
            } finally {
                finish();
            }
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ---- data -------------------------------------------------------------

    private static void fetch(Context app) {
        SharedPreferences prefs = prefs(app);
        String server = NativeConfig.serverUrl(app);
        String token = TokenStore.getToken(app);
        if (server == null || token == null || token.isEmpty()) {
            prefs.edit().remove(KEY_ROWS).putString(KEY_ERROR, AUTH).apply();
            return;
        }
        HttpURLConnection connection = null;
        try {
            URL base = new URL(server);
            String origin = base.getProtocol() + "://" + base.getAuthority();
            connection = (HttpURLConnection) new URL(origin + "/api/sessions?limit=" + FETCH).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) {
                prefs.edit().putString(KEY_ERROR, AUTH).apply();
                return;
            }
            if (status != 200) throw new IOException("HTTP " + status);
            JSONArray rows = rowsFrom(new JSONObject(readBounded(connection.getInputStream())).optJSONArray("sessions"));
            prefs.edit().putString(KEY_ROWS, rows.toString()).putString(KEY_ORIGIN, origin)
                    .putLong(KEY_OK_AT, System.currentTimeMillis()).putString(KEY_ERROR, "").apply();
        } catch (Exception error) {
            Log.d(TAG, "fetch failed: " + error);
            prefs.edit().putString(KEY_ERROR, OFFLINE).apply();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readBounded(InputStream in) throws IOException {
        try (InputStream stream = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (out.size() + count > MAX_BODY) throw new IOException("response too large");
                out.write(buffer, 0, count);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    /** Listing rows (web/src/domain/protocol.ts OmpSessionSummary) to the few fields drawn. */
    private static JSONArray rowsFrom(JSONArray sessions) throws Exception {
        JSONArray rows = new JSONArray();
        for (int i = 0; sessions != null && i < sessions.length() && rows.length() < MAX_ROWS; i++) {
            JSONObject session = sessions.optJSONObject(i);
            String path = session == null ? "" : session.optString("path", "");
            if (path.isEmpty()) continue;
            rows.put(new JSONObject().put("path", path).put("title", titleOf(session))
                    .put("state", stateOf(session)).put("at", session.optLong("activeAt", session.optLong("mtime", 0))));
        }
        return rows;
    }

    private static String titleOf(JSONObject session) {
        String title = session.optString("title", "").trim();
        if (title.isEmpty()) {
            JSONObject snippet = session.optJSONObject("snippet");
            title = snippet == null ? "" : snippet.optString("text", "").trim();
        }
        if (title.isEmpty()) {
            String cwd = session.optString("cwd", "");
            title = cwd.substring(cwd.lastIndexOf('/') + 1);
        }
        return title;
    }

    /** Mirrors the web's sessionTurn precedence: the canonical record, then the legacy flags. */
    private static String stateOf(JSONObject session) {
        if (session.has("pendingAsk") && !session.isNull("pendingAsk") || "waiting".equals(session.optString("status"))) {
            return NEEDS_INPUT;
        }
        JSONObject authority = session.optJSONObject("sessionState");
        boolean running = authority != null
                ? "running".equals(authority.optString("turn"))
                : session.optBoolean("running") || "streaming".equals(session.optString("status"));
        return running ? RUNNING : "done";
    }

    // ---- drawing ----------------------------------------------------------

    /** shortcut: a height heuristic, not a measured layout; swap for size-mapped RemoteViews if it clips. */
    static int rowsFor(int minHeightDp) {
        if (minHeightDp <= 0) return MAX_ROWS;
        // 48dp of header and padding, 24dp a row; rounding lets a stock 4x2 show all three.
        return Math.max(1, Math.min(MAX_ROWS, Math.round((minHeightDp - 48) / 24f)));
    }

    /** Compact age: "now", "5m", "3h", "2d". */
    static String ago(long deltaMillis) {
        long minutes = deltaMillis / 60_000L;
        if (minutes < 1) return "now";
        if (minutes < 60) return minutes + "m";
        if (minutes < 24 * 60) return (minutes / 60) + "h";
        return (minutes / (24 * 60)) + "d";
    }

    private static void render(Context context, AppWidgetManager manager, int id) {
        try {
            manager.updateAppWidget(id, build(context, manager.getAppWidgetOptions(id)));
        } catch (Throwable error) {
            Log.w(TAG, "render failed", error);
        }
    }

    private static RemoteViews build(Context context, Bundle options) throws Exception {
        SharedPreferences prefs = prefs(context);
        String error = prefs.getString(KEY_ERROR, null);
        long now = System.currentTimeMillis();
        JSONArray rows = new JSONArray(prefs.getString(KEY_ROWS, "[]"));
        // Another computer's chats must not outlive a switch of server.
        String origin = NativeConfig.originOf(NativeConfig.serverUrl(context));
        if (origin != null && !origin.equals(prefs.getString(KEY_ORIGIN, origin))) rows = new JSONArray();
        int shown = Math.min(rows.length(), rowsFor(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0)));

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_pulse);
        views.setOnClickPendingIntent(R.id.widget_root, activity(context, 0, new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER).setClass(context, MainActivity.class)));
        views.setOnClickPendingIntent(R.id.widget_new_chat, activity(context, 1, shellIntent(context)
                .setData(Uri.parse("omppulse://widget/new#new=1"))));

        String status = context.getString(R.string.app_name);
        if (OFFLINE.equals(error) && shown > 0) {
            status = context.getString(R.string.widget_stale, ago(now - prefs.getLong(KEY_OK_AT, now)));
        }
        views.setTextViewText(R.id.widget_status, status);

        views.removeAllViews(R.id.widget_rows);
        for (int i = 0; i < shown; i++) {
            JSONObject row = rows.getJSONObject(i);
            String path = row.getString("path");
            String state = row.optString("state");
            boolean needsInput = NEEDS_INPUT.equals(state);
            String title = row.optString("title", "");
            RemoteViews item = new RemoteViews(context.getPackageName(), R.layout.widget_pulse_row);
            item.setTextViewText(R.id.widget_row_title, title.isEmpty() ? context.getString(R.string.widget_untitled) : title);
            int label = RUNNING.equals(state) ? R.string.widget_state_running
                    : needsInput ? R.string.widget_state_needs_input : R.string.widget_state_done;
            item.setTextViewText(R.id.widget_row_meta, context.getString(label) + " \u00b7 " + ago(now - row.optLong("at", now)));
            item.setTextColor(R.id.widget_row_meta, ContextCompat.getColor(context,
                    RUNNING.equals(state) ? R.color.widget_accent
                            : needsInput ? R.color.widget_attention : R.color.widget_on_surface_variant));
            // Same extras a session notification carries: needs_input opens the answer sheet.
            item.setOnClickPendingIntent(R.id.widget_row, activity(context, path.hashCode(), shellIntent(context)
                    .setData(Uri.parse("omppulse://widget/session/" + Uri.encode(path)))
                    .putExtra("sessionPath", path)
                    .putExtra("kind", needsInput ? "needs_input" : "")));
            views.addView(R.id.widget_rows, item);
        }

        int message = AUTH.equals(error) ? R.string.widget_pair
                : OFFLINE.equals(error) ? R.string.widget_unreachable : R.string.widget_empty;
        views.setViewVisibility(R.id.widget_message, shown == 0 && error != null ? View.VISIBLE : View.GONE);
        views.setTextViewText(R.id.widget_message, context.getString(message));
        return views;
    }

    private static Intent shellIntent(Context context) {
        return new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    private static PendingIntent activity(Context context, int requestCode, Intent intent) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, requestCode, intent, flags);
    }
}
