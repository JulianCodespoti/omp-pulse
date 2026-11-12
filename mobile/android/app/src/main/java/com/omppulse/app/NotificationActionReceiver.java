package com.omppulse.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import androidx.core.app.RemoteInput;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Notification replies enter the same durable native queue as both WebViews. */
public final class NotificationActionReceiver extends BroadcastReceiver {
    private static final String TAG = "OmpNotifyAction";
    public static final String ACTION_STOP = "com.omppulse.app.notification.STOP";
    public static final String ACTION_REPLY = "com.omppulse.app.notification.REPLY";
    public static final String EXTRA_SESSION_PATH = "sessionPath";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String EXTRA_KIND = "kind";
    public static final String EXTRA_TAG = "tag";
    public static final String EXTRA_REPLY_TEXT = "replyText";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!ACTION_STOP.equals(action) && !ACTION_REPLY.equals(action)) return;
        String path = intent.getStringExtra(EXTRA_SESSION_PATH);
        if (path == null || path.isEmpty()) return;
        String text = null;
        if (ACTION_REPLY.equals(action)) {
            Bundle results = RemoteInput.getResultsFromIntent(intent);
            CharSequence input = results == null ? null : results.getCharSequence(EXTRA_REPLY_TEXT);
            if (input == null || input.toString().trim().isEmpty()) return;
            text = input.toString().trim();
        }
        final String reply = text;
        Context app = context.getApplicationContext();
        String tokenAtTap = TokenStore.getToken(app);
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                if (ACTION_REPLY.equals(action)) {
                    if (tokenAtTap == null || tokenAtTap.isEmpty())
                        throw new IllegalStateException("Device is not paired; reply was not saved");
                    JSONObject command = new JSONObject()
                            .put("commandId", UUID.randomUUID().toString())
                            .put("namespace", NativeOutbox.namespace(tokenAtTap))
                            .put("sessionPath", path).put("text", reply)
                            .put("createdAt", System.currentTimeMillis())
                            .put("title", intent.getStringExtra(EXTRA_TITLE))
                            .put("body", intent.getStringExtra(EXTRA_BODY))
                            .put("kind", intent.getStringExtra(EXTRA_KIND))
                            .put("tag", intent.getStringExtra(EXTRA_TAG));
                    // Do not create a second preferences queue: migration could race
                    // this tap and mistake fresh work for an ambiguous legacy send.
                    NativeOutbox.enqueueNotification(app, command, false);
                    feedback(app, intent, path, reply, null);
                } else {
                    feedback(app, intent, path, null, sendStop(app, path));
                }
            } catch (Exception error) {
                Log.w(TAG, "Notification action failed", error);
                feedback(app, intent, path, reply, readable(error));
            } finally {
                pending.finish();
            }
        }, "omp-notification-action").start();
    }

    private static void feedback(Context context, Intent intent, String path, String reply, String error) {
        NotificationHelper.actionResult(context, path, intent.getStringExtra(EXTRA_TITLE),
                intent.getStringExtra(EXTRA_BODY), intent.getStringExtra(EXTRA_KIND),
                intent.getStringExtra(EXTRA_TAG), reply, error);
    }

    /** Migrate old preferences only after native persistence succeeds. */
    public static void retryPending(Context context) {
        NativeOutbox.initialize(context);
    }

    private static String sendStop(Context context, String path) throws Exception {
        String token = TokenStore.getToken(context);
        if (token == null || token.isEmpty()) return "Device is not paired; stop was not sent";
        URL endpoint = new URL(NativeConfig.appUrl(context));
        URL url = new URL(endpoint.getProtocol() + "://" + endpoint.getAuthority() + "/api/abort");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(10000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] payload = new JSONObject().put("sessionPath", path).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            }
            int status = connection.getResponseCode();
            String body = read(connection, status);
            if (status < 200 || status >= 300) return "HTTP " + status + ": " + body;
            JSONObject result = new JSONObject(body);
            return result.optBoolean("ok", false) ? null
                    : result.optString("error", "Server did not confirm the stop request");
        } finally {
            connection.disconnect();
        }
    }

    private static String read(HttpURLConnection connection, int status) throws Exception {
        InputStream input = status < 400 ? connection.getInputStream() : connection.getErrorStream();
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (bytes.size() + count > 16384) throw new IllegalStateException("Server response too large");
                bytes.write(buffer, 0, count);
            }
            return bytes.toString("UTF-8");
        }
    }

    private static String readable(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return "Notification action failed";
        return message.length() > 180 ? message.substring(0, 180) : message;
    }
}
