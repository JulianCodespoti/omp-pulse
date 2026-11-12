# proguard-rules.pro — R8 keep rules for omp-pulse release
# INVARIANT: This project had a blank-screen failure from over-aggressive shrinking.
# Capacitor registers plugins via reflection on @CapacitorPlugin / @PluginMethod.
# Keep rules below are intentionally conservative; do not tighten without testing
# `assembleRelease` on device (launch, bridge ready, SSE stream, notification tap).

# ── Keep attributes needed for reflection / debugging ────────────────────────
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,SourceFile,LineNumberTable,JavascriptInterface

# ── Capacitor core — reflection-heavy bridge ────────────────────────────────
# WHY: Capacitor scans classpath for @CapacitorPlugin at runtime and invokes
# @PluginMethod via reflection. Stripping them produces a WebView that loads
# but never fires bridge events (blank screen / no SSE token).
-keep class com.getcapacitor.Bridge { *; }
-keep class com.getcapacitor.BridgeActivity { *; }
-keep class com.getcapacitor.Plugin { *; }
-keep class com.getcapacitor.PluginCall { *; }
-keep class com.getcapacitor.PluginHandle { *; }
-keep class com.getcapacitor.PluginMethodHandle { *; }
-keep class com.getcapacitor.CapConfig { *; }
-keep class com.getcapacitor.annotation.** { *; }
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.annotation.PluginMethod <methods>;
}
-keepclassmembers class * {
    @com.getcapacitor.annotation.Permission <methods>;
}
-keepclassmembers class * {
    @com.getcapacitor.annotation.ActivityCallback <methods>;
}
# Cordova plugin scaffolding (capacitor-cordova-android-plugins) — also reflection
-keep class org.apache.cordova.** { *; }
-keep class org.chromium.** { *; }

# ── WebView bridge ──────────────────────────────────────────────────────────
# WHY: Methods exposed to JS via @JavascriptInterface are accessed by name from
# the WebView; obfuscation would break the JS↔Java bridge silently. Covers
# OmpNative (NativeShellMarker) and OmpLocal (bridge.LocalModeBridge).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class android.webkit.** { *; }

# ── Sibling: AndroidService — manifest-referenced components ────────────────
# WHY: Services / receivers referenced only from AndroidManifest.xml look unused
# to R8. Stripping them removes the foreground SSE service and BOOT_COMPLETED
# receiver, breaking persistent notifications and bubbles.
# Classic R8 casualty — keep every class under com.omppulse.app, including the
# phone-mode runtime/, phone/ and bridge/ packages.
-keep class com.omppulse.app.** { *; }
# Manifest-only services: NotifyService, runtime.LocalPulseService,
# phone.PhoneAccessibilityService (via AccessibilityService), NativeOutboxJob.
-keep class * extends android.app.Service { *; }
-keep class * extends android.content.BroadcastReceiver { *; }
-keep class androidx.core.app.NotificationCompat { *; }
-keep class androidx.core.app.NotificationCompat$* { *; }
-keep class androidx.core.app.Person { *; }
-keep class androidx.core.content.LocusIdCompat { *; }
-keep class androidx.core.content.pm.ShortcutInfoCompat { *; }
-keep class androidx.core.graphics.drawable.IconCompat { *; }
# Bubble / shortcut helpers
-keep class androidx.core.app.NotificationCompat$BubbleMetadata { *; }

# ── androidx.security (optional) — reflectively loaded if present ──────────
# WHY: EncryptedSharedPreferences is loaded via reflection; keep if the
# dependency is added so R8 does not strip it as unreachable.
-keep class androidx.security.crypto.** { *; }

# ── General Android keeps ───────────────────────────────────────────────────
-keep class * implements android.os.Parcelable { *; }
-keepclassmembers class * implements android.os.Parcelable {
    public static final android.os.Parcelable$Creator *;
}
-keep enum * { *; }
-keepclassmembers enum * { *; }
-keep class * extends androidx.appcompat.app.AppCompatActivity { *; }

# ── Native methods — never obfuscate names matching JNI ────────────────────
-keepclasseswithmembernames class * { native <methods>; }

# ── Suppress warnings for optional Cordova deps that may not be present ───
-dontwarn org.apache.cordova.**
-dontwarn com.getcapacitor.**

# ── R8 fullMode keeps source file / line numbers for Play Console traces ──
# (Actual -keepattributes already above; this renames source to keep mapping useful)
-renamesourcefileattribute SourceFile

# ── Do NOT keep everything via -keep class ** { *; } — that defeats R8.
# The rules above are the minimal conservative set proven to keep the WebView bridge alive.
