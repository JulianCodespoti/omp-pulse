package com.omppulse.app.runtime;

import android.content.Context;
import android.os.Build;
import com.omppulse.app.TokenStore;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** HTTP calls the app makes to its own local daemon: liveness probe, device pairing, busy long-poll. */
final class DaemonClient {
    /** TokenStore slot of the credential this app uses against the local daemon. */
    static final String TOKEN_SLOT = "phone";
    static final int UNREACHABLE = -1;

    private final int port;

    DaemonClient(int port) {
        this.port = port;
    }

    /**
     * HTTP status of GET /api/version, or {@link #UNREACHABLE}. The route requires auth, so any
     * status means "a daemon answers", and 200 with {@code token} means the token is valid there.
     */
    int probe(String token) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(origin() + "/api/version").openConnection();
            conn.setConnectTimeout(1500);
            conn.setReadTimeout(3000);
            if (token != null) conn.setRequestProperty("Authorization", "Bearer " + token);
            return conn.getResponseCode();
        } catch (IOException e) {
            return UNREACHABLE;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Makes sure TokenStore holds a working admin token for this daemon: keeps a valid one, else
     * mints a pairing code with the daemon's owner credential and redeems it.
     */
    void ensurePaired(Context ctx, String ownerToken) throws IOException {
        String current = TokenStore.getTokenFor(ctx, TOKEN_SLOT);
        if (current != null && !current.isEmpty() && probe(current) == HttpURLConnection.HTTP_OK) return;
        if (ownerToken == null || ownerToken.isEmpty()) throw new IOException("omp-pulse has no owner credential; re-run setup");
        try {
            String code = postJson("/api/devices/pairing-codes", ownerToken,
                    new JSONObject().put("role", "admin").put("name", "This phone")).optString("code", "");
            if (code.isEmpty()) throw new IOException("omp-pulse issued no enrollment code");
            String token = postJson("/api/pair", null,
                    new JSONObject().put("code", code).put("name", Build.MODEL + " (local)")).optString("token", "");
            if (token.isEmpty()) throw new IOException("pairing with omp-pulse returned no token");
            TokenStore.saveTokenFor(ctx, TOKEN_SLOT, token);
        } catch (JSONException e) {
            throw new IOException("unexpected pairing response: " + e.getMessage(), e);
        }
    }

    /** One {@code GET /api/busy} answer. */
    static final class Busy {
        final boolean busy;
        final long version;

        Busy(boolean busy, long version) {
            this.busy = busy;
            this.version = version;
        }
    }

    /**
     * Long-polls {@code /api/busy}: answers at once when the daemon's version differs from {@code
     * after} (negative means "none yet"), else on the next flip or after {@code waitSeconds}. The
     * read timeout outlasts the wait by a minute so a held poll is never cut short. The open
     * connection is published through {@code control} so another thread can disconnect it: a
     * blocked socket read ignores {@link Thread#interrupt()}.
     */
    Busy busy(String token, long after, int waitSeconds, BusyWatchControl control) throws IOException {
        if (token == null || token.isEmpty()) throw new IOException("Missing local daemon credential");
        String query = "?wait=" + waitSeconds + (after < 0 ? "" : "&after=" + after);
        HttpURLConnection conn = (HttpURLConnection) new URL(origin() + "/api/busy" + query).openConnection();
        try {
            conn.setConnectTimeout(3000);
            conn.setReadTimeout((waitSeconds + 60) * 1000);
            conn.setInstanceFollowRedirects(false);
            conn.setUseCaches(false);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            // Stop and publication share a monitor: a stopped generation can never publish
            // a new read after stop() captured its connection. The timeout is a final bound
            // on platform transports whose disconnect does not immediately unblock a read.
            if (!control.publish(conn) || Thread.currentThread().isInterrupted())
                throw new InterruptedIOException("Busy watch stopped");
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("/api/busy: HTTP " + code);
            JSONObject body;
            try (InputStream in = conn.getInputStream()) {
                body = new JSONObject(RuntimeIo.drain(in));
            }
            return new Busy(body.getBoolean("busy"), body.getLong("version"));
        } catch (JSONException e) {
            throw new IOException("unexpected /api/busy response: " + e.getMessage(), e);
        } finally {
            control.clear(conn);
            conn.disconnect();
        }
    }
    private JSONObject postJson(String path, String bearer, JSONObject body) throws IOException, JSONException {
        HttpURLConnection conn = (HttpURLConnection) new URL(origin() + path).openConnection();
        try {
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(10000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer " + bearer);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            InputStream in = code < 400 ? conn.getInputStream() : conn.getErrorStream();
            String text = in == null ? "" : RuntimeIo.drain(in);
            if (code >= 400) throw new IOException(path + ": HTTP " + code + " " + RuntimeIo.tail(text));
            return new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    private String origin() {
        return "http://127.0.0.1:" + port;
    }
}
