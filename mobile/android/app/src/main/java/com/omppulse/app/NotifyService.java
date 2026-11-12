package com.omppulse.app;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.ServiceCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground service that holds a long-lived SSE connection to
 * {@code /api/notify/stream}. Auth via {@code Authorization: Bearer <token>}
 * and {@code Last-Event-ID} for replay. Reconnects with bounded exponential
 * backoff and treats ~60s without a byte (server pings every 25s) as dead,
 * via the socket read timeout. Stops itself while unpaired; pairing starts it.
 *
 * INVARIANT: event IDs and replay are handled once here; per-event and per-chat
 * preferences are applied at the notification boundary after the server gate.
 *
 * The shared endpoint is configured as a Tailscale address. Android routes that
 * address through its configured network stack; this service uses no alternate
 * endpoint or cloud push fallback.
 *
 * Foreground type: {@code remoteMessaging} on API 34+ for cross-device
 * messaging; older Android versions use {@code dataSync}. The declared type
 * and the type passed to {@code startForeground} must match or the system
 * throws at runtime.
 */
public class NotifyService extends Service {
    private static final String TAG = "OmpNotifyService";

    public static final String ACTION_SET_TOKEN = "com.omppulse.app.action.SET_TOKEN";
    public static final String ACTION_STOP = "com.omppulse.app.action.STOP";
    public static final String EXTRA_TOKEN = "extra_token";

    private static final String STREAM_PATH = "/api/notify/stream";

    // A read that sees no byte for this long throws SocketTimeoutException into
    // the ordinary failure-and-backoff path. It replaced a 15 s Handler watchdog
    // that woke the app four times a minute for the whole service lifetime.
    private static final int PING_TIMEOUT_MS = 60_000;
    // Server pings every 25 s (src/server/http.rs notify_stream).
    private static final long SCREEN_ON_FRESH_MS = 35_000;

    // Native notification settings read these health indicators without binding.
    // Connection state and delivery errors describe this process only.
    // They are intentionally not persisted or treated as a delivery guarantee.

    public static volatile boolean sAlive = false;
    public static volatile boolean sConnected = false;
    public static volatile long sLastEventAt = 0L;
    public static volatile String sLastError = null;
    public static volatile int sLastHttpStatus = 0;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Random jitter = new Random();

    private volatile Thread sseThread;
    private volatile HttpURLConnection currentConn;
    private final AtomicBoolean shouldRun = new AtomicBoolean(true);
    private volatile long lastEventMillis = 0L;
    private volatile String lastEventId = null;
    // Sessions whose turn this stream has announced and not yet ended.
    private final Set<String> runningTurns = ConcurrentHashMap.newKeySet();
    // Newest onStartCommand id; a start that arrives after it keeps the
    // service alive when the unpaired loop asks to stop.
    private int latestStartId;

    private ConnectivityManager.NetworkCallback networkCallback;
    // The default network the stream last moved to; written only by the
    // connectivity callback thread after registration.
    private volatile Network defaultNetwork;
    private BroadcastReceiver screenReceiver;


    @Override public void onCreate() {
        super.onCreate();
        sAlive = true;
        NotificationHelper.ensureChannels(this);
        lastEventId = TokenStore.getLastEventId(this);
        lastEventMillis = SystemClock.elapsedRealtime();
        sLastEventAt = 0L;
        registerNetworkAndScreenListeners();
        NotificationActionReceiver.retryPending(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        latestStartId = startId;
        String action = intent != null ? intent.getAction() : null;
        String tokenExtra = intent != null ? intent.getStringExtra(EXTRA_TOKEN) : null;

        if (tokenExtra != null && !tokenExtra.isEmpty()) {
            TokenStore.saveToken(this, tokenExtra);
        }
        if (ACTION_STOP.equals(action) || !NotificationPreferences.isBackgroundEnabled(this) || !hasDaemon(this)) {
            return stopStartRequest();
        }

        // Must be foreground immediately — Android enforces a short start deadline.
        if (!startAsForeground()) return START_NOT_STICKY;
        if (sseThread == null || !sseThread.isAlive()) {
            startSseThread();
        } else if (tokenExtra != null) {
            reconnectNow("token-changed");
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        shouldRun.set(false);
        sAlive = false;
        sConnected = false;
        unregisterNetworkAndScreenListeners();
        closeCurrentConn();
        if (sseThread != null) {
            sseThread.interrupt();
            sseThread = null;
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void startSseThread() {
        shouldRun.set(true);
        Thread thread = new Thread(this::sseLoop, "omp-sse");
        thread.setDaemon(true);
        sseThread = thread;
        thread.start();
    }

    // ---- foreground ----

    private boolean startAsForeground() {
        NotificationHelper.ensureChannels(this);
        android.app.Notification n = NotificationHelper.buildForegroundNotification(this);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Cross-device conversation continuity, not a bounded file sync.
                // dataSync is capped at six background hours/day on Android 15+.
                int type = Build.VERSION.SDK_INT >= 34
                        ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
                        : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
                ServiceCompat.startForeground(this, NotificationHelper.FG_ID, n, type);
            } else {
                startForeground(NotificationHelper.FG_ID, n);
            }
            return true;
        } catch (Throwable e) {
            sLastError = "Could not start foreground service: " + e.getClass().getSimpleName();
            Log.e(TAG, "startForeground failed", e);
            stopSelf();
            return false;
        }
    }

    /**
     * Declines a start request. On API 26+ every start is a foreground start:
     * {@link #startWithToken} uses startForegroundService, and the system
     * requires startForeground() before such a service stops, else it throws
     * ForegroundServiceDidNotStartInTimeException / RemoteServiceException
     * ("did not then call Service.startForeground()") and kills the app.
     * Android 12+ defers showing the notification, so the brief foreground
     * period is normally invisible.
     */
    private int stopStartRequest() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && startAsForeground()) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        }
        stopSelf();
        return START_NOT_STICKY;
    }

    // ---- live turn status ----
    // Kept outside the span the notify-backoff host test extracts from the SSE
    // loop: that harness stubs these two entry points, not Android widgets.

    /**
     * The stream re-announces every running turn on connect, so a progress
     * notification still up is one whose end was missed.
     */
    private void onStreamOpened() {
        if (!runningTurns.isEmpty()) {
            runningTurns.clear();
            PulseWidget.refresh(getApplicationContext());
        }
        NotificationHelper.cancelAllProgress(this);
    }

    /**
     * Show or clear a running turn's notification and, when a turn starts or
     * ends, nudge the home-screen widget so its running state follows.
     */
    private void onProgressEvent(JSONObject payload) {
        NotificationHelper.postProgress(this, payload);
        String path = payload.optString("sessionPath", "");
        boolean ended = "progress_end".equals(payload.optString("kind"));
        if (ended ? runningTurns.remove(path) : runningTurns.add(path)) {
            PulseWidget.refresh(getApplicationContext());
        }
    }

    // ---- SSE loop ----

    private String apiBaseUrl() throws Exception {
        URL appUrl = new URL(NativeConfig.appUrl(this));
        return appUrl.getProtocol() + "://" + appUrl.getAuthority();
    }

    private void sseLoop() {
        NotifyReconnectBackoff backoff = new NotifyReconnectBackoff();
        while (shouldRun.get()) {
            Thread.interrupted();
            String token = TokenStore.getToken(this);
            if (token == null || token.isEmpty()) {
                // Unpaired, or the pairing was cleared under a running service.
                // This used to sleep 5 s and poll forever, waking an unpaired
                // phone for nothing. Every way a token arrives (setToken, and
                // startIfPaired at boot, launch and in settings) starts the
                // service again with it.
                Log.i(TAG, "no token, stopping until paired");
                final Thread exiting = Thread.currentThread();
                mainHandler.post(() -> stopWithoutToken(exiting));
                break;
            }

            HttpURLConnection conn = null;
            try {
                URL url = new URL(apiBaseUrl() + STREAM_PATH);
                conn = (HttpURLConnection) url.openConnection();
                currentConn = conn;
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "text/event-stream");
                conn.setRequestProperty("Cache-Control", "no-cache");
                conn.setInstanceFollowRedirects(false);
                conn.setRequestProperty("Authorization", "Bearer " + token);
                if (lastEventId != null && !lastEventId.isEmpty()) {
                    conn.setRequestProperty("Last-Event-ID", lastEventId);
                }
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(PING_TIMEOUT_MS);
                conn.setUseCaches(false);
                conn.setRequestProperty("X-Requested-With", "omp-pulse-android");
                int code = conn.getResponseCode();
                sLastHttpStatus = code;
                if (code == 401 || code == 403) {
                    Log.w(TAG, "auth failed http=" + code + " token may be invalid, backoff");
                    // Keep the failure readable in native notification settings.
                    sLastError = code == 401 ? "Pairing was rejected." : "Notification access was refused.";
                    // Don't clear token — user may re-pair; just back off longer.
                    sleepWithJitter(backoff.delayMs());
                    backoff.recordFailure();
                    continue;
                }
                if (code != 200) {
                    Log.w(TAG, "stream http=" + code + " backoff=" + backoff.delayMs());
                    sLastError = "server returned HTTP " + code;
                    // Drain error body so connection can be reused/closed cleanly
                    try { InputStream es = conn.getErrorStream(); if (es != null) es.close(); } catch (Throwable ignore) {}
                    sleepWithJitter(backoff.delayMs());
                    backoff.recordFailure();
                    continue;
                }

                // HTTP success alone is not a healthy stream: repeated early
                // EOF/body failures must retain the capped retry progression.
                lastEventMillis = SystemClock.elapsedRealtime();
                backoff.streamOpened(lastEventMillis);
                sConnected = true;
                sLastError = null;
                onStreamOpened();
                try (InputStream is = conn.getInputStream();
                     BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                    parseSse(br, backoff);
                }

                // parseSse returned (EOF / server closed) — reconnect with backoff
                if (!shouldRun.get()) break;
                Log.i(TAG, "stream closed by server, reconnecting");
                sleepWithJitter(backoff.delayMs());
                backoff.recordFailure();
            } catch (InterruptedException ie) {
                if (!shouldRun.get()) break;
                Thread.interrupted();
                Log.i(TAG, "SSE reconnect requested");
            } catch (Throwable e) {
                if (!shouldRun.get()) break;
                if (Thread.interrupted()) {
                    Log.i(TAG, "SSE reconnect requested after transport interruption");
                    continue;
                }
                Log.w(TAG, "sse error: " + e.getMessage() + " backoff=" + backoff.delayMs());
                // WHY: mirror lastError for getStatus() — trimmed to stay readable in UI.
                String msg = e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage());
                if (msg.length() > 120) msg = msg.substring(0, 120);
                sLastError = msg;
                sleepWithJitter(backoff.delayMs());
                backoff.recordFailure();
            } finally {
                sConnected = false;
                if (conn != null) {
                    try { conn.disconnect(); } catch (Throwable ignore) {}
                    if (currentConn == conn) currentConn = null;
                }
            }
        }
        Log.i(TAG, "sseLoop exited");
    }

    /**
     * Runs on the main thread, so it is ordered against onStartCommand: a token
     * delivered while the loop was exiting (its reconnectNow found the thread
     * still alive) restarts the loop here instead of being lost.
     */
    private void stopWithoutToken(Thread exited) {
        if (!shouldRun.get() || sseThread != exited) return;
        String token = TokenStore.getToken(this);
        if (token != null && !token.isEmpty()) {
            startSseThread();
            return;
        }
        sseThread = null;
        stopSelfResult(latestStartId);
    }
    /**
     * Minimal SSE parser per https://html.spec.whatwg.org/multipage/server-sent-events.html
     * Handles {@code id:}, {@code event:}, {@code data:} lines, blank-line
     * dispatch, and comment lines starting with {@code :}. {@code retry:} is
     * ignored (we use our own backoff). Every completed envelope refreshes
     * liveness; only data-bearing envelopes dispatch.
     */
    private void parseSse(BufferedReader br, NotifyReconnectBackoff backoff) throws Exception {
        String line;
        String curId = null;
        String curEvent = null;
        StringBuilder curData = new StringBuilder();

        while (shouldRun.get() && (line = br.readLine()) != null) {
            if (line.isEmpty()) {
                // Any completed envelope proves the stream is alive, even a
                // keepalive that carries no data.
                lastEventMillis = SystemClock.elapsedRealtime();
                sLastEventAt = lastEventMillis;
                // Only a data-bearing envelope is dispatched.
                if (curData.length() > 0) {
                    String data = curData.toString();
                    // Strip trailing newline added during accumulation
                    if (data.endsWith("\n")) data = data.substring(0, data.length() - 1);
                    if (dispatchEvent(curEvent, data)) {
                        backoff.observedLiveness(lastEventMillis);
                    }
                    // Persist id for replay on reconnect
                    if (curId != null && !curId.isEmpty()) {
                        lastEventId = curId;
                        TokenStore.saveLastEventId(this, curId);
                    }
                }
                curId = null; curEvent = null; curData.setLength(0);
                continue;
            }
            if (line.startsWith(":")) {
                // comment / keepalive — also treat as liveness
                lastEventMillis = SystemClock.elapsedRealtime();
                sLastEventAt = lastEventMillis;
                backoff.observedLiveness(lastEventMillis);
                continue;
            }
            int colon = line.indexOf(':');
            String field, value;
            if (colon == -1) { field = line; value = ""; }
            else {
                field = line.substring(0, colon);
                value = line.substring(colon + 1);
                if (value.startsWith(" ")) value = value.substring(1);
            }
            switch (field) {
                case "id": curId = value; break;
                case "event": curEvent = value; break;
                case "data":
                    curData.append(value).append("\n");
                    break;
                case "retry": break; // ignore
                default: break;
            }
        }
    }

    private boolean dispatchEvent(String event, String data) {
        lastEventMillis = SystemClock.elapsedRealtime();
        sLastEventAt = lastEventMillis;
        // "notify", and the SSE default event name for a bare data frame, carry
        // a notification payload. "ping" is transport-only; any other named event
        // is not a delivery this client is responsible for.
        boolean validEvent = false;
        boolean notification = event == null || "notify".equals(event);
        // Live turn status: a named event so a client that predates it ignores
        // it; the daemon sends it without an id, so it never moves replay.
        boolean progress = "progress".equals(event);
        if (notification || progress || "ping".equals(event)) {
            try {
                JSONObject payload = new JSONObject(data);
                validEvent = true;
                if (notification) NotificationHelper.postFromPayload(this, payload);
                if (progress) onProgressEvent(payload);
            } catch (Throwable e) {
                // Never log the payload: it carries conversation content.
                if (notification || progress) Log.w(TAG, "notify parse failed", e);
            }
        }
        // Parsing proves transport health even if local posting is suppressed
        // or fails. It does not claim that Android delivered a notification.
        return validEvent;
    }

    /**
     * Sleep for the backoff window, absorbing interruption here rather than
     * forcing every call site to catch it. Explicit reconnect triggers wake
     * this thread by interruption, so it must return promptly
     * and leave the flag set, not propagate out of the connect loop.
     */
    private void sleepWithJitter(long baseMs) {
        long ms = baseMs + jitter.nextInt(700); // 0-700ms jitter
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            // Restore the flag so the loop's shouldRun check and any blocking
            // call below still observe that a reconnect was requested.
            Thread.currentThread().interrupt();
        }
    }

    private void reconnectNow(String reason) {
        Log.i(TAG, "reconnectNow: " + reason);
        closeCurrentConn();
        if (sseThread != null) sseThread.interrupt();
    }

    private void closeCurrentConn() {
        HttpURLConnection c = currentConn;
        if (c != null) {
            try { c.disconnect(); } catch (Throwable ignore) {}
            currentConn = null;
        }
    }

    // ---- network / screen listeners — reasonable best-effort against Doze ----

    private void registerNetworkAndScreenListeners() {
        // Follow the app's default network only, the one HttpURLConnection
        // uses (Tailscale's VPN while it is up). A callback for every
        // Internet-capable network fired onAvailable for each of them (and on
        // registration), and every one tore down a working stream.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    // registerDefaultNetworkCallback reports the current default
                    // at once; seeding it here makes that first report a no-op.
                    defaultNetwork = cm.getActiveNetwork();
                    networkCallback = new ConnectivityManager.NetworkCallback() {
                        @Override public void onAvailable(Network network) {
                            if (network.equals(defaultNetwork)) return;
                            // The system terminates sockets left on the old
                            // default later; move the stream now.
                            defaultNetwork = network;
                            NativeOutbox.wake();
                            reconnectNow("default-network-changed");
                        }
                        // For a default-network callback this means the network
                        // stopped being the default; a later onAvailable names
                        // the replacement, if any.
                        @Override public void onLost(Network network) {
                            if (!network.equals(defaultNetwork)) return;
                            defaultNetwork = null;
                            reconnectNow("default-network-lost");
                        }
                    };
                    cm.registerDefaultNetworkCallback(networkCallback);
                }
            } catch (Throwable e) { Log.d(TAG, "network callback registration failed", e); }
        }

        // ACTION_SCREEN_ON — device waking from Doze; reconnect promptly.
        try {
            screenReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent intent) {
                    if (Intent.ACTION_SCREEN_ON.equals(intent.getAction()) && !isStreamFresh()) {
                        reconnectNow("screen-on");
                    }
                }
            };
            IntentFilter f = new IntentFilter();
            f.addAction(Intent.ACTION_SCREEN_ON);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(screenReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(screenReceiver, f);
            }
        } catch (Throwable e) { Log.d(TAG, "screen receiver failed", e); }
    }

    /**
     * Whether the open stream has delivered something within one server ping
     * interval (25 s) plus slack. Doze suspends the network, so after a real
     * Doze stretch this is false and screen-on reconnects; a screen toggle on a
     * live stream leaves it alone.
     */
    private boolean isStreamFresh() {
        return sConnected && currentConn != null
                && SystemClock.elapsedRealtime() - lastEventMillis < SCREEN_ON_FRESH_MS;
    }

    private void unregisterNetworkAndScreenListeners() {
        if (networkCallback != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(networkCallback);
            } catch (Throwable ignore) {}
            networkCallback = null;
        }
        if (screenReceiver != null) {
            try { unregisterReceiver(screenReceiver); } catch (Throwable ignore) {}
            screenReceiver = null;
        }
    }

    /**
     * Whether the current run mode has a daemon to stream from. Stopped ("unset") has none; the
     * stream would otherwise be aimed at the bundled app's own origin. Saved credentials are kept.
     */
    private static boolean hasDaemon(Context ctx) {
        return NativeConfig.serverUrl(ctx) != null;
    }

    /**
     * Starts the paired listener when background delivery is enabled and a daemon is configured.
     * The native activity calls this after pairing; Android may also call it
     * when the service recovers. Repeated starts are safe.
     * Pairing remains stored independently when background delivery is off.
     *
     */
    public static void startIfPaired(Context ctx) {
        try {
            if (!NotificationPreferences.isBackgroundEnabled(ctx) || !hasDaemon(ctx)) return;
            String token = TokenStore.getToken(ctx);
            if (token != null && !token.isEmpty()) startWithToken(ctx, token);
        } catch (Throwable e) {
            sLastError = "Could not start notification service: " + e.getClass().getSimpleName();
            Log.w(TAG, "startIfPaired failed", e);
        }
    }


    public static void startWithToken(Context ctx, String token) {
        if (ctx == null || token == null || token.isEmpty()) return;
        try {
            // Persist pairing independently from the user's background-delivery choice.
            TokenStore.saveToken(ctx, token);
            if (!NotificationPreferences.isBackgroundEnabled(ctx) || !hasDaemon(ctx)) return;
            Intent i = new Intent(ctx, NotifyService.class);
            i.setAction(ACTION_SET_TOKEN);
            i.putExtra(EXTRA_TOKEN, token);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
            sLastError = null;
            sLastHttpStatus = 0;
        } catch (Throwable e) {
            sLastError = "Could not start notification service: " + e.getClass().getSimpleName();
            Log.w(TAG, "startWithToken failed", e);
        }
    }

    public static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, NotifyService.class)); }
        catch (Throwable e) { Log.w(TAG, "stop failed", e); }
    }
}
