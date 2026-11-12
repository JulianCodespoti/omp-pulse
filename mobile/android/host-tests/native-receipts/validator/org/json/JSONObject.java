package org.json;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Test-only object fixture, NOT a JSON parser or Android org.json implementation.
 * The production validator uses only opt/has; put/remove construct typed test values.
 */
public final class JSONObject {
    public static final Object NULL = new Object() {
        @Override public boolean equals(Object value) { return value == this || value == null; }
        @Override public int hashCode() { return 0; }
        @Override public String toString() { return "null"; }
    };

    private final Map<String, Object> values = new LinkedHashMap<>();

    public Object opt(String name) { return values.get(name); }
    public boolean has(String name) { return values.containsKey(name); }
    public Object remove(String name) { return values.remove(name); }

    public JSONObject put(String name, Object value) {
        if (value == null) values.remove(name);
        else values.put(name, value);
        return this;
    }
}
