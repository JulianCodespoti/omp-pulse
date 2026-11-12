package com.omppulse.app.bridge;

import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.util.Log;

import com.omppulse.app.runtime.LocalRuntime;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Model-provider sign-in through the on-device omp CLI.
 *
 * `omp login <provider>` is interactive: it prints an authorization URL and
 * may then ask for a pasted code. The web onboarding drives it by polling
 * {@link #state()} and forwarding input, so the process and its output live
 * here, process-wide, rather than in the activity: switching run mode
 * recreates the activity and must not kill a sign-in in progress.
 *
 * INVARIANT: at most one login process exists; every mutation of the static
 * state happens under {@link #LOCK}, and a pump thread only writes state while
 * its process is still the current one.
 */
final class ProviderLogin {
    private static final String TAG = "OmpProviderLogin";
    private static final Pattern URL = Pattern.compile("https://\\S+");
    private static final Pattern ANSI = Pattern.compile("\u001b\\[[0-?]*[ -/]*[@-~]");
    private static final Pattern PROVIDER_ID = Pattern.compile("[A-Za-z0-9._-]+");
    /** Login transcripts are a few lines; the cap only bounds a runaway process. */
    private static final int MAX_OUTPUT_CHARS = 64 * 1024;
    /**
     * JavascriptInterface calls block the page's JS thread, so a wedged CLI
     * must not freeze the UI indefinitely.
     */
    private static final long LIST_TIMEOUT_MS = 30_000;
    /** omp's credential store inside the guest. */
    private static final String AGENT_DB = "/root/.omp/agent/agent.db";

    private static final Object LOCK = new Object();
    private static Process login;
    private static Integer loginExit;
    private static boolean loginUrlOpened;
    private static final StringBuilder loginOutput = new StringBuilder();

    private ProviderLogin() {}

    /**
     * Providers `omp auth-broker list` offers, as [{id,label,signedIn}]. The
     * CLI prints one provider per two-space-indented line: "  <id> <label…>".
     * When none are listed the result is {"error": "<why>"} with omp's own
     * output tail: a bare empty list left a fresh phone at "omp did not list
     * any providers" with nothing to act on or report.
     */
    static String providers(LocalRuntime runtime) {
        JSONArray result = new JSONArray();
        if (!runtime.isInstalled()) return error("omp is not installed on this phone yet.");
        Set<String> signedIn = signedInProviders(runtime);
        Process process = null;
        Thread watchdog = null;
        boolean[] timedOut = {false};
        try {
            process = runtime.guest("omp", "auth-broker", "list").start();
            process.getOutputStream().close();
            final Process listed = process;
            watchdog = new Thread(() -> {
                try {
                    Thread.sleep(LIST_TIMEOUT_MS);
                    timedOut[0] = true;
                    listed.destroy();
                } catch (InterruptedException ignored) {
                    // Finished in time.
                }
            }, "omp-providers-timeout");
            watchdog.setDaemon(true);
            watchdog.start();
            String text = readAll(process);
            int exit = process.waitFor();
            for (String line : text.split("\n")) {
                if (!line.startsWith("  ")) continue;
                String trimmed = line.trim();
                int space = trimmed.indexOf(' ');
                if (space <= 0) continue;
                String id = trimmed.substring(0, space);
                result.put(new JSONObject()
                        .put("id", id)
                        .put("label", trimmed.substring(space).trim())
                        .put("signedIn", signedIn.contains(id)));
            }
            if (result.length() > 0) return result.toString();
            if (timedOut[0]) return error("omp did not answer within " + (LIST_TIMEOUT_MS / 1000) + " s.");
            String tail = ANSI.matcher(text).replaceAll("").trim();
            if (tail.length() > 600) tail = "…" + tail.substring(tail.length() - 600);
            Log.w(TAG, "provider list empty (exit " + exit + "): " + tail);
            return error("omp exited with code " + exit + (tail.isEmpty() ? "." : ": " + tail));
        } catch (Exception e) {
            Log.w(TAG, "provider list failed", e);
            if (process != null) process.destroy();
            return error("omp could not be started: " + e.getMessage());
        } finally {
            if (watchdog != null) watchdog.interrupt();
        }
    }

    /**
     * Providers with a usable stored credential: only the provider column is
     * read, never the credential itself. WHY: the sign-in screen had no way to
     * say "already signed in", so after the browser round trip (which reloads
     * the page and drops the finished login's state) nobody could tell whether
     * it worked, and a session then died with omp's "No default model selected".
     */
    private static Set<String> signedInProviders(LocalRuntime runtime) {
        Set<String> ids = new HashSet<>();
        File db = runtime.hostPath(AGENT_DB);
        if (!db.isFile()) return ids;
        try (SQLiteDatabase sql = SQLiteDatabase.openDatabase(db.getPath(), null, SQLiteDatabase.OPEN_READONLY);
             Cursor c = sql.rawQuery("SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL", null)) {
            while (c.moveToNext()) ids.add(c.getString(0));
        } catch (Exception e) {
            Log.w(TAG, "cannot read signed-in providers", e);
        }
        return ids;
    }

    private static String error(String message) {
        try {
            return new JSONObject().put("error", message).toString();
        } catch (Exception e) {
            return "{\"error\":\"omp did not list any providers.\"}";
        }
    }

    static void start(Context context, LocalRuntime runtime, String providerId) {
        if (providerId == null || !PROVIDER_ID.matcher(providerId).matches()) return;
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            if (login != null) login.destroy();
            login = null;
            loginOutput.setLength(0);
            loginExit = null;
            loginUrlOpened = false;
            if (!runtime.isInstalled()) {
                loginOutput.append("omp is not installed on this phone yet.\n");
                loginExit = -1;
                return;
            }
            try {
                Process process = runtime.guest("omp", "login", providerId).start();
                login = process;
                Thread pump = new Thread(() -> pump(app, process), "omp-local-login");
                pump.setDaemon(true);
                pump.start();
            } catch (Exception e) {
                loginOutput.append("Could not start sign-in: ").append(e.getMessage()).append('\n');
                loginExit = -1;
            }
        }
    }

    /** Send one line (e.g. a pasted authorization code) to the login prompt. */
    static void input(String text) {
        if (text == null) return;
        synchronized (LOCK) {
            if (login == null) return;
            try {
                OutputStream stdin = login.getOutputStream();
                stdin.write((text.trim() + "\n").getBytes(StandardCharsets.UTF_8));
                stdin.flush();
            } catch (Exception e) {
                Log.w(TAG, "login input failed", e);
            }
        }
    }

    /** {"running":bool,"exitCode":int|null,"output":string} */
    static String state() {
        synchronized (LOCK) {
            try {
                return new JSONObject()
                        .put("running", login != null && loginExit == null)
                        .put("exitCode", loginExit == null ? JSONObject.NULL : loginExit)
                        .put("output", loginOutput.toString())
                        .toString();
            } catch (Exception e) {
                return "{}";
            }
        }
    }

    static void cancel() {
        synchronized (LOCK) {
            if (login != null) login.destroy();
            login = null;
            loginExit = null;
            loginOutput.setLength(0);
        }
    }

    /**
     * Explicit stop of phone mode ("unset"): ends a sign-in in progress, proot and guest, and
     * clears its state. Not for a normal mode switch, which keeps a sign-in running. The guest is
     * stopped before the logical cancel because Process.destroy() alone leaves it running.
     */
    static void stop(LocalRuntime runtime) {
        boolean active;
        synchronized (LOCK) {
            active = login != null;
        }
        if (active) runtime.stopGuestCommands();
        cancel();
    }

    private static void pump(Context app, Process process) {
        StringBuilder raw = new StringBuilder();
        char[] buffer = new char[4096];
        try (Reader reader = new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)) {
            int count;
            while ((count = reader.read(buffer)) > 0) {
                raw.append(buffer, 0, count);
                if (raw.length() > MAX_OUTPUT_CHARS) raw.delete(0, raw.length() - MAX_OUTPUT_CHARS);
                String clean = ANSI.matcher(raw).replaceAll("");
                String toOpen = null;
                synchronized (LOCK) {
                    if (login != process) return;
                    loginOutput.setLength(0);
                    loginOutput.append(clean);
                    // Only complete lines: a URL still streaming in would open truncated.
                    int lastNewline = clean.lastIndexOf('\n');
                    if (!loginUrlOpened && lastNewline >= 0) {
                        Matcher m = URL.matcher(clean.substring(0, lastNewline));
                        if (m.find()) {
                            loginUrlOpened = true;
                            toOpen = m.group();
                        }
                    }
                }
                if (toOpen != null) openBrowser(app, toOpen);
            }
            int exit = process.waitFor();
            synchronized (LOCK) {
                if (login == process) loginExit = exit;
            }
        } catch (Exception e) {
            synchronized (LOCK) {
                if (login == process) loginExit = -1;
            }
        }
    }

    /**
     * The provider's consent page belongs in the user's browser (saved
     * sessions, password manager), not in the app WebView. The application
     * context outlives a mode-switch activity restart.
     */
    private static void openBrowser(Context app, String url) {
        try {
            app.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            Log.w(TAG, "cannot open sign-in URL", e);
        }
    }

    private static String readAll(Process process) throws Exception {
        StringBuilder out = new StringBuilder();
        char[] buffer = new char[4096];
        try (Reader reader = new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)) {
            int count;
            while ((count = reader.read(buffer)) > 0) out.append(buffer, 0, count);
        }
        return out.toString();
    }
}
