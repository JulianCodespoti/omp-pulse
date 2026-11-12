package org.json;

import java.math.BigDecimal;

/** Small deterministic test parser; explicitly not an Android parser substitute. */
public final class JSONTokener {
    private final String input;
    private int at;
    public JSONTokener(String input) { this.input = input; }
    public char nextClean() { while (at < input.length() && Character.isWhitespace(input.charAt(at))) at++; return at < input.length() ? input.charAt(at++) : 0; }
    public Object nextValue() {
        char c = nextClean();
        if (c == '"') return string();
        if (c == '{') {
            JSONObject result = new JSONObject();
            c=nextClean(); if(c=='}') return result; at--;
            while(true) {
                if(nextClean()!='"') throw new IllegalArgumentException("object key");
                String key=string(); if(nextClean()!=':') throw new IllegalArgumentException("colon");
                result.put(key,nextValue()); c=nextClean(); if(c=='}') return result; if(c!=',') throw new IllegalArgumentException("object separator");
            }
        }
        if (c == '[') {
            JSONArray result=new JSONArray(); c=nextClean(); if(c==']') return result; at--;
            while(true) { result.put(nextValue()); c=nextClean(); if(c==']') return result; if(c!=',') throw new IllegalArgumentException("array separator"); }
        }
        if(c==0) throw new IllegalArgumentException("missing value");
        int start=at-1;
        while(at<input.length() && ",]} \r\n\t".indexOf(input.charAt(at))<0) at++;
        String token=input.substring(start,at);
        if(token.equals("null")) return JSONObject.NULL;
        if(token.equals("true")) return true;
        if(token.equals("false")) return false;
        return new BigDecimal(token);
    }
    private String string() {
        StringBuilder out=new StringBuilder();
        while(at<input.length()) {
            char c=input.charAt(at++); if(c=='"') return out.toString();
            if(c=='\\') {
                if(at==input.length()) throw new IllegalArgumentException("escape"); c=input.charAt(at++);
                switch(c) {
                    case '"': case '\\': case '/': out.append(c); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'u': out.append((char)Integer.parseInt(input.substring(at,at+4),16)); at+=4; break;
                    default: throw new IllegalArgumentException("escape");
                }
            } else out.append(c);
        }
        throw new IllegalArgumentException("unterminated string");
    }
}
