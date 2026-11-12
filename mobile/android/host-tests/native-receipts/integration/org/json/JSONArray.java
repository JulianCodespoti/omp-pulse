package org.json;

import java.util.ArrayList;
import java.util.List;

/** Minimal synthetic array boundary. */
public final class JSONArray {
    private final List<Object> values = new ArrayList<>();
    public JSONArray put(Object value) { values.add(value == null ? JSONObject.NULL : value); return this; }
    public int length() { return values.size(); }
    public JSONObject getJSONObject(int index) { return (JSONObject)values.get(index); }
    public JSONObject optJSONObject(int index) { Object value = values.get(index); return value instanceof JSONObject ? (JSONObject)value : null; }
    @Override public String toString() {
        StringBuilder out = new StringBuilder("[");
        for (int i=0; i<values.size(); i++) { if (i>0) out.append(','); out.append(JSONObject.encoded(values.get(i))); }
        return out.append(']').toString();
    }
}
