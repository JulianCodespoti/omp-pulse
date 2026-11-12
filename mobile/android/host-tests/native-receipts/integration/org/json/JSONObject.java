package org.json;

import java.util.LinkedHashMap;
import java.util.Map;

/** Test-only typed JSON boundary, not Android org.json compatibility evidence. */
public final class JSONObject {
    public static final Object NULL = new Object() { @Override public String toString() { return "null"; } };
    private final Map<String, Object> values = new LinkedHashMap<>();
    public JSONObject() {}
    public JSONObject(String input) {
        Object parsed = new JSONTokener(input).nextValue();
        if (!(parsed instanceof JSONObject)) throw new IllegalArgumentException("object required");
        values.putAll(((JSONObject) parsed).values);
    }
    public JSONObject put(String key, Object value) {
        if (value == null) values.remove(key); else values.put(key, value);
        return this;
    }
    public Object opt(String key) { return values.get(key); }
    public boolean has(String key) { return values.containsKey(key); }
    public Object remove(String key) { return values.remove(key); }
    public String getString(String key) {
        Object value = opt(key);
        if (!(value instanceof String)) throw new IllegalArgumentException("string required: " + key);
        return (String) value;
    }
    public String optString(String key) { return optString(key, ""); }
    public String optString(String key, String fallback) {
        Object value = opt(key);
        return value == null || value == NULL ? fallback : value.toString();
    }
    public long getLong(String key) {
        Object value = opt(key);
        if (!(value instanceof Number)) throw new IllegalArgumentException("number required: " + key);
        return ((Number)value).longValue();
    }
    public int getInt(String key) { return Math.toIntExact(getLong(key)); }
    public long optLong(String key, long fallback) { Object v = opt(key); return v instanceof Number ? ((Number)v).longValue() : fallback; }
    public int optInt(String key, int fallback) { return (int)optLong(key, fallback); }
    public boolean optBoolean(String key, boolean fallback) { Object v = opt(key); return v instanceof Boolean ? (Boolean)v : fallback; }
    public boolean getBoolean(String key) {
        Object value = opt(key);
        if (!(value instanceof Boolean)) throw new IllegalArgumentException("boolean required: " + key);
        return (Boolean)value;
    }
    public JSONObject getJSONObject(String key) {
        JSONObject value = optJSONObject(key);
        if (value == null) throw new IllegalArgumentException("object required: " + key);
        return value;
    }
    public JSONArray getJSONArray(String key) {
        JSONArray value = optJSONArray(key);
        if (value == null) throw new IllegalArgumentException("array required: " + key);
        return value;
    }
    public JSONObject optJSONObject(String key) { Object v = opt(key); return v instanceof JSONObject ? (JSONObject)v : null; }
    public JSONArray optJSONArray(String key) { Object v = opt(key); return v instanceof JSONArray ? (JSONArray)v : null; }
    static String encoded(Object value) {
        if (value == null || value == NULL) return "null";
        if (value instanceof String) {
            StringBuilder out = new StringBuilder("\"");
            for (char c : ((String)value).toCharArray()) {
                switch (c) {
                    case '"': out.append("\\\""); break;
                    case '\\': out.append("\\\\"); break;
                    case '\n': out.append("\\n"); break;
                    case '\r': out.append("\\r"); break;
                    case '\t': out.append("\\t"); break;
                    default:
                        if (c < 32) out.append(String.format("\\u%04x", (int)c)); else out.append(c);
                }
            }
            return out.append('"').toString();
        }
        return value.toString();
    }
    @Override public String toString() {
        StringBuilder out = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String,Object> entry : values.entrySet()) {
            if (!first) out.append(',');
            first = false;
            out.append(encoded(entry.getKey())).append(':').append(encoded(entry.getValue()));
        }
        return out.append('}').toString();
    }
}
