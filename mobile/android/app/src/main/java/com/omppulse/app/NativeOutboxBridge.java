package com.omppulse.app;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.net.URL;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Origin-scoped persistence interface; neither WebView owns network delivery. */
public final class NativeOutboxBridge {
    // SQLite can wait on disk/another writer. Never make that an Android UI wait,
    // and never serialize saves behind the separate network-delivery executor.
    private static final ExecutorService STORAGE = Executors.newSingleThreadExecutor(
            task -> new Thread(task, "omp-native-storage"));
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final String CHANGED_EVENT = "{\"event\":\"outbox-changed\"}";
    private static final OutboxPageRegistry<WebView, JavaScriptReplyProxy> PAGES = new OutboxPageRegistry<>();

    private NativeOutboxBridge() {}

    /** Drop only this document's reply channel, not the other shell's live channel. */
    public static void pageNavigated(WebView view) {
        PAGES.navigate(view);
        updateChangeListener();
    }

    public static void forgetPage(WebView view) {
        PAGES.remove(view);
        updateChangeListener();
    }

    private static void updateChangeListener() {
        NativeOutbox.setChangeListener(PAGES.hasPages() ? NativeOutboxBridge::pushChanged : null);
    }

    private static void pushChanged() {
        MAIN.post(() -> {
            PAGES.broadcast(reply -> reply.postMessage(CHANGED_EVENT));
            updateChangeListener();
        });
    }
    public static boolean install(Context context, WebView view) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false;
        Context app = context.getApplicationContext();
        OutboxPageRegistry.Owner<JavaScriptReplyProxy> owner = PAGES.install(view);
        try {
            URL url = new URL(NativeConfig.appUrl(app));
            String origin = url.getProtocol() + "://" + url.getAuthority();
            WebViewCompat.addWebMessageListener(view, "OmpOutbox", Collections.singleton(origin),
                    (WebView webView, WebMessageCompat message, Uri sourceOrigin,
                     boolean isMainFrame, JavaScriptReplyProxy reply) -> {
                        String data = message.getData();
                        boolean trusted = isMainFrame && sourceOrigin != null
                                && origin.equals(sourceOrigin.toString());
                        if (trusted && PAGES.attach(webView, owner, reply)) {
                            updateChangeListener();
                            // Covers changes before the first request registered this channel.
                            pushChanged();
                        }
                        STORAGE.execute(() -> handle(app, origin, data, trusted, reply));
                    });
            return true;
        } catch (Exception error) {
            PAGES.remove(view);
            updateChangeListener();
            Log.w("OmpNativeOutbox", "Native storage bridge unavailable", error);
            return false;
        }
    }

    private static void handle(Context context, String origin, String data, boolean trusted,
                               JavaScriptReplyProxy reply) {
        String id = "";
        try {
            JSONObject request = new JSONObject(data);
            id = request.optString("id", "");
            if (!trusted) throw new SecurityException("Untrusted outbox caller");
            String token = TokenStore.getToken(context);
            if (token == null || token.isEmpty()) throw new SecurityException("Device is not paired");
            String namespace = request.optString("namespace", "");
            if (!NativeOutbox.namespace(token).equals(namespace))
                throw new SecurityException("Credential scope changed");
            long deadline = request.optLong("deadlineAt", 0);
            if (System.currentTimeMillis() >= deadline) throw new IllegalStateException("deadline");
            Object value = execute(context, origin, namespace, request, deadline);
            // `changeEvents` tells the page this APK pushes `outbox-changed`. The
            // web ships with the daemon, ahead of the APK; without the flag it
            // keeps polling `list` as before, or an older APK's outbox goes stale.
            respond(reply, new JSONObject().put("id", id).put("ok", true).put("changeEvents", true)
                    .put("value", value == null ? JSONObject.NULL : value));
        } catch (Exception error) {
            try {
                String message = error.getMessage();
                String code = error instanceof SecurityException ? "scope"
                        : "deadline".equals(message) ? "deadline" : "native_outbox";
                respond(reply, new JSONObject().put("id", id).put("ok", false).put("changeEvents", true).put("code", code)
                        .put("error", message == null ? "Native storage request failed" : message));
            } catch (Exception serializationFailure) {
                Log.w("OmpNativeOutbox", "Could not encode storage result", serializationFailure);
            }
        }
    }

    private static Object execute(Context context, String origin, String namespace,
                                  JSONObject request, long deadline) throws Exception {
        String operation = request.getString("op");
        switch (operation) {
            case "list":
                return NativeOutbox.list(context, namespace, origin, null);
            case "get":
                return NativeOutbox.get(context, namespace, origin, request.getString("commandId"));
            case "images":
                return NativeOutbox.images(context, namespace, origin, request.getString("commandId"));
            case "edit_begin":
                return NativeOutbox.editBegin(context, namespace, origin, request.getString("commandId"),
                        request.getJSONObject("expected"), deadline);
            case "edit_finish":
                return new JSONObject().put("finished", NativeOutbox.editFinish(context, namespace, origin,
                        request.getString("commandId"), request.getString("editToken"),
                        request.getBoolean("commit"), deadline));
            case "enqueue":
            case "import": {
                JSONObject command = request.getJSONObject("command");
                if (command.optBoolean("droppedImages", false))
                    throw new IllegalArgumentException("Legacy attachments are incomplete; text-only send was blocked");
                String state = command.optString("state", "saved");
                boolean terminal = "completed".equals(state) || "forwarded".equals(state) || "failed".equals(state);
                boolean saved = "saved".equals(state) || "queued".equals(state);
                // Every non-saved imported state may already have reached a daemon.
                boolean reconcileOnly = !saved && !terminal;
                return NativeOutbox.enqueue(context, namespace, origin, command, reconcileOnly, deadline);
            }
            case "remove":
                return new JSONObject().put("removed", NativeOutbox.remove(context, namespace, origin,
                        request.getString("commandId"),
                        request.has("expected") ? request.getJSONObject("expected") : null, deadline));
            case "clear":
                NativeOutbox.clear(context, namespace, origin,
                        request.has("sessionPath") ? request.getString("sessionPath") : null, deadline);
                return null;
            case "wake":
                NativeOutbox.wake();
                return null;
            default:
                throw new IllegalArgumentException("Unsupported outbox operation");
        }
    }

    private static void respond(JavaScriptReplyProxy reply, JSONObject result) {
        String encoded = result.toString();
        MAIN.post(() -> {
            try {
                reply.postMessage(encoded);
            } catch (Exception gone) {
                // The save is durable even if its WebView died before receiving it.
                Log.d("OmpNativeOutbox", "Storage caller left before acknowledgement");
            }
        });
    }
}
