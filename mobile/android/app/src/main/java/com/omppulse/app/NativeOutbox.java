package com.omppulse.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
/** Durable Android command queue shared by activities, bubbles, and notification replies. */
public final class NativeOutbox {
    private static final String TAG = "OmpNativeOutbox";
    private static final String DATABASE = "native-outbox.db";
    // 2 meant different schemas on the two lines this file was merged from:
    // `delivery` on the redesign build, the receipt binding columns on the
    // other. 3 has all of them; the upgrade adds whichever columns are
    // missing, so a v2 database from either build reaches the same schema.
    // 4 adds crash-durable draft-edit reservations without changing receipt states.
    private static final int DATABASE_VERSION = 4;
    private static final int MAX_ROWS = 50;
    private static final long MAX_BYTES = 32L * 1024 * 1024;
    private static final long TERMINAL_TTL_MS = 24L * 60 * 60 * 1000;
    // INVARIANT: a tombstone must outlive every local source that can still
    // offer its command ID back: the browser import and legacy reply migration
    // run on the next app open, and a lost save acknowledgement keeps the ID
    // only until the draft is cleared. A week covers those; a send that did
    // reach the daemon stays deduplicated there by its archived receipt.
    private static final long TOMBSTONE_TTL_MS = 7L * 24 * 60 * 60 * 1000;
    // Background follow-up of unfinished work backs off with the command's age
    // up to this interval, so a stuck command costs a few requests an hour.
    private static final long FOLLOW_UP_CAP_MS = 15 * 60_000L;
    // The daemon stops watching a receipt 24 h after accepting it (RECEIPT_WATCH_MAX
    // in src/server/http.rs); past that a poll cannot observe progress, so polling stops.
    private static final long FOLLOW_UP_GIVE_UP_MS = 25L * 60 * 60 * 1000;
    private static final long HTTP_DEADLINE_MS = 120_000;
    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

    private static final ExecutorService DELIVERY = Executors.newSingleThreadExecutor(r ->
            new Thread(r, "omp-native-delivery"));
    // Checking one saved send must neither wait behind the full delivery drain
    // nor wake unrelated saved prompts. Reservations bound running + queued work.
    private static final Set<StatusKey> STATUS_KEYS = new HashSet<>();
    private static final ExecutorService STATUS = new ThreadPoolExecutor(
            1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(MAX_ROWS),
            r -> new Thread(r, "omp-native-status"), new ThreadPoolExecutor.AbortPolicy());
    private static final ScheduledExecutorService DEADLINES = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "omp-native-http-deadline");
        thread.setDaemon(true);
        return thread;
    });
    // The WebView used to list the whole outbox over the bridge every second to
    // spot rows that delivery, receipt checks or notification replies changed
    // behind it, so a timer kept firing even with nothing in flight. Every
    // committed mutation now signals here instead, and the bridge forwards one
    // push per burst to the page.
    private static final ChangeSignal CHANGES = new ChangeSignal(SystemClock::elapsedRealtime, (task, delayMs) -> {
        ScheduledFuture<?> future = DEADLINES.schedule(task, delayMs, TimeUnit.MILLISECONDS);
        return () -> future.cancel(false);
    });
    private static final AtomicBoolean DRAIN_ACTIVE = new AtomicBoolean();
    private static final AtomicBoolean DRAIN_AGAIN = new AtomicBoolean();
    private static final AtomicBoolean MIGRATING_NOTIFICATION_REPLIES = new AtomicBoolean();
    private static final ConcurrentLinkedQueue<Runnable> JOB_COMPLETIONS = new ConcurrentLinkedQueue<>();

    private static final long VERSION_CACHE_MS = 5 * 60_000L;
    private static volatile String versionVerifiedOrigin;
    private static volatile long versionVerifiedAt;
    private static volatile Helper helper;
    private static volatile Context app;

    private NativeOutbox() {}

    public static void initialize(Context context) {
        Context application = context.getApplicationContext();
        app = application;
        database(application);
        migrateNotificationReplies(application);
        wake();
    }

    /** One listener (the page bridge); it must not throw and must not block. */
    static void setChangeListener(Runnable listener) {
        CHANGES.setListener(listener);
    }

    private static void changed() {
        try {
            CHANGES.signal();
        } catch (RuntimeException error) {
            // A UI hint must never turn a committed save into a reported storage failure.
            Log.w("OmpNativeOutbox", "Could not announce an outbox change", error);
        }
    }

    /** First hint immediately, then one trailing hint per burst, at most four per second. */
    static final class ChangeSignal {
        interface Clock { long now(); }
        interface Cancellation { void cancel(); }
        interface Scheduler { Cancellation schedule(Runnable task, long delayMs); }

        static final long MIN_INTERVAL_MS = 250;
        private final Clock clock;
        private final Scheduler scheduler;
        private final Object lock = new Object();
        private volatile Runnable listener;
        private boolean fired;
        private long firedAt;
        private boolean trailing;
        private Cancellation pending;
        private long generation;

        ChangeSignal(Clock clock, Scheduler scheduler) {
            this.clock = clock;
            this.scheduler = scheduler;
        }

        void setListener(Runnable listener) {
            synchronized (lock) {
                this.listener = listener;
                if (listener == null) {
                    generation++;
                    if (pending != null) pending.cancel();
                    pending = null;
                    trailing = false;
                    fired = false;
                }
            }
        }

        void signal() {
            synchronized (lock) {
                if (listener == null || trailing) return;
                long now = clock.now();
                long wait = fired ? firedAt + MIN_INTERVAL_MS - now : 0;
                if (wait > 0) {
                    trailing = true;
                    long expected = generation;
                    pending = scheduler.schedule(() -> flush(expected), wait);
                    return;
                }
                fired = true;
                firedAt = now;
            }
            deliver();
        }

        private void flush(long expected) {
            synchronized (lock) {
                if (generation != expected || listener == null) return;
                pending = null;
                trailing = false;
                fired = true;
                firedAt = clock.now();
            }
            deliver();
        }

        private void deliver() {
            Runnable current = listener;
            if (current != null) current.run();
        }
    }
    /** Credential scope deliberately excludes the server; SQLite scopes by origin separately. */
    public static String namespace(String token) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(StandardCharsets.UTF_8));
        return "cred-" + hex(digest);
    }

    public static String currentNamespace(Context context) throws Exception {
        String token = TokenStore.getToken(context);
        if (token == null || token.isEmpty()) throw new IllegalStateException("Device is not paired");
        return namespace(token);
    }

    private static void migrateNotificationReplies(Context context) {
        if (!MIGRATING_NOTIFICATION_REPLIES.compareAndSet(false, true)) return;
        boolean complete = false;
        try {
            String token = TokenStore.getToken(context);
            if (token == null || token.isEmpty()) return;
            String endpoint = NativeConfig.appUrl(context);
            complete = true;
            JSONArray saved = NotificationPreferences.pendingReplyCommands(context);
            for (int i = 0; i < saved.length(); i++) {
                JSONObject command = saved.optJSONObject(i);
                if (command == null || !NotificationPreferences.isReplyCommandCurrent(
                        context, command, endpoint, token)) continue;
                try {
                    enqueueNotification(context, command, true);
                    NotificationPreferences.removeReplyCommand(context, command.optString("commandId"));
                } catch (Exception error) {
                    complete = false;
                    Log.w(TAG, "Legacy notification reply remains in SharedPreferences", error);
                }
            }
        } finally {
            MIGRATING_NOTIFICATION_REPLIES.set(complete);
        }
    }

    static void enqueueNotification(Context context, JSONObject saved) throws Exception {
        enqueueNotification(context, saved, false);
    }

    /** New replies may post; replies recovered from old preferences are reconcile-only. */
    static void enqueueNotification(Context context, JSONObject saved, boolean reconcileOnly) throws Exception {
        Context application = context.getApplicationContext();
        app = application;
        database(application);
        String token = TokenStore.getToken(application);
        if (token == null || token.isEmpty()) throw new IllegalStateException("Device is not paired");
        String currentNamespace = namespace(token);
        String suppliedNamespace = saved.optString("namespace", currentNamespace);
        if (!currentNamespace.equals(suppliedNamespace)) throw new SecurityException("Credential scope changed");
        String currentOrigin = origin(NativeConfig.appUrl(application));
        String suppliedOrigin = saved.optString("origin", currentOrigin);
        if (!currentOrigin.equals(suppliedOrigin)) throw new SecurityException("Server scope changed");
        JSONObject command = new JSONObject()
                .put("commandId", saved.getString("commandId"))
                .put("sessionPath", saved.getString("sessionPath"))
                .put("text", saved.getString("text"))
                .put("images", new JSONArray())
                .put("createdAt", saved.optLong("createdAt", System.currentTimeMillis()))
                .put("notificationReply", true)
                .put("title", saved.optString("title", "omp-pulse"))
                .put("body", saved.optString("body", ""))
                .put("kind", saved.optString("kind", "agent_end"))
                .put("tag", saved.optString("tag", ""))
                .put("state", reconcileOnly ? "uncertain" : "saved");
        InsertResult result = insert(context, NativeConfig.appUrl(context), namespace(token), command,
                reconcileOnly, reconcileOnly, Long.MAX_VALUE);
        routeSavedCommand(context, namespace(token), currentOrigin, result, reconcileOnly);
    }

    static JSONArray list(Context context, String namespace, String origin, String session) throws Exception {
        JSONArray result = new JSONArray();
        String where = "namespace=? AND origin=?" + (session == null ? "" : " AND session_path=?");
        String[] args = session == null
                ? new String[]{namespace, origin} : new String[]{namespace, origin, session};
        try (Cursor rows = database(context).getReadableDatabase().query(
                "commands", null, where, args, null, null, "created_at ASC")) {
            while (rows.moveToNext()) result.put(prompt(context, rows));
        }
        return result;
    }

    static JSONObject get(Context context, String namespace, String origin, String commandId) throws Exception {
        try (Cursor row = database(context).getReadableDatabase().query(
                "commands", null, "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, null)) {
            return row.moveToFirst() ? prompt(context, row) : null;
        }
    }

    static JSONArray images(Context context, String namespace, String origin, String commandId) throws Exception {
        JSONArray result = new JSONArray();
        String sql = "SELECT mime_type,file_path FROM attachments " +
                "WHERE namespace=? AND origin=? AND command_id=? ORDER BY image_index ASC";
        try (Cursor rows = database(context).getReadableDatabase().rawQuery(
                sql, new String[]{namespace, origin, commandId})) {
            while (rows.moveToNext()) {
                String data = readTextFile(new File(rows.getString(1)));
                result.put(new JSONObject().put("data", data).put("mimeType", rows.getString(0)));
            }
        }
        return result;
    }

    /** Reserve an undispatched intent before another store takes custody of its photos. */
    static JSONObject editBegin(Context context, String namespace, String origin, String commandId,
                                JSONObject expected, long deadline) throws Exception {
        SQLiteDatabase db = database(context).getWritableDatabase();
        boolean reserved = false;
        db.beginTransaction();
        try {
            checkDeadline(deadline);
            assertStoreScope(context, namespace, origin);
            StoredIntent current = readIntent(db, namespace, origin, commandId);
            if (current == null || !"saved".equals(current.state) || current.legacy
                    || current.receipt != null || current.binding != null
                    || (current.editToken == null && !current.mayPost)) return null;
            JSONObject entry = get(context, namespace, origin, commandId);
            if (!sameExpectedIntent(entry, expected)) return null;
            String editToken = current.editToken;
            if (editToken == null) {
                editToken = UUID.randomUUID().toString();
                ContentValues values = new ContentValues();
                values.put("edit_token", editToken);
                values.put("may_post", 0);
                values.put("receipt_revision", current.revision + 1);
                db.update("commands", values, "namespace=? AND origin=? AND command_id=?",
                        new String[]{namespace, origin, commandId});
                // Keep updatedAt: a lost begin acknowledgement can reacquire this exact reservation.
                entry.put("editToken", editToken);
            }
            JSONArray recovered = images(context, namespace, origin, commandId);
            checkDeadline(deadline);
            assertStoreScope(context, namespace, origin);
            db.setTransactionSuccessful();
            reserved = true;
            return new JSONObject().put("editToken", editToken).put("entry", entry).put("images", recovered);
        } finally {
            db.endTransaction();
            if (reserved) changed();
        }
    }

    private static boolean sameExpectedIntent(JSONObject current, JSONObject expected) throws Exception {
        return current != null
                && current.getString("commandId").equals(expected.getString("commandId"))
                && current.getString("state").equals(expected.getString("state"))
                && current.getString("sessionPath").equals(expected.getString("sessionPath"))
                && current.getString("text").equals(expected.getString("text"))
                && current.getLong("createdAt") == expected.getLong("createdAt")
                && current.getLong("updatedAt") == expected.getLong("updatedAt")
                && current.getInt("imageCount") == expected.getInt("imageCount")
                && current.getLong("imageBytes") == expected.getLong("imageBytes")
                && current.optBoolean("droppedImages", false) == expected.optBoolean("droppedImages", false);
    }

    /** Commit only after durable draft custody; an abandoned reservation never auto-sends. */
    static boolean editFinish(Context context, String namespace, String origin, String commandId,
                              String editToken, boolean commit, long deadline) throws Exception {
        SQLiteDatabase db = database(context).getWritableDatabase();
        List<String> files = null;
        db.beginTransaction();
        try {
            checkDeadline(deadline);
            assertStoreScope(context, namespace, origin);
            StoredIntent current = readIntent(db, namespace, origin, commandId);
            if (current == null) return commit && isTombstoned(db, namespace, origin, commandId);
            if (editToken.isEmpty() || !editToken.equals(current.editToken)
                    || !"saved".equals(current.state)) return false;
            if (commit) {
                files = removeRecord(db, namespace, origin, commandId);
            } else {
                ContentValues values = new ContentValues();
                values.putNull("edit_token");
                values.put("may_post", 1);
                values.put("updated_at", System.currentTimeMillis());
                values.put("receipt_revision", current.revision + 1);
                db.update("commands", values, "namespace=? AND origin=? AND command_id=?",
                        new String[]{namespace, origin, commandId});
            }
            checkDeadline(deadline);
            assertStoreScope(context, namespace, origin);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        changed();
        if (files != null) deleteFiles(files);
        else wake();
        return true;
    }

    private static List<String> removeRecord(SQLiteDatabase db, String namespace, String origin, String commandId) {
        List<String> files = attachmentPaths(db, namespace, origin, commandId);
        db.execSQL("INSERT OR IGNORE INTO tombstones(namespace,origin,command_id,created_at) VALUES(?,?,?,?)",
                new Object[]{namespace, origin, commandId, System.currentTimeMillis()});
        db.delete("attachments", "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId});
        db.delete("commands", "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId});
        return files;
    }

    static boolean remove(Context context, String namespace, String origin, String commandId,
                          JSONObject expected, long deadline) throws Exception {
        SQLiteDatabase db = database(context).getWritableDatabase();
        List<String> files;
        db.beginTransaction();
        try {
            checkDeadline(deadline);
            assertStoreScope(context, namespace, origin);
            if (expected != null) {
                JSONObject current = get(context, namespace, origin, commandId);
                if (!sameExpectedIntent(current, expected)
                        || !Objects.equals(current.optString("editToken", null), expected.optString("editToken", null))) return false;
            }
            assertNotDispatching(db, namespace, origin, commandId, null);
            files = removeRecord(db, namespace, origin, commandId);
            checkDeadline(deadline);
            assertStoreScope(context, namespace, origin);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        changed();
        deleteFiles(files);
        return true;
    }

    static JSONObject enqueue(Context context, String namespace, String origin,
                              JSONObject command, boolean reconcileOnly, long deadline) throws Exception {
        checkDeadline(deadline);
        InsertResult saved = insert(context, origin, namespace, command, reconcileOnly,
                reconcileOnly, deadline);
        routeSavedCommand(context, namespace, origin, saved, reconcileOnly);
        return saved.command;
    }

    private static final class InsertResult {
        final JSONObject command;
        final boolean inserted;
        InsertResult(JSONObject command, boolean inserted) {
            this.command = command;
            this.inserted = inserted;
        }
    }

    private static void routeSavedCommand(Context context, String namespace, String origin,
                                          InsertResult result, boolean reconcileOnly) {
        if (result.command == null) return;
        // A later routing/read failure cannot retract the durable save ack.
        try {
            StoredIntent intent = readIntent(context, namespace, origin,
                    result.command.getString("commandId"));
            if (intent == null || intent.editToken != null || isTerminal(intent.state)) return;
            if (result.inserted) {
                if (!reconcileOnly && "saved".equals(intent.state) && intent.mayPost && !intent.legacy
                        && intent.receipt == null && intent.binding == null) wake();
                else requestStatus(context, intent);
            } else if ("saved".equals(intent.state) && intent.mayPost && !intent.legacy
                    && intent.receipt == null && intent.binding == null) {
                wake();
            } else {
                // Existing handed-off intent is Check status, never a new send.
                requestStatus(context, intent);
            }
        } catch (Exception error) {
            Log.w(TAG, "Saved command acknowledged; follow-up status unavailable", error);
        }
    }

    private static final class StatusKey {
        final String namespace;
        final String origin;
        final String commandId;
        StatusKey(StoredIntent intent) {
            namespace = intent.namespace;
            origin = intent.origin;
            commandId = intent.commandId;
        }
        @Override public boolean equals(Object other) {
            if (!(other instanceof StatusKey)) return false;
            StatusKey key = (StatusKey) other;
            return namespace.equals(key.namespace) && origin.equals(key.origin)
                    && commandId.equals(key.commandId);
        }
        @Override public int hashCode() { return Objects.hash(namespace, origin, commandId); }
    }

    private static void requestStatus(Context context, StoredIntent intent) throws Exception {
        if (intent.editToken != null) return;
        String token = TokenStore.getToken(context);
        String endpoint = NativeConfig.appUrl(context);
        assertCurrentScope(context, token, intent.namespace, endpoint);
        if (!intent.origin.equals(origin(endpoint))) return;
        StatusKey key = new StatusKey(intent);
        synchronized (STATUS_KEYS) {
            if (STATUS_KEYS.contains(key) || STATUS_KEYS.size() >= MAX_ROWS) return;
            STATUS_KEYS.add(key);
        }
        try {
            STATUS.execute(() -> {
                try { inspectSavedReceipt(context, token, endpoint, intent); }
                finally { synchronized (STATUS_KEYS) { STATUS_KEYS.remove(key); } }
            });
        } catch (RejectedExecutionException rejected) {
            synchronized (STATUS_KEYS) { STATUS_KEYS.remove(key); }
            Log.w(TAG, "Native status worker busy; saved command retained", rejected);
        }
    }

    /** This lane observes one receipt and may finish its local terminal notification. */
    private static void inspectSavedReceipt(Context context, String token, String endpoint,
                                            StoredIntent expected) {
        HttpSession http = null;
        try {
            assertCurrentScope(context, token, expected.namespace, endpoint);
            StoredIntent current = readIntent(context, expected.namespace, expected.origin, expected.commandId);
            if (!expected.matches(current) || current.revision != expected.revision || current.editToken != null || isTerminal(current.state)) return;
            http = new HttpSession(token);
            JSONObject response = lookupReceipt(http, expected.origin, token,
                    expected.commandId, expected.sessionPath);
            if (response != null) {
                NativeReceiptValidator.Evidence applied = applyReceipt(context, token, endpoint, expected, response);
                if (applied != null) reportTerminalNotification(context, expected.namespace,
                        expected.origin, expected.commandId, applied.receipt);
            }
        } catch (Exception error) {
            // An absent or unavailable observation changes no evidence or posting authority.
            Log.w(TAG, "Native receipt status unavailable; saved evidence retained", error);
        } finally {
            if (http != null) http.close();
        }
    }

    private static final class StoredIntent {
        final String namespace;
        final String origin;
        final String commandId;
        final String sessionPath;
        final String payloadHash;
        final String state;
        final String receipt;
        final String binding;
        final String editToken;
        final long revision;
        final boolean mayPost;
        final boolean legacy;
        final long createdAt;

        StoredIntent(Cursor row) {
            namespace = row.getString(row.getColumnIndexOrThrow("namespace"));
            origin = row.getString(row.getColumnIndexOrThrow("origin"));
            commandId = row.getString(row.getColumnIndexOrThrow("command_id"));
            sessionPath = row.getString(row.getColumnIndexOrThrow("session_path"));
            payloadHash = row.getString(row.getColumnIndexOrThrow("payload_hash"));
            state = row.getString(row.getColumnIndexOrThrow("state"));
            receipt = row.getString(row.getColumnIndexOrThrow("receipt"));
            binding = row.getString(row.getColumnIndexOrThrow("receipt_binding"));
            editToken = row.getString(row.getColumnIndexOrThrow("edit_token"));
            revision = row.getLong(row.getColumnIndexOrThrow("receipt_revision"));
            mayPost = row.getInt(row.getColumnIndexOrThrow("may_post")) != 0;
            legacy = row.getInt(row.getColumnIndexOrThrow("legacy")) != 0;
            createdAt = row.getLong(row.getColumnIndexOrThrow("created_at"));
        }

        boolean matches(StoredIntent current) {
            return current != null && namespace.equals(current.namespace) && origin.equals(current.origin)
                    && commandId.equals(current.commandId) && sessionPath.equals(current.sessionPath)
                    && payloadHash.equals(current.payloadHash);
        }
    }

    private static StoredIntent readIntent(Context context, String namespace, String origin, String commandId) {
        return readIntent(database(context).getReadableDatabase(), namespace, origin, commandId);
    }

    private static StoredIntent readIntent(SQLiteDatabase db, String namespace, String origin, String commandId) {
        try (Cursor row = db.query("commands", null, "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, null)) {
            return row.moveToFirst() ? new StoredIntent(row) : null;
        }
    }

    private static String encodeBinding(Object binding) {
        String array = new JSONArray().put(binding).toString();
        return array.substring(1, array.length() - 1);
    }

    private static Object decodeBinding(String binding) throws Exception {
        JSONTokener parser = new JSONTokener(binding);
        Object value = parser.nextValue();
        if (parser.nextClean() != 0) throw new IllegalStateException("Invalid saved receipt binding");
        return value;
    }

    static void clear(Context context, String namespace, String origin, String sessionPath, long deadline) {
        SQLiteDatabase db = database(context).getWritableDatabase();
        List<String> files = new ArrayList<>();
        db.beginTransaction();
        try {
            checkDeadline(deadline);
            String where = "namespace=? AND origin=?" + (sessionPath == null ? "" : " AND session_path=?");
            String[] args = sessionPath == null
                    ? new String[]{namespace, origin} : new String[]{namespace, origin, sessionPath};
            assertNotDispatching(db, namespace, origin, null, sessionPath);
            try (Cursor rows = db.query("commands", new String[]{"command_id"},
                    where, args, null, null, null)) {
                while (rows.moveToNext()) {
                    String commandId = rows.getString(0);
                    db.execSQL("INSERT OR IGNORE INTO tombstones(namespace,origin,command_id,created_at) VALUES(?,?,?,?)",
                            new Object[]{namespace, origin, commandId, System.currentTimeMillis()});
                    files.addAll(attachmentPaths(db, namespace, origin, commandId));
                    db.delete("attachments", "namespace=? AND origin=? AND command_id=?",
                            new String[]{namespace, origin, commandId});
                }
            }
            long now = System.currentTimeMillis();
            String markerSession = sessionPath == null ? "" : sessionPath;
            db.execSQL("INSERT OR REPLACE INTO clear_markers(namespace,origin,session_path,clear_at) VALUES(?,?,?,?)",
                    new Object[]{namespace, origin, markerSession, now});
            db.delete("commands", where, args);
            checkDeadline(deadline);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        changed();
        deleteFiles(files);
    }

    private static void assertNoPendingSessionEdit(SQLiteDatabase db, String namespace, String origin,
                                                  String sessionPath) {
        try (Cursor rows = db.query("commands", new String[]{"edit_token"},
                "namespace=? AND origin=? AND session_path=?",
                new String[]{namespace, origin, sessionPath}, null, null, null)) {
            while (rows.moveToNext()) {
                if (rows.getString(0) != null)
                    throw new IllegalStateException("Edit again to finish or cancel saved message");
            }
        }
    }

    private static InsertResult insert(Context context, String endpoint, String namespace,
                                     JSONObject command, boolean reconcileOnly,
                                     boolean legacy, long deadline) throws Exception {
        String origin = origin(endpoint);
        String commandId = command.getString("commandId");
        String sessionPath = command.getString("sessionPath");
        String text = command.getString("text");
        JSONArray incomingImages = command.optJSONArray("images");
        if (incomingImages == null) incomingImages = new JSONArray();
        if (commandId.isEmpty() || sessionPath.isEmpty()) throw new IllegalArgumentException("Incomplete command");
        if (command.optBoolean("droppedImages", false)) {
            throw new IllegalArgumentException("Legacy attachments are incomplete; text-only send was blocked");
        }
        Object reservation = command.opt("editToken");
        String editToken = null;
        if (reservation != null && reservation != JSONObject.NULL) {
            if (!(reservation instanceof String) || ((String) reservation).isEmpty()
                    || !"saved".equals(command.optString("state", "saved"))
                    || reconcileOnly || legacy
                    || command.opt("receipt") != null && command.opt("receipt") != JSONObject.NULL
                    || command.opt("receiptBinding") != null && command.opt("receiptBinding") != JSONObject.NULL) {
                throw new IllegalArgumentException("Invalid imported edit reservation");
            }
            editToken = (String) reservation;
        }

        long textBytes = utf8Length(text);
        long imageBytes = 0;
        MessageDigest fingerprint = MessageDigest.getInstance("SHA-256");
        digestField(fingerprint, sessionPath);
        digestField(fingerprint, text);
        List<PreparedImage> prepared = new ArrayList<>(incomingImages.length());
        for (int i = 0; i < incomingImages.length(); i++) {
            JSONObject image = incomingImages.getJSONObject(i);
            String data = image.getString("data");
            String mimeType = image.getString("mimeType");
            long bytes = decodedLength(data);
            imageBytes += bytes;
            digestField(fingerprint, mimeType);
            digestField(fingerprint, data);
            prepared.add(new PreparedImage(mimeType, data, bytes));
        }
        long payloadBytes = textBytes + imageBytes;
        if (payloadBytes > MAX_BYTES) throw new IllegalStateException("Native queue is full (32 MiB)");
        byte[] payloadHash = fingerprint.digest();
        SQLiteDatabase db = database(context).getWritableDatabase();
        assertStoreScope(context, namespace, origin);

        boolean newSend = editToken == null && !reconcileOnly
                && "saved".equals(command.optString("state", "saved"))
                && command.optJSONObject("receipt") == null
                && (command.opt("receiptBinding") == null || command.opt("receiptBinding") == JSONObject.NULL);
        if (newSend) assertNoPendingSessionEdit(db, namespace, origin, sessionPath);
        JSONObject existing = findExisting(context, namespace, origin, commandId);
        if (existing != null) {
            assertSamePayload(db, namespace, origin, commandId, payloadHash);
            if (editToken != null && !editToken.equals(existing.optString("editToken", null)))
                throw new IllegalArgumentException("Conflicting imported edit reservation");
            return new InsertResult(existing, false);
        }
        if (isTombstoned(db, namespace, origin, commandId)) return new InsertResult(null, false);

        NativeAttachmentRecovery.OWNERSHIP.lock();
        try {
            List<String> stagedFiles = persistAttachments(context, prepared, deadline);
            boolean committed = false;
            try {
                db.beginTransaction();
                try {
                    checkDeadline(deadline);
                    if (newSend) assertNoPendingSessionEdit(db, namespace, origin, sessionPath);
                    JSONObject raced = findExisting(context, namespace, origin, commandId);
                    if (raced != null) {
                        assertSamePayload(db, namespace, origin, commandId, payloadHash);
                        if (editToken != null && !editToken.equals(raced.optString("editToken", null)))
                            throw new IllegalArgumentException("Conflicting imported edit reservation");
                        db.setTransactionSuccessful();
                        return new InsertResult(raced, false);
                    }
                    if (isTombstoned(db, namespace, origin, commandId)) {
                        db.setTransactionSuccessful();
                        return new InsertResult(null, false);
                    }
                    long createdAt = command.optLong("createdAt", System.currentTimeMillis());
                    boolean imported = command.has("state") || command.has("createdAt");
                    if (imported && wasCleared(db, namespace, origin, sessionPath, createdAt)) {
                        db.setTransactionSuccessful();
                        return new InsertResult(null, false);
                    }
                    int count;
                    long usedBytes;
                    try (Cursor counts = db.rawQuery(
                            "SELECT COUNT(*),COALESCE(SUM(payload_bytes),0) FROM commands " +
                                    "WHERE namespace=? AND origin=? AND state NOT IN ('completed','forwarded','failed')",
                            new String[]{namespace, origin})) {
                        counts.moveToFirst();
                        count = counts.getInt(0);
                        usedBytes = counts.getLong(1);
                    }
                    if (count >= MAX_ROWS) throw new IllegalStateException("Native queue is full (50 commands)");
                    if (usedBytes + payloadBytes > MAX_BYTES) {
                        throw new IllegalStateException("Native queue is full (32 MiB)");
                    }
    
                    String state = command.optString("state", "saved");
                    validateState(state);
                    JSONObject receipt = command.optJSONObject("receipt");
                    ContentValues values = new ContentValues();
                    values.put("namespace", namespace);
                    values.put("origin", origin);
                    values.put("command_id", commandId);
                    values.put("session_path", sessionPath);
                    values.put("text", text);
                    values.put("created_at", createdAt);
                    values.put("updated_at", command.optLong("updatedAt", createdAt));
                    values.put("state", state);
                    values.put("receipt", receipt == null ? null : receipt.toString());
                    // Browser legacy imports define null as no witness. Preserve
                    // every other value so malformed proof cannot become absence.
                    Object binding = command.opt("receiptBinding");
                    boolean priorEvidence = receipt != null || (binding != null && binding != JSONObject.NULL);
                    values.put("receipt_binding", binding == null || binding == JSONObject.NULL
                            ? null : encodeBinding(binding));
                    values.put("error", reconcileOnly
                            ? "Legacy delivery status cannot be determined" : command.optString("error", null));
                    values.put("legacy", legacy || priorEvidence ? 1 : 0);
                    values.put("edit_token", editToken);
                    values.put("may_post", reconcileOnly || priorEvidence || editToken != null ? 0 : 1);
                    values.put("payload_hash", hex(payloadHash));
                    values.put("payload_bytes", payloadBytes);
                    values.put("notification_reply", command.optBoolean("notificationReply", false) ? 1 : 0);
                    values.put("notify_title", command.optString("title", "omp-pulse"));
                    values.put("notify_body", command.optString("body", ""));
                    values.put("notify_kind", command.optString("kind", "agent_end"));
                    values.put("notify_tag", command.optString("tag", ""));
                    values.put("delivery", delivery(command));
                    db.insertOrThrow("commands", null, values);
                    for (int i = 0; i < prepared.size(); i++) {
                        ContentValues attachment = new ContentValues();
                        attachment.put("namespace", namespace);
                        attachment.put("origin", origin);
                        attachment.put("command_id", commandId);
                        attachment.put("image_index", i);
                        attachment.put("mime_type", prepared.get(i).mimeType);
                        attachment.put("file_path", stagedFiles.get(i));
                        attachment.put("byte_count", prepared.get(i).bytes);
                        db.insertOrThrow("attachments", null, attachment);
                    }
                    assertStoreScope(context, namespace, origin);
                    checkDeadline(deadline);
                    db.setTransactionSuccessful();
                    committed = true;
                } finally {
                    db.endTransaction();
                }
                changed();
                return new InsertResult(get(context, namespace, origin, commandId), true);
            } finally {
                if (!committed) deleteFiles(stagedFiles);
            }
        } finally {
            NativeAttachmentRecovery.OWNERSHIP.unlock();
        }
    }

    private static JSONObject findExisting(Context context, String namespace, String origin,
                                           String commandId) throws Exception {
        try (Cursor row = database(context).getReadableDatabase().query(
                "commands", null, "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, null)) {
            return row.moveToFirst() ? prompt(context, row) : null;
        }
    }

    private static void assertSamePayload(SQLiteDatabase db, String namespace, String origin,
                                          String commandId, byte[] fingerprint) {
        try (Cursor row = db.query("commands", new String[]{"payload_hash"},
                "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, null)) {
            if (!row.moveToFirst() || !hex(fingerprint).equals(row.getString(0))) {
                throw new IllegalStateException("Command ID payload collision");
            }
        }
    }

    private static JSONObject prompt(Context context, Cursor row) throws Exception {
        String namespace = row.getString(row.getColumnIndexOrThrow("namespace"));
        String origin = row.getString(row.getColumnIndexOrThrow("origin"));
        String commandId = row.getString(row.getColumnIndexOrThrow("command_id"));
        int imageCount = 0;
        long imageBytes = 0;
        try (Cursor images = database(context).getReadableDatabase().rawQuery(
                "SELECT COUNT(*),COALESCE(SUM(byte_count),0) FROM attachments " +
                        "WHERE namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId})) {
            images.moveToFirst();
            imageCount = images.getInt(0);
            imageBytes = images.getLong(1);
        }
        String receipt = row.getString(row.getColumnIndexOrThrow("receipt"));
        String binding = row.getString(row.getColumnIndexOrThrow("receipt_binding"));
        String error = row.getString(row.getColumnIndexOrThrow("error"));
        JSONObject result = new JSONObject()
                .put("id", commandId)
                .put("commandId", commandId)
                .put("sessionPath", row.getString(row.getColumnIndexOrThrow("session_path")))
                .put("text", row.getString(row.getColumnIndexOrThrow("text")))
                .put("imageCount", imageCount)
                .put("imageBytes", imageBytes)
                .put("droppedImages", false)
                .put("createdAt", row.getLong(row.getColumnIndexOrThrow("created_at")))
                .put("updatedAt", row.getLong(row.getColumnIndexOrThrow("updated_at")))
                .put("state", row.getString(row.getColumnIndexOrThrow("state")));
        if (receipt != null) result.put("receipt", new JSONObject(receipt));
        if (binding != null) result.put("receiptBinding", decodeBinding(binding));
        if (error != null) result.put("error", error);
        String editToken = row.getString(row.getColumnIndexOrThrow("edit_token"));
        if (editToken != null) result.put("editToken", editToken);
        String delivery = row.getString(row.getColumnIndexOrThrow("delivery"));
        if (delivery != null) result.put("delivery", delivery);
        return result;
    }

    /** Only the three modes the daemon accepts; anything else is stored as none (steer). */
    private static String delivery(JSONObject command) {
        String value = command.optString("delivery", "");
        return "steer".equals(value) || "queue".equals(value) || "interrupt".equals(value) ? value : null;
    }


    private static List<String> persistAttachments(Context context, List<PreparedImage> images,
                                                    long deadline) throws Exception {
        List<String> paths = new ArrayList<>(images.size());
        File directory = new File(context.getFilesDir(), "native-outbox");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Could not create private attachment storage");
        try {
            for (PreparedImage image : images) {
                checkDeadline(deadline);
                File file = new File(directory, UUID.randomUUID() + ".b64");
                paths.add(file.getAbsolutePath());
                try (FileOutputStream fileStream = new FileOutputStream(file);
                     java.io.BufferedOutputStream stream = new java.io.BufferedOutputStream(fileStream, 16 * 1024)) {
                    for (int offset = 0; offset < image.data.length(); offset++) {
                        stream.write((byte) image.data.charAt(offset));
                    }
                    stream.flush();
                    fileStream.getFD().sync();
                }
            }
            return paths;
        } catch (Exception failure) {
            deleteFiles(paths);
            throw failure;
        }
    }


    private static List<String> attachmentPaths(SQLiteDatabase db, String namespace,
                                                String origin, String commandId) {
        List<String> result = new ArrayList<>();
        try (Cursor rows = db.query("attachments", new String[]{"file_path"},
                "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, null)) {
            while (rows.moveToNext()) result.add(rows.getString(0));
        }
        return result;
    }

    private static void deleteFiles(List<String> paths) {
        for (String path : paths) new File(path).delete();
    }

    private static boolean isTombstoned(SQLiteDatabase db, String namespace, String origin,
                                        String commandId) {
        try (Cursor row = db.query("tombstones", new String[]{"command_id"},
                "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, null)) {
            return row.moveToFirst();
        }
    }

    private static boolean wasCleared(SQLiteDatabase db, String namespace, String origin,
                                      String sessionPath, long createdAt) {
        String sql = "SELECT MAX(clear_at) FROM clear_markers WHERE namespace=? AND origin=? " +
                "AND session_path IN ('',?)";
        try (Cursor row = db.rawQuery(sql, new String[]{namespace, origin, sessionPath})) {
            return row.moveToFirst() && !row.isNull(0) && createdAt <= row.getLong(0);
        }
    }

    private static void validateState(String state) {
        switch (state) {
            case "saved": case "accepted": case "dispatching": case "forwarded":
            case "received": case "running": case "completed": case "failed": case "uncertain":
                return;
            default:
                throw new IllegalArgumentException("Unsupported command state");
        }
    }

    private static long utf8Length(String value) {
        long bytes = 0;
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch <= 0x7f) bytes++;
            else if (ch <= 0x7ff) bytes += 2;
            else if (Character.isHighSurrogate(ch) && i + 1 < value.length() &&
                    Character.isLowSurrogate(value.charAt(i + 1))) { bytes += 4; i++; }
            else if (Character.isSurrogate(ch)) bytes++;
            else bytes += 3;
        }
        return bytes;
    }

    private static void digestField(MessageDigest digest, String value) {
        // 0xff cannot occur in valid UTF-8, so it separates exact field boundaries.
        digest.update((byte) 0xff);
        for (int i = 0; i < value.length(); i++) {
            int code = value.charAt(i);
            if (Character.isHighSurrogate((char) code) && i + 1 < value.length() &&
                    Character.isLowSurrogate(value.charAt(i + 1))) {
                code = Character.toCodePoint((char) code, value.charAt(++i));
            } else if (Character.isSurrogate((char) code)) {
                digest.update((byte) '?');
                continue;
            }
            if (code <= 0x7f) digest.update((byte) code);
            else if (code <= 0x7ff) {
                digest.update((byte) (0xc0 | (code >>> 6)));
                digest.update((byte) (0x80 | (code & 0x3f)));
            } else if (code <= 0xffff) {
                digest.update((byte) (0xe0 | (code >>> 12)));
                digest.update((byte) (0x80 | ((code >>> 6) & 0x3f)));
                digest.update((byte) (0x80 | (code & 0x3f)));
            } else {
                digest.update((byte) (0xf0 | (code >>> 18)));
                digest.update((byte) (0x80 | ((code >>> 12) & 0x3f)));
                digest.update((byte) (0x80 | ((code >>> 6) & 0x3f)));
                digest.update((byte) (0x80 | (code & 0x3f)));
            }
        }
    }

    private static long decodedLength(String base64) {
        int length = base64.length();
        if ((length & 3) != 0) throw new IllegalArgumentException("Attachment data is not valid base64");
        int padding = 0;
        if (length > 0 && base64.charAt(length - 1) == '=') padding++;
        if (length > 1 && base64.charAt(length - 2) == '=') padding++;
        for (int i = 0; i < length; i++) {
            char ch = base64.charAt(i);
            boolean alphabet = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
                    (ch >= '0' && ch <= '9') || ch == '+' || ch == '/' || ch == '=';
            if (!alphabet || (ch == '=' && i < length - padding)) {
                throw new IllegalArgumentException("Attachment data is not valid base64");
            }
        }
        return (long) (length / 4) * 3 - padding;
    }

    public static void wake() {
        Context context = app;
        if (context == null) return;
        if (!DRAIN_ACTIVE.compareAndSet(false, true)) {
            // The running drain passes again, but this process may die first.
            scheduleIfPending(context);
            DRAIN_AGAIN.set(true);
            return;
        }
        // The check reads SQLite, so it runs on the delivery thread rather than
        // on whichever thread (often main) asked for delivery.
        DELIVERY.execute(() -> {
            scheduleIfPending(context);
            runDrains(context);
        });
    }

    /**
     * Persist a wake as a network-constrained job only when the current pairing
     * has unfinished commands, so delivery survives process death without an
     * idle outbox scheduling persisted work on every wake.
     * Job-started drains never call this: their follow-ups come from delivery's
     * backoff, and a guard at delay 0 would rerun the job back to back.
     */
    private static void scheduleIfPending(Context context) {
        boolean pending;
        try {
            pending = hasPendingWork(context);
        } catch (Exception error) {
            // Unknown counts as pending: a spare job is cheaper than a stranded send.
            Log.w(TAG, "Could not check for unfinished native commands", error);
            pending = true;
        }
        if (pending) NativeOutboxJob.schedule(context, 0);
    }

    static boolean hasPendingWork(Context context) throws Exception {
        String token = TokenStore.getToken(context);
        if (token == null || token.isEmpty()) return false;
        try (Cursor row = database(context).getReadableDatabase().query("commands",
                new String[]{"command_id"},
                "namespace=? AND origin=? AND edit_token IS NULL AND state NOT IN ('completed','forwarded','failed')",
                new String[]{namespace(token), origin(NativeConfig.appUrl(context))},
                null, null, null, "1")) {
            return row.moveToFirst();
        }
    }

    private static void runDrains(Context context) {
        try {
            do {
                DRAIN_AGAIN.set(false);
                drain(context);
            } while (DRAIN_AGAIN.getAndSet(false));
        } finally {
            DRAIN_ACTIVE.set(false);
            Runnable completion;
            while ((completion = JOB_COMPLETIONS.poll()) != null) {
                try { completion.run(); } catch (RuntimeException error) { Log.w(TAG, "Job completion callback failed", error); }
            }
            if (DRAIN_AGAIN.getAndSet(false)) wake();
        }
    }

    static void runJob(Context context, Runnable finished) {
        Context application = context.getApplicationContext();
        app = application;
        database(application);
        migrateNotificationReplies(application);
        JOB_COMPLETIONS.add(finished);
        if (!DRAIN_ACTIVE.compareAndSet(false, true)) {
            DRAIN_AGAIN.set(true);
            return;
        }
        DELIVERY.execute(() -> runDrains(application));
    }

    private static void drain(Context context) {
        String token = TokenStore.getToken(context);
        if (token == null || token.isEmpty()) return;
        String namespace;
        String endpoint = NativeConfig.appUrl(context);
        String origin;
        try {
            namespace = namespace(token);
            origin = origin(endpoint);
        } catch (Exception error) {
            Log.w(TAG, "Cannot determine current sender scope", error);
            return;
        }
        // New sends go first. Commands that were already handed to the daemon
        // only need their receipt refreshed, and each of those is a network
        // round trip: oldest-first ordering made a message you had just typed
        // wait behind every older command's reconciliation requests, which on
        // a slow link is exactly the stretch the user watched "Saved offline".
        List<String> commandIds = new ArrayList<>();
        List<String> reconcileIds = new ArrayList<>();
        try (Cursor rows = database(context).getReadableDatabase().query(
                "commands", new String[]{"command_id", "state"}, "namespace=? AND origin=? AND edit_token IS NULL",
                new String[]{namespace, origin}, null, null, "created_at ASC")) {
            while (rows.moveToNext()) {
                ("saved".equals(rows.getString(1)) ? commandIds : reconcileIds).add(rows.getString(0));
            }
        }
        commandIds.addAll(reconcileIds);
        for (String commandId : commandIds) {
            JSONObject command = null;
            try {
                command = get(context, namespace, origin, commandId);
                if (command == null) continue;
                String state = command.optString("state");
                if (isTerminal(state)) continue;
                deliver(context, token, endpoint, namespace, command);
            } catch (Exception error) {
                Log.w(TAG, "Native command delivery deferred: " + commandId, error);
                // A transient failure on a slow link should retry in seconds,
                // not half a minute: the user is watching this message. Older
                // work backs off; work already handed to the daemon stops
                // polling once its receipt can no longer change.
                long now = System.currentTimeMillis();
                long createdAt = command == null ? now : command.optLong("createdAt", now);
                boolean handedOff = command != null && !"saved".equals(command.optString("state"));
                if (!handedOff || now - createdAt < FOLLOW_UP_GIVE_UP_MS)
                    NativeOutboxJob.schedule(context, followUpDelay(createdAt, 8_000));
            }
        }
        prune(context);
    }

    private static boolean versionCurrentlyVerified(String origin) {
        String verified = versionVerifiedOrigin;
        return verified != null && verified.equals(origin)
                && SystemClock.elapsedRealtime() - versionVerifiedAt < VERSION_CACHE_MS;
    }

    private static void deliver(Context context, String token, String endpoint, String namespace,
                                JSONObject command) throws Exception {
        String origin = origin(endpoint);
        String commandId = command.getString("commandId");
        StoredIntent basis = readIntent(context, namespace, origin, commandId);
        if (basis == null || basis.editToken != null || isTerminal(basis.state)) return;
        String sessionPath = basis.sessionPath;
        HttpSession http = new HttpSession(token);
        boolean postClaimed = false;
        try {
            // Numeric compatibility is unchanged; legacy exact-path receipts remain supported.
            if (!versionCurrentlyVerified(origin)) {
                JSONObject version = request(http, new URL(origin + "/api/version"), token, "GET", null);
                int protocol = version.optInt("protocolVersion", 0);
                int minimum = version.optInt("minClientProtocolVersion", Integer.MAX_VALUE);
                if (protocol < NativeConfig.MIN_CLIENT_PROTOCOL_VERSION || minimum > NativeConfig.PROTOCOL_VERSION) {
                    throw new RejectedDeliveryException("Daemon protocol is incompatible with native delivery");
                }
                versionVerifiedOrigin = origin;
                versionVerifiedAt = SystemClock.elapsedRealtime();
            }
            assertCurrentScope(context, token, namespace, endpoint);
            JSONObject response = lookupReceipt(http, origin, token, commandId, sessionPath);
            if (response == null) {
                if (basis.legacy || basis.receipt != null || basis.binding != null) {
                    markIfCurrent(context, token, endpoint, basis, "uncertain",
                            "Receipt is absent for legacy or previously dispatched work; not replaying");
                    scheduleDeliveryRetryIfPending(context, token, endpoint, basis);
                    return;
                }
                if (!basis.mayPost) {
                    StoredIntent rearmed = rearmForVerified404(context, token, endpoint, basis);
                    if (rearmed == null) {
                        markIfCurrent(context, token, endpoint, basis, "uncertain",
                                "Receipt is absent for legacy or previously dispatched work; not replaying");
                        scheduleDeliveryRetryIfPending(context, token, endpoint, basis);
                        return;
                    }
                    basis = rearmed;
                }
                StoredIntent claimed = claimForPost(context, token, endpoint, basis);
                if (claimed == null) {
                    scheduleDeliveryRetryIfPending(context, token, endpoint, basis);
                    return;
                }
                basis = claimed;
                postClaimed = true;
                assertCurrentScope(context, token, namespace, endpoint);
                response = postCommand(http, context, origin, token, namespace, command);
                if (response == null) {
                    markIfCurrent(context, token, endpoint, basis, "uncertain",
                            "Dispatch response was lost; waiting for a receipt lookup");
                    scheduleDeliveryRetryIfPending(context, token, endpoint, basis);
                    return;
                }
            }
            NativeReceiptValidator.Evidence applied = applyReceipt(context, token, endpoint, basis, response);
            if (applied != null) afterDeliveryReceipt(context, token, endpoint, basis, applied.receipt);
            else scheduleDeliveryRetryIfPending(context, token, endpoint, basis);
        } catch (RejectedDeliveryException rejected) {
            if (markIfCurrent(context, token, endpoint, basis, "failed", rejected.getMessage()))
                reportNotificationFailure(context, namespace, origin, commandId,
                        sessionPath, command.optString("text", ""), rejected.getMessage());
            else scheduleDeliveryRetryIfPending(context, token, endpoint, basis);
        } catch (Exception error) {
            versionVerifiedOrigin = null;
            if (postClaimed || (!basis.mayPost && !basis.legacy)) {
                markIfCurrent(context, token, endpoint, basis, "uncertain",
                        "Delivery could not be confirmed; check the daemon receipt before replay");
            }
            throw error;
        } finally {
            http.close();
        }
    }

    private static JSONObject postCommand(HttpSession http, Context context, String origin,
                                          String token, String namespace, JSONObject command) throws Exception {
        HttpURLConnection connection = http.open(new URL(origin + "/api/prompt"), "POST");
        connection.setDoOutput(true);
        connection.setChunkedStreamingMode(64 * 1024);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        try (OutputStream output = connection.getOutputStream()) {
            Writer writer = new OutputStreamWriter(output, StandardCharsets.UTF_8);
            writer.write("{\"commandId\":");
            writeJsonString(writer, command.getString("commandId"));
            writer.write(",\"sessionPath\":");
            writeJsonString(writer, command.getString("sessionPath"));
            writer.write(",\"text\":");
            writeJsonString(writer, command.getString("text"));
            String delivery = delivery(command);
            if (delivery != null) {
                writer.write(",\"delivery\":");
                writeJsonString(writer, delivery);
            }
            List<Attachment> attachments = getAttachments(context, namespace, origin,
                    command.getString("commandId"));
            if (!attachments.isEmpty()) {
                writer.write(",\"images\":[");
                for (int i = 0; i < attachments.size(); i++) {
                    if (i > 0) writer.write(',');
                    Attachment image = attachments.get(i);
                    writer.write("{\"data\":\"");
                    writer.flush();
                    copyFile(new File(image.filePath), output, http);
                    writer.write("\",\"mimeType\":");
                    writeJsonString(writer, image.mimeType);
                    writer.write('}');
                }
                writer.write(']');
            }
            writer.write('}');
            writer.flush();
        }
        int status = responseCode(http, connection);
        JSONObject response = parseResponse(http, connection, status);
        if (status >= 400 && status < 500) {
            throw new RejectedDeliveryException(responseError(response, status));
        }
        if (status < 200 || status >= 300) {
            throw new IllegalStateException(responseError(response, status));
        }
        if (Boolean.FALSE.equals(response.opt("ok"))) {
            throw new RejectedDeliveryException(responseError(response, status));
        }
        return response;
    }

    private static List<Attachment> getAttachments(Context context, String namespace,
                                                    String origin, String commandId) {
        List<Attachment> result = new ArrayList<>();
        try (Cursor rows = database(context).getReadableDatabase().query(
                "attachments", new String[]{"mime_type", "file_path"},
                "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, "image_index ASC")) {
            while (rows.moveToNext()) result.add(new Attachment(rows.getString(0), rows.getString(1)));
        }
        return result;
    }

    private static JSONObject lookupReceipt(HttpSession http, String origin, String token,
                                            String commandId, String sessionPath) throws Exception {
        String encoded = URLEncoder.encode(commandId, "UTF-8");
        String scopedPath = URLEncoder.encode(sessionPath, "UTF-8");
        HttpURLConnection connection = http.open(new URL(origin + "/api/receipts/" + encoded
                + "?session=" + scopedPath), "GET");
        int status = responseCode(http, connection);
        if (status == 404) return null;
        JSONObject response = parseResponse(http, connection, status);
        if (status == 401 || status == 403) {
            throw new RejectedDeliveryException(responseError(response, status));
        }
        if (status < 200 || status >= 300) throw new IllegalStateException(responseError(response, status));
        return response;
    }

    private static JSONObject request(HttpSession http, URL url, String token, String method,
                                      JSONObject body) throws Exception {
        HttpURLConnection connection = http.open(url, method);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = responseCode(http, connection);
        JSONObject response = parseResponse(http, connection, status);
        if (status >= 400 && status < 500) {
            throw new RejectedDeliveryException(responseError(response, status));
        }
        if (status < 200 || status >= 300 || !response.optBoolean("ok", status < 300)) {
            throw new IllegalStateException(responseError(response, status));
        }
        return response;
    }

    private static int responseCode(HttpSession http, HttpURLConnection connection) throws Exception {
        http.check();
        int status = connection.getResponseCode();
        http.check();
        return status;
    }

    private static JSONObject parseResponse(HttpSession http, HttpURLConnection connection,
                                             int status) throws Exception {
        String body = readResponse(http, connection, status);
        return body.isEmpty() ? new JSONObject() : new JSONObject(body);
    }

    private static String readResponse(HttpSession http, HttpURLConnection connection,
                                       int status) throws Exception {
        InputStream stream = status < 400 ? connection.getInputStream() : connection.getErrorStream();
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                http.check();
                if (output.size() + count > MAX_RESPONSE_BYTES) {
                    throw new IllegalStateException("Server response was too large");
                }
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        }
    }

    private static void writeJsonString(Writer writer, String value) throws Exception {
        writer.write('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            switch (ch) {
                case '"': writer.write("\\\""); break;
                case '\\': writer.write("\\\\"); break;
                case '\b': writer.write("\\b"); break;
                case '\f': writer.write("\\f"); break;
                case '\n': writer.write("\\n"); break;
                case '\r': writer.write("\\r"); break;
                case '\t': writer.write("\\t"); break;
                default:
                    if (ch < 0x20) {
                        writer.write(String.format(Locale.ROOT, "\\u%04x", (int) ch));
                    } else if (Character.isHighSurrogate(ch)) {
                        if (i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1))) {
                            writer.write(ch);
                            writer.write(value.charAt(++i));
                        } else {
                            writer.write(String.format(Locale.ROOT, "\\u%04x", (int) ch));
                        }
                    } else if (Character.isLowSurrogate(ch)) {
                        writer.write(String.format(Locale.ROOT, "\\u%04x", (int) ch));
                    } else {
                        writer.write(ch);
                    }
            }
        }
        writer.write('"');
    }

    private static void copyFile(File file, OutputStream output, HttpSession http) throws Exception {
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                http.check();
                output.write(buffer, 0, count);
            }
        }
    }

    /** Shared atomic evidence application; no delivery scheduling or user notification effects. */
    private static NativeReceiptValidator.Evidence applyReceipt(Context context, String token,
                                                                 String endpoint, StoredIntent expected,
                                                                 JSONObject response) throws Exception {
        assertCurrentScope(context, token, expected.namespace, endpoint);
        SQLiteDatabase db = database(context).getWritableDatabase();
        boolean applied = false;
        db.beginTransaction();
        try {
            StoredIntent current = readIntent(db, expected.namespace, expected.origin, expected.commandId);
            if (!expected.matches(current) || current.revision != expected.revision || current.editToken != null || isTerminal(current.state)) return null;
            JSONObject previous = current.receipt == null ? null : new JSONObject(current.receipt);
            Object priorBinding = current.binding == null ? null : decodeBinding(current.binding);
            NativeReceiptValidator.Evidence evidence = NativeReceiptValidator.validate(
                    response, current.commandId, current.sessionPath, previous, priorBinding);
            String state = evidence.receipt.getString("state");
            String error = evidence.receipt.optString("error", evidence.receipt.optString("code", ""));
            if (error.isEmpty() && "uncertain".equals(state)) error = "Daemon receipt is uncertain";
            if (error.isEmpty() && "failed".equals(state)) error = "Command failed";
            ContentValues values = new ContentValues();
            values.put("state", state);
            values.put("receipt", evidence.receipt.toString());
            values.put("receipt_binding", evidence.binding == null ? null : evidence.binding.toString());
            values.put("error", error.isEmpty() ? null : error);
            values.put("may_post", 0);
            values.put("updated_at", System.currentTimeMillis());
            values.put("receipt_revision", current.revision + 1);
            assertCurrentScope(context, token, expected.namespace, endpoint);
            int changed = db.update("commands", values,
                    "namespace=? AND origin=? AND command_id=? AND receipt_revision=?",
                    new String[]{expected.namespace, expected.origin, expected.commandId, String.valueOf(expected.revision)});
            if (changed != 1) return null;
            db.setTransactionSuccessful();
            applied = true;
            return evidence;
        } finally {
            db.endTransaction();
            if (applied) changed();
        }
    }

    /**
     * Only the normal delivery owner schedules follow-up of unfinished work,
     * including after losing a CAS. The interval backs off with the command's
     * age. Once the daemon can no longer change a handed-off receipt, polling
     * stops and the command is left uncertain, which the app shows as
     * "Delivery uncertain" with Check status: nothing is resent or settled.
     */
    private static void scheduleDeliveryRetryIfPending(Context context, String token,
                                                       String endpoint, StoredIntent expected) throws Exception {
        try {
            assertCurrentScope(context, token, expected.namespace, endpoint);
        } catch (Exception changed) {
            // A repaired scope is no longer this delivery owner's work.
            return;
        }
        // Storage failures propagate to drain's ordinary bounded retry handling.
        StoredIntent current = readIntent(context, expected.namespace, expected.origin, expected.commandId);
        if (!expected.matches(current) || current.editToken != null || isTerminal(current.state)) return;
        // A command never handed off is still the user's unsent message: it
        // keeps retrying at the capped interval and never gives up.
        if ("saved".equals(current.state)
                || System.currentTimeMillis() - current.createdAt < FOLLOW_UP_GIVE_UP_MS) {
            NativeOutboxJob.schedule(context, followUpDelay(current.createdAt, 30_000));
        } else if (!"uncertain".equals(current.state)) {
            markIfCurrent(context, token, endpoint, current, "uncertain",
                    "Still unconfirmed after a day; check status before sending again");
        }
    }

    /** Retry interval for unfinished work: an eighth of its age, within floor and cap. */
    private static long followUpDelay(long createdAt, long floorMs) {
        long age = Math.max(0, System.currentTimeMillis() - createdAt);
        return Math.min(FOLLOW_UP_CAP_MS, Math.max(floorMs, age / 8));
    }

    /** Only the normal delivery owner schedules retries after applying receipt evidence. */
    private static void afterDeliveryReceipt(Context context, String token, String endpoint,
                                             StoredIntent basis, JSONObject receipt) throws Exception {
        if (!isTerminal(receipt.optString("state", ""))) {
            scheduleDeliveryRetryIfPending(context, token, endpoint, basis);
            return;
        }
        reportTerminalNotification(context, basis.namespace, basis.origin, basis.commandId, receipt);
    }

    /** Called only by a winning apply; no delivery scheduling or network work. */
    private static void reportTerminalNotification(Context context, String namespace, String origin,
                                                     String commandId, JSONObject receipt) {
        String state = receipt.optString("state", "");
        if (!isTerminal(state)) return;
        try {
            JSONObject notification = notificationData(context, namespace, origin, commandId);
            if (notification == null) return;
            JSONObject command = get(context, namespace, origin, commandId);
            String error = receipt.optString("error", receipt.optString("code", ""));
            NotificationHelper.actionResult(context,
                    command == null ? "" : command.optString("sessionPath", ""),
                    notification.optString("title", "omp-pulse"), notification.optString("body", ""),
                    notification.optString("kind", "agent_end"), notification.optString("tag", ""),
                    command == null ? null : command.optString("text", ""),
                    "failed".equals(state) ? error.isEmpty() ? "Command failed" : error : null);
        } catch (Exception error) {
            // A notification failure cannot undo committed terminal receipt evidence.
            Log.w(TAG, "Could not show native delivery result", error);
        }
    }

    private static void reportNotificationFailure(Context context, String namespace,
                                                  String origin, String commandId,
                                                  String sessionPath, String text, String error) {
        try {
            JSONObject notification = notificationData(context, namespace, origin, commandId);
            if (notification == null) return;
            NotificationHelper.actionResult(context, sessionPath,
                    notification.optString("title", "omp-pulse"),
                    notification.optString("body", ""),
                    notification.optString("kind", "agent_end"),
                    notification.optString("tag", ""), text, error);
        } catch (Exception failure) {
            Log.w(TAG, "Could not show notification reply failure", failure);
        }
    }

    private static JSONObject notificationData(Context context, String namespace,
                                               String origin, String commandId) throws Exception {
        try (Cursor row = database(context).getReadableDatabase().query(
                "commands", new String[]{"notification_reply", "notify_title", "notify_body", "notify_kind", "notify_tag"},
                "namespace=? AND origin=? AND command_id=?",
                new String[]{namespace, origin, commandId}, null, null, null)) {
            if (!row.moveToFirst() || row.getInt(0) == 0) return null;
            return new JSONObject()
                    .put("title", row.getString(1))
                    .put("body", row.getString(2))
                    .put("kind", row.getString(3))
                    .put("tag", row.getString(4));
        }
    }

    private static StoredIntent rearmForVerified404(Context context, String token,
                                                    String endpoint, StoredIntent expected) throws Exception {
        return changePostingAuthority(context, token, endpoint, expected, false);
    }

    /** Claim/rearm transitions use the same revision fence as evidence application. */
    private static StoredIntent changePostingAuthority(Context context, String token,
                                                       String endpoint, StoredIntent expected,
                                                       boolean claim) throws Exception {
        assertCurrentScope(context, token, expected.namespace, endpoint);
        SQLiteDatabase db = database(context).getWritableDatabase();
        boolean moved = false;
        db.beginTransaction();
        try {
            StoredIntent current = readIntent(db, expected.namespace, expected.origin, expected.commandId);
            if (!expected.matches(current) || current.revision != expected.revision
                    || current.editToken != null || isTerminal(current.state) || current.legacy) return null;
            if (current.receipt != null || current.binding != null) return null;
            if (claim ? !current.mayPost : current.mayPost) return null;
            ContentValues values = new ContentValues();
            values.put("may_post", claim ? 0 : 1);
            if (claim) values.put("state", "dispatching");
            values.put("updated_at", System.currentTimeMillis());
            values.put("receipt_revision", current.revision + 1);
            assertCurrentScope(context, token, expected.namespace, endpoint);
            int changed = db.update("commands", values,
                    "namespace=? AND origin=? AND command_id=? AND receipt_revision=?",
                    new String[]{expected.namespace, expected.origin, expected.commandId, String.valueOf(expected.revision)});
            if (changed != 1) return null;
            StoredIntent result = readIntent(db, expected.namespace, expected.origin, expected.commandId);
            db.setTransactionSuccessful();
            moved = true;
            return result;
        } finally {
            db.endTransaction();
            if (moved) changed();
        }
    }

    /** Do not delete attachment files after the sender has claimed their HTTP handoff. */
    private static void assertNotDispatching(SQLiteDatabase db, String namespace, String origin,
                                            String commandId, String sessionPath) {
        String where = "namespace=? AND origin=? AND state='dispatching'";
        List<String> args = new ArrayList<>();
        args.add(namespace);
        args.add(origin);
        if (commandId != null) { where += " AND command_id=?"; args.add(commandId); }
        if (sessionPath != null) { where += " AND session_path=?"; args.add(sessionPath); }
        try (Cursor rows = db.query("commands", new String[]{"command_id"}, where,
                args.toArray(new String[0]), null, null, null, "1")) {
            if (rows.moveToFirst())
                throw new IllegalStateException("Delivery has started; check its status before removing it");
        }
    }

    /** Claim atomically against remove/clear and competing receipt checks before HTTP handoff. */
    private static StoredIntent claimForPost(Context context, String token,
                                             String endpoint, StoredIntent expected) throws Exception {
        return changePostingAuthority(context, token, endpoint, expected, true);
    }

    private static String responseError(JSONObject response, int status) {
        String message = response.optString("error", response.optString("code", "")).trim();
        if (message.isEmpty()) return "HTTP " + status + " from daemon";
        return message.length() > 180 ? message.substring(0, 180) : message;
    }



    private static void assertStoreScope(Context context, String namespace, String origin) throws Exception {
        String token = TokenStore.getToken(context);
        if (token == null || token.isEmpty() || !namespace(token).equals(namespace) ||
                !origin(NativeConfig.appUrl(context)).equals(origin)) {
            throw new SecurityException("Pairing or server changed; native save was not committed");
        }
    }
    private static void assertCurrentScope(Context context, String expectedToken,
                                           String expectedNamespace, String endpoint) throws Exception {
        String currentToken = TokenStore.getToken(context);
        if (currentToken == null || !currentToken.equals(expectedToken) ||
                !namespace(currentToken).equals(expectedNamespace) ||
                !origin(NativeConfig.appUrl(context)).equals(origin(endpoint))) {
            throw new IllegalStateException("Pairing or server changed; command was not sent");
        }
    }

    /** A delayed local failure may not undo a concurrent status or delivery receipt. */
    private static boolean markIfCurrent(Context context, String token, String endpoint,
                                          StoredIntent expected, String state, String error) throws Exception {
        assertCurrentScope(context, token, expected.namespace, endpoint);
        SQLiteDatabase db = database(context).getWritableDatabase();
        boolean marked = false;
        db.beginTransaction();
        try {
            StoredIntent current = readIntent(db, expected.namespace, expected.origin, expected.commandId);
            if (!expected.matches(current) || current.revision != expected.revision || current.editToken != null || isTerminal(current.state)) return false;
            ContentValues values = new ContentValues();
            values.put("state", state);
            values.put("error", error);
            values.put("may_post", 0);
            values.put("updated_at", System.currentTimeMillis());
            values.put("receipt_revision", current.revision + 1);
            assertCurrentScope(context, token, expected.namespace, endpoint);
            int changed = db.update("commands", values,
                    "namespace=? AND origin=? AND command_id=? AND receipt_revision=?",
                    new String[]{expected.namespace, expected.origin, expected.commandId, String.valueOf(expected.revision)});
            if (changed != 1) return false;
            db.setTransactionSuccessful();
            marked = true;
            return true;
        } finally {
            db.endTransaction();
            if (marked) changed();
        }
    }

    private static void prune(Context context) {
        SQLiteDatabase db = database(context).getWritableDatabase();
        List<String> files = new ArrayList<>();
        int pruned = 0;
        long cutoff = System.currentTimeMillis() - TERMINAL_TTL_MS;
        db.beginTransaction();
        try {
            try (Cursor rows = db.query("commands", new String[]{"namespace", "origin", "command_id"},
                    "state IN ('completed','forwarded','failed') AND updated_at<?",
                    new String[]{String.valueOf(cutoff)}, null, null, null)) {
                while (rows.moveToNext()) {
                    String namespace = rows.getString(0);
                    String origin = rows.getString(1);
                    String commandId = rows.getString(2);
                    pruned++;
                    db.execSQL("INSERT OR IGNORE INTO tombstones(namespace,origin,command_id,created_at) VALUES(?,?,?,?)",
                            new Object[]{namespace, origin, commandId, System.currentTimeMillis()});
                    files.addAll(attachmentPaths(db, namespace, origin, commandId));
                    db.delete("attachments", "namespace=? AND origin=? AND command_id=?",
                            new String[]{namespace, origin, commandId});
                    db.delete("commands", "namespace=? AND origin=? AND command_id=?",
                            new String[]{namespace, origin, commandId});
                }
            }
            // See TOMBSTONE_TTL_MS: by now no local source still offers these IDs.
            db.delete("tombstones", "created_at<?",
                    new String[]{String.valueOf(System.currentTimeMillis() - TOMBSTONE_TTL_MS)});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        // Only expired terminal rows the page may still show; tombstone expiry is invisible.
        if (pruned > 0) changed();
        deleteFiles(files);
    }

    private static boolean isTerminal(String state) {
        return "completed".equals(state) || "forwarded".equals(state) || "failed".equals(state);
    }

    private static void checkDeadline(long deadline) {
        if (System.currentTimeMillis() >= deadline) throw new IllegalStateException("deadline");
    }

    private static String readTextFile(File file) throws Exception {
        try (InputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(file.length(), MAX_BYTES))) {
            byte[] buffer = new byte[16 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString("UTF-8");
        }
    }



    private static String origin(String endpoint) throws Exception {
        URL url = new URL(endpoint);
        return url.getProtocol() + "://" + url.getAuthority();
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] result = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 0xff;
            result[i * 2] = digits[value >>> 4];
            result[i * 2 + 1] = digits[value & 0x0f];
        }
        return new String(result);
    }

    private static Helper database(Context context) {
        Helper result = helper;
        if (result == null) {
            synchronized (NativeOutbox.class) {
                if (helper == null) helper = new Helper(context.getApplicationContext());
                result = helper;
            }
        }
        NativeAttachmentRecovery.schedule(context, result);
        return result;
    }


    private static final class RejectedDeliveryException extends Exception {
        RejectedDeliveryException(String message) { super(message); }
    }

    private static final class PreparedImage {
        final String mimeType;
        final String data;
        final long bytes;
        PreparedImage(String mimeType, String data, long bytes) {
            this.mimeType = mimeType;
            this.data = data;
            this.bytes = bytes;
        }
    }

    private static final class Attachment {
        final String mimeType;
        final String filePath;
        Attachment(String mimeType, String filePath) {
            this.mimeType = mimeType;
            this.filePath = filePath;
        }
    }

    private static final class HttpSession implements AutoCloseable {
        private final String token;
        private final long deadline = SystemClock.elapsedRealtime() + HTTP_DEADLINE_MS;
        private final List<HttpURLConnection> connections = new ArrayList<>();
        private final ScheduledFuture<?> timeout;
        private volatile boolean expired;

        HttpSession(String token) {
            this.token = token;
            timeout = DEADLINES.schedule(this::abort, HTTP_DEADLINE_MS, TimeUnit.MILLISECONDS);
        }

        synchronized HttpURLConnection open(URL url, String method) throws Exception {
            check();
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            int remaining = (int) Math.min(Integer.MAX_VALUE,
                    Math.max(1, deadline - SystemClock.elapsedRealtime()));
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Cache-Control", "no-store");
            connection.setRequestMethod(method);
            connection.setConnectTimeout(Math.min(15_000, remaining));
            connection.setReadTimeout(Math.min(20_000, remaining));
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json");
            connections.add(connection);
            return connection;
        }

        void check() {
            if (expired || SystemClock.elapsedRealtime() >= deadline) {
                abort();
                throw new IllegalStateException("Native HTTP delivery exceeded its deadline");
            }
        }


        private synchronized void abort() {
            expired = true;
            for (HttpURLConnection connection : connections) connection.disconnect();
            connections.clear();
        }

        @Override public synchronized void close() {
            timeout.cancel(false);
            for (HttpURLConnection connection : connections) connection.disconnect();
            connections.clear();
        }
    }

    private static final class Helper extends SQLiteOpenHelper {
        private final Context context;
        Helper(Context context) {
            super(context, DATABASE, null, DATABASE_VERSION);
            this.context = context;
        }

        @Override public void onCreate(SQLiteDatabase db) {
            NativeAttachmentRecovery.beforeDatabaseCreate(context);
            db.execSQL("CREATE TABLE commands(" +
                    "namespace TEXT NOT NULL,origin TEXT NOT NULL,command_id TEXT NOT NULL," +
                    "session_path TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL," +
                    "updated_at INTEGER NOT NULL,state TEXT NOT NULL,receipt TEXT,receipt_binding TEXT," +
                    "receipt_revision INTEGER NOT NULL DEFAULT 0,error TEXT,edit_token TEXT," +
                    "legacy INTEGER NOT NULL,may_post INTEGER NOT NULL,payload_hash TEXT NOT NULL," +
                    "payload_bytes INTEGER NOT NULL,notification_reply INTEGER NOT NULL," +
                    "notify_title TEXT NOT NULL,notify_body TEXT NOT NULL,notify_kind TEXT NOT NULL," +
                    "notify_tag TEXT NOT NULL,delivery TEXT,PRIMARY KEY(namespace,origin,command_id))");
            db.execSQL("CREATE TABLE attachments(" +
                    "namespace TEXT NOT NULL,origin TEXT NOT NULL,command_id TEXT NOT NULL," +
                    "image_index INTEGER NOT NULL,mime_type TEXT NOT NULL,file_path TEXT NOT NULL," +
                    "byte_count INTEGER NOT NULL,PRIMARY KEY(namespace,origin,command_id,image_index))");
            db.execSQL("CREATE TABLE tombstones(" +
                    "namespace TEXT NOT NULL,origin TEXT NOT NULL,command_id TEXT NOT NULL," +
                    "created_at INTEGER NOT NULL,PRIMARY KEY(namespace,origin,command_id))");
            db.execSQL("CREATE TABLE clear_markers(" +
                    "namespace TEXT NOT NULL,origin TEXT NOT NULL,session_path TEXT NOT NULL," +
                    "clear_at INTEGER NOT NULL,PRIMARY KEY(namespace,origin,session_path))");
        }

        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            // By column, not by version: see DATABASE_VERSION.
            Set<String> columns = new HashSet<>();
            try (Cursor c = db.rawQuery("PRAGMA table_info(commands)", null)) {
                int name = c.getColumnIndexOrThrow("name");
                while (c.moveToNext()) columns.add(c.getString(name));
            }
            if (!columns.contains("receipt_binding")) {
                db.execSQL("ALTER TABLE commands ADD COLUMN receipt_binding TEXT");
            }
            if (!columns.contains("receipt_revision")) {
                db.execSQL("ALTER TABLE commands ADD COLUMN receipt_revision INTEGER NOT NULL DEFAULT 0");
            }
            if (!columns.contains("delivery")) {
                db.execSQL("ALTER TABLE commands ADD COLUMN delivery TEXT");
            }
            if (!columns.contains("edit_token")) {
                db.execSQL("ALTER TABLE commands ADD COLUMN edit_token TEXT");
            }
        }
    }
}
