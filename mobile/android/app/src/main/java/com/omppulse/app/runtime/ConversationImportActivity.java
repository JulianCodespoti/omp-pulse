package com.omppulse.app.runtime;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;
import androidx.core.content.ContextCompat;

/** Starts the signed conversation transfer while Android permits foreground-service startup. */
public final class ConversationImportActivity extends Activity {
    public static final String ACTION = "com.omppulse.app.IMPORT_CONVERSATIONS";
    private boolean dispatched;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent request = getIntent();
        Uri uri = request == null ? null : request.getData();
        if (request == null || !ACTION.equals(request.getAction()) || uri == null
                || !"content".equals(uri.getScheme())) finish();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (isFinishing() || dispatched) return;
        dispatched = true;
        Uri uri = getIntent().getData();
        Intent transfer = new Intent(this, ConversationImportService.class)
                .setData(uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        transfer.setClipData(ClipData.newRawUri("Conversation archive", uri));
        try {
            ContextCompat.startForegroundService(this, transfer);
        } catch (RuntimeException e) {
            // Never include provider URIs or exception text: either can identify private chats.
            Toast.makeText(this, "Could not start the conversation import", Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
