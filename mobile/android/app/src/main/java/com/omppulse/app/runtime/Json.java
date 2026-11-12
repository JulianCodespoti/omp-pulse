package com.omppulse.app.runtime;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal strict JSON reader for {@code runtime.json}, and a writer for the small guest files the
 * app maintains (harness seed status, the MCP registration).
 *
 * WHY not org.json: on the JVM unit-test classpath org.json is the android.jar stub that throws
 * "not mocked", and adding a test dependency is not allowed. Spec parsing must be unit-testable,
 * so this tiny reader keeps it pure Java. Objects map to {@link LinkedHashMap}, arrays to
 * {@link ArrayList}, numbers to {@link Long} (integers) or {@link Double}, plus String, Boolean and
 * null.
 */
final class Json {
    private final String s;
    private int i;

    private Json(String s) {
        this.s = s;
    }

    static Object parse(String text) {
        Json p = new Json(text);
        p.ws();
        Object v = p.value();
        p.ws();
        if (p.i != p.s.length()) throw p.err("trailing data");
        return v;
    }

    /**
     * Serializes what {@link #parse} produces (Map, List, String, Number, Boolean, null), two-space
     * indented; key order is the map's iteration order, so a parse/write round trip keeps it.
     */
    static String write(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value, "");
        return sb.append('\n').toString();
    }

    private static void write(StringBuilder sb, Object v, String indent) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            quote(sb, (String) v);
        } else if (v instanceof Boolean || v instanceof Long || v instanceof Integer) {
            sb.append(v);
        } else if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            sb.append(Double.isNaN(d) || Double.isInfinite(d) ? "null" : Double.toString(d));
        } else if (v instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) v;
            if (m.isEmpty()) {
                sb.append("{}");
                return;
            }
            String inner = indent + "  ";
            sb.append("{\n");
            int n = 0;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                sb.append(inner);
                quote(sb, String.valueOf(e.getKey()));
                sb.append(": ");
                write(sb, e.getValue(), inner);
                sb.append(++n < m.size() ? ",\n" : "\n");
            }
            sb.append(indent).append('}');
        } else if (v instanceof List) {
            List<?> l = (List<?>) v;
            if (l.isEmpty()) {
                sb.append("[]");
                return;
            }
            String inner = indent + "  ";
            sb.append("[\n");
            for (int k = 0; k < l.size(); k++) {
                sb.append(inner);
                write(sb, l.get(k), inner);
                sb.append(k + 1 < l.size() ? ",\n" : "\n");
            }
            sb.append(indent).append(']');
        } else {
            throw new IllegalArgumentException("not a JSON value: " + v.getClass().getName());
        }
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int k = 0; k < s.length(); k++) {
            char c = s.charAt(k);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    private Object value() {
        if (i >= s.length()) throw err("unexpected end");
        char c = s.charAt(i);
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            case 't': word("true"); return Boolean.TRUE;
            case 'f': word("false"); return Boolean.FALSE;
            case 'n': word("null"); return null;
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return number();
                throw err("unexpected '" + c + "'");
        }
    }

    private Map<String, Object> object() {
        Map<String, Object> out = new LinkedHashMap<>();
        i++;
        ws();
        if (peek('}')) return out;
        while (true) {
            ws();
            if (i >= s.length() || s.charAt(i) != '"') throw err("expected key");
            String key = string();
            ws();
            expect(':');
            ws();
            out.put(key, value());
            ws();
            if (peek('}')) return out;
            expect(',');
        }
    }

    private List<Object> array() {
        List<Object> out = new ArrayList<>();
        i++;
        ws();
        if (peek(']')) return out;
        while (true) {
            ws();
            out.add(value());
            ws();
            if (peek(']')) return out;
            expect(',');
        }
    }

    private String string() {
        i++;
        StringBuilder sb = new StringBuilder();
        while (true) {
            if (i >= s.length()) throw err("unterminated string");
            char c = s.charAt(i++);
            if (c == '"') return sb.toString();
            if (c < 0x20) throw err("control character in string");
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            if (i >= s.length()) throw err("unterminated escape");
            char e = s.charAt(i++);
            switch (e) {
                case '"': sb.append('"'); break;
                case '\\': sb.append('\\'); break;
                case '/': sb.append('/'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'u':
                    if (i + 4 > s.length()) throw err("short \\u escape");
                    try {
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                    } catch (NumberFormatException ex) {
                        throw err("bad \\u escape");
                    }
                    i += 4;
                    break;
                default: throw err("bad escape");
            }
        }
    }

    private Object number() {
        int start = i;
        if (s.charAt(i) == '-') i++;
        boolean integral = true;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c >= '0' && c <= '9') {
                i++;
            } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                integral = false;
                i++;
            } else {
                break;
            }
        }
        String n = s.substring(start, i);
        try {
            return integral ? (Object) Long.parseLong(n) : (Object) Double.parseDouble(n);
        } catch (NumberFormatException ex) {
            throw err("bad number " + n);
        }
    }

    private void word(String w) {
        if (!s.startsWith(w, i)) throw err("expected " + w);
        i += w.length();
    }

    private boolean peek(char c) {
        if (i < s.length() && s.charAt(i) == c) {
            i++;
            return true;
        }
        return false;
    }

    private void expect(char c) {
        if (!peek(c)) throw err("expected '" + c + "'");
    }

    private void ws() {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != ' ' && c != '\n' && c != '\r' && c != '\t') return;
            i++;
        }
    }

    private IllegalArgumentException err(String what) {
        return new IllegalArgumentException("invalid JSON at offset " + i + ": " + what);
    }
}
