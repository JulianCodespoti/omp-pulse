package com.omppulse.app.phone;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.MimeTypeMap;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.omppulse.app.NotificationHelper;
import com.omppulse.app.runtime.LocalRuntime;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Loopback HTTP API that lets the guest `android` CLI drive the phone.
 *
 * Wire protocol: {@code POST /v1/<cmd>} with a JSON body and {@code Authorization: Bearer <token>};
 * response is {@code {"ok":true,...}} or {@code {"ok":false,"error":"..."}}. The token is regenerated
 * on every start and written to the guest at /root/.config/omp-phone/token (0600), so only code running
 * inside this app's sandbox (the guest) can read it.
 */
public final class PhoneApi {
    private static final String TAG = "PhoneApi";
    private static final int MAX_BODY = 1024 * 1024;
    private static final int MAX_HEADER_LINE = 16 * 1024;
    private static final int MAX_HEADERS = 64;
    private static final int WORKERS = 4;
    private static final int QUEUE = 8;
    private static final int REQUEST_DEADLINE_MS = 15_000;
    private static final String TOKEN_GUEST_PATH = "/root/.config/omp-phone/token";

    private interface Command {
        JSONObject run(Context ctx, JSONObject body) throws Exception;
    }

    private static final Map<String, Command> COMMANDS = new HashMap<>();

    static {
        COMMANDS.put("status", PhoneApi::status);
        COMMANDS.put("apps", PhoneApi::apps);
        COMMANDS.put("launch", PhoneApi::launchApp);
        COMMANDS.put("open", PhoneApi::open);
        COMMANDS.put("share", PhoneApi::share);
        COMMANDS.put("install", PhoneApi::install);
        COMMANDS.put("uninstall", PhoneApi::uninstall);
        COMMANDS.put("notify", PhoneApi::notify);
        COMMANDS.put("intent", PhoneApi::intent);
        COMMANDS.put("clipboard_get", PhoneApi::clipboardGet);
        COMMANDS.put("clipboard_set", PhoneApi::clipboardSet);
        COMMANDS.put("ui_dump", PhoneApi::uiDump);
        COMMANDS.put("tap", PhoneApi::tap);
        COMMANDS.put("tap_text", PhoneApi::tapText);
        COMMANDS.put("type", PhoneApi::type);
        COMMANDS.put("swipe", PhoneApi::swipe);
        COMMANDS.put("key", PhoneApi::key);
        COMMANDS.put("screenshot", PhoneApi::screenshot);
    }

    private static ServerSocket server;
    private static ExecutorService pool;
    private static byte[] token;

    private PhoneApi() {}

    public static synchronized void start(Context context) {
        if (server != null && !server.isClosed()) return;
        Context app = context.getApplicationContext();
        LocalRuntime runtime = LocalRuntime.get(app);
        try {
            // Bind before publishing the token: if the port is squatted, endpoint.json must move to
            // the port we actually own, or the CLI would hand our bearer token to the squatter.
            ServerSocket socket = bind(runtime);
            server = socket; // so stop() closes it if publishing the token fails
            String hex = newToken();
            writeToken(runtime.hostPath(TOKEN_GUEST_PATH), hex);
            token = hex.getBytes(StandardCharsets.UTF_8);
            // Small bounded queue: unauthenticated clients must not be able to pile up sockets
            // (and fds shared with the WebView and proot) behind slow workers.
            ThreadPoolExecutor workers = new ThreadPoolExecutor(WORKERS, WORKERS, 0L,
                    TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(QUEUE));
            pool = workers;
            Thread acceptor = new Thread(() -> acceptLoop(app, socket, workers), "omp-phone-api");
            acceptor.setDaemon(true);
            acceptor.start();
        } catch (Exception e) {
            Log.e(TAG, "start failed: " + e.getMessage());
            stop();
        }
    }

    private static ServerSocket bind(LocalRuntime runtime) throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        try {
            return new ServerSocket(runtime.endpoints().phoneApiPort(), 16, loopback);
        } catch (BindException taken) {
            // The port was free when claimed, but the claim can be a whole daemon start earlier.
            int port = runtime.movePhoneApiPort();
            Log.w(TAG, "phone API port taken; moved to " + port);
            return new ServerSocket(port, 16, loopback);
        }
    }

    public static synchronized void stop() {
        try {
            if (server != null) server.close();
        } catch (Exception ignored) {
            // Closing an already-broken socket is not actionable.
        }
        server = null;
        if (pool != null) pool.shutdownNow();
        pool = null;
    }

    private static String newToken() {
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : raw) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    private static void writeToken(File file, String hex) throws Exception {
        File dir = file.getParentFile();
        if (dir != null) dir.mkdirs();
        // Write to a temp file restricted to owner before any bytes land, then rename, so readers
        // never see a truncated token and the secret is never briefly world-readable.
        File tmp = new File(dir, file.getName() + ".tmp");
        tmp.delete();
        if (!tmp.createNewFile()) throw new Exception("cannot create " + tmp);
        // INVARIANT: token readable by the app UID only; it grants full phone control.
        tmp.setReadable(false, false);
        tmp.setReadable(true, true);
        tmp.setWritable(false, false);
        tmp.setWritable(true, true);
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(hex.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(file)) {
            tmp.delete();
            throw new Exception("cannot replace " + file);
        }
    }

    private static void acceptLoop(Context ctx, ServerSocket socket, ExecutorService workers) {
        while (!socket.isClosed()) {
            Socket client;
            try {
                client = socket.accept();
            } catch (Exception e) {
                if (socket.isClosed()) return;
                continue;
            }
            try {
                workers.execute(() -> handle(ctx, client));
            } catch (RejectedExecutionException busy) {
                closeQuietly(client);
            }
        }
    }

    private static void closeQuietly(Socket s) {
        try {
            s.close();
        } catch (Exception ignored) {
            // Dropping an overflow connection; nothing to report.
        }
    }

    // ---- HTTP ----

    private static void handle(Context ctx, Socket socket) {
        try (Socket s = socket) {
            // Absolute deadline, not just a per-read timeout: a client trickling one byte per read
            // could otherwise hold a worker for minutes before auth is even checked.
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(REQUEST_DEADLINE_MS);
            s.setSoTimeout(REQUEST_DEADLINE_MS);
            InputStream in = new DeadlineInputStream(s, s.getInputStream(), deadline);
            String requestLine = readLine(in);
            String auth = "";
            int length = 0;
            boolean hasOrigin = false;
            for (int n = 0; ; n++) {
                if (n > MAX_HEADERS) throw new Exception("too many headers");
                String line = readLine(in);
                if (line.isEmpty()) break;
                int colon = line.indexOf(':');
                if (colon < 0) continue;
                String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(colon + 1).trim();
                switch (name) {
                    case "authorization": auth = value; break;
                    case "content-length": length = Integer.parseInt(value); break;
                    case "origin": hasOrigin = true; break;
                    default: break;
                }
            }
            int status;
            JSONObject reply;
            String presented = auth.startsWith("Bearer ") ? auth.substring(7) : "";
            String[] parts = requestLine.split(" ");
            if (hasOrigin) {
                // Browsers always send Origin on cross-origin POSTs; the CLI never does. Rejecting it
                // stops any web page (including one served on localhost) from reaching the API.
                status = 403;
                reply = err("browser requests are not allowed");
            } else if (!MessageDigest.isEqual(presented.getBytes(StandardCharsets.UTF_8), token)) {
                // MessageDigest.isEqual is constant-time since API 19 (no early exit on mismatch).
                status = 401;
                reply = err("unauthorized");
            } else if (length < 0 || length > MAX_BODY) {
                status = 413;
                reply = err("body too large");
            } else if (parts.length < 2 || !parts[0].equals("POST") || !parts[1].startsWith("/v1/")) {
                status = 400;
                reply = err("expected POST /v1/<cmd>");
            } else {
                byte[] body = readBody(in, length);
                try {
                    JSONObject args = length == 0
                            ? new JSONObject()
                            : new JSONObject(new String(body, StandardCharsets.UTF_8));
                    reply = dispatch(ctx, parts[1].substring(4), args);
                    status = reply.optBoolean("ok") ? 200 : 400;
                } catch (Throwable e) {
                    // Throwable, not Exception: StackOverflowError from deeply nested JSON or OOM
                    // from a screenshot would otherwise kill the shared app process.
                    status = 500;
                    reply = err(e.getMessage() != null ? e.getMessage() : e.toString());
                }
            }
            byte[] bytes = reply.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream out = s.getOutputStream();
            out.write(("HTTP/1.1 " + status + " X\r\nContent-Type: application/json\r\nContent-Length: "
                    + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
            out.flush();
        } catch (Throwable ignored) {
            // Malformed or abandoned connection: nothing useful to reply.
        }
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        while (buf.size() <= MAX_HEADER_LINE) {
            int c = in.read();
            if (c < 0 || c == '\n') {
                if (c < 0 && buf.size() == 0) throw new Exception("eof");
                return buf.toString("UTF-8");
            }
            if (c != '\r') buf.write(c);
        }
        throw new Exception("header too long");
    }

    private static byte[] readBody(InputStream in, int length) throws Exception {
        byte[] body = new byte[length];
        int read = 0;
        while (read < length) {
            int n = in.read(body, read, length - read);
            if (n < 0) throw new Exception("short body");
            read += n;
        }
        return body;
    }

    /** Enforces an absolute deadline by shrinking SO_TIMEOUT to the remaining time on every read. */
    private static final class DeadlineInputStream extends java.io.FilterInputStream {
        private final Socket socket;
        private final long deadline;

        DeadlineInputStream(Socket socket, InputStream in, long deadline) {
            super(in);
            this.socket = socket;
            this.deadline = deadline;
        }

        private void arm() throws java.io.IOException {
            long left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (left <= 0) throw new java.net.SocketTimeoutException("request deadline");
            socket.setSoTimeout((int) Math.max(1, left));
        }

        @Override
        public int read() throws java.io.IOException {
            arm();
            return super.read();
        }

        @Override
        public int read(byte[] b, int off, int len) throws java.io.IOException {
            arm();
            return super.read(b, off, len);
        }
    }

    private static JSONObject dispatch(Context ctx, String cmd, JSONObject body) throws Exception {
        Command command = COMMANDS.get(cmd);
        return command == null ? err("unknown command: " + cmd) : command.run(ctx, body);
    }

    // ---- Commands ----

    private static JSONObject status(Context ctx, JSONObject body) throws Exception {
        boolean storage = Build.VERSION.SDK_INT >= 30
                ? Environment.isExternalStorageManager()
                : ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        == PackageManager.PERMISSION_GRANTED;
        boolean install = Build.VERSION.SDK_INT < 26 || ctx.getPackageManager().canRequestPackageInstalls();
        boolean accessibility = PhoneAccessibilityService.isEnabled(ctx) && PhoneAccessibilityService.get() != null;
        return ok().put("storage", storage).put("install", install).put("accessibility", accessibility);
    }

    private static JSONObject apps(Context ctx, JSONObject body) throws Exception {
        PackageManager pm = ctx.getPackageManager();
        JSONArray list = new JSONArray();
        for (ApplicationInfo info : pm.getInstalledApplications(0)) {
            String version = "";
            try {
                String v = pm.getPackageInfo(info.packageName, 0).versionName;
                if (v != null) version = v;
            } catch (Exception ignored) {
                // Package vanished between the two calls; list it without a version.
            }
            list.put(new JSONObject()
                    .put("package", info.packageName)
                    .put("label", String.valueOf(pm.getApplicationLabel(info)))
                    .put("version", version)
                    .put("system", (info.flags & ApplicationInfo.FLAG_SYSTEM) != 0));
        }
        return ok().put("apps", list);
    }

    private static JSONObject launchApp(Context ctx, JSONObject body) throws Exception {
        String pkg = need(body, "package");
        Intent intent = ctx.getPackageManager().getLaunchIntentForPackage(pkg);
        if (intent == null) return err("no launchable app: " + pkg);
        launch(ctx, intent);
        return ok();
    }

    private static JSONObject open(Context ctx, JSONObject body) throws Exception {
        String target = need(body, "target");
        Intent intent = new Intent(Intent.ACTION_VIEW);
        if (target.matches("^[a-zA-Z][a-zA-Z0-9+.-]*:.*")) {
            intent.setData(Uri.parse(target));
        } else {
            File file = hostFile(ctx, target);
            if (!file.exists()) return err("no such file: " + target);
            intent.setDataAndType(uriFor(ctx, file), mime(file)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        launch(ctx, intent);
        return ok();
    }

    private static JSONObject share(Context ctx, JSONObject body) throws Exception {
        String path = need(body, "path");
        File file = hostFile(ctx, path);
        if (!file.isFile()) return err("no such file: " + path);
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType(mime(file))
                .putExtra(Intent.EXTRA_STREAM, uriFor(ctx, file))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        launch(ctx, Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        return ok();
    }

    private static JSONObject install(Context ctx, JSONObject body) throws Exception {
        String path = need(body, "path");
        File file = hostFile(ctx, path);
        if (!file.isFile()) return err("no such file: " + path);
        launch(ctx, new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uriFor(ctx, file), "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        return ok().put("note", "installer opened; the user must confirm on the phone");
    }

    private static JSONObject uninstall(Context ctx, JSONObject body) throws Exception {
        launch(ctx, new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + need(body, "package"))));
        return ok().put("note", "uninstall prompt opened; the user must confirm on the phone");
    }

    private static JSONObject notify(Context ctx, JSONObject body) throws Exception {
        NotificationHelper.ensureChannels(ctx);
        String text = body.optString("text", "");
        NotificationManagerCompat.from(ctx).notify(
                (int) (System.currentTimeMillis() & Integer.MAX_VALUE),
                new NotificationCompat.Builder(ctx, NotificationHelper.CH_ALERTS)
                        // Not the app icon: it is adaptive, and Android 8.0 kills the process
                        // ("Couldn't create icon") when an adaptive icon is a small icon.
                        .setSmallIcon(android.R.drawable.ic_dialog_info)
                        .setContentTitle(body.optString("title", "omp"))
                        .setContentText(text)
                        .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                        .setAutoCancel(true)
                        .build());
        return ok();
    }

    private static JSONObject intent(Context ctx, JSONObject body) throws Exception {
        Intent intent = new Intent();
        String action = body.optString("action", "");
        if (!action.isEmpty()) intent.setAction(action);
        String type = body.optString("type", "");
        String data = body.optString("data", "");
        if (data.startsWith("/")) {
            // A guest path: expose it through the FileProvider so the receiving app can read it.
            File file = hostFile(ctx, data);
            if (!file.exists()) return err("no such file: " + data);
            intent.setDataAndType(uriFor(ctx, file), type.isEmpty() ? mime(file) : type)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } else if (data.isEmpty()) {
            if (!type.isEmpty()) intent.setType(type);
        } else if (type.isEmpty()) {
            intent.setData(Uri.parse(data));
        } else {
            intent.setDataAndType(Uri.parse(data), type);
        }
        String pkg = body.optString("package", "");
        if (!pkg.isEmpty()) intent.setPackage(pkg);
        String component = body.optString("component", "");
        if (!component.isEmpty()) {
            ComponentName name = ComponentName.unflattenFromString(component);
            if (name == null) return err("bad component (want pkg/.Class): " + component);
            intent.setComponent(name);
        }
        Object category = body.opt("category");
        if (category instanceof JSONArray) {
            JSONArray categories = (JSONArray) category;
            for (int i = 0; i < categories.length(); i++) intent.addCategory(categories.getString(i));
        } else if (category instanceof String && !((String) category).isEmpty()) {
            intent.addCategory((String) category);
        }
        JSONObject extras = body.optJSONObject("extras");
        if (extras != null) {
            for (Iterator<String> keys = extras.keys(); keys.hasNext(); ) {
                String key = keys.next();
                Object value = extras.get(key);
                if (value instanceof Boolean) intent.putExtra(key, (Boolean) value);
                else if (value instanceof Integer) intent.putExtra(key, (Integer) value);
                else if (value instanceof Long) intent.putExtra(key, (Long) value);
                else if (value instanceof Double) intent.putExtra(key, (Double) value);
                else if (value instanceof String) intent.putExtra(key, (String) value);
                else return err("extra " + key + ": only string/number/boolean values");
            }
        }
        if (body.has("flags")) intent.addFlags(body.getInt("flags"));
        String mode = body.optString("mode", "activity");
        switch (mode) {
            case "activity": launch(ctx, intent); break;
            case "broadcast": ctx.sendBroadcast(intent); break;
            case "service": ctx.startService(intent); break;
            default: return err("bad mode: " + mode);
        }
        return ok();
    }

    private static JSONObject clipboardGet(Context ctx, JSONObject body) throws Exception {
        AtomicReference<String> text = new AtomicReference<>("");
        // ClipboardManager must be used on a Looper thread; the worker threads have none.
        onMain(() -> {
            ClipData clip = clipboard(ctx).getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                text.set(String.valueOf(clip.getItemAt(0).coerceToText(ctx)));
            }
        });
        return ok().put("text", text.get());
    }

    private static JSONObject clipboardSet(Context ctx, JSONObject body) throws Exception {
        String text = body.optString("text", "");
        onMain(() -> clipboard(ctx).setPrimaryClip(ClipData.newPlainText("omp", text)));
        return ok();
    }

    private static JSONObject uiDump(Context ctx, JSONObject body) throws Exception {
        PhoneAccessibilityService a11y = PhoneAccessibilityService.get();
        return a11y == null ? a11yOff() : ok().put("tree", a11y.dump());
    }

    private static JSONObject tap(Context ctx, JSONObject body) throws Exception {
        PhoneAccessibilityService a11y = PhoneAccessibilityService.get();
        if (a11y == null) return a11yOff();
        return done(a11y.tap(body.getInt("x"), body.getInt("y")), "tap failed");
    }

    private static JSONObject tapText(Context ctx, JSONObject body) throws Exception {
        PhoneAccessibilityService a11y = PhoneAccessibilityService.get();
        if (a11y == null) return a11yOff();
        String text = need(body, "text");
        return done(a11y.clickText(text), "no node matches: " + text);
    }

    private static JSONObject type(Context ctx, JSONObject body) throws Exception {
        PhoneAccessibilityService a11y = PhoneAccessibilityService.get();
        if (a11y == null) return a11yOff();
        return done(a11y.type(body.optString("text", "")), "no focused editable field");
    }

    private static JSONObject swipe(Context ctx, JSONObject body) throws Exception {
        PhoneAccessibilityService a11y = PhoneAccessibilityService.get();
        if (a11y == null) return a11yOff();
        return done(a11y.swipe(body.getInt("x1"), body.getInt("y1"), body.getInt("x2"), body.getInt("y2"),
                body.optLong("ms", 300L)), "swipe failed");
    }

    private static JSONObject key(Context ctx, JSONObject body) throws Exception {
        PhoneAccessibilityService a11y = PhoneAccessibilityService.get();
        if (a11y == null) return a11yOff();
        String name = need(body, "name");
        return done(a11y.key(name), "unknown or failed key: " + name);
    }

    private static JSONObject screenshot(Context ctx, JSONObject body) throws Exception {
        PhoneAccessibilityService a11y = PhoneAccessibilityService.get();
        if (a11y == null) return a11yOff();
        String path = need(body, "path");
        a11y.screenshot(hostFile(ctx, path));
        return ok().put("path", path);
    }

    // ---- Helpers ----

    private static JSONObject a11yOff() {
        return err("accessibility service is off: enable omp-pulse in Settings > Accessibility");
    }

    private static File hostFile(Context ctx, String guestPath) {
        return LocalRuntime.get(ctx).hostPath(guestPath);
    }

    private static ClipboardManager clipboard(Context ctx) {
        return (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
    }

    private static void launch(Context ctx, Intent intent) {
        // Started from an application context, so a new task is mandatory.
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private static Uri uriFor(Context ctx, File file) {
        return FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
    }

    private static String mime(File file) {
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        String type = dot < 0 ? null
                : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "*/*" : type;
    }

    private static void onMain(Runnable task) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        Throwable[] failure = new Throwable[1];
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                task.run();
            } catch (Throwable t) {
                failure[0] = t;
            } finally {
                latch.countDown();
            }
        });
        if (!latch.await(5, TimeUnit.SECONDS)) throw new Exception("main thread busy");
        if (failure[0] != null) throw new Exception(String.valueOf(failure[0].getMessage()));
    }

    private static String need(JSONObject body, String field) {
        String value = body.optString(field, "");
        if (value.isEmpty()) throw new IllegalArgumentException("missing field: " + field);
        return value;
    }

    private static JSONObject done(boolean success, String error) throws Exception {
        return success ? ok() : err(error);
    }

    private static JSONObject ok() throws Exception {
        return new JSONObject().put("ok", true);
    }

    private static JSONObject err(String message) {
        try {
            return new JSONObject().put("ok", false).put("error", message);
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
