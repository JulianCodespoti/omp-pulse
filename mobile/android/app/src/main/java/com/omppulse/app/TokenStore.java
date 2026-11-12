package com.omppulse.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.omppulse.app.runtime.LocalRuntime;

/**
 * Persists the pairing token and last SSE event ID.
 *
 * INVARIANT: the token is the sole credential for /api/notify/stream — it must
 * survive reboot and process death. We try EncryptedSharedPreferences via
 * reflection (if androidx.security:security-crypto is present) otherwise fall
 * back to private SharedPreferences. Reflection avoids a hard compile-time dep
 * so a build can omit security-crypto with zero breakage.
 *
 * INVARIANT: credentials are scoped per daemon. The on-device daemon ("phone")
 * and the laptop daemon ("laptop") issue unrelated tokens; one must never be
 * sent to the other, and switching run mode must not destroy the other mode's
 * pairing. The unscoped accessors resolve the scope from the current run mode
 * so every existing caller (NotifyService, outbox, plugins) follows the mode.
 * The laptop scope keeps the historical unsuffixed keys so users upgrading
 * from a laptop-only build stay paired.
 */
public final class TokenStore {
    private static final String TAG = "OmpTokenStore";
    private static final String PREFS_NAME = "omp_pulse_prefs";
    private static final String KEY_TOKEN = "pairing_token";
    private static final String KEY_LAST_EVENT_ID = "last_event_id";
    public static final String SCOPE_PHONE = "phone";
    public static final String SCOPE_LAPTOP = "laptop";

    private TokenStore() {}

    public static void saveToken(Context ctx, String token) {
        saveTokenFor(ctx, currentScope(ctx), token);
    }

    public static String getToken(Context ctx) {
        return getTokenFor(ctx, currentScope(ctx));
    }

    public static void clearToken(Context ctx) {
        String scope = currentScope(ctx);
        if (scope != null) prefs(ctx).edit().remove(key(scope, KEY_TOKEN)).apply();
    }

    public static void saveTokenFor(Context ctx, String scope, String token) {
        if (scope == null) return;
        // commit(), not apply(): setToken only acknowledges after the credential
        // reads back, and apply() would race that check.
        prefs(ctx).edit().putString(key(scope, KEY_TOKEN), token).commit();
        // A new pairing is the moment the widget stops asking to pair.
        PulseWidget.refresh(ctx);
    }

    public static String getTokenFor(Context ctx, String scope) {
        return scope == null ? null : prefs(ctx).getString(key(scope, KEY_TOKEN), null);
    }

    /**
     * Forget a scope's pairing and stream position. Used when the laptop URL
     * changes: the old token belongs to a different server and must not be
     * presented to the new one, and its event IDs mean nothing there.
     */
    public static void clearScope(Context ctx, String scope) {
        prefs(ctx).edit()
                .remove(key(scope, KEY_TOKEN))
                .remove(key(scope, KEY_LAST_EVENT_ID))
                .commit();
    }

    public static void saveLastEventId(Context ctx, String id) {
        String scope = currentScope(ctx);
        if (id == null || scope == null) return;
        prefs(ctx).edit().putString(key(scope, KEY_LAST_EVENT_ID), id).apply();
    }

    public static String getLastEventId(Context ctx) {
        String scope = currentScope(ctx);
        return scope == null ? null : prefs(ctx).getString(key(scope, KEY_LAST_EVENT_ID), null);
    }

    /**
     * The scope of the run mode's daemon, or null in {@link LocalRuntime.Mode#UNSET}: stopped, no
     * daemon, so the unscoped accessors read nothing and write nothing. A stale page or the
     * outbox cannot then store a credential under, or reuse, the laptop scope. Saved phone and
     * laptop credentials stay untouched and return when a mode is chosen again.
     */
    private static String currentScope(Context ctx) {
        switch (LocalRuntime.get(ctx).mode()) {
            case PHONE: return SCOPE_PHONE;
            case LAPTOP: return SCOPE_LAPTOP;
            default: return null;
        }
    }

    private static String key(String scope, String base) {
        return SCOPE_PHONE.equals(scope) ? base + "_phone" : base;
    }

    // INVARIANT: reflection path must never crash the app if security-crypto
    // is absent or API shape changes — every failure falls through to plain prefs.
    // When the dep is present we reflectively build MasterKey and call the modern
    // EncryptedSharedPreferences.create(Context, String, MasterKey, Scheme, Scheme).
    private static SharedPreferences prefs(Context ctx) {
        try {
            Class<?> espClass = Class.forName("androidx.security.crypto.EncryptedSharedPreferences");
            // MasterKey.Builder path
            Class<?> builderClass = Class.forName("androidx.security.crypto.MasterKey$Builder");
            Object builder = builderClass.getConstructor(Context.class).newInstance(ctx);
            // Best-effort setKeyScheme(AES256_GCM) — ignore if method/enum missing across versions
            try {
                Class<?> schemeEnum = Class.forName("androidx.security.crypto.MasterKey$KeyScheme");
                @SuppressWarnings("unchecked")
                Object aes = Enum.valueOf((Class<Enum>) schemeEnum, "AES256_GCM");
                builderClass.getMethod("setKeyScheme", schemeEnum).invoke(builder, aes);
            } catch (Throwable ignore) {}
            Object masterKey = builderClass.getMethod("build").invoke(builder);
            Class<?> masterKeyClass = Class.forName("androidx.security.crypto.MasterKey");
            Class<?> keyScheme = Class.forName("androidx.security.crypto.EncryptedSharedPreferences$PrefKeyEncryptionScheme");
            Class<?> valScheme = Class.forName("androidx.security.crypto.EncryptedSharedPreferences$PrefValueEncryptionScheme");
            @SuppressWarnings("unchecked")
            Object ks = Enum.valueOf((Class<Enum>) keyScheme, "AES256_SIV");
            @SuppressWarnings("unchecked")
            Object vs = Enum.valueOf((Class<Enum>) valScheme, "AES256_GCM");
            java.lang.reflect.Method create = espClass.getMethod(
                    "create", Context.class, String.class, masterKeyClass, keyScheme, valScheme);
            Object esp = create.invoke(null, ctx, PREFS_NAME, masterKey, ks, vs);
            if (esp instanceof SharedPreferences) return (SharedPreferences) esp;
        } catch (Throwable e) {
            Log.d(TAG, "EncryptedSharedPreferences unavailable, using plain prefs: " + e.getMessage());
        }
        // Fallback: private prefs are still sandbox-private (MODE_PRIVATE).
        try {
            return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        } catch (Throwable e) {
            Log.w(TAG, "getSharedPreferences failed", e);
            return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        }
    }
}
