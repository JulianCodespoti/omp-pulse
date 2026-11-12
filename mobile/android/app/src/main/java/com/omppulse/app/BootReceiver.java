package com.omppulse.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.omppulse.app.runtime.LocalRuntime;

/**
 * Restarts background work after reboot or app update.
 *
 * INVARIANT: the notification service is START_STICKY and holds a persistent
 * SSE, but the system kills it on reboot. This receiver asks the service to
 * resume only when pairing exists and the user's background-delivery setting
 * is enabled. Otherwise no foreground listener is started.
 *
 * In phone mode the daemon the notification stream talks to runs on this
 * device, so it has to come back first; prepare() also upgrades the runtime
 * when an app update shipped new pins.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "OmpBootReceiver";

    @Override public void onReceive(Context ctx, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        boolean isBoot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!isBoot) return;
        try {
            NativeOutbox.initialize(ctx);
            LocalRuntime runtime = LocalRuntime.get(ctx);
            if (runtime.mode() == LocalRuntime.Mode.PHONE) runtime.prepare();
            String token = TokenStore.getToken(ctx);
            if (token == null || token.isEmpty()) {
                Log.i(TAG, "boot: no token, not starting service");
                return;
            }
            Log.i(TAG, "boot: restarting NotifyService");
            NotifyService.startIfPaired(ctx);
        } catch (Throwable e) {
            Log.w(TAG, "boot receiver failed", e);
        }
    }
}
