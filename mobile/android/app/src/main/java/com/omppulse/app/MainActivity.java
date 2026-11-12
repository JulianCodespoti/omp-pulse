package com.omppulse.app;

import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;

/**
 * Launcher surface. All behavior — plugins, bridges, deep links, offline
 * fallback, network restoration, downloads and predictive Back — is owned by
 * {@link OmpShellActivity}, which the bubble also uses.
 */
public class MainActivity extends OmpShellActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Only the launcher uses AppTheme.NoActionBarLaunch; the bubble's plain
        // theme is not a splash theme. Must precede super.onCreate.
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
    }
}
