package com.omppulse.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebView;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.CapConfig;
import com.omppulse.app.runtime.LocalRuntime;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
/**
 * Values shared by every native entry route.
 *
 * The run mode is the source of truth for which document the shell shows:
 * the bundled app (first run, nothing chosen yet), the daemon on this phone,
 * or the laptop. Keeping the lookup in one place prevents MainActivity,
 * notifications, the outbox and bubbles from drifting onto different hosts.
 */
public final class NativeConfig {
    private static final String TAG = "OmpNativeConfig";
    // From BuildConfig, which build.gradle stamps alongside the manifest
    // placeholder. A second literal here stayed at 2 when the protocol moved
    // to 3, so the shell reported itself older than the daemon's minimum
    // while the manifest (and app-release.json) said 3.
    public static final int PROTOCOL_VERSION = BuildConfig.OMP_PULSE_PROTOCOL_VERSION;
    public static final int MIN_CLIENT_PROTOCOL_VERSION = BuildConfig.OMP_PULSE_MIN_CLIENT_PROTOCOL_VERSION;

    /**
     * Where Capacitor serves the bundled React build when no server.url is
     * configured: its default androidScheme + hostname (capacitor.config.json
     * sets neither). Not file://, because the Vite bundle is ES modules, which
     * the WebView refuses to load from a file origin.
     */
    public static final String BUNDLED_APP_URL = "https://localhost/";

    private static final String SHELL_PREFS = "omp_pulse_shell";
    private static final String KEY_LAPTOP_URL = "laptop_url";
    /** Every computer this phone has connected to, most recent first (JSON array of /app/ URLs). */
    private static final String KEY_COMPUTERS = "computers";

    private NativeConfig() {}

    /** The document the shell treats as "the app" in the current run mode. */
    public static String appUrl(Context context) {
        String remote = context == null ? null : serverUrl(context);
        return remote != null ? remote : BUNDLED_APP_URL;
    }

    /**
     * The remote app for the current run mode, or null when the bundled app is
     * the app (first run, or laptop mode before a laptop URL is known).
     */
    public static String serverUrl(Context context) {
        LocalRuntime runtime = LocalRuntime.get(context);
        switch (runtime.mode()) {
            case PHONE: return runtime.appUrl();
            case LAPTOP: return laptopUrl(context);
            default: return null;
        }
    }

    /**
     * The laptop's /app/ URL: what the user entered, else what a personal
     * build baked in, else null (public build, nothing entered yet). A user
     * entry wins so a public-build user is never pinned to someone else's host.
     */
    public static String laptopUrl(Context context) {
        String saved = shellPrefs(context).getString(KEY_LAPTOP_URL, null);
        if (saved != null && !saved.isEmpty()) return saved;
        String baked = BuildConfig.OMP_PULSE_SERVER_URL;
        return baked.isEmpty() ? null : ensureTrailingSlash(baked);
    }

    /**
     * Validate a user-entered laptop URL and return its canonical form.
     * Mirrors build.gradle's rules for the baked URL: exactly
     * https://host[:port]/app/, loopback HTTP only in debug builds, and never
     * a loopback HTTPS host (that is this phone, which phone mode covers).
     *
     * @throws IllegalArgumentException with a user-facing reason.
     */
    public static String normalizeLaptopUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        URI uri;
        try {
            uri = new URI(value);
        } catch (Exception e) {
            throw new IllegalArgumentException("That is not a valid address.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new IllegalArgumentException("Enter the full address, like https://my-computer.example.ts.net/app/");
        }
        if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("The address must not contain a user name, ?query or #fragment.");
        }
        if (uri.getPort() == 0 || uri.getPort() > 65535 || uri.getRawAuthority().endsWith(":")) {
            throw new IllegalArgumentException("The port is not valid.");
        }
        if (!"/app/".equals(uri.getRawPath())) {
            throw new IllegalArgumentException("The address must end in /app/");
        }
        boolean loopback = isLoopbackHost(host);
        if ("https".equals(scheme)) {
            if (loopback) throw new IllegalArgumentException("That address is this phone; choose “Run on this phone” instead.");
        } else if (!("http".equals(scheme) && loopback && BuildConfig.DEBUG)) {
            throw new IllegalArgumentException("The address must start with https://");
        }
        return scheme + "://" + uri.getRawAuthority().toLowerCase(Locale.ROOT) + "/app/";
    }

    /**
     * Split a pairing link ({@code https://host/app/#pair=CODE}, what
     * {@code omp-pulse pair} prints and shows as a QR code) into the laptop's
     * normalized app URL and its one-use code, so one scan both points the app
     * at the computer and pairs with it.
     *
     * @return {url, code}
     * @throws IllegalArgumentException with a user-facing reason.
     */
    public static String[] laptopFromPairingLink(String raw) {
        URI uri;
        try {
            uri = new URI(raw == null ? "" : raw.trim());
        } catch (Exception e) {
            throw new IllegalArgumentException("That isn't a Pulse pairing link.");
        }
        String code = null;
        String fragment = uri.getRawFragment();
        if (fragment != null) {
            for (String part : fragment.split("&")) {
                if (part.startsWith("pair=")) code = part.substring(5);
            }
        }
        // The daemon's codes are URL-safe tokens; anything else is not one.
        if (code == null || !code.matches("[A-Za-z0-9_-]{4,128}") || uri.getScheme() == null || uri.getRawAuthority() == null) {
            throw new IllegalArgumentException("That isn't a Pulse pairing link. Run omp-pulse pair on your computer and scan its code.");
        }
        return new String[] {normalizeLaptopUrl(uri.getScheme() + "://" + uri.getRawAuthority() + "/app/"), code};
    }

    /**
     * Persist an already-normalized laptop URL as the active computer and
     * remember it in the computer list. A different origin means a different
     * server: drop the old laptop pairing so its token is never sent to the
     * new host. (Each computer's page keeps its own credential in its own
     * origin's storage and hands it back on load, so switching back to a
     * computer needs no new pairing.)
     *
     * @return true when the laptop origin changed.
     */
    public static boolean saveLaptopUrl(Context context, String normalized) {
        String previous = laptopUrl(context);
        List<String> list = computers(context);
        list.remove(normalized);
        list.add(0, normalized);
        shellPrefs(context).edit()
                .putString(KEY_LAPTOP_URL, normalized)
                .putString(KEY_COMPUTERS, new JSONArray(list).toString())
                .commit();
        String before = previous == null ? null : originOf(previous);
        boolean changed = before == null || !before.equals(originOf(normalized));
        if (changed) TokenStore.clearScope(context, TokenStore.SCOPE_LAPTOP);
        return changed;
    }

    /**
     * The computers this phone knows, most recent first. Installs from before
     * the list existed contribute their single saved (or baked) address.
     */
    public static List<String> computers(Context context) {
        List<String> list = new ArrayList<>();
        try {
            JSONArray saved = new JSONArray(shellPrefs(context).getString(KEY_COMPUTERS, "[]"));
            for (int i = 0; i < saved.length(); i++) {
                String url = saved.optString(i, "");
                if (!url.isEmpty() && !list.contains(url)) list.add(url);
            }
        } catch (Exception ignored) {
            // A corrupt list falls back to the active address below.
        }
        String active = laptopUrl(context);
        if (active != null && !list.contains(active)) list.add(0, active);
        return list;
    }

    /**
     * Forget a computer. Forgetting the active one makes the next most recent
     * active (its pairing dropped, as on any origin change), or none.
     *
     * @return true when the active computer changed.
     */
    public static boolean forgetComputer(Context context, String url) {
        List<String> list = computers(context);
        if (!list.remove(url)) return false;
        boolean active = url.equals(laptopUrl(context));
        SharedPreferences.Editor edit = shellPrefs(context).edit().putString(KEY_COMPUTERS, new JSONArray(list).toString());
        if (active) {
            if (list.isEmpty()) edit.remove(KEY_LAPTOP_URL);
            else edit.putString(KEY_LAPTOP_URL, list.get(0));
            TokenStore.clearScope(context, TokenStore.SCOPE_LAPTOP);
        }
        edit.commit();
        return active;
    }

    /**
     * Capacitor configuration for the current run mode. Capacitor injects its
     * JS bridge (and so every plugin) only into documents under server.url, so
     * the URL must match the mode the activity loads; it is derived here at
     * startup instead of being baked into the asset, which a public build
     * cannot know. No server.url means Capacitor serves the bundled app.
     *
     * @return null if the derived file cannot be written; Capacitor then falls
     *         back to the asset, i.e. the bundled app.
     */
    public static CapConfig capConfig(Context context) {
        String serverUrl = serverUrl(context);
        try (InputStream in = context.getAssets().open("capacitor.config.json")) {
            JSONObject root = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
            JSONObject server = root.optJSONObject("server");
            if (server == null) server = new JSONObject();
            if (serverUrl == null) server.remove("url");
            else server.put("url", serverUrl);
            root.put("server", server);
            File dir = new File(context.getFilesDir(), "capacitor");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("cannot create " + dir);
            File target = new File(dir, "capacitor.config.json");
            File temp = new File(dir, "capacitor.config.json.tmp");
            try (FileOutputStream out = new FileOutputStream(temp)) {
                out.write(root.toString().getBytes(StandardCharsets.UTF_8));
            }
            // Rename so a crash mid-write never leaves Capacitor a torn file.
            if (!temp.renameTo(target)) throw new IllegalStateException("cannot replace " + target);
            return CapConfig.loadFromFile(context, dir.getAbsolutePath());
        } catch (Exception e) {
            Log.w(TAG, "run-mode Capacitor config failed; using the bundled one", e);
            return null;
        }
    }

    public static String releaseId() {
        String value = BuildConfig.OMP_PULSE_RELEASE_ID;
        return value == null || value.trim().isEmpty() ? "unknown" : value.trim();
    }

    /**
     * scheme://host[:port] of an http(s) URL, lower-cased with the default
     * port dropped so equal origins compare equal; null for anything else.
     */
    public static String originOf(String url) {
        if (url == null) return null;
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || host.isEmpty() || uri.getUserInfo() != null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            int defaultPort;
            if ("https".equals(scheme)) defaultPort = 443;
            else if ("http".equals(scheme)) defaultPort = 80;
            else return null;
            StringBuilder origin = new StringBuilder(scheme).append("://").append(host.toLowerCase(Locale.ROOT));
            int port = uri.getPort();
            if (port != -1 && port != defaultPort) origin.append(':').append(port);
            return origin.toString();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static boolean isLoopbackHost(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        return h.equals("localhost") || h.endsWith(".localhost") || h.startsWith("127.") || h.equals("::1");
    }

    private static SharedPreferences shellPrefs(Context context) {
        return context.getSharedPreferences(SHELL_PREFS, Context.MODE_PRIVATE);
    }

    private static String ensureTrailingSlash(String value) {
        return value.endsWith("/") ? value : value + "/";
    }

    /** Whether this install still has the credential paired by the native APK. */
    public static boolean hasStoredPairingToken(Context context) {
        try {
            String token = context == null ? null : TokenStore.getToken(context);
            return token != null && !token.trim().isEmpty();
        } catch (Throwable ignored) {
            return false;
        }
    }

    /**
     * Register a one-document migration before the WebView app executes. The
     * script is restricted to the configured app origin and never overwrites
     * an existing browser credential; callers remove the handler after load.
     */
    public static ScriptHandler installPairingTokenBootstrap(Context context, WebView webView) {
        if (webView == null) return null;
        String script = pairingTokenMigrationScript(context);
        String origin = context == null ? null : originOf(serverUrl(context));
        if (script == null || origin == null
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return null;
        try {
            return WebViewCompat.addDocumentStartJavaScript(
                    webView, script, Collections.singleton(origin));
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * Script used as a reload-on-success fallback on older Android WebViews.
     * Null while the bundled app is the app: it talks to no daemon, so it has
     * no business holding a daemon credential.
     */
    public static String pairingTokenMigrationScript(Context context) {
        if (context == null || serverUrl(context) == null) return null;
        try {
            String token = TokenStore.getToken(context);
            if (token == null || token.trim().isEmpty()) return null;
            return "(function(){try{"
                    + "var k='omp-remote-token',t=" + JSONObject.quote(token) + ";"
                    + "var current=localStorage.getItem(k);"
                    + "if(current&&current.trim())return false;"
                    + "localStorage.setItem(k,t);"
                    + "return localStorage.getItem(k)===t;"
                    + "}catch(_){return false;}})()";
        } catch (Throwable ignored) {
            return null;
        }
    }

    /** Read notification extras which may be serialized as numbers or strings. */
    public static String stringExtra(Intent intent, String name) {
        if (intent == null || name == null) return null;
        try {
            android.os.Bundle extras = intent.getExtras();
            Object value = extras == null ? null : extras.get(name);
            return value == null ? null : String.valueOf(value);
        } catch (RuntimeException ignored) {
            return null;
        }
    }
    /** Return the conversation path only when the WebView is on this app's configured document. */
    public static String conversationPathFromTrustedUrl(Context context, String pageUrl) {
        if (context == null || pageUrl == null) return null;
        try {
            Uri configured = Uri.parse(appUrl(context));
            Uri page = Uri.parse(pageUrl);
            String scheme = configured.getScheme();
            String host = configured.getHost();
            if (scheme == null || configured.getUserInfo() != null
                    || configured.getQuery() != null || configured.getFragment() != null
                    || !scheme.equalsIgnoreCase(page.getScheme())
                    || page.getUserInfo() != null
                    || configured.getPort() != page.getPort()
                    || !sameNullableIgnoreCase(host, page.getHost())
                    || !sameNullable(configured.getEncodedPath(), page.getEncodedPath())) return null;

            String fragment = page.getEncodedFragment();
            if (fragment == null || fragment.isEmpty()) return null;
            String encodedPath = null;
            int start = 0;
            while (start <= fragment.length()) {
                int end = fragment.indexOf('&', start);
                if (end < 0) end = fragment.length();
                if (end - start >= 2 && fragment.charAt(start) == 's' && fragment.charAt(start + 1) == '=') {
                    if (encodedPath != null) return null;
                    encodedPath = fragment.substring(start + 2, end);
                }
                if (end == fragment.length()) break;
                start = end + 1;
            }
            if (encodedPath == null || encodedPath.isEmpty()) return null;
            String path = URLDecoder.decode(encodedPath, StandardCharsets.UTF_8.name());
            return path.isEmpty() ? null : path;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean sameNullable(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }

    private static boolean sameNullableIgnoreCase(String left, String right) {
        return left == null ? right == null : right != null && left.equalsIgnoreCase(right);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        return out.toByteArray();
    }
}
