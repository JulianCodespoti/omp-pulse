package com.omppulse.app;

import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.io.DataInputStream;
import java.io.FileInputStream;
import java.security.MessageDigest;

/** Read-only recovery of unsent data from the replaced native chat runtime. */
@CapacitorPlugin(name = "OmpNativeUpgrade")
public class NativeUpgradePlugin extends Plugin {
    private SharedPreferences legacy() {
        return getContext().getSharedPreferences("omp_pulse_native_ui_v1", 0);
    }
    private SharedPreferences markers() {
        return getContext().getSharedPreferences("omp_native_web_upgrade", 0);
    }
    private static String hash(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(64);
        for (byte b : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    private String scope(PluginCall call) throws Exception {
        String token = call.getString("token"), stored = TokenStore.getToken(getContext());
        if (token == null || token.isEmpty() || !token.equals(stored)) throw new IllegalStateException("Pairing changed during recovery");
        String endpoint = NativeConfig.appUrl(getContext());
        return endpoint + "\n" + token;
    }
    private String path(PluginCall call) {
        String path = call.getString("sessionPath");
        if (path == null || path.isEmpty()) throw new IllegalArgumentException("Session required");
        return path;
    }
    private String encodedFile(String path) throws Exception {
        File file = new File(path).getCanonicalFile();
        String root = getContext().getFilesDir().getCanonicalPath() + File.separator;
        if (!file.getPath().startsWith(root) || !file.isFile() || file.length() > 32L * 1024 * 1024)
            throw new IllegalStateException("Previous attachment is unavailable; its saved data was not changed");
        byte[] bytes = new byte[(int) file.length()];
        try (DataInputStream input = new DataInputStream(new FileInputStream(file))) { input.readFully(bytes); }
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }
    @PluginMethod
    public void readSession(PluginCall call) {
        try {
            if (legacy().getAll().isEmpty() && !getContext().getDatabasePath("omp_native_outbox.db").isFile()) {
                call.resolve(new JSObject()); return;
            }
            String scope = scope(call), path = path(call), marker = hash(scope + "\n" + path);
            JSObject result = new JSObject();
            String suffix = hash(scope).substring(0, 24) + ":" + hash(path).substring(0, 24);
            String voice = legacy().getString("voice:" + suffix, null);
            if (voice != null && !voice.isEmpty()) result.put("recording", encodedFile(voice));
            if (markers().getBoolean(marker, false)) { call.resolve(result); return; }
            result.put("text", legacy().getString("draft:" + suffix, ""));
            JSONArray images = new JSONArray();
            JSONArray saved = new JSONArray(legacy().getString("attachments:" + suffix, "[]"));
            for (int i = 0; i < saved.length(); i++) {
                JSONObject image = saved.getJSONObject(i);
                images.put(new JSONObject().put("data", encodedFile(image.getString("file")))
                        .put("mimeType", image.optString("mimeType", "image/jpeg"))
                        .put("name", image.optString("name", "Recovered image")));
            }
            result.put("images", images);
            JSONArray commands = new JSONArray();
            File dbFile = getContext().getDatabasePath("omp_native_outbox.db");
            if (dbFile.isFile()) {
                Uri url = Uri.parse(NativeConfig.appUrl(getContext()));
                int port = url.getPort() == -1 ? ("https".equals(url.getScheme()) ? 443 : 80) : url.getPort();
                String namespace = hash(url.getScheme() + "://" + url.getHost() + ":" + port + "\n" + call.getString("token"));
                try (SQLiteDatabase db = SQLiteDatabase.openDatabase(dbFile.getPath(), null, SQLiteDatabase.OPEN_READONLY);
                     Cursor rows = db.query("commands", new String[]{"command_id", "prompt_text", "images_json"},
                             "namespace=? AND session_path=? AND state NOT IN ('forwarded','completed','failed')",
                             new String[]{namespace, path}, null, null, "created_at ASC")) {
                    while (rows.moveToNext()) commands.put(new JSONObject().put("commandId", rows.getString(0))
                            .put("text", rows.getString(1)).put("images", new JSONArray(rows.getString(2))));
                }
            }
            result.put("commands", commands);
            call.resolve(result);
        } catch (Exception error) { call.reject("Could not recover previous app data: " + error.getMessage()); }
    }
    @PluginMethod
    public void acknowledgeSession(PluginCall call) {
        try {
            String marker = hash(scope(call) + "\n" + path(call));
            // Keep the original database/files. Only mark the completed durable
            // import so clearing a web draft cannot resurrect its old copy.
            if (!markers().edit().putBoolean(marker, true).commit()) throw new IllegalStateException("Could not save recovery marker");
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage()); }
    }
}
