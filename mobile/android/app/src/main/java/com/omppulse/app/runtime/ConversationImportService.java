package com.omppulse.app.runtime;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import com.omppulse.app.NotificationHelper;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/** Imports only archives authenticated by this APK's signing key; never reads the source guest. */
public final class ConversationImportService extends Service {
    private static final String TAG = "OmpConversationImport";
    private static final int NOTIFICATION_ID = 1004;
    private static final AtomicBoolean RUNNING = new AtomicBoolean();
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile Thread worker;
    private volatile InputStream source;
    private volatile NativeConversationPublisher publisher;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Uri uri = intent == null ? null : intent.getData();
        if (uri == null || !"content".equals(uri.getScheme())) {
            if (worker == null) stopSelf();
            return START_NOT_STICKY;
        }
        if (!RUNNING.compareAndSet(false, true)) {
            if (worker == null) stopSelf(startId);
            return START_NOT_STICKY;
        }
        try {
            NotificationHelper.ensureChannels(this);
            Notification notification = new NotificationCompat.Builder(this, NotificationHelper.CH_FG)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("Importing conversations")
                    .setContentText("Original chats are kept")
                    .setOngoing(true).setSilent(true).setShowWhen(false)
                    .setCategory(NotificationCompat.CATEGORY_SERVICE).build();
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                    Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0);
            worker = new Thread(() -> transfer(uri), "omp-conversation-import");
            worker.start();
        } catch (RuntimeException e) {
            RUNNING.set(false);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        Thread current = worker;
        if (current != null) current.interrupt();
        NativeConversationPublisher currentPublisher = publisher;
        if (currentPublisher != null) currentPublisher.close();
        InputStream input = source;
        if (input != null) {
            try { input.close(); } catch (IOException ignored) { }
        }
        super.onDestroy();
    }

    private void transfer(Uri uri) {
        Callback[] callback = new Callback[1];
        NativeConversationPublisher publication = null;
        String phase = "archive_validation";
        int imported = 0;
        int unchanged = 0;
        JSONArray files = new JSONArray();
        try (InputStream input = getContentResolver().openInputStream(uri)) {
            if (input == null) throw new IOException("Archive unavailable");
            source = input;
            try (ConversationArchive.Prepared prepared = ConversationArchive.prepare(input,
                    // Stage with persistent app data so exclusive moves stay on the guest filesystem.
                    getFilesDir().getCanonicalFile(), trustedSigners(), getPackageName(), metadata -> {
                        callback[0] = Callback.from(metadata);
                    })) {
                phase = "runtime_setup";
                LocalRuntime runtime = LocalRuntime.get(this);
                if (runtime.mode() == LocalRuntime.Mode.LAPTOP)
                    throw new IOException("Conversation import requires phone mode");
                if (runtime.mode() == LocalRuntime.Mode.UNSET) runtime.setMode(LocalRuntime.Mode.PHONE);
                runtime.prepare();
                if (!runtime.awaitReady(20 * 60_000L)) throw new IOException("Runtime not ready");
                checkInterrupted();
                createWorkingDirectories(runtime.rootfs(), prepared.metadata);
                phase = "publish";
                ConversationArchive.Result result;
                try (NativeConversationPublisher current = new NativeConversationPublisher(this)) {
                    publication = current;
                    publisher = current;
                    checkInterrupted();
                    result = prepared.publish(runtime.rootfs().getCanonicalFile(), current);
                } finally {
                    publisher = null;
                }
                imported = result.imported;
                unchanged = result.unchanged;
                files = fileReceipt(prepared.files);
                phase = "readback";
                int indexed = verifyIndex(runtime, prepared.files);
                JSONObject receipt = receipt(callback[0], "completed", imported, unchanged, files);
                receipt.put("indexedSessionCount", indexed);
                callback[0].send(receipt);
                Log.i(TAG, "Conversation import completed: " + imported + " imported, " + unchanged + " unchanged");
            }
        } catch (Exception e) {
            // Exception messages may contain provider URIs or private paths. Keep both logs and
            // the authenticated receipt bounded to a fixed phase name, never content or secrets.
            Log.w(TAG, "Conversation import failed during " + phase);
            if (callback[0] != null) {
                try {
                    JSONObject failed = receipt(callback[0], "failed", imported, unchanged, files);
                    failed.put("errorPhase", phase);
                    if (e instanceof ConversationArchive.PublishFailure) {
                        ConversationArchive.PublishFailure failure = (ConversationArchive.PublishFailure) e;
                        failed.put("publication", new JSONObject().put("operation", failure.operation)
                                .put("entryIndex", failure.entryIndex)
                                .put("errno", publication == null ? 0 : publication.errno()));
                    }
                    callback[0].send(failed);
                } catch (Exception ignored) {
                    Log.w(TAG, "Conversation import receipt unavailable");
                }
            }
        } finally {
            source = null;
            // Serialise admission release with Android's main-thread lifecycle. Releasing it on
            // this worker could admit another start immediately before stopSelf kills that import.
            main.post(() -> {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                RUNNING.set(false);
            });
        }
    }

    @SuppressWarnings("deprecation")
    private Set<String> trustedSigners() throws Exception {
        PackageManager manager = getPackageManager();
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28) {
            PackageInfo info = manager.getPackageInfo(getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            signatures = info.signingInfo == null ? new Signature[0] : info.signingInfo.getApkContentsSigners();
        } else {
            signatures = manager.getPackageInfo(getPackageName(), PackageManager.GET_SIGNATURES).signatures;
        }
        Set<String> trusted = new HashSet<>();
        if (signatures != null) {
            for (Signature signature : signatures) {
                byte[] digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray());
                StringBuilder hex = new StringBuilder(64);
                for (byte b : digest) hex.append("0123456789abcdef".charAt((b >>> 4) & 15))
                        .append("0123456789abcdef".charAt(b & 15));
                trusted.add(hex.toString());
            }
        }
        if (trusted.isEmpty()) throw new IOException("APK signing identity unavailable");
        return trusted;
    }

    private static void createWorkingDirectories(File rootfs, Properties metadata) throws IOException {
        int count;
        try { count = Integer.parseInt(metadata.getProperty("cwdCount", "0")); }
        catch (NumberFormatException e) { throw new IOException("Invalid working directory metadata"); }
        if (count < 0 || count > 100_000) throw new IOException("Invalid working directory count");
        File root = rootfs.getCanonicalFile();
        for (int i = 0; i < count; i++) {
            String cwd = metadata.getProperty("cwd." + i, "");
            if (!(cwd.equals("/root/projects") || cwd.startsWith("/root/projects/")
                    || cwd.equals("/tmp") || cwd.startsWith("/tmp/")))
                continue;
            File directory = root;
            for (String part : cwd.substring(1).split("/", -1)) {
                if (part.isEmpty() || part.equals(".") || part.equals("..")
                        || part.indexOf('\\') >= 0 || part.indexOf('\0') >= 0)
                    throw new IOException("Unsafe working directory");
                directory = new File(directory, part);
                if (!directory.getAbsoluteFile().equals(directory.getCanonicalFile()))
                    break;
                if (!directory.isDirectory() && !directory.mkdir())
                    break;
            }
        }
    }

    private static JSONArray fileReceipt(List<ConversationArchive.Entry> entries) throws Exception {
        JSONArray files = new JSONArray();
        for (ConversationArchive.Entry entry : entries) {
            files.put(new JSONObject().put("path", entry.path).put("sha256", entry.sha256).put("bytes", entry.bytes));
        }
        return files;
    }

    private static JSONObject receipt(Callback callback, String status, int imported, int unchanged,
            JSONArray files) throws Exception {
        return new JSONObject().put("requestId", callback.requestId).put("status", status)
                .put("imported", imported).put("unchanged", unchanged).put("files", files);
    }

    private static int verifyIndex(LocalRuntime runtime, List<ConversationArchive.Entry> files) throws Exception {
        Set<String> expected = new HashSet<>();
        for (ConversationArchive.Entry entry : files) {
            String[] parts = entry.path.split("/", -1);
            if (parts.length == 3 && parts[0].equals("sessions") && parts[2].endsWith(".jsonl"))
                expected.add("/root/.local/share/omp/" + entry.path);
        }
        for (int attempt = 0; attempt < 4; attempt++) {
            checkInterrupted();
            Set<String> found = new HashSet<>();
            Set<String> cursors = new HashSet<>();
            String cursor = "";
            for (int page = 0; page < 2000; page++) {
                String path = "/api/sessions?live=false&limit=50";
                if (!cursor.isEmpty()) path += "&cursor=" + URLEncoder.encode(cursor, "UTF-8");
                HttpURLConnection conn = (HttpURLConnection) new URL(
                        "http://127.0.0.1:" + runtime.endpoints().daemonPort() + path).openConnection();
                JSONObject body;
                try {
                    conn.setConnectTimeout(3000);
                    conn.setReadTimeout(15_000);
                    conn.setInstanceFollowRedirects(false);
                    conn.setUseCaches(false);
                    conn.setRequestProperty("Authorization", "Bearer " + runtime.ownerToken());
                    if (conn.getResponseCode() != 200) throw new IOException("Session index unavailable");
                    try (InputStream input = conn.getInputStream()) {
                        body = new JSONObject(readBounded(input, 8 * 1024 * 1024));
                    }
                } finally { conn.disconnect(); }
                JSONArray sessions = body.getJSONArray("sessions");
                for (int i = 0; i < sessions.length(); i++) {
                    String session = sessions.getJSONObject(i).getString("path");
                    if (expected.contains(session)) found.add(session);
                }
                if (found.containsAll(expected)) return found.size();
                cursor = body.isNull("nextCursor") ? "" : body.optString("nextCursor", "");
                if (cursor.isEmpty()) break;
                if (!cursors.add(cursor)) throw new IOException("Session index repeated a cursor");
            }
            if (attempt < 3) Thread.sleep(1500);
        }
        throw new IOException("Imported conversations not visible in the session index");
    }

    private static String readBounded(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int read;
        while ((read = input.read(buffer)) != -1) {
            checkInterrupted();
            if (bytes.size() > maximum - read) throw new IOException("Response too large");
            bytes.write(buffer, 0, read);
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void checkInterrupted() throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("Import interrupted");
    }

    private static final class Callback {
        final URL url;
        final String token;
        final String requestId;

        Callback(URL url, String token, String requestId) {
            this.url = url;
            this.token = token;
            this.requestId = requestId;
        }

        static Callback from(Properties metadata) throws IOException {
            try {
                URI uri = new URI(metadata.getProperty("callbackUrl", ""));
                int port = uri.getPort();
                if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost())
                        || port < 1024 || port > 65535 || port == 7681 || port == 7682 || port == 7690 || port == 7691
                        || !"/result".equals(uri.getRawPath()) || uri.getRawQuery() != null
                        || uri.getRawFragment() != null || uri.getRawUserInfo() != null)
                    throw new IOException("Invalid callback address");
                String token = metadata.getProperty("callbackToken", "");
                String requestId = metadata.getProperty("requestId", "");
                if (!token.matches("[0-9a-f]{64}") || !UUID.fromString(requestId).toString().equals(requestId))
                    throw new IOException("Invalid callback authentication");
                return new Callback(uri.toURL(), token, requestId);
            } catch (Exception e) {
                throw new IOException("Invalid callback metadata");
            }
        }

        void send(JSONObject receipt) throws IOException {
            byte[] bytes = receipt.toString().getBytes(StandardCharsets.UTF_8);
            if (bytes.length > 16 * 1024 * 1024) throw new IOException("Receipt too large");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            try {
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(10_000);
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(bytes.length);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Authorization", "Bearer " + token);
                try (OutputStream output = conn.getOutputStream()) { output.write(bytes); }
                if (conn.getResponseCode() != 200) throw new IOException("Receipt rejected");
            } finally { conn.disconnect(); }
        }
    }
}
