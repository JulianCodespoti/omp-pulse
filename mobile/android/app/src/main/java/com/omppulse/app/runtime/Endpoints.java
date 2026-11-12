package com.omppulse.app.runtime;

import android.content.SharedPreferences;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Loopback ports of the local daemon and the phone-control API.
 *
 * WHY not fixed ports: a second omp-pulse install (another user/work profile, or a side-by-side
 * .dev build) shares the loopback interface. The preferred ports are tried first; when taken, a
 * free port is chosen. Choices are persisted because the daemon port is part of the WebView
 * origin, and an origin change would drop the app's local storage.
 */
public final class Endpoints {
    static final int PREFERRED_DAEMON_PORT = 7681;
    static final int PREFERRED_PHONE_API_PORT = 7690;

    private static final String KEY_DAEMON = "daemon_port";
    private static final String KEY_PHONE_API = "phone_api_port";

    private final int daemonPort;
    private final int phoneApiPort;

    Endpoints(int daemonPort, int phoneApiPort) {
        this.daemonPort = daemonPort;
        this.phoneApiPort = phoneApiPort;
    }

    public int daemonPort() {
        return daemonPort;
    }

    public int phoneApiPort() {
        return phoneApiPort;
    }

    /**
     * The guest discovery document ({@code endpoint.json}). {@code package} and
     * {@code nativeLibraryDir} let harness tools that run outside the guest (the shell tier) find
     * this install, whose package carries a suffix in side-by-side builds and whose library
     * directory moves on every app update.
     */
    String guestJson(String packageName, String nativeLibraryDir) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("phoneApi", "http://127.0.0.1:" + phoneApiPort + "/v1/");
        m.put("daemon", "http://127.0.0.1:" + daemonPort + "/");
        m.put("package", packageName);
        m.put("nativeLibraryDir", nativeLibraryDir);
        return Json.write(m);
    }

    /** Persisted ports, or a fresh choice (persisted) on first use. */
    static Endpoints load(SharedPreferences prefs) {
        int daemon = prefs.getInt(KEY_DAEMON, 0);
        int phone = prefs.getInt(KEY_PHONE_API, 0);
        if (daemon > 0 && phone > 0 && daemon != phone) return new Endpoints(daemon, phone);
        daemon = choose(PREFERRED_DAEMON_PORT, 0);
        phone = choose(PREFERRED_PHONE_API_PORT, daemon);
        return save(prefs, new Endpoints(daemon, phone));
    }

    /** Replaces the daemon port after another process took it. */
    Endpoints withNewDaemonPort(SharedPreferences prefs) {
        return save(prefs, new Endpoints(choose(PREFERRED_DAEMON_PORT, phoneApiPort), phoneApiPort));
    }

    /** Replaces the phone API port after another process took it. */
    Endpoints withNewPhoneApiPort(SharedPreferences prefs) {
        return save(prefs, new Endpoints(daemonPort, choose(PREFERRED_PHONE_API_PORT, daemonPort)));
    }

    private static Endpoints save(SharedPreferences prefs, Endpoints e) {
        prefs.edit().putInt(KEY_DAEMON, e.daemonPort).putInt(KEY_PHONE_API, e.phoneApiPort).commit();
        return e;
    }

    /** {@code preferred} when bindable, else a kernel-assigned free port; never {@code avoid}. */
    private static int choose(int preferred, int avoid) {
        if (preferred != avoid && isFree(preferred)) return preferred;
        for (int i = 0; i < 8; i++) {
            int p = ephemeral();
            if (p > 0 && p != avoid) return p;
        }
        // Binding fails only without INTERNET permission or with no loopback; keep the preferred
        // port so the failure surfaces where the daemon binds, with its own error message.
        return preferred;
    }

    /** True when nothing listens on 127.0.0.1:{@code port}. */
    static boolean isFree(int port) {
        try (ServerSocket s = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static int ephemeral() {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return s.getLocalPort();
        } catch (IOException e) {
            return -1;
        }
    }
}
