package com.omppulse.app.runtime;

import android.app.ActivityManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Build;
import android.util.Log;
import com.omppulse.app.NativeConfig;
import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.util.LinkedHashMap;
import java.util.Map;

/** Files the app maintains inside the guest: network config, endpoint discovery, phone harness. */
final class GuestFiles {
    private static final String TAG = "OmpLocalRuntime";
    /** Scratch copy of the seed while it is committed to the harness repo's upstream branch. */
    private static final String HARNESS_STAGE = "/tmp/omp-pulse-harness-seed";

    private final Context ctx;
    private final RuntimePaths paths;
    private final GuestLauncher guest;
    private final Posix posix;
    private final HarnessInstall harness;

    GuestFiles(Context ctx, RuntimePaths paths, GuestLauncher guest, Posix posix) {
        this.ctx = ctx;
        this.paths = paths;
        this.guest = guest;
        this.posix = posix;
        this.harness = new HarnessInstall(paths, posix, (message, e) -> Log.w(TAG, message, e));
    }

    /**
     * resolv.conf from the active network's DNS servers (public resolvers as fallback) and a
     * loopback hosts file. Android has no /etc/resolv.conf for musl to read, and DNS servers change
     * with the network, so this is rewritten before every install and daemon start.
     */
    void writeNetworkConfig() {
        StringBuilder sb = new StringBuilder();
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            LinkProperties lp = null;
            if (cm != null && Build.VERSION.SDK_INT >= 23) {
                Network net = cm.getActiveNetwork();
                if (net != null) lp = cm.getLinkProperties(net);
            }
            if (lp != null) {
                for (InetAddress dns : lp.getDnsServers()) {
                    String host = dns.getHostAddress();
                    if (host != null) sb.append("nameserver ").append(host.replaceAll("%.*$", "")).append('\n');
                }
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "dns lookup failed", e);
        }
        sb.append("nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
        try {
            RuntimeIo.writeTextAtomic(paths.inRootfs("/etc/resolv.conf"), sb.toString());
            RuntimeIo.writeTextAtomic(paths.inRootfs("/etc/hosts"), "127.0.0.1 localhost\n::1 localhost\n");
        } catch (IOException e) {
            Log.w(TAG, "cannot write guest network config", e);
        }
    }

    /** Guest discovery file for the `android` CLI and agents; mode 0600 like the API token. */
    void writeEndpoint(Endpoints endpoints) throws IOException {
        File file = paths.inRootfs(RuntimePaths.GUEST_ENDPOINT_JSON);
        RuntimeIo.writeTextAtomic(file, endpoints.guestJson(ctx.getPackageName(), paths.nativeLibDir.getAbsolutePath()));
        posix.chmod(file, 0600);
    }

    /**
     * Device facts for the harness ({@code device.json}). The guest has no getprop (no /system),
     * and the harness scales and gates its tools by them: memory thresholds by RAM, OEM-specific
     * tools by manufacturer.
     */
    void writeDeviceInfo() throws IOException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("manufacturer", Build.MANUFACTURER);
        m.put("brand", Build.BRAND);
        m.put("model", Build.MODEL);
        m.put("device", Build.DEVICE);
        m.put("android", Build.VERSION.RELEASE);
        m.put("sdk", (long) Build.VERSION.SDK_INT);
        m.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am != null) {
            ActivityManager.MemoryInfo mem = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mem);
            m.put("memTotalMb", mem.totalMem >> 20);
        }
        RuntimeIo.writeTextAtomic(paths.inRootfs(RuntimePaths.GUEST_DEVICE_JSON), Json.write(m));
    }

    /** "Phone tools for the agent": {@code stored}, or the upgrade-aware default ({@link HarnessInstall#enabled}). */
    boolean phoneToolsEnabled(Boolean stored) {
        return harness.enabled(stored);
    }

    /**
     * Applies "Phone tools for the agent" ({@link HarnessInstall}): on seeds or upgrades the harness
     * and links it where omp, PATH and the job broker look; off seeds nothing and removes what the
     * app linked. Synchronized: the daemon start and the Settings switch both call it.
     */
    synchronized void applyHarness(boolean enabled) throws IOException, InterruptedException {
        harness.apply(enabled, this::seedHarness);
    }

    /**
     * Seeds or upgrades /root/projects/phone-harness from the APK's harness (see
     * {@link HarnessMerge}: the agent's own commits survive app updates; conflicts keep the
     * device's version and are reported by `android doctor`).
     */
    private void seedHarness() throws InterruptedException {
        File dir = paths.inRootfs(HarnessInstall.DIR);
        // Builds before the upstream branch kept a read-only mirror of the seed here.
        RuntimeIo.deleteTree(new File(dir, "shipped"), posix);
        try {
            HarnessSeed seed = new HarnessSeed(name -> ctx.getAssets().open("phone/" + name));
            new HarnessMerge(guest, dir, HarnessInstall.DIR, paths.inRootfs(HARNESS_STAGE), HARNESS_STAGE,
                    paths.inRootfs(RuntimePaths.GUEST_HARNESS_STATUS), posix).apply(seed, NativeConfig.releaseId());
        } catch (IOException e) {
            // The daemon (and the user's chat) must not stay down over a harness upgrade: the
            // agent's current harness still works, and the status file tells `android doctor` why.
            Log.w(TAG, "harness seed failed", e);
        }
    }
}
