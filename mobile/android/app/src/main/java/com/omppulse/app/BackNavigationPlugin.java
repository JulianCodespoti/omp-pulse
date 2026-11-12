package com.omppulse.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The page reports whether it has an in-app back target (an open sheet, a
 * drilled list, a chat). Android decides at the START of a back swipe whether
 * the app consumes it, so this must be known in advance; see
 * OmpShellActivity's back callback and web/src/platform/native-back.ts.
 */
@CapacitorPlugin(name = "OmpBack")
public class BackNavigationPlugin extends Plugin {
    @PluginMethod
    public void setEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            if (getActivity() instanceof OmpShellActivity) {
                ((OmpShellActivity) getActivity()).setWebBackEnabled(enabled);
            }
            call.resolve();
        });
    }
}
