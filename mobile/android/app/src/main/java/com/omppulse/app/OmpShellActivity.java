package com.omppulse.app;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.activity.BackEventCompat;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.lifecycle.Lifecycle;
import androidx.webkit.ScriptHandler;

import com.getcapacitor.BridgeActivity;
import com.omppulse.app.bridge.LocalModeBridge;
import com.omppulse.app.runtime.LocalRuntime;
import com.omppulse.app.runtime.RuntimeStatus;

import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.Arrays;
import java.util.Locale;

/**
 * The one Capacitor-backed conversation surface.
 *
 * Main and bubble differ only in what Android does with the Activity window:
 * which theme/task flags the manifest applies, and what an unconsumed Back
 * gesture should do. Everything else — plugin registration, the native sender
 * and pairing-token bridges, offline fallback, network restoration, downloads,
 * the Bridge WebViewClient, predictive Back and deep links — is owned here so
 * both surfaces cannot drift apart again.
 *
 * The run mode, read once per activity instance, picks the document: the
 * bundled app while no mode is chosen, the daemon on this phone once it is
 * ready, or the laptop. Changing mode restarts the activity
 * ({@link #restartForMode()}) because Capacitor's server.url is fixed when the
 * bridge is created.
 */
public class OmpShellActivity extends BridgeActivity {
    private static final String TAG = "OmpShellActivity";
    private static final String LOCAL_FALLBACK = "file:///android_asset/public/offline.html";
    private static final String STATE_PENDING_DEEP_LINK = "com.omppulse.app.pendingDeepLink";
    /** Shown while the on-device daemon installs or starts; the native waiter updates #m. */
    private static final String STARTING_PAGE = "<!doctype html><html><head>"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>"
            + "<body style=\"background:#000000;color:#9a9aa2;font:15px sans-serif;display:flex;"
            + "height:100vh;margin:0;padding:0 24px;box-sizing:border-box;align-items:center;"
            + "justify-content:center;text-align:center\">"
            + "<div id=\"m\">Starting omp on this phone…</div></body></html>";

    private boolean didFallback = false;
    private String pendingDeepLink = null;
    private ConnectivityManager.NetworkCallback networkCallback;
    private ScriptHandler tokenBootstrapScript;
    private boolean tokenMigrationRetryStarted = false;
    // True once a configured app document has finished loading, false from the
    // moment the next one starts. A hash route evaluated in between runs in the
    // outgoing (or initial blank) document and is lost with it.
    private boolean documentLoaded = false;
    private boolean documentLoadFailed;
    private long navigationGeneration;
    // The system reclaimed the WebView renderer; the shell is rebuilt on next start.
    private boolean rendererGone = false;
    private boolean shellDestroyed;
    private static final ShellLifecycle<OmpShellActivity, WebView> SHELLS = new ShellLifecycle<>();
    private LocalRuntime.Mode mode;
    /**
     * The app URL Capacitor's config was built from in onCreate. Capacitor
     * proxies (and bridges) only that authority, port included, so a later
     * load of a different app URL would get no plugins.
     */
    private String startAppUrl;
    /**
     * Main-frame URL as last reported to the WebViewClient. OmpLocal runs on
     * the JavaBridge thread, where WebView.getUrl() is not allowed, and gates
     * every call on this value.
     */
    private volatile String trackedPageUrl;

    /**
     * The page reports its back target before Android starts a gesture. Legacy
     * onBackPressed/KEYCODE_BACK cannot preview and stop dispatching on Android 16.
     */
    private final OnBackPressedCallback webBack = new OnBackPressedCallback(false) {
        @Override
        public void handleOnBackStarted(@NonNull BackEventCompat event) {
            sendBack("start", 0f, event.getSwipeEdge());
        }

        @Override
        public void handleOnBackProgressed(@NonNull BackEventCompat event) {
            sendBack("progress", event.getProgress(), event.getSwipeEdge());
        }

        @Override
        public void handleOnBackCancelled() {
            sendBack("cancel", 0f, BackEventCompat.EDGE_LEFT);
        }

        @Override
        public void handleOnBackPressed() {
            commitBack();
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotifyBridgePlugin.class);
        registerPlugin(NativeUpgradePlugin.class);
        registerPlugin(BackNavigationPlugin.class);
        if (savedInstanceState == null) chooseRunOnIfAsked(getIntent());
        mode = LocalRuntime.get(this).mode();
        // Before super.onCreate(): the bridge reads this config to decide which
        // origin gets the Capacitor JS bridge. Null keeps the asset config.
        config = NativeConfig.capConfig(this);
        startAppUrl = NativeConfig.appUrl(this);
        super.onCreate(savedInstanceState);
        NativeOutbox.initialize(this);
        // Recreation (process death, an unhandled configuration change) and a
        // Recents relaunch hand back the Intent that first created this
        // Activity, not a new tap. Its notification or pairing target was
        // consumed back then; replaying it throws the user into an old chat and
        // re-opens an already answered question. New taps arrive via onNewIntent;
        // one not yet applied when the Activity was torn down is in the saved state.
        if (savedInstanceState != null) {
            pendingDeepLink = savedInstanceState.getString(STATE_PENDING_DEEP_LINK);
        }
        Intent launch = getIntent();
        boolean relaunched = savedInstanceState != null || (launch != null
                && (launch.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0);
        if (!relaunched || reopensLaunchTarget()) handleDeepLinkIntent(launch);
        // Bridge registration must precede the first page script, and the
        // JavaScript interfaces below only reach documents loaded afterwards.
        // Capacitor has already begun loading in super.onCreate(), so stop that
        // load and restart it once every document-start hook is installed.
        try {
            WebView wv = webView();
            if (wv != null) {
                SHELLS.attach(this, wv);
                // Black until the page paints; the default WebView paints white.
                wv.setBackgroundColor(Color.BLACK);
                wv.addJavascriptInterface(new NativeShellMarker(this), "OmpNative");
                wv.addJavascriptInterface(new LocalModeBridge(this), "OmpLocal");
                NativeOutboxBridge.install(this, wv);
                tokenBootstrapScript = NativeConfig.installPairingTokenBootstrap(this, wv);
                WebSettings s = wv.getSettings();
                // LOAD_DEFAULT, not LOAD_NO_CACHE. NO_CACHE was a fix for the
                // legacy root client, whose unhashed index.html/qol.js were
                // served cacheable and stranded the phone on a stale UI. The
                // React client's shell is `no-cache` (revalidated every load)
                // and every bundle is content-hashed `immutable`, so the HTTP
                // cache can no longer serve stale code — while NO_CACHE made
                // every cold launch re-download ~500 KB of unchanged JS, CSS
                // and fonts over the tailnet, and a deploy that changed one
                // chunk re-fetched all of them.
                s.setCacheMode(WebSettings.LOAD_DEFAULT);
                s.setDomStorageEnabled(true);
                s.setJavaScriptEnabled(true);
                // The app's Appearance text size times the system font scale
                // (OmpNative.fontScale) is the one source of scale: it sets
                // the root font-size, and every type AND spacing token is
                // rem, so text and its boxes grow together, as sp does in a
                // native app. WebView otherwise copies the system font scale
                // into textZoom, which grows text only, so px-sized controls
                // clip it, and the two scales would compound. Here, not in
                // MainActivity, so the bubble (which shares this shell)
                // renders the same.
                s.setTextZoom(100);
                injectFallbackClient(wv);
                wv.stopLoading();
                // Include the cold intent in the first document URL. A hash
                // event at onPageFinished can precede React listener setup.
                if (mode == LocalRuntime.Mode.PHONE) {
                    loadWhenLocalReady(wv);
                } else {
                    load(wv, NativeConfig.appUrl(this) + (pendingDeepLink == null ? "" : pendingDeepLink));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "webview setup failed", e);
        }
        // Restart the listener from persisted pairing state even when the
        // WebView is cold or its JavaScript bundle has not reached App.tsx yet.
        NotifyService.startIfPaired(this);
        try {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            WindowInsetsControllerCompat insetsController =
                    WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            if (insetsController != null) {
                insetsController.setAppearanceLightStatusBars(false);
                insetsController.setAppearanceLightNavigationBars(false);
            }
        } catch (Exception e) {
            Log.w(TAG, "edge-to-edge setup failed", e);
        }
        // Android 17 back-to-home finishes the Activity. Keep the WebView alive
        // instead; this fallback has lower priority than the page callback.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBackUnhandled();
            }
        });
        getOnBackPressedDispatcher().addCallback(this, webBack);
    }

    /** What an unconsumed Back gesture means for this particular window. */
    protected void onBackUnhandled() {
        moveTaskToBack(true);
    }

    /** Whether a relaunched instance re-opens its launch Intent's target; see onCreate. */
    protected boolean reopensLaunchTarget() {
        return false;
    }

    /**
     * Resume what onStop paused. Before this override the WebView kept every
     * JavaScript timer (watchdogs, pollers, tickers) running while nobody could
     * see the page, and with the daemon's wake lock held the phone never slept.
     */
    @Override
    public void onStart() {
        super.onStart();
        SHELLS.start(this);
        PulseWidget.refresh(this);
        if (rendererGone) {
            recreate();
            return;
        }
        WebView view = webView();
        if (view != null) {
            view.resumeTimers();
            view.onResume();
        }
        if (didFallback && mode == LocalRuntime.Mode.LAPTOP) {
            registerNetworkReload();
            retryFallback(view, true);
        }
    }

    /**
     * Pause the page's timers once no shell window is visible. Stop rather
     * than pause, so split screen and permission dialogs never freeze a page
     * the user can still see. visibilitychange is an event, not a timer, so
     * the page still reports itself hidden to the daemon.
     */
    @Override
    public void onStop() {
        super.onStop();
        SHELLS.stop(this);
        unregisterNetworkReload();
        WebView view = webView();
        if (view != null && !rendererGone) view.onPause();
        pauseHiddenTimers();
    }

    private static void pauseHiddenTimers() {
        WebView view = SHELLS.hiddenTimerView();
        if (view != null) view.pauseTimers();
    }

    /**
     * The system reclaimed the WebView renderer (low memory, usually while in the
     * background). That WebView can never be used again: detach and destroy it,
     * then rebuild the Activity — now when visible, otherwise on the next start so
     * a background shell does not respawn the renderer the system just reclaimed.
     */
    private void recoverFromRendererLoss(WebView view) {
        if (!ownsView(view)) return;
        Log.w(TAG, "WebView renderer reclaimed by the system; rebuilding the shell");
        rendererGone = true;
        unregisterNetworkReload();
        // The handle belongs to the dead WebView; the rebuilt Activity installs its own.
        tokenBootstrapScript = null;
        NativeOutboxBridge.forgetPage(view);
        SHELLS.rendererGone(this);
        ViewParent parent = view.getParent();
        if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(view);
        view.destroy();
        if (getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) recreate();
    }

    /** Current main-frame URL for OmpLocal's origin gate; safe from any thread. */
    public String trackedPageUrl() {
        return trackedPageUrl;
    }

    /** Native recovery stays in the trusted page and never replaces pairing credentials. */
    public void openRecoverySettings(String page, java.util.function.Consumer<Boolean> result) {
        WebView view = webView();
        if ((!page.equals("computer") && !page.equals("diagnostics") && !page.equals("repair-pairing"))
                || view == null || !documentLoaded || !isConfiguredAppUrl(view.getUrl())
                || !isConfiguredAppUrl(trackedPageUrl)) {
            result.accept(false);
            return;
        }
        view.evaluateJavascript("!window.dispatchEvent(new CustomEvent('app:open-settings',"
                + "{cancelable:true,detail:{page:" + JSONObject.quote(page) + "}}))",
                accepted -> result.accept("true".equals(accepted)));
    }

    /**
     * Run mode changed: start a fresh task so onCreate derives the new
     * Capacitor config and document. Call on the UI thread.
     */
    public void restartForMode() {
        restartForMode(null);
    }

    /**
     * As {@link #restartForMode()}, with {@code hash} (e.g. {@code #pair=CODE})
     * carried into the new mode's first document the way a deep link's
     * fragment is (handleDeepLinkIntent reads only the fragment).
     */
    public void restartForMode(String hash) {
        Intent next = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        if (hash != null && hash.startsWith("#")) next.setData(Uri.parse(NativeConfig.appUrl(this) + hash));
        startActivity(next);
        finish();
    }

    /**
     * Phone mode: (re)start the runtime and load the local app once the daemon
     * answers. Installing can take minutes, so there is no deadline here; the
     * runtime reports failures as phase "error", which lands on the offline
     * page and its retry.
     */
    private void loadWhenLocalReady(WebView wv) {
        LocalRuntime runtime = LocalRuntime.get(this);
        // INVARIANT: prepare() leaves a stale "error"/"ready" synchronously, so
        // the first poll below already reflects this attempt.
        runtime.prepare();
        trackedPageUrl = null;
        wv.loadDataWithBaseURL(null, STARTING_PAGE, "text/html", "utf-8", null);
        Thread waiter = new Thread(() -> {
            String shown = null;
            while (!isDestroyed() && !rendererGone) {
                RuntimeStatus.Snapshot status = runtime.status();
                if ("ready".equals(status.phase())) {
                    runOnUiThread(() -> loadLocalApp(wv));
                    return;
                }
                if ("error".equals(status.phase())) {
                    runOnUiThread(() -> showLocalFailure(wv));
                    return;
                }
                String line = status.message() == null || status.message().isEmpty()
                        ? "Starting omp on this phone…" : status.message();
                if (status.progress() >= 0) line += " · " + status.progress() + "%";
                if (!line.equals(shown)) {
                    shown = line;
                    String js = "(function(){var e=document.getElementById('m');if(e)e.textContent="
                            + JSONObject.quote(line) + ";})()";
                    runOnUiThread(() -> wv.evaluateJavascript(js, null));
                }
                try {
                    Thread.sleep(250);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }, "omp-local-wait");
        waiter.setDaemon(true);
        waiter.start();
    }

    private void loadLocalApp(WebView wv) {
        if (isDestroyed() || rendererGone) return;
        // The runtime may have paired the local daemon only just now, after
        // onCreate found no token to bootstrap.
        removeTokenBootstrap();
        tokenMigrationRetryStarted = false;
        tokenBootstrapScript = NativeConfig.installPairingTokenBootstrap(this, wv);
        setFallback(false);
        String appUrl = NativeConfig.appUrl(this);
        // claimDaemonPort may have moved the daemon off a port another process
        // holds since onCreate; only a fresh activity rebuilds the Capacitor
        // config for the new authority.
        if (!appUrl.equals(startAppUrl)) {
            restartForMode();
            return;
        }
        load(wv, appUrl + (pendingDeepLink == null ? "" : pendingDeepLink));
    }

    private void showLocalFailure(WebView wv) {
        if (isDestroyed() || rendererGone) return;
        setFallback(true);
        load(wv, fallbackUrl(null));
    }

    /**
     * Every navigation the shell itself starts. The tracked URL is set before
     * loading because onPageStarted arrives after the document's inline
     * scripts may already have asked OmpLocal for state.
     */
    private void load(WebView wv, String url) {
        if (!ownsView(wv)) return;
        navigationGeneration++;
        documentLoadFailed = false;
        documentLoaded = false;
        trackedPageUrl = url;
        wv.loadUrl(url);
    }

    private void clearVisibleConversationNotifications(WebView view) {
        if (!ownsView(view) || !hasWindowFocus() || !view.isShown() || !view.hasWindowFocus()) return;
        String sessionPath = NativeConfig.conversationPathFromTrustedUrl(this, view.getUrl());
        if (sessionPath != null) NotificationHelper.clearConversationNotifications(this, sessionPath);
    }

    @Override
    public void onWindowFocusChanged(boolean hasWindowFocus) {
        super.onWindowFocusChanged(hasWindowFocus);
        if (!hasWindowFocus) return;
        WebView view = webView();
        if (view != null) view.post(() -> clearVisibleConversationNotifications(view));
    }

    /** Called by BackNavigationPlugin on the UI thread. */
    void setWebBackEnabled(boolean enabled) {
        webBack.setEnabled(enabled);
    }

    protected WebView webView() {
        return getBridge() != null ? getBridge().getWebView() : null;
    }

    private boolean ownsView(WebView view) {
        return !shellDestroyed && !rendererGone && !isFinishing() && !isDestroyed()
                && SHELLS.ownsView(this, view) && webView() == view;
    }

    private boolean ownsStartedView(WebView view) {
        return ownsView(view) && SHELLS.ownsStartedView(this, view);
    }

    /**
     * The manifest handles fontScale and density in place so a Samsung font
     * size or screen zoom change does not recreate the Activity and reload the
     * page. WebView follows density itself (AwContents observes the display's
     * DIP scale). Newer WebView releases re-copy fontScale into textZoom on a
     * configuration change, so pin it back to 100 and tell the page to
     * re-read OmpNative.fontScale into its root rem instead.
     */
    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        WebView wv = webView();
        if (wv == null) return;
        WebSettings settings = wv.getSettings();
        if (settings.getTextZoom() != 100) settings.setTextZoom(100);
        wv.evaluateJavascript("window.dispatchEvent(new Event('omp-font-scale'))", null);
    }

    private void sendBack(String phase, float progress, int edge) {
        WebView wv = webView();
        if (wv == null) return;
        wv.evaluateJavascript(String.format(Locale.ROOT,
                "window.__ompNativeBack&&window.__ompNativeBack('%s',%.4f,%d)", phase, progress, edge), null);
    }

    /** A lost or reloaded page must never swallow Back. */
    private void commitBack() {
        WebView wv = webView();
        if (wv == null) {
            webBack.setEnabled(false);
            onBackUnhandled();
            return;
        }
        wv.evaluateJavascript(
                "(function(){try{return typeof window.__ompNativeBack==='function'"
                        + "&&window.__ompNativeBack('commit')===true;}catch(e){return false;}})()",
                handled -> {
                    if (!"true".equals(handled)) {
                        webBack.setEnabled(false);
                        onBackUnhandled();
                    }
                });
    }

    /** The app shortcut's action: back to the first-run "where to run" choice. */
    static final String ACTION_CHOOSE_RUN_ON = "com.omppulse.app.CHOOSE_RUN_ON";

    /**
     * Long-press the icon › "Choose where to run" resets the mode to the
     * first-run choice, natively, so a computer page that offers no way out
     * (unpaired, stale, broken) can never trap the app. Nothing is deleted:
     * every computer and its pairing stay saved.
     */
    private boolean chooseRunOnIfAsked(Intent intent) {
        if (intent == null || !ACTION_CHOOSE_RUN_ON.equals(intent.getAction())) return false;
        NotifyService.stop(this);
        LocalRuntime.get(this).setMode(LocalRuntime.Mode.UNSET);
        // Consumed: a recreation must not reset again.
        intent.setAction(Intent.ACTION_MAIN);
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (chooseRunOnIfAsked(intent)) {
            restartForMode();
            return;
        }
        handleDeepLinkIntent(intent);
        if (pendingDeepLink != null) {
            String hash = pendingDeepLink;
            applyDeepLink(hash);
        }
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        // A tap still waiting for its document (mid-load, or for the WebView
        // rebuilt after renderer loss) must outlive this instance.
        if (pendingDeepLink != null) outState.putString(STATE_PENDING_DEEP_LINK, pendingDeepLink);
    }

    @Override
    public void onDestroy() {
        shellDestroyed = true;
        WebView view = webView();
        if (view != null) NativeOutboxBridge.forgetPage(view);
        SHELLS.destroy(this);
        pauseHiddenTimers();
        unregisterNetworkReload();
        removeTokenBootstrap();
        super.onDestroy();
    }

    private void removeTokenBootstrap() {
        if (tokenBootstrapScript == null) return;
        try { tokenBootstrapScript.remove(); } catch (Throwable ignored) {}
        tokenBootstrapScript = null;
    }

    private void handleDeepLinkIntent(Intent intent) {
        if (intent == null) return;
        String sessionPath = intent.getStringExtra("sessionPath");
        if (sessionPath == null || sessionPath.isEmpty()) {
            if (intent.getData() != null) {
                String frag = intent.getData().getEncodedFragment();
                // Pairing and session links are both hash routes. Preserve the
                // complete fragment so recovery cannot turn #pair=CODE into a
                // bare session list or drop reqId/kind state.
                if (frag != null && !frag.isEmpty()) {
                    pendingDeepLink = "#" + frag;
                }
            }
            return;
        }
        String reqId = NativeConfig.stringExtra(intent, "reqId");
        String kind = intent.getStringExtra("kind");
        try {
            String enc = URLEncoder.encode(sessionPath, "UTF-8");
            String hash = "#s=" + enc;
            if (reqId != null && !reqId.isEmpty()) hash += "&q=" + URLEncoder.encode(reqId, "UTF-8");
            // needs_input auto-opens the answer sheet (ChatScreen watches the
            // link kind); without this the APK tap lands in chat and the
            // sheet never opens — the browser path already carries &k=.
            if (kind != null && !kind.isEmpty()) hash += "&k=" + URLEncoder.encode(kind, "UTF-8");
            pendingDeepLink = hash;
        } catch (UnsupportedEncodingException e) {
            pendingDeepLink = "#s=" + sessionPath;
        }
    }

    private void applyDeepLink(String hash) {
        if (hash == null || hash.isEmpty()) return;
        try {
            WebView wv = webView();
            // The live document URL, not the url the callback was handed:
            // a fragment redirect between the two must not fool the gate.
            // Until the configured document has finished loading, leave the
            // link pending for onPageFinished: a tap that lands mid-load (cold
            // relaunch after process death, slow tailnet) would otherwise be
            // evaluated in the outgoing document and dropped.
            if (wv == null || !documentLoaded || !isConfiguredAppUrl(wv.getUrl())) return;
            String js = "(function(h){try{"
                    + "if(window.location.hash!==h){history.replaceState(null,'',window.location.pathname+window.location.search+h);"
                    + "window.dispatchEvent(new HashChangeEvent('hashchange'));}"
                    + "}catch(e){window.location.hash=h;}})( " + JSONObjectEscape(hash) + ")";
            wv.evaluateJavascript(js, result -> wv.post(() -> clearVisibleConversationNotifications(wv)));
            pendingDeepLink = null;
        } catch (Throwable e) {
            Log.w(TAG, "applyDeepLink failed", e);
            try {
                WebView wv = webView();
                if (wv != null) load(wv, NativeConfig.appUrl(this) + hash);
            } catch (Throwable ignore) {}
            pendingDeepLink = null;
        }
    }

    private static String JSONObjectEscape(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /**
     * Hand a URL to whatever app the system thinks should have it.
     *
     * Used for the APK download: Chrome fetches it and offers to install,
     * which keeps the package installer's own consent flow intact rather than
     * this app trying to side-load. Failure is deliberately silent — there is
     * no useful recovery from "no browser installed", and throwing here would
     * take the WebView down with it.
     */
    private void openExternally(String url) {
        try {
            android.content.Intent intent = new android.content.Intent(
                android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Throwable ignore) {
        }
    }

    private void injectFallbackClient(WebView wv) {
        final WebViewClient original = wv.getWebViewClient();
        // A WebView silently ignores a download: an `<a href="...apk" download>`
        // does nothing at all without a DownloadListener. Settings offers exactly
        // that link to install a new build, so the one in-app route to updating
        // the shell was dead and updating it needed a USB cable and adb. Hand
        // any .apk to the system instead, which is also the only way the
        // package installer can be reached without file-provider plumbing.
        wv.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> openExternally(url));
        // The Bridge's own client owns the Capacitor JS bridge and file/permission
        // chrome. Wrap and delegate to it: replacing it raw loses the bridge.
        wv.setWebViewClient(new WebViewClient() {
            // Capacitor serves the bundled app (https://localhost/, the public
            // build's onboarding) from APK assets through this hook. Without it
            // that origin went to the network, failed, and every fresh install
            // landed on offline.html instead of onboarding. Only that origin:
            // for a laptop or the on-device daemon Capacitor would proxy the
            // document through its own HTTP client, which the shell never did.
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (original == null || request == null || request.getUrl() == null) return null;
                if (!sameOrigin(request.getUrl(), android.net.Uri.parse(NativeConfig.BUNDLED_APP_URL))) return null;
                return original.shouldInterceptRequest(view, request);
            }
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (original != null) {
                    try { original.onReceivedHttpError(view, request, errorResponse); } catch (Throwable ignore) {}
                }
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (original != null) {
                    try { if (original.shouldOverrideUrlLoading(view, request)) return true; } catch (Throwable ignore) {}
                }
                // Same reasoning as the DownloadListener above: a plain
                // navigation to the APK would otherwise render as bytes in the
                // WebView rather than offering to install.
                android.net.Uri target = request != null ? request.getUrl() : null;
                if (target != null) {
                    String path = target.getPath();
                    if (path != null && path.endsWith(".apk")) {
                        openExternally(target.toString());
                        return true;
                    }
                }
                // Capacitor keeps same-host navigations in the WebView but
                // ignores the port, so another loopback service (a dev server
                // on 127.0.0.1:5173) would replace the chat with no way back.
                if (target != null && request.isForMainFrame() && isHttp(target)
                        && !sameOrigin(target, android.net.Uri.parse(NativeConfig.appUrl(OmpShellActivity.this)))) {
                    openExternally(target.toString());
                    return true;
                }
                // Do not track the destination here: the calling document keeps
                // running until the new one commits, and forever if it never
                // does (204, download, window.stop()). onPageStarted and
                // doUpdateVisitedHistory record committed URLs; shell-initiated
                // load() pre-sets its own.
                return false;
            }
            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                if (!ownsView(view)) return;
                if (original != null) {
                    try { original.doUpdateVisitedHistory(view, url, isReload); } catch (Throwable ignore) {}
                }
                trackedPageUrl = url;
                view.post(() -> clearVisibleConversationNotifications(view));
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (!ownsView(view)) return;
                navigationGeneration++;
                documentLoadFailed = false;
                NativeOutboxBridge.pageNavigated(view);
                if (original != null) {
                    try { original.onPageStarted(view, url, favicon); } catch (Throwable ignore) {}
                }
                // Before the new document's scripts run, so OmpLocal never
                // judges a page by its predecessor's origin.
                trackedPageUrl = url;
                // A new document must not inherit the previous page's back claim.
                webBack.setEnabled(false);
                documentLoaded = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!ownsView(view)) return;
                if (original != null) {
                    try { original.onPageFinished(view, url); } catch (Throwable ignore) {}
                }
                // One read of the APK's immutable config, after the original
                // client has run: both the migration script and the deep link
                // are gated on the same fact.
                // An obsolete finish from the failed/outgoing document cannot
                // change fallback state or consume a pending deep link.
                String currentUrl = view.getUrl();
                boolean configured = !documentLoadFailed && isConfiguredAppUrl(url)
                        && isConfiguredAppUrl(currentUrl) && isConfiguredAppUrl(trackedPageUrl);
                boolean fallback = isFallbackUrl(url) && isFallbackUrl(currentUrl)
                        && isFallbackUrl(trackedPageUrl);
                documentLoaded = configured;
                if (configured) {
                    SHELLS.recovered(OmpShellActivity.this);
                    setFallback(false);
                } else if (fallback) {
                    setFallback(true);
                    // The fallback may only have committed after onStart.
                    retryFallback(view, true);
                }
                if (configured) {
                    removeTokenBootstrap();
                    if (!tokenMigrationRetryStarted) {
                        String migration = NativeConfig.pairingTokenMigrationScript(OmpShellActivity.this);
                        if (migration != null) {
                            tokenMigrationRetryStarted = true;
                            // Reload only once the migration actually ran, so the
                            // reload never precedes the document-start migration.
                            long migrationNavigation = navigationGeneration;
                            view.evaluateJavascript(migration, result -> {
                                if ("true".equals(result) && ownsView(view)) {
                                    view.post(() -> {
                                        if (!ownsView(view) || navigationGeneration != migrationNavigation) return;
                                        String current = view.getUrl();
                                        if (isConfiguredAppUrl(current)) load(view, current);
                                    });
                                }
                            });
                        }
                    }
                }
                // Once per app version and origin, drop the page's service
                // worker and its caches, then reload. A computer that changed
                // builds (or a phone that last saw an older daemon there) kept
                // serving the cached old client indefinitely: it showed a dead
                // pairing page the new daemon refused. Credentials live in
                // localStorage and TokenStore, which this does not touch.
                if (configured && resetStaleClient(view, url)) return;
                // Cold-start intents must wait for the actual document,
                // not an 800ms guess that loses targets on a slow connection.
                if (configured && pendingDeepLink != null) {
                    applyDeepLink(pendingDeepLink);
                } else if (configured) {
                    view.post(() -> clearVisibleConversationNotifications(view));
                }
            }
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!ownsView(view)) return;
                if (original != null) {
                    try { original.onReceivedError(view, request, error); } catch (Throwable ignore) {}
                }
                if (request == null || !request.isForMainFrame()) return;
                String url = request.getUrl() == null ? "" : request.getUrl().toString();
                handleLoadFailure(view, url,
                        "configured app load failed, falling back to bundled assets: ", error);
            }
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (!ownsView(view)) return;
                if (original != null) {
                    try { original.onReceivedError(view, errorCode, description, failingUrl); } catch (Throwable ignore) {}
                }
                handleLoadFailure(view, failingUrl,
                        "configured app load failed (legacy), falling back: ", description);
            }
            @Override
            @RequiresApi(Build.VERSION_CODES.O)
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (!ownsView(view)) return true;
                if (original != null) {
                    try { if (original.onRenderProcessGone(view, detail)) return true; } catch (Throwable ignore) {}
                }
                // Unhandled, Android kills this whole process when the system
                // reclaims the renderer, and NotifyService with it since both
                // share the process. A genuine renderer crash still crashes.
                if (detail.didCrash()) return false;
                recoverFromRendererLoss(view);
                return true;
            }
        });
    }

    /**
     * Every failed configured load falls back, including a Retry from the
     * fallback page itself: a one-shot guard left that retry stranded on the
     * bare WebView error page, which has no Retry and is not file:///, so the
     * network callback would not reload it either.
     */
    private void handleLoadFailure(WebView view, String failedUrl, String logPrefix, Object detail) {
        if (!ownsView(view) || !isConfiguredAppUrl(failedUrl)
                || !isConfiguredAppUrl(trackedPageUrl)) return;
        documentLoadFailed = true;
        documentLoaded = false;
        long failedNavigation = navigationGeneration;
        Log.w(TAG, logPrefix + detail);
        setFallback(true);
        // Resolve the hash now: the error page's onPageFinished can run before
        // this post and consume pendingDeepLink, dropping it from the fallback.
        String target = fallbackUrl(failedUrl);
        view.post(() -> {
            if (ownsView(view) && navigationGeneration == failedNavigation) load(view, target);
        });
    }

    private boolean isConfiguredAppUrl(String url) {
        return url != null && url.startsWith(NativeConfig.appUrl(this));
    }

    /** @return true when a reset was started; the page reloads itself after it. */
    private boolean resetStaleClient(WebView view, String url) {
        String origin = NativeConfig.originOf(url);
        if (origin == null) return false;
        android.content.SharedPreferences prefs = getSharedPreferences("omp_pulse_shell", MODE_PRIVATE);
        String key = "client_reset:" + origin;
        int version = BuildConfig.VERSION_CODE;
        if (prefs.getInt(key, -1) == version) return false;
        prefs.edit().putInt(key, version).commit();
        view.evaluateJavascript("(async()=>{try{"
                + "const r=await navigator.serviceWorker?.getRegistrations?.()??[];await Promise.all(r.map(x=>x.unregister()));"
                + "const k=await caches?.keys?.()??[];await Promise.all(k.map(x=>caches.delete(x)));"
                + "}catch(e){}location.reload();})()", null);
        return true;
    }

    private static boolean isFallbackUrl(String url) {
        return url != null && (url.equals(LOCAL_FALLBACK) || url.startsWith(LOCAL_FALLBACK + "#"));
    }

    /** One retry per foreground return or real network arrival, never per registration. */
    private void retryFallback(WebView view, boolean foregroundReturn) {
        if (mode != LocalRuntime.Mode.LAPTOP || !didFallback || !ownsStartedView(view)) return;
        String currentUrl = view.getUrl();
        boolean fallback = isFallbackUrl(currentUrl) && isFallbackUrl(trackedPageUrl);
        if (foregroundReturn) {
            if (!SHELLS.claimForegroundRetry(this, view, fallback)) return;
        } else if (!fallback) {
            return;
        }
        SHELLS.recovered(this);
        // Invalidate this registration before loading. A failed retry registers
        // a fresh snapshot, whose initial onAvailable callbacks cannot loop.
        setFallback(false);
        String hash = fallbackHash(currentUrl);
        Log.i(TAG, "retrying configured app URL after foreground/network restoration");
        load(view, NativeConfig.appUrl(this) + hash);
    }

    private static boolean isHttp(android.net.Uri u) {
        String s = u.getScheme();
        return "http".equalsIgnoreCase(s) || "https".equalsIgnoreCase(s);
    }

    private static boolean sameOrigin(android.net.Uri a, android.net.Uri b) {
        return a.getScheme() != null && a.getScheme().equalsIgnoreCase(b.getScheme())
                && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost())
                && effectivePort(a) == effectivePort(b);
    }

    private static int effectivePort(android.net.Uri u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    private String fallbackUrl(String failedUrl) {
        String hash = fallbackHash(failedUrl);
        return hash.isEmpty() ? LOCAL_FALLBACK : LOCAL_FALLBACK + hash;
    }

    private String fallbackHash(String failedUrl) {
        String hash = pendingDeepLink;
        if (hash == null || hash.isEmpty()) {
            try {
                android.net.Uri uri = failedUrl == null ? null : android.net.Uri.parse(failedUrl);
                String fragment = uri == null ? null : uri.getEncodedFragment();
                if (fragment != null && !fragment.isEmpty()) hash = "#" + fragment;
            } catch (Throwable ignored) {}
        }
        return hash == null ? "" : hash;
    }

    /**
     * Record whether the fallback page stands in for the configured app and,
     * in laptop mode, hold the network callback that reloads it only for that
     * long. It used to stay registered for the activity's whole life, waking
     * the app on every network change with nothing to reload.
     */
    private void setFallback(boolean fallback) {
        didFallback = fallback;
        if (mode != LocalRuntime.Mode.LAPTOP) return;
        if (fallback && !shellDestroyed && !rendererGone
                && getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) registerNetworkReload();
        else unregisterNetworkReload();
    }

    @SuppressWarnings("deprecation")
    private void registerNetworkReload() {
        if (networkCallback != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm == null) return;
            NetworkRequest req = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            // Initial networks did not arrive during this registration. Foreground
            // reconciliation separately covers connectivity restored while stopped.
            ShellLifecycle.NetworkArrivals<Network> arrivals =
                    new ShellLifecycle.NetworkArrivals<>(Arrays.asList(cm.getAllNetworks()));
            ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
                @Override public void onLost(Network network) {
                    arrivals.lost(network);
                }
                @Override public void onAvailable(Network network) {
                    if (!arrivals.available(network)) return;
                    runOnUiThread(() -> {
                        if (networkCallback != this) return;
                        try {
                            retryFallback(webView(), false);
                        } catch (Throwable e) { Log.d(TAG, "network reload failed", e); }
                    });
                }
            };
            networkCallback = callback;
            cm.registerNetworkCallback(req, callback);
        } catch (Throwable e) {
            networkCallback = null;
            Log.d(TAG, "network callback failed", e);
        }
    }

    private void unregisterNetworkReload() {
        if (networkCallback == null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(networkCallback);
        } catch (Throwable ignore) {}
        networkCallback = null;
    }
}
