package com.omppulse.app.runtime;

/** Byte-level progress callback (java.util.function is API 24+, the repo's minSdk is lower). */
interface Progress {
    void update(long done, long total);
}
